import type { Collector } from '../types.ts';
import { RssCollector } from './rss.ts';
import { RedditCollector } from './reddit.ts';
import { YouTubeCollector } from './youtube.ts';
import { BlueskyCollector } from './bluesky.ts';

export const COLLECTORS: Collector[] = [
  new RssCollector(),
  new RedditCollector(),
  new YouTubeCollector(),
  new BlueskyCollector(),
];

export { RssCollector, RedditCollector, YouTubeCollector, BlueskyCollector };
