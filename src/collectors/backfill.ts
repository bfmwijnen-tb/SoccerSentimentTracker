import { politeFetch } from './http.ts';
import { parseFeed } from './rss.ts';
import { detectClubs, CLUBS, FEATURED_CLUBS, type Club } from '../clubs.ts';
import { analyzeDocument } from '../sentiment/analyzer.ts';
import { detectTopics } from '../sentiment/topics.ts';
import { extractPlayers } from '../sentiment/players.ts';
import { insertDocument, countDocuments, db } from '../db/index.ts';

/**
 * Historical backfill.
 *
 * Ordinary RSS feeds carry a day or two, so a fresh install shows a timeline
 * that is 90% last-week and a thin scattering before it — technically a month
 * of coverage, but not enough per day to plot a trend against.
 *
 * Google News search accepts `after:` and `before:` operators and answers with
 * up to 100 items per query, so walking backwards a month at a time builds a
 * real history in one pass. This is the same public feed the normal collector
 * reads; only the query changes.
 *
 * It is a separate command rather than part of `collect` because it is a
 * one-off: once the history exists, the routine collector keeps it current, and
 * re-running the backfill would re-request months that are already stored.
 */

const SEARCH = 'https://news.google.com/rss/search';

function monthWindows(months: number, now = new Date()): Array<{ from: string; to: string }> {
  const windows: Array<{ from: string; to: string }> = [];

  for (let back = 0; back < months; back += 1) {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 1));
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    windows.push({ from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) });
  }

  return windows;
}

export interface BackfillResult {
  queries: number;
  fetched: number;
  relevant: number;
  inserted: number;
  failures: number;
}

/** Distinct days of coverage already stored — the test for "do we need this". */
export function coveredDays(): number {
  const row = db()
    .prepare(`SELECT COUNT(DISTINCT date(published_at)) AS n FROM documents`)
    .get() as { n: number };
  return row.n;
}

export async function backfill(
  months = 6,
  clubs: Club[] = FEATURED_CLUBS,
  options: { onlyIfSparse?: boolean } = {},
): Promise<BackfillResult | null> {
  // Backfilling is a one-off. Re-running it re-requests months that are already
  // stored, which is wasteful and rude to the source, so an automated caller
  // can ask for it to happen only when there is not already a history worth
  // plotting.
  if (options.onlyIfSparse) {
    const days = coveredDays();
    const wanted = months * 25;
    if (days >= wanted) {
      console.log(`Already ${days} days of coverage — skipping backfill.`);
      return null;
    }
    console.log(`Only ${days} days of coverage; backfilling.`);
  }

  const windows = monthWindows(months);
  const result: BackfillResult = { queries: 0, fetched: 0, relevant: 0, inserted: 0, failures: 0 };

  console.log(
    `Backfilling ${months} month(s) for ${clubs.map((c) => c.shortName).join(', ')} ` +
      `— ${clubs.length * windows.length} queries, roughly ${Math.ceil((clubs.length * windows.length * 1.3) / 60)} min.\n`,
  );

  for (const window of windows) {
    let monthInserted = 0;

    for (const club of clubs) {
      // The club's own name plus "voetbal" keeps the query on football without
      // narrowing it to one outlet's phrasing.
      const query = `${club.shortName} voetbal after:${window.from} before:${window.to}`;
      const url = `${SEARCH}?q=${encodeURIComponent(query)}&hl=nl&gl=NL&ceid=NL:nl`;
      result.queries += 1;

      try {
        const response = await politeFetch(url);
        if (!response.ok) {
          result.failures += 1;
          continue;
        }

        const documents = parseFeed(await response.text(), `Google News — ${club.shortName}`);
        result.fetched += documents.length;

        for (const doc of documents) {
          const matched = detectClubs(doc.title, doc.body);
          if (matched.length === 0) continue;
          result.relevant += 1;

          const text = `${doc.title ?? ''}. ${doc.body}`;
          const primaryClub = matched.find((c) => c.primary)?.club ?? matched[0]?.club ?? null;

          const stored = insertDocument({
            doc,
            clubs: matched,
            sentiment: analyzeDocument(doc.title, doc.body),
            topics: detectTopics(text),
            players: extractPlayers(text).map((name) => ({ name, club: primaryClub })),
          });
          if (stored) {
            result.inserted += 1;
            monthInserted += 1;
          }
        }
      } catch (error) {
        result.failures += 1;
        console.warn(`  ✗ ${club.shortName} ${window.from}: ${(error as Error).message}`);
      }
    }

    console.log(`  ✓ ${window.from.slice(0, 7)}: ${monthInserted} new`);
  }

  console.log(
    `\n${result.inserted} new documents from ${result.queries} queries ` +
      `(${result.fetched} fetched, ${result.relevant} club-relevant, ${result.failures} failed).`,
  );
  console.log(`${countDocuments()} documents total.\n`);

  return result;
}

export { CLUBS };
