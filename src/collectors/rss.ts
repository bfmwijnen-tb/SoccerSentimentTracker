import type { Collector, CollectorContext, RawDocument } from '../types.ts';
import { politeFetch, stripHtml, decodeEntities } from './http.ts';

export interface FeedDefinition {
  name: string;
  url: string;
  /** Feeds that cover all sport; club filtering happens downstream. */
  general?: boolean;
}

/**
 * Dutch football RSS feeds. These need no credentials and no authentication,
 * which makes them the project's dependable baseline: every other source can be
 * switched off by a platform policy change, these keep working.
 *
 * What they measure is *media tone*, not fan sentiment — an important
 * distinction the dashboard makes explicit rather than blurring the two.
 */
export const FEEDS: FeedDefinition[] = [
  { name: 'AD Sport', url: 'https://www.ad.nl/sport/rss.xml', general: true },
  { name: 'NU.nl Sport', url: 'https://www.nu.nl/rss/Sport', general: true },
  { name: 'VoetbalPrimeur', url: 'https://www.voetbalprimeur.nl/rss/' },
  { name: 'Voetbal International', url: 'https://www.vi.nl/rss/index.xml' },
  { name: 'NOS Voetbal', url: 'https://feeds.nos.nl/nosvoetbal' },
  { name: 'Soccernews', url: 'https://www.soccernews.nl/feed' },
  { name: 'FCUpdate', url: 'https://www.fcupdate.nl/rss' },
  { name: 'ELF Voetbal', url: 'https://www.elfvoetbal.nl/rss' },
  { name: 'Google News — Ajax', url: 'https://news.google.com/rss/search?q=Ajax+voetbal&hl=nl&gl=NL&ceid=NL:nl' },
  { name: 'Google News — PSV', url: 'https://news.google.com/rss/search?q=PSV+Eindhoven&hl=nl&gl=NL&ceid=NL:nl' },
  { name: 'Google News — Feyenoord', url: 'https://news.google.com/rss/search?q=Feyenoord&hl=nl&gl=NL&ceid=NL:nl' },
];

function tagContent(xml: string, tag: string): string | null {
  const cdata = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i').exec(xml);
  if (cdata) return cdata[1] ?? null;
  const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return plain?.[1] ?? null;
}

/** Atom uses <link href="..."/> where RSS uses <link>...</link>. */
function extractLink(entry: string): string | null {
  const atom = /<link[^>]*\shref=["']([^"']+)["']/i.exec(entry);
  if (atom) return decodeEntities(atom[1]!);
  const rss = tagContent(entry, 'link');
  return rss ? decodeEntities(rss.trim()) : null;
}

function parseDate(entry: string): string {
  const raw =
    tagContent(entry, 'pubDate') ??
    tagContent(entry, 'published') ??
    tagContent(entry, 'updated') ??
    tagContent(entry, 'dc:date');
  if (!raw) return new Date().toISOString();
  const parsed = new Date(raw.trim());
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

export function parseFeed(xml: string, feedName: string): RawDocument[] {
  const entries = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  const documents: RawDocument[] = [];

  for (const entry of entries) {
    const title = tagContent(entry, 'title');
    const link = extractLink(entry);
    if (!title || !link) continue;

    const description =
      tagContent(entry, 'content:encoded') ??
      tagContent(entry, 'description') ??
      tagContent(entry, 'summary') ??
      tagContent(entry, 'content') ??
      '';

    const guid = tagContent(entry, 'guid') ?? tagContent(entry, 'id') ?? link;

    documents.push({
      externalId: `rss:${guid.trim()}`,
      sourceKind: 'news',
      sourceName: feedName,
      url: link,
      title: stripHtml(title),
      body: stripHtml(description),
      author: tagContent(entry, 'dc:creator')?.trim() ?? null,
      publishedAt: parseDate(entry),
      engagement: 0,
      lang: 'nl',
    });
  }

  return documents;
}

export class RssCollector implements Collector {
  readonly id = 'rss';
  readonly kind = 'news' as const;

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async collect(ctx: CollectorContext): Promise<RawDocument[]> {
    const all: RawDocument[] = [];

    for (const feed of FEEDS) {
      try {
        const response = await politeFetch(feed.url);
        if (!response.ok) {
          console.warn(`  ✗ ${feed.name}: HTTP ${response.status}`);
          continue;
        }
        const xml = await response.text();
        const parsed = parseFeed(xml, feed.name).filter(
          (doc) => new Date(doc.publishedAt) >= ctx.since,
        );
        all.push(...parsed);
        console.log(`  ✓ ${feed.name}: ${parsed.length} items`);
      } catch (error) {
        console.warn(`  ✗ ${feed.name}: ${(error as Error).message}`);
      }
    }

    return all;
  }
}
