import { collectAll } from './pipeline.ts';
import { db, countDocuments } from './db/index.ts';
import { analyzeDocument } from './sentiment/analyzer.ts';
import { detectTopics } from './sentiment/topics.ts';
import { extractPlayers } from './sentiment/players.ts';
import { detectClubs } from './clubs.ts';
import { clubOverview, sourceHealth } from './db/queries.ts';
import { rescoreAmbiguous } from './sentiment/llm.ts';
import { CLUB_BY_ID } from './clubs.ts';
import { collectFixtures, countMatches } from './collectors/fixtures.ts';
import { checkAlerts } from './alerts.ts';
import { backfill } from './collectors/backfill.ts';
import { CLUBS, FEATURED_CLUBS } from './clubs.ts';
import { pressureIndex, leagueTable } from './analysis/index.ts';
import { exportStandalone } from './export.ts';

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
    // Re-runs the whole analysis over already-collected text. Sentiment, topics
    // and player mentions are stored separately from the documents precisely so
    // a lexicon, topic or extractor change can be rolled out over the existing
    // corpus without re-fetching anything.
    const conn = db();
    const documents = conn
      .prepare(`SELECT id, title, body FROM documents`)
      .all() as Array<{ id: number; title: string | null; body: string }>;

    const updateSentiment = conn.prepare(
      `UPDATE sentiments
          SET score = ?, magnitude = ?, label = ?, confidence = ?, drivers = ?,
              ambiguous = ?, method = 'lexicon', scored_at = datetime('now')
        WHERE document_id = ?`,
    );
    const clearTopics = conn.prepare(`DELETE FROM document_topics WHERE document_id = ?`);
    const addTopic = conn.prepare(
      `INSERT OR IGNORE INTO document_topics (document_id, topic) VALUES (?, ?)`,
    );
    const clearPlayers = conn.prepare(`DELETE FROM document_players WHERE document_id = ?`);
    const addPlayer = conn.prepare(
      `INSERT OR IGNORE INTO document_players (document_id, player, club) VALUES (?, ?, ?)`,
    );

    const run = conn.transaction(() => {
      for (const doc of documents) {
        const text = `${doc.title ?? ''}. ${doc.body}`;
        const result = analyzeDocument(doc.title, doc.body);
        updateSentiment.run(
          result.score,
          result.magnitude,
          result.label,
          result.confidence,
          JSON.stringify(result.drivers),
          result.ambiguous ? 1 : 0,
          doc.id,
        );

        clearTopics.run(doc.id);
        for (const topic of detectTopics(text)) addTopic.run(doc.id, topic);

        const clubs = detectClubs(doc.title, doc.body);
        const primaryClub = clubs.find((c) => c.primary)?.club ?? clubs[0]?.club ?? null;
        clearPlayers.run(doc.id);
        for (const name of extractPlayers(text)) addPlayer.run(doc.id, name, primaryClub);
      }
    });
    run();

    console.log(`Re-analysed ${documents.length} documents (sentiment, topics, players).`);
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

  case 'backfill': {
    // Google News answers date-ranged searches, so history can be pulled in one
    // pass rather than waiting weeks for the routine collector to accumulate it.
    const months = flag('months', 6);
    const clubs = args.includes('--all') ? CLUBS : FEATURED_CLUBS;
    await backfill(months, clubs, { onlyIfSparse: args.includes('--if-sparse') });
    break;
  }

  case 'fixtures': {
    console.log('Fetching Eredivisie fixtures and results…');
    await collectFixtures();
    console.log(`\n${countMatches()} matches stored.\n`);
    break;
  }

  case 'alerts': {
    const dryRun = args.includes('--dry-run');
    const fired = await checkAlerts({ dryRun });
    if (fired.length === 0) {
      console.log('No alerts. All clubs within thresholds.');
    } else {
      console.log(`${fired.length} alert(s)${dryRun ? ' (dry run — nothing sent)' : ''}:\n`);
      for (const alert of fired) console.log(`  [${alert.kind}] ${alert.message}`);
    }
    console.log();
    break;
  }

  case 'pressure': {
    const rows = pressureIndex(flag('days', 30));
    console.log('\n  Ontslagbarometer — manager pressure\n');
    console.log(`  ${'Club'.padEnd(12)} ${'Index'.padStart(6)}  ${'Band'.padEnd(9)} ${'Vorm'.padEnd(6)} ${'Coach'.padStart(7)}`);
    console.log(`  ${'─'.repeat(52)}`);
    for (const row of rows.slice(0, 10)) {
      console.log(
        `  ${row.name.padEnd(12)} ${row.index.toFixed(1).padStart(6)}  ${row.band.padEnd(9)} ${(row.recentForm || '—').padEnd(6)} ${row.coachSentiment.toFixed(2).padStart(7)}`,
      );
    }
    console.log('\n  Mood indicator from public commentary — not a prediction about anyone\'s job.\n');
    break;
  }

  case 'table': {
    const rows = leagueTable(flag('days', 30));
    console.log('\n  Eredivisie — stand en stemming\n');
    console.log(`  ${'#'.padStart(2)} ${'Club'.padEnd(12)} ${'G'.padStart(3)} ${'P'.padStart(3)} ${'DV'.padStart(4)} ${'Stemming'.padStart(9)}`);
    console.log(`  ${'─'.repeat(46)}`);
    rows.forEach((row, i) => {
      const diff = row.goalsFor - row.goalsAgainst;
      console.log(
        `  ${String(i + 1).padStart(2)} ${row.name.padEnd(12)} ${String(row.played).padStart(3)} ${String(row.points).padStart(3)} ${String(diff >= 0 ? '+' + diff : diff).padStart(4)} ${(row.documents ? row.sentiment.toFixed(2) : '—').padStart(9)}`,
      );
    });
    console.log();
    break;
  }

  case 'export': {
    const index = args.indexOf('--out');
    const target = index === -1 ? './dist/stemming.html' : (args[index + 1] ?? './dist/stemming.html');
    console.log('Building standalone dashboard…');
    const result = exportStandalone(target);
    const mb = (result.bytes / 1024 / 1024).toFixed(1);
    console.log(`\n✓ ${result.path} (${mb} MB)`);
    console.log('  Open it directly in a browser — no server needed.\n');
    break;
  }

  case 'setup':
  case 'seed': {
    // One command to a working dashboard: fixtures first (they anchor every
    // derived view), then a 30-day window of documents.
    console.log('Setting up — this takes about a minute.\n');
    console.log('▸ fixtures');
    await collectFixtures();
    console.log('\n▸ documents (last 30 days)');
    await collectAll(30);
    console.log(`\n✓ ${countDocuments()} documents, ${countMatches()} matches.`);
    console.log('  Run "npm start" and open http://localhost:8787\n');
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

    npm run setup                   First run: fixtures + a 30-day window
    npm run collect  [--days 7]     Fetch, score and store new documents
    npm run backfill [--months 6]   Pull historical coverage (--all for every club,
                                    --if-sparse to skip when history already exists)
    npm run fixtures                Refresh Eredivisie fixtures and results
    npm run relex                   Re-apply the lexicon to stored documents
    npm run rescore  [--limit 200]  Re-score ambiguous documents with Claude
    npm run stats    [--days 30]    Print current standings
    npm run table    [--days 30]    League table with a sentiment column
    npm run pressure [--days 30]    Manager pressure index
    npm run alerts   [--dry-run]    Check sentiment alerts, fire webhooks
    npm run export   [--out FILE]   Build a standalone single-file dashboard
    npm start                       Serve the dashboard
`);
}
