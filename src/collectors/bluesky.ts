import type { Collector, CollectorContext, RawDocument } from '../types.ts';
import { config } from '../config.ts';
import { CLUBS } from '../clubs.ts';
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
 * Anonymous search works from residential IPs. From a datacenter the public
 * endpoint returns 403, so an app password (free, revocable, not your account
 * password) switches the collector to authenticated requests.
 */
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
    return 'Running anonymously — set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD if requests are refused (common on cloud hosts).';
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

  async collect(ctx: CollectorContext): Promise<RawDocument[]> {
    const documents: RawDocument[] = [];
    const token = await this.authenticate().catch(() => null);

    const host = token ? 'https://bsky.social' : 'https://public.api.bsky.app';
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

    for (const club of CLUBS) {
      try {
        const query = new URLSearchParams({
          q: club.shortName,
          limit: '100',
          lang: 'nl',
          since: ctx.since.toISOString(),
        });

        const response = await politeFetch(
          `${host}/xrpc/app.bsky.feed.searchPosts?${query}`,
          { headers },
        );

        if (!response.ok) {
          throw new Error(
            response.status === 403
              ? 'HTTP 403 — this IP is refused anonymously; set BLUESKY_APP_PASSWORD'
              : `HTTP ${response.status}`,
          );
        }

        const payload = (await response.json()) as { posts?: BlueskyPost[] };
        const posts = payload.posts ?? [];

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
