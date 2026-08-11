import type { Collector, CollectorContext, RawDocument } from '../types.ts';
import { config } from '../config.ts';
import { FEATURED_CLUBS } from '../clubs.ts';
import { politeFetch, decodeEntities } from './http.ts';

/**
 * YouTube comments under club channels and highlight videos.
 *
 * This is the most *Dutch* of the social sources — where Reddit's club subs
 * skew international and English, YouTube comment sections under Eredivisie
 * highlights are overwhelmingly Dutch, which suits the analyzer. Quota is the
 * constraint: the free tier is 10,000 units/day and a comment page costs 1 unit
 * while a search costs 100, so this collector searches sparingly and reads
 * comments generously.
 */
export class YouTubeCollector implements Collector {
  readonly id = 'youtube';
  readonly kind = 'youtube' as const;

  isConfigured(): boolean {
    return Boolean(config.youtube.apiKey);
  }

  unavailableReason(): string | null {
    if (this.isConfigured()) return null;
    return 'Set YOUTUBE_API_KEY (Data API v3 key from console.cloud.google.com).';
  }

  private async api<T>(path: string, params: Record<string, string>): Promise<T> {
    const query = new URLSearchParams({ ...params, key: config.youtube.apiKey });
    const response = await politeFetch(`https://www.googleapis.com/youtube/v3/${path}?${query}`);
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`HTTP ${response.status}: ${detail.slice(0, 160)}`);
    }
    return (await response.json()) as T;
  }

  async collect(ctx: CollectorContext): Promise<RawDocument[]> {
    const documents: RawDocument[] = [];

    for (const club of FEATURED_CLUBS) {
      try {
        const search = await this.api<{
          items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string } }>;
        }>('search', {
          part: 'snippet',
          channelId: club.youtubeChannels[0] ?? '',
          order: 'date',
          maxResults: '10',
          type: 'video',
          publishedAfter: ctx.since.toISOString(),
        });

        const videos = (search.items ?? []).filter((item) => item.id?.videoId);

        for (const video of videos) {
          const videoId = video.id!.videoId!;
          const videoTitle = decodeEntities(video.snippet?.title ?? '');
          documents.push(...(await this.fetchComments(videoId, videoTitle, club.shortName, ctx)));
        }

        console.log(`  ✓ YouTube ${club.shortName}: ${videos.length} videos`);
      } catch (error) {
        console.warn(`  ✗ YouTube ${club.shortName}: ${(error as Error).message}`);
      }
    }

    return documents;
  }

  private async fetchComments(
    videoId: string,
    videoTitle: string,
    clubName: string,
    ctx: CollectorContext,
  ): Promise<RawDocument[]> {
    try {
      const response = await this.api<{
        items?: Array<{
          snippet?: {
            topLevelComment?: {
              id?: string;
              snippet?: {
                textOriginal?: string;
                authorDisplayName?: string;
                publishedAt?: string;
                likeCount?: number;
              };
            };
          };
        }>;
      }>('commentThreads', {
        part: 'snippet',
        videoId,
        maxResults: '100',
        order: 'relevance',
        textFormat: 'plainText',
      });

      return (response.items ?? [])
        .map((item) => item.snippet?.topLevelComment)
        .filter((comment): comment is NonNullable<typeof comment> => Boolean(comment?.snippet))
        .map((comment) => {
          const snippet = comment.snippet!;
          return {
            // The video title is prepended to the body so club and topic
            // detection can see the context the commenter is reacting to —
            // "wat een goal!" alone names no club.
            externalId: `youtube:${comment.id ?? `${videoId}:${snippet.publishedAt}`}`,
            sourceKind: 'youtube' as const,
            sourceName: `YouTube — ${clubName}`,
            url: `https://www.youtube.com/watch?v=${videoId}&lc=${comment.id ?? ''}`,
            title: videoTitle,
            body: snippet.textOriginal ?? '',
            author: snippet.authorDisplayName ?? null,
            publishedAt: snippet.publishedAt ?? new Date().toISOString(),
            engagement: snippet.likeCount ?? 0,
            lang: 'nl',
          };
        })
        .filter((doc) => new Date(doc.publishedAt) >= ctx.since && doc.body.length > 8);
    } catch {
      // Comments disabled on a video is normal and not worth a warning.
      return [];
    }
  }
}
