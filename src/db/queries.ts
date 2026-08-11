import { db } from './index.ts';
import type { ClubId, TopicId } from '../types.ts';

/**
 * Weighted sentiment.
 *
 * A plain average treats a throwaway one-line comment and a widely-upvoted
 * verdict as equal, and treats a document the analyzer barely understood as
 * equal to one it read confidently. The weight below corrects both:
 *
 *   weight = confidence * (1 + ln(1 + engagement))
 *
 * The logarithm matters — engagement on social platforms is power-law
 * distributed, so a linear weight would let one viral post dictate a club's
 * entire daily mood.
 */
const WEIGHT_SQL = `(s.confidence * (1.0 + ln(1.0 + MAX(d.engagement, 0))))`;

export interface Filters {
  days: number;
  clubs?: ClubId[];
  sourceKinds?: string[];
  /** Only count documents where the club is the subject, not a passing mention. */
  primaryOnly?: boolean;
  minConfidence?: number;
}

function buildWhere(filters: Filters): { sql: string; params: unknown[] } {
  const clauses = [`d.published_at >= datetime('now', ?)`];
  const params: unknown[] = [`-${filters.days} days`];

  if (filters.clubs?.length) {
    clauses.push(`dc.club IN (${filters.clubs.map(() => '?').join(',')})`);
    params.push(...filters.clubs);
  }
  if (filters.sourceKinds?.length) {
    clauses.push(`d.source_kind IN (${filters.sourceKinds.map(() => '?').join(',')})`);
    params.push(...filters.sourceKinds);
  }
  if (filters.primaryOnly) clauses.push(`dc.is_primary = 1`);
  if (filters.minConfidence !== undefined) {
    clauses.push(`s.confidence >= ?`);
    params.push(filters.minConfidence);
  }

  return { sql: clauses.join(' AND '), params };
}

export interface ClubOverview {
  club: ClubId;
  score: number;
  documents: number;
  positive: number;
  neutral: number;
  negative: number;
  /** Change against the immediately preceding window of equal length. */
  delta: number;
  /** Standard deviation of daily scores — how reactive the fanbase is. */
  volatility: number;
}

export function clubOverview(filters: Filters): ClubOverview[] {
  const conn = db();
  const { sql, params } = buildWhere(filters);

  const rows = conn
    .prepare(
      `SELECT dc.club                                            AS club,
              SUM(s.score * ${WEIGHT_SQL}) / SUM(${WEIGHT_SQL})  AS score,
              COUNT(*)                                           AS documents,
              SUM(CASE WHEN s.score >=  0.15 THEN 1 ELSE 0 END)  AS positive,
              SUM(CASE WHEN s.score >  -0.15 AND s.score < 0.15 THEN 1 ELSE 0 END) AS neutral,
              SUM(CASE WHEN s.score <= -0.15 THEN 1 ELSE 0 END)  AS negative
         FROM documents d
         JOIN document_clubs dc ON dc.document_id = d.id
         JOIN sentiments s      ON s.document_id  = d.id
        WHERE ${sql}
        GROUP BY dc.club`,
    )
    .all(...params) as Array<Omit<ClubOverview, 'delta' | 'volatility'>>;

  // Previous window, for the delta.
  const previous = conn
    .prepare(
      `SELECT dc.club                                           AS club,
              SUM(s.score * ${WEIGHT_SQL}) / SUM(${WEIGHT_SQL}) AS score
         FROM documents d
         JOIN document_clubs dc ON dc.document_id = d.id
         JOIN sentiments s      ON s.document_id  = d.id
        WHERE d.published_at >= datetime('now', ?)
          AND d.published_at <  datetime('now', ?)
        GROUP BY dc.club`,
    )
    .all(`-${filters.days * 2} days`, `-${filters.days} days`) as Array<{
    club: ClubId;
    score: number;
  }>;

  const previousByClub = new Map(previous.map((row) => [row.club, row.score ?? 0]));

  const daily = dailyScores(filters);

  return rows.map((row) => {
    const series = daily.filter((point) => point.club === row.club).map((point) => point.score);
    const mean = series.reduce((sum, value) => sum + value, 0) / (series.length || 1);
    const variance =
      series.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (series.length || 1);

    return {
      ...row,
      score: Number((row.score ?? 0).toFixed(4)),
      delta: Number(((row.score ?? 0) - (previousByClub.get(row.club) ?? 0)).toFixed(4)),
      volatility: Number(Math.sqrt(variance).toFixed(4)),
    };
  });
}

