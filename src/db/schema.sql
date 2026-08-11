-- SoccerSentimentTracker storage schema.
--
-- Design notes:
--  * documents.external_id is UNIQUE so re-running a collector is idempotent —
--    feeds repeat the same items on every poll.
--  * club attribution is a join table, not a column: a match report about the
--    Klassieker is genuinely about two clubs and must count for both.
--  * sentiment lives in its own table so scores can be recomputed (a lexicon
--    change, or the LLM pass) without touching collected text.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id   TEXT    NOT NULL UNIQUE,
  source_kind   TEXT    NOT NULL,
  source_name   TEXT    NOT NULL,
  url           TEXT    NOT NULL,
  title         TEXT,
  body          TEXT    NOT NULL,
  author        TEXT,
  published_at  TEXT    NOT NULL,
  collected_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  engagement    INTEGER NOT NULL DEFAULT 0,
  lang          TEXT    NOT NULL DEFAULT 'nl'
);

CREATE INDEX IF NOT EXISTS idx_documents_published ON documents (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_kind      ON documents (source_kind);

CREATE TABLE IF NOT EXISTS document_clubs (
  document_id INTEGER NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  club        TEXT    NOT NULL,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (document_id, club)
);

CREATE INDEX IF NOT EXISTS idx_document_clubs_club ON document_clubs (club);

CREATE TABLE IF NOT EXISTS sentiments (
  document_id INTEGER PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
  score       REAL    NOT NULL,
  magnitude   REAL    NOT NULL,
  label       TEXT    NOT NULL,
  method      TEXT    NOT NULL,
  confidence  REAL    NOT NULL,
  drivers     TEXT    NOT NULL DEFAULT '[]',
  ambiguous   INTEGER NOT NULL DEFAULT 0,
  scored_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sentiments_ambiguous ON sentiments (ambiguous, method);

CREATE TABLE IF NOT EXISTS document_topics (
  document_id INTEGER NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  topic       TEXT    NOT NULL,
  PRIMARY KEY (document_id, topic)
);

CREATE INDEX IF NOT EXISTS idx_document_topics_topic ON document_topics (topic);

-- Observability for the collectors: which source produced how much, and which
-- ones are quietly failing. Surfaced on the dashboard's source-health panel.
CREATE TABLE IF NOT EXISTS collector_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  collector_id TEXT    NOT NULL,
  started_at   TEXT    NOT NULL,
  finished_at  TEXT,
  fetched      INTEGER NOT NULL DEFAULT 0,
  inserted     INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_collector_runs_started ON collector_runs (started_at DESC);
