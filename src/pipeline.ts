import { COLLECTORS } from './collectors/index.ts';
import { throttle } from './collectors/http.ts';
import { detectClubs } from './clubs.ts';
import { analyzeDocument } from './sentiment/analyzer.ts';
import { detectTopics } from './sentiment/topics.ts';
import { extractPlayers } from './sentiment/players.ts';
import { insertDocument, startRun, finishRun } from './db/index.ts';
import type { CollectorContext } from './types.ts';

export interface CollectSummary {
  collector: string;
  fetched: number;
  relevant: number;
  inserted: number;
  skipped: string | null;
  error: string | null;
}

/**
 * Runs every configured collector, attributes documents to clubs, scores them
 * and stores them.
 *
 * Documents that mention no tracked club are discarded here rather than stored:
 * a general sport feed is ~85% noise for this project, and keeping it would
 * bloat the database without ever being queried.
 */
export async function collectAll(sinceDays = 7): Promise<CollectSummary[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const ctx: CollectorContext = { userAgent: '', throttle, since };
  const summaries: CollectSummary[] = [];

  for (const collector of COLLECTORS) {
    if (!collector.isConfigured()) {
      const reason = collector.unavailableReason();
      console.log(`\n▸ ${collector.id} — skipped: ${reason}`);
      summaries.push({
        collector: collector.id,
        fetched: 0,
        relevant: 0,
        inserted: 0,
        skipped: reason,
        error: null,
      });
      continue;
    }

    console.log(`\n▸ ${collector.id}`);
    const runId = startRun(collector.id);
    let fetched = 0;
    let relevant = 0;
    let inserted = 0;

    try {
      const documents = await collector.collect(ctx);
      fetched = documents.length;

      for (const doc of documents) {
        const clubs = detectClubs(doc.title, doc.body);
        if (clubs.length === 0) continue;
        relevant += 1;

        const text = `${doc.title ?? ''}. ${doc.body}`;
        const sentiment = analyzeDocument(doc.title, doc.body);
        const topics = detectTopics(text);
        // Attribute players to the document's primary club so a leaderboard can
        // be scoped per club without re-reading the text.
        const primaryClub = clubs.find((c) => c.primary)?.club ?? clubs[0]?.club ?? null;
        const players = extractPlayers(text).map((name) => ({ name, club: primaryClub }));

        if (insertDocument({ doc, clubs, sentiment, topics, players })) inserted += 1;
      }

      finishRun(runId, { fetched, inserted });
      console.log(`  → ${fetched} fetched, ${relevant} club-relevant, ${inserted} new`);
      summaries.push({
        collector: collector.id,
        fetched,
        relevant,
        inserted,
        skipped: null,
        error: null,
      });
    } catch (error) {
      const message = (error as Error).message;
      finishRun(runId, { fetched, inserted, error: message });
      console.error(`  ✗ ${collector.id} failed: ${message}`);
      summaries.push({
        collector: collector.id,
        fetched,
        relevant,
        inserted,
        skipped: null,
        error: message,
      });
    }
  }

  return summaries;
}
