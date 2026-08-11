import { collectAll } from '../pipeline.ts';
import { collectFixtures, countMatches } from '../collectors/fixtures.ts';
import { countDocuments } from '../db/index.ts';

/**
 * On-demand refresh, driven from the dashboard.
 *
 * Collecting takes tens of seconds and hits a dozen third-party hosts, so this
 * is deliberately single-flight: a second request while one is running joins
 * the run in progress rather than starting another. Without that, an impatient
 * double-click would fan out into concurrent crawls of the same feeds — rude to
 * the publishers and a good way to get rate-limited.
 */

export interface RefreshResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  documentsBefore: number;
  documentsAfter: number;
  newDocuments: number;
  matches: number;
  sources: Array<{ collector: string; inserted: number; skipped: string | null; error: string | null }>;
}

let inFlight: Promise<RefreshResult> | null = null;
let lastRun: RefreshResult | null = null;

export function isRefreshing(): boolean {
  return inFlight !== null;
}

export function lastRefresh(): RefreshResult | null {
  return lastRun;
}

export function refresh(days = 7): Promise<RefreshResult> {
  if (inFlight) return inFlight;

  const startedAt = new Date();
  const documentsBefore = countDocuments();

  inFlight = (async () => {
    // Fixtures first: they are cheap, and every match-anchored view depends on
    // them being current before the new documents are scored against them.
    await collectFixtures();
    const summaries = await collectAll(days);
    const finishedAt = new Date();

    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      documentsBefore,
      documentsAfter: countDocuments(),
      newDocuments: countDocuments() - documentsBefore,
      matches: countMatches(),
      sources: summaries.map((s) => ({
        collector: s.collector,
        inserted: s.inserted,
        skipped: s.skipped,
        error: s.error,
      })),
    };
  })();

  return inFlight
    .then((result) => {
      lastRun = result;
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
}