export interface TimePoint {
  bucket: string;
  club: ClubId;
  score: number;
  documents: number;
}

export function dailyScores(filters: Filters): TimePoint[] {
  const { sql, params } = buildWhere(filters);
  return db()
    .prepare(
      `SELECT date(d.published_at)                              AS bucket,
              dc.club                                           AS club,
              SUM(s.score * ${WEIGHT_SQL}) / SUM(${WEIGHT_SQL})  AS score,
              COUNT(*)                                          AS documents
         FROM documents d
         JOIN document_clubs dc ON dc.document_id = d.id
         JOIN sentiments s      ON s.document_id  = d.id
        WHERE ${sql}
        GROUP BY bucket, dc.club
        ORDER BY bucket ASC`,
    )
    .all(...params)
    .map((row) => {
      const point = row as TimePoint;
      return { ...point, score: Number((point.score ?? 0).toFixed(4)) };
    });
}

export interface TopicBreakdown {
  topic: TopicId;
  club: ClubId;
  score: number;
  documents: number;
}

export function topicBreakdown(filters: Filters): TopicBreakdown[] {
  const { sql, params } = buildWhere(filters);
  return db()
    .prepare(
      `SELECT dt.topic                                          AS topic,
              dc.club                                           AS club,
              SUM(s.score * ${WEIGHT_SQL}) / SUM(${WEIGHT_SQL})  AS score,
              COUNT(*)                                          AS documents
         FROM documents d
         JOIN document_clubs dc  ON dc.document_id = d.id
         JOIN sentiments s       ON s.document_id  = d.id
         JOIN document_topics dt ON dt.document_id = d.id
        WHERE ${sql}
        GROUP BY dt.topic, dc.club
        HAVING documents >= 2
        ORDER BY documents DESC`,
    )
    .all(...params)
    .map((row) => {
      const point = row as TopicBreakdown;
      return { ...point, score: Number((point.score ?? 0).toFixed(4)) };
    });
}

export interface FeedItem {
  id: number;
  title: string | null;
  body: string;
  url: string;
  sourceName: string;
  sourceKind: string;
  author: string | null;
  publishedAt: string;
  engagement: number;
  score: number;
  label: string;
  confidence: number;
  ambiguous: number;
  method: string;
  drivers: string;
  clubs: string;
  topics: string;
}

