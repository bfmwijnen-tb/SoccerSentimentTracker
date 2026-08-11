import type { Collector, CollectorContext, RawDocument } from '../types.ts';
import { config } from '../config.ts';
import { CLUBS, NEUTRAL_SUBREDDITS } from '../clubs.ts';
import { politeFetch } from './http.ts';
import { parseFeed } from './rss.ts';

interface RedditListing {
  data?: {
    children?: Array<{
      kind: string;
      data: Record<string, unknown>;
    }>;
  };
}

/**
 * Reddit is the single best source of unfiltered fan reaction in this project:
 * r/AjaxAmsterdam, r/PSV and r/Feyenoord are match-thread cultures where people
 * post during and immediately after games, which is exactly the signal a
 * sentiment tracker wants.
 *
 * Three practical notes:
 *  - The JSON API is blocked from datacenter IPs without OAuth, but the per-
 *    subreddit **Atom feed** is not: `/r/<sub>/new/.rss` answers 200 from the
 *    same address that gets a 403 on `/r/<sub>/new.json`. So the collector has
 *    two modes. With credentials it reads posts *and comments* over OAuth; with
 *    none it falls back to the feed, which carries the 25 newest posts and no
 *    comments. Less signal — but it means fan reaction shows up on a fresh
 *    install with nothing to configure, which is worth more than the comments.
 *  - The club subreddits are majority-English; the neutral ones are mixed. The
 *    analyzer is Dutch-tuned, so English comments score weakly. Language is
 *    recorded per document and the dashboard can filter on it.
 *  - Subreddit names are a trap: r/Ajax is a town in Ontario. See clubs.ts.
 */
export class RedditCollector implements Collector {
  readonly id = 'reddit';
  readonly kind = 'reddit' as const;

  private token: string | null = null;
  private tokenExpiresAt = 0;

  private get hasOauth(): boolean {
    return Boolean(config.reddit.clientId && config.reddit.clientSecret);
  }

  isConfigured(): boolean {
    // Always run: the feed fallback needs no credentials.
    return true;
  }

  unavailableReason(): string | null {
    if (this.hasOauth) return null;
    return 'Leest publieke subreddit-feeds (alleen posts, geen reacties). Zet REDDIT_CLIENT_ID en REDDIT_CLIENT_SECRET voor reacties erbij — gratis script-app op reddit.com/prefs/apps.';
  }

