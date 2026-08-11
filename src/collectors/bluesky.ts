import type { Collector, CollectorContext, RawDocument } from '../types.ts';
import { config } from '../config.ts';
import { FEATURED_CLUBS } from '../clubs.ts';
import { politeFetch } from './http.ts';

interface BlueskyPost {
  uri: string;
  author?: { handle?: string };
  record?: { text?: string; createdAt?: string; langs?: string[] };
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
}

/**
 * Bluesky is the practical replacement for X/Twitter in this project. X's API
 * now starts at roughly $200/month for a usable tier, which puts real-time
 * microblog sentiment out of reach for a hobby project; Bluesky's search
 * endpoint is public, free and unmetered, and Dutch football has a genuine
 * presence there.
 *
 * The two anonymous hosts do not behave the same: `public.api.bsky.app` returns
 * 403 from datacenter ranges — which is exactly where this normally runs, on
 * GitHub Actions — while `api.bsky.app` answers 200 from that same address.
 * Preferring the latter is what makes anonymous collection work unattended,
 * with nothing to configure. An app password is still used when set, and is
 * worth having if both hosts start refusing.
 */
const ANONYMOUS_HOSTS = ['https://api.bsky.app', 'https://public.api.bsky.app'];

export class BlueskyCollector implements Collector {
  readonly id = 'bluesky';
  readonly kind = 'bluesky' as const;

  private jwt: string | null = null;

  isConfigured(): boolean {
    // Always attempt: anonymous search is free and often works.
    return true;
  }

  unavailableReason(): string | null {
    if (config.bluesky.identifier && config.bluesky.appPassword) return null;
    return 'Draait anoniem — dat werkt normaal gesproken. Zet BLUESKY_IDENTIFIER en BLUESKY_APP_PASSWORD als er niets binnenkomt.';
  }

  private async authenticate(): Promise<string | null> {
    if (this.jwt) return this.jwt;
    if (!config.bluesky.identifier || !config.bluesky.appPassword) return null;

    const response = await politeFetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: config.bluesky.identifier,
        password: config.bluesky.appPassword,
      }),
    });

    if (!response.ok) throw new Error(`Bluesky auth failed: HTTP ${response.status}`);
    const payload = (await response.json()) as { accessJwt: string };
    this.jwt = payload.accessJwt;
    return this.jwt;
  }

  /** Searches, trying each host until one does not refuse this address. */
  private async search(query: URLSearchParams, token: string | null): Promise<BlueskyPost[]> {
    const hosts = token ? ['https://bsky.social'] : ANONYMOUS_HOSTS;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    let lastStatus = 0;

    for (const host of hosts) {
      const response = await politeFetch(`${host}/xrpc/app.bsky.feed.searchPosts?${query}`, {
        headers,
      });
      if (response.ok) {
        return ((await response.json()) as { posts?: BlueskyPost[] }).posts ?? [];
      }
      lastStatus = response.status;
    }

    throw new Error(
      lastStatus === 403
        ? 'HTTP 403 — dit IP wordt anoniem geweigerd; zet BLUESKY_APP_PASSWORD'
        : `HTTP ${lastStatus}`,
    );
  }

  async collect(ctx: CollectorContext): Promise<RawDocument[]> {
    const documents: RawDocument[] = [];
    const token = await this.authenticate().catch(() => null);

    for (const club of FEATURED_CLUBS) {
      try {
        const query = new URLSearchParams({
          q: club.shortName,
          limit: '100',
          lang: 'nl',
          since: ctx.since.toISOString(),
        });

        const posts = await this.search(query, token);

        for (const post of posts) {
          const text = post.record?.text ?? '';
          if (text.length < 10) continue;

          // at://did:plc:xxx/app.bsky.feed.post/yyy -> bsky.app/profile/.../post/yyy
          const rkey = post.uri.split('/').pop() ?? post.uri;
          const handle = post.author?.handle ?? 'unknown';

          documents.push({
            externalId: `bluesky:${post.uri}`,
            sourceKind: 'bluesky',
            sourceName: 'Bluesky',
            url: `https://bsky.app/profile/${handle}/post/${rkey}`,
            title: null,
            body: text,
            author: handle,
            publishedAt: post.record?.createdAt ?? new Date().toISOString(),
            engagement:
              (post.likeCount ?? 0) + (post.repostCount ?? 0) * 2 + (post.replyCount ?? 0),
            lang: post.record?.langs?.[0] ?? 'nl',
          });
        }

        console.log(`  ✓ Bluesky ${club.shortName}: ${posts.length} posts`);
      } catch (error) {
        console.warn(`  ✗ Bluesky ${club.shortName}: ${(error as Error).message}`);
      }
    }

    return documents;
  }
}
