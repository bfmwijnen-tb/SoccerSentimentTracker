import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, ensureDataDir } from '../config.ts';
import type { ClubId, RawDocument, SentimentResult, TopicId } from '../types.ts';

const here = dirname(fileURLToPath(import.meta.url));

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (instance) return instance;
  ensureDataDir();
  instance = new Database(config.dbPath);
  instance.pragma('journal_mode = WAL');
  instance.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return instance;
}

export interface StoredDocumentInput {
  doc: RawDocument;
  clubs: Array<{ club: ClubId; primary: boolean }>;
  sentiment: SentimentResult & { ambiguous: boolean };
  topics: TopicId[];
}

/**
 * Inserts a document with its clubs, sentiment and topics.
 * Returns false when the document was already present (feeds repeat items).
 */
export function insertDocument(input: StoredDocumentInput): boolean {
  const conn = db();
  const run = conn.transaction((data: StoredDocumentInput) => {
    const result = conn
      .prepare(
        `INSERT OR IGNORE INTO documents
           (external_id, source_kind, source_name, url, title, body, author, published_at, engagement, lang)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.doc.externalId,
        data.doc.sourceKind,
        data.doc.sourceName,
        data.doc.url,
        data.doc.title,
        data.doc.body,
        data.doc.author,
        data.doc.publishedAt,
        data.doc.engagement,
        data.doc.lang,
      );

    if (result.changes === 0) return false;
    const documentId = Number(result.lastInsertRowid);

    const clubStmt = conn.prepare(
      `INSERT OR IGNORE INTO document_clubs (document_id, club, is_primary) VALUES (?, ?, ?)`,
    );
    for (const { club, primary } of data.clubs) clubStmt.run(documentId, club, primary ? 1 : 0);

    conn
      .prepare(
        `INSERT INTO sentiments
           (document_id, score, magnitude, label, method, confidence, drivers, ambiguous)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        documentId,
        data.sentiment.score,
        data.sentiment.magnitude,
        data.sentiment.label,
        data.sentiment.method,
        data.sentiment.confidence,
        JSON.stringify(data.sentiment.drivers),
        data.sentiment.ambiguous ? 1 : 0,
      );

    const topicStmt = conn.prepare(
      `INSERT OR IGNORE INTO document_topics (document_id, topic) VALUES (?, ?)`,
    );
    for (const topic of data.topics) topicStmt.run(documentId, topic);

    return true;
  });

  return run(input);
}

export function startRun(collectorId: string): number {
  const result = db()
    .prepare(`INSERT INTO collector_runs (collector_id, started_at) VALUES (?, datetime('now'))`)
    .run(collectorId);
  return Number(result.lastInsertRowid);
}

export function finishRun(
  runId: number,
  stats: { fetched: number; inserted: number; error?: string },
): void {
  db()
    .prepare(
      `UPDATE collector_runs
          SET finished_at = datetime('now'), fetched = ?, inserted = ?, error = ?
        WHERE id = ?`,
    )
    .run(stats.fetched, stats.inserted, stats.error ?? null, runId);
}

export function countDocuments(): number {
  const row = db().prepare(`SELECT COUNT(*) AS n FROM documents`).get() as { n: number };
  return row.n;
}
