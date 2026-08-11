import { collectAll } from './pipeline.ts';
import { db, countDocuments } from './db/index.ts';
import { analyzeDocument } from './sentiment/analyzer.ts';
import { clubOverview, sourceHealth } from './db/queries.ts';
import { rescoreAmbiguous } from './sentiment/llm.ts';
import { CLUB_BY_ID } from './clubs.ts';

const [command = 'help', ...args] = process.argv.slice(2);

function flag(name: string, fallback: number): number {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return Number(args[index + 1] ?? fallback);
}

function bar(score: number, width = 24): string {
  const position = Math.round(((score + 1) / 2) * width);
  return `${'·'.repeat(position)}▓${'·'.repeat(Math.max(0, width - position))}`;
}

switch (command) {
  case 'collect': {
    const days = flag('days', 7);
    console.log(`Collecting the last ${days} days…`);
    const summaries = await collectAll(days);
    const inserted = summaries.reduce((sum, s) => sum + s.inserted, 0);
    console.log(`\n${inserted} new documents. ${countDocuments()} total.\n`);
    break;
  }

  case 'rescore': {
    const limit = flag('limit', 200);
    await rescoreAmbiguous(limit);
    break;
  }

  case 'relex': {
    // Re-applies the lexicon to already-collected text. Sentiment is stored
    // separately from documents precisely so a lexicon or analyzer change can
    // be rolled out over the existing corpus without re-fetching anything.
    const conn = db();
    const documents = conn
      .prepare(`SELECT id, title, body FROM documents`)
      .all() as Array<{ id: number; title: string | null; body: string }>;

    const update = conn.prepare(
      `UPDATE sentiments
          SET score = ?, magnitude = ?, label = ?, confidence = ?, drivers = ?,
              ambiguous = ?, method = 'lexicon', scored_at = datetime('now')
        WHERE document_id = ?`,
    );

    const run = conn.transaction(() => {
      for (const doc of documents) {
        const result = analyzeDocument(doc.title, doc.body);
        update.run(
          result.score,
          result.magnitude,
          result.label,
          result.confidence,
          JSON.stringify(result.drivers),
          result.ambiguous ? 1 : 0,
          doc.id,
        );
      }
    });
    run();

    console.log(`Re-scored ${documents.length} documents with the current lexicon.`);
    break;
  }

  case 'stats': {
    const days = flag('days', 30);
    const overview = clubOverview({ days });

    console.log(`\n  Sentiment, last ${days} days\n`);
    console.log(`  ${'Club'.padEnd(12)} ${'Score'.padStart(7)}  ${'Mood'.padEnd(26)} ${'Docs'.padStart(6)} ${'Δ'.padStart(7)}`);
    console.log(`  ${'─'.repeat(64)}`);

    for (const row of overview.sort((a, b) => b.score - a.score)) {
      const club = CLUB_BY_ID.get(row.club);
      const delta = row.delta >= 0 ? `+${row.delta.toFixed(2)}` : row.delta.toFixed(2);
      console.log(
        `  ${(club?.shortName ?? row.club).padEnd(12)} ${row.score.toFixed(3).padStart(7)}  ${bar(row.score)} ${String(row.documents).padStart(6)} ${delta.padStart(7)}`,
      );
    }

    console.log(`\n  Sources\n`);
    for (const source of sourceHealth(days).slice(0, 15)) {
      console.log(
        `  ${source.sourceName.padEnd(28)} ${String(source.documents).padStart(5)} docs  ${source.score.toFixed(3).padStart(7)}`,
      );
    }
    console.log();
    break;
  }

  case 'seed': {
    // Convenience for a first run: collect a wider window so the charts have
    // something to show immediately.
    console.log('Seeding with the last 30 days…');
    await collectAll(30);
    console.log(`\n${countDocuments()} documents.\n`);
    break;
  }

  case 'reset': {
    db().exec(`DELETE FROM documents;`);
    console.log('Documents cleared.');
    break;
  }

  default:
    console.log(`
  SoccerSentimentTracker

    npm run collect  [--days 7]     Fetch, score and store new documents
    npm run seed                    First run: collect a 30-day window
    npm run relex                   Re-apply the lexicon to stored documents
    npm run rescore  [--limit 200]  Re-score ambiguous documents with Claude
    npm run stats    [--days 30]    Print current standings
    npm start                       Serve the dashboard
`);
}