  private async authenticate(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const credentials = Buffer.from(
      `${config.reddit.clientId}:${config.reddit.clientSecret}`,
    ).toString('base64');

    const response = await politeFetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      throw new Error(`Reddit auth failed: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { access_token: string; expires_in: number };
    this.token = payload.access_token;
    // Renew a minute early to avoid racing the expiry.
    this.tokenExpiresAt = Date.now() + (payload.expires_in - 60) * 1000;
    return this.token;
  }

  private async fetchListing(path: string): Promise<RedditListing> {
    const token = await this.authenticate();
    const response = await politeFetch(`https://oauth.reddit.com${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
    return (await response.json()) as RedditListing;
  }

  /**
   * The Atom feed for a subreddit — the no-credentials path.
   *
   * Reddit wraps every post body in the same "submitted by /u/x [link]
   * [comments]" footer. Left in, that boilerplate is a constant appended to
   * every document, and the analyzer would score it over and over.
   */
  private async fetchFeed(subreddit: string, ctx: CollectorContext): Promise<RawDocument[]> {
    // Reddit refuses Node's TLS fingerprint outright, so every one of these is
    // served by politeFetch's curl fallback — and that fallback is *also* rate
    // limited, which shows up as an intermittent 403 on the third or fourth
    // subreddit in a row rather than a steady one. Backing off and retrying
    // recovers them; without it roughly half the feeds were dropped per run.
    let response = await politeFetch(`https://www.reddit.com/r/${subreddit}/new/.rss`);

    for (const wait of [4_000, 12_000]) {
      if (response.ok) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
      response = await politeFetch(`https://www.reddit.com/r/${subreddit}/new/.rss`);
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    return parseFeed(await response.text(), `r/${subreddit}`)
      .filter((doc) => new Date(doc.publishedAt) >= ctx.since)
      .map((doc) => ({
        ...doc,
        externalId: doc.externalId.replace(/^rss:/, 'reddit:post:'),
        sourceKind: 'reddit' as const,
        body: doc.body.split(/\s*submitted by\s*/i)[0]!.trim(),
        lang: 'und',
      }));
  }

  async collect(ctx: CollectorContext): Promise<RawDocument[]> {
    const documents: RawDocument[] = [];
    const subreddits = [...CLUBS.flatMap((c) => c.subreddits), ...NEUTRAL_SUBREDDITS];

    if (!this.hasOauth) {
      for (const subreddit of subreddits) {
        try {
          const posts = await this.fetchFeed(subreddit, ctx);
          documents.push(...posts);
          console.log(`  ✓ r/${subreddit}: ${posts.length} posts (feed)`);
        } catch (error) {
          console.warn(`  ✗ r/${subreddit}: ${(error as Error).message}`);
        }
      }
      return documents;
    }

    for (const subreddit of subreddits) {
      try {
        // Posts carry the topic; comments carry the emotion. Both are collected.
        const listing = await this.fetchListing(`/r/${subreddit}/new?limit=100`);
        const posts = listing.data?.children ?? [];
        let count = 0;

        for (const child of posts) {
          const post = child.data;
          const createdUtc = Number(post['created_utc'] ?? 0) * 1000;
          if (createdUtc < ctx.since.getTime()) continue;

          const id = String(post['id'] ?? '');
          const title = String(post['title'] ?? '');
          const selfText = String(post['selftext'] ?? '');

          documents.push({
            externalId: `reddit:post:${id}`,
            sourceKind: 'reddit',
            sourceName: `r/${subreddit}`,
            url: `https://reddit.com${String(post['permalink'] ?? '')}`,
            title,
            body: selfText,
            author: String(post['author'] ?? '') || null,
            publishedAt: new Date(createdUtc).toISOString(),
            engagement: Number(post['score'] ?? 0),
            lang: 'und',
          });
          count += 1;

          // Only pull comments for posts with real discussion; a 2-comment post
          // is not worth an extra API round trip.
          if (Number(post['num_comments'] ?? 0) >= 5) {
            documents.push(...(await this.fetchComments(subreddit, id, ctx)));
          }
        }

        console.log(`  ✓ r/${subreddit}: ${count} posts`);
      } catch (error) {
        console.warn(`  ✗ r/${subreddit}: ${(error as Error).message}`);
      }
    }

    return documents;
  }

  private async fetchComments(
    subreddit: string,
    postId: string,
    ctx: CollectorContext,
  ): Promise<RawDocument[]> {
    try {
      const response = (await this.fetchListing(
        `/r/${subreddit}/comments/${postId}?limit=100&depth=2&sort=top`,
      )) as unknown as RedditListing[];

      // The comments endpoint returns [postListing, commentListing].
      const commentListing = Array.isArray(response) ? response[1] : undefined;
      const comments = commentListing?.data?.children ?? [];

      return comments
        .filter((child) => child.kind === 't1')
        .map((child) => child.data)
        .filter((comment) => {
          const created = Number(comment['created_utc'] ?? 0) * 1000;
          const body = String(comment['body'] ?? '');
          return created >= ctx.since.getTime() && body.length > 12 && body !== '[deleted]';
        })
        .map((comment) => ({
          externalId: `reddit:comment:${String(comment['id'])}`,
          sourceKind: 'reddit' as const,
          sourceName: `r/${subreddit}`,
          url: `https://reddit.com${String(comment['permalink'] ?? '')}`,
          title: null,
          body: String(comment['body'] ?? ''),
          author: String(comment['author'] ?? '') || null,
          publishedAt: new Date(Number(comment['created_utc'] ?? 0) * 1000).toISOString(),
          engagement: Number(comment['score'] ?? 0),
          lang: 'und',
        }));
    } catch {
      return [];
    }
  }
}
