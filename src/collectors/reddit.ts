import type { Collector, CollectorContext, RawDocument } from '../types.ts';
import { config } from '../config.ts';
import { CLUBS, NEUTRAL_SUBREDDITS } from '../clubs.ts';
import { politeFetch } from './http.ts';

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
 * r/Ajax, r/PSV and r/Feyenoord are match-thread cultures where people post
 * during and immediately after games, which is exactly the signal a sentiment
 * tracker wants.
 *
 * Two practical notes:
 *  - Anonymous access (the old .json trick) is blocked from datacenter IPs, so
 *    OAuth is mandatory anywhere but a home connection. The credentials are a
 *    free "script" app.
 *  - The club subreddits are majority-English; the neutral ones are mixed. The
 *    analyzer is Dutch-tuned, so English comments score weakly. Language is
 *    recorded per document and the dashboard can filter on it.
 */
export class RedditCollector implements Collector {
  readonly id = 'reddit';
  readonly kind = 'reddit' as const;

  private token: string | null = null;
  private tokenExpiresAt = 0;

  isConfigured(): boolean {
    return Boolean(config.reddit.clientId && config.reddit.clientSecret);
  }

  unavailableReason(): string | null {
    if (this.isConfigured()) return null;
    return 'Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET (free script app at reddit.com/prefs/apps).';
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

  async collect(ctx: CollectorContext): Promise<RawDocument[]> {
    const documents: RawDocument[] = [];
    const subreddits = [...CLUBS.flatMap((c) => c.subreddits), ...NEUTRAL_SUBREDDITS];

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