export function recentDocuments(filters: Filters, limit = 60, offset = 0): FeedItem[] {
  const { sql, params } = buildWhere(filters);
  return db()
    .prepare(
      `SELECT d.id, d.title, d.body, d.url,
              d.source_name AS sourceName, d.source_kind AS sourceKind,
              d.author, d.published_at AS publishedAt, d.engagement,
              s.score, s.label, s.confidence, s.ambiguous, s.method, s.drivers,
              (SELECT group_concat(club)  FROM document_clubs  WHERE document_id = d.id) AS clubs,
              (SELECT group_concat(topic) FROM document_topics WHERE document_id = d.id) AS topics
         FROM documents d
         JOIN document_clubs dc ON dc.document_id = d.id
         JOIN sentiments s      ON s.document_id  = d.id
        WHERE ${sql}
        GROUP BY d.id
        ORDER BY d.published_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as FeedItem[];
}

/**
 * The documents that moved a club's number the most — the "why is Ajax at -0.4
 * this week" answer. Ranked by weighted contribution, not raw score, so a
 * furious comment nobody read does not outrank a widely-shared verdict.
 */
export function drivingDocuments(
  filters: Filters,
  direction: 'positive' | 'negative',
  limit = 5,
): FeedItem[] {
  const { sql, params } = buildWhere(filters);
  const comparison = direction === 'positive' ? 's.score > 0.15' : 's.score < -0.15';
  const order = direction === 'positive' ? 'DESC' : 'ASC';

  return db()
    .prepare(
      `SELECT d.id, d.title, d.body, d.url,
              d.source_name AS sourceName, d.source_kind AS sourceKind,
              d.author, d.published_at AS publishedAt, d.engagement,
              s.score, s.label, s.confidence, s.ambiguous, s.method, s.drivers,
              (SELECT group_concat(club)  FROM document_clubs  WHERE document_id = d.id) AS clubs,
              (SELECT group_concat(topic) FROM document_topics WHERE document_id = d.id) AS topics
         FROM documents d
         JOIN document_clubs dc ON dc.document_id = d.id
         JOIN sentiments s      ON s.document_id  = d.id
        WHERE ${sql} AND ${comparison}
        GROUP BY d.id
        ORDER BY (s.score * ${WEIGHT_SQL}) ${order}
        LIMIT ?`,
    )
    .all(...params, limit) as FeedItem[];
}

export interface SourceHealth {
  sourceKind: string;
  sourceName: string;
  documents: number;
  score: number;
  lastSeen: string;
}

export function sourceHealth(days = 30): SourceHealth[] {
  return db()
    .prepare(
      `SELECT d.source_kind AS sourceKind,
              d.source_name AS sourceName,
              COUNT(*)      AS documents,
              AVG(s.score)  AS score,
              MAX(d.published_at) AS lastSeen
         FROM documents d
         JOIN sentiments s ON s.document_id = d.id
        WHERE d.published_at >= datetime('now', ?)
        GROUP BY d.source_kind, d.source_name
        ORDER BY documents DESC`,
    )
    .all(`-${days} days`)
    .map((row) => {
      const health = row as SourceHealth;
      return { ...health, score: Number((health.score ?? 0).toFixed(4)) };
    });
}

/**
 * Media tone versus fan reaction for the same club and window.
 *
 * This is the comparison the project exists to make: press coverage is written
 * to be measured, fan reaction is not, and the gap between them is often the
 * most interesting number on the dashboard. A club whose press is calm while
 * its fans are furious is in a different situation from one where both agree.
 */
export interface Divergence {
  club: ClubId;
  mediaScore: number;
  fanScore: number;
  gap: number;
  mediaDocuments: number;
  fanDocuments: number;
}

export function mediaVsFans(days: number): Divergence[] {
  const rows = db()
    .prepare(
      `SELECT dc.club AS club,
              CASE WHEN d.source_kind = 'news' THEN 'media' ELSE 'fans' END AS side,
              SUM(s.score * ${WEIGHT_SQL}) / SUM(${WEIGHT_SQL}) AS score,
              COUNT(*) AS documents
         FROM documents d
         JOIN document_clubs dc ON dc.document_id = d.id
         JOIN sentiments s      ON s.document_id  = d.id
        WHERE d.published_at >= datetime('now', ?)
        GROUP BY dc.club, side`,
    )
    .all(`-${days} days`) as Array<{
    club: ClubId;
    side: 'media' | 'fans';
    score: number;
    documents: number;
  }>;

  const byClub = new Map<ClubId, Divergence>();
  for (const row of rows) {
    const entry = byClub.get(row.club) ?? {
      club: row.club,
      mediaScore: 0,
      fanScore: 0,
      gap: 0,
      mediaDocuments: 0,
      fanDocuments: 0,
    };
    if (row.side === 'media') {
      entry.mediaScore = Number((row.score ?? 0).toFixed(4));
      entry.mediaDocuments = row.documents;
    } else {
      entry.fanScore = Number((row.score ?? 0).toFixed(4));
      entry.fanDocuments = row.documents;
    }
    byClub.set(row.club, entry);
  }

  return [...byClub.values()].map((entry) => ({
    ...entry,
    gap: Number((entry.fanScore - entry.mediaScore).toFixed(4)),
  }));
}
