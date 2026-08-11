import { db } from '../db/index.ts';
import { CLUBS, CLUB_BY_ID, DERBIES } from '../clubs.ts';
import { matchesForClub, currentSeason, type ClubMatch } from '../collectors/fixtures.ts';
import type { ClubId } from '../types.ts';

/** Same weighting as the main query layer: confidence x log-damped engagement. */
const WEIGHT = `(s.confidence * (1.0 + ln(1.0 + MAX(d.engagement, 0))))`;

/** Weighted sentiment for one club inside an arbitrary window. */
export function sentimentBetween(
  club: ClubId,
  fromIso: string,
  toIso: string,
): { score: number; documents: number } {
  const row = db()
    .prepare(
      `SELECT SUM(s.score * ${WEIGHT}) / NULLIF(SUM(${WEIGHT}), 0) AS score,
              COUNT(*) AS documents
         FROM documents d
         JOIN document_clubs dc ON dc.document_id = d.id
         JOIN sentiments s      ON s.document_id  = d.id
        WHERE dc.club = ? AND d.published_at >= ? AND d.published_at < ?`,
    )
    .get(club, fromIso, toIso) as { score: number | null; documents: number };

  return { score: row.score ?? 0, documents: row.documents };
}

function shift(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 3600_000).toISOString();
}

/* ------------------------------------------------------------ league table */

export interface TableRow {
  club: ClubId;
  name: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  sentiment: number;
  documents: number;
}

/**
 * League table with a sentiment column.
 *
 * The interesting reading is the mismatch: a club sitting fourth whose fanbase
 * is at -0.4 is in a different situation from one sitting fourth at +0.3.
 */
export function leagueTable(days = 30, season = currentSeason()): TableRow[] {
  const rows: TableRow[] = [];

  for (const club of CLUBS) {
    const fixtures = matchesForClub(club.id, { season });
    // Promotion and relegation are handled by the data rather than a hardcoded
    // list: a club with no fixtures this season simply is not in this league.
    if (fixtures.length === 0) continue;
    const matches = fixtures.filter((m) => m.outcome !== null);
    const mood = sentimentBetween(
      club.id,
      new Date(Date.now() - days * 864e5).toISOString(),
      new Date().toISOString(),
    );

    const row: TableRow = {
      club: club.id,
      name: club.shortName,
      played: matches.length,
      won: matches.filter((m) => m.outcome === 'win').length,
      drawn: matches.filter((m) => m.outcome === 'draw').length,
      lost: matches.filter((m) => m.outcome === 'loss').length,
      goalsFor: matches.reduce((sum, m) => sum + (m.goalsFor ?? 0), 0),
      goalsAgainst: matches.reduce((sum, m) => sum + (m.goalsAgainst ?? 0), 0),
      points: 0,
      sentiment: Number(mood.score.toFixed(4)),
      documents: mood.documents,
    };
    row.points = row.won * 3 + row.drawn;
    rows.push(row);
  }

  return rows.sort(
    (a, b) =>
      b.points - a.points ||
      b.goalsFor - b.goalsAgainst - (a.goalsFor - a.goalsAgainst) ||
      b.goalsFor - a.goalsFor,
  );
}

/* ------------------------------------------------------- pressure / sacking */

export interface PressureRow {
  club: ClubId;
  name: string;
  /** 0 = comfortable, 100 = fans are calling for the manager's head. */
  index: number;
  band: 'safe' | 'watch' | 'warm' | 'hot' | 'critical';
  coachSentiment: number;
  coachDocuments: number;
  trend: number;
  pointsPerGame: number | null;
  recentForm: string;
  /** Documents behind the sentiment components, so thin data is visible. */
  coverage: number;
}

/**
 * Manager pressure index — the "ontslagbarometer".
 *
 * Three independent signals, because any one on its own is misleading: a bad
 * run of results with calm fans is survivable, and a furious fanbase after one
 * freak defeat usually is too. Sacking risk is when they line up.
 *
 *   50%  sentiment on coach/tactics topics (the direct signal)
 *   30%  overall sentiment trend vs the previous window (is it getting worse?)
 *   20%  points per game across the last five matches
 *
 * This is a mood indicator built from public commentary, not a prediction about
 * any individual's employment, and the dashboard labels it that way.
 */
export function pressureIndex(days = 30): PressureRow[] {
  const now = Date.now();
  const conn = db();
  const season = currentSeason();
  const inLeague = CLUBS.filter((club) => matchesForClub(club.id, { season }).length > 0);

  return (inLeague.length > 0 ? inLeague : CLUBS).map((club) => {
    const coach = conn
      .prepare(
        `SELECT SUM(s.score * ${WEIGHT}) / NULLIF(SUM(${WEIGHT}), 0) AS score,
                COUNT(*) AS documents
           FROM documents d
           JOIN document_clubs dc  ON dc.document_id = d.id
           JOIN sentiments s       ON s.document_id  = d.id
           JOIN document_topics dt ON dt.document_id = d.id
          WHERE dc.club = ? AND dt.topic = 'coach'
            AND d.published_at >= datetime('now', ?)`,
      )
      .get(club.id, `-${days} days`) as { score: number | null; documents: number };

    const current = sentimentBetween(
      club.id,
      new Date(now - days * 864e5).toISOString(),
      new Date(now).toISOString(),
    );
    const previous = sentimentBetween(
      club.id,
      new Date(now - days * 2 * 864e5).toISOString(),
      new Date(now - days * 864e5).toISOString(),
    );

    // Form is read from the current season only — reaching back across a summer
    // break would describe a squad that no longer exists.
    const played = matchesForClub(club.id, { season: currentSeason() }).filter(
      (m) => m.outcome !== null,
    );
    const recent = played.slice(-5);
    const points = recent.reduce(
      (sum, m) => sum + (m.outcome === 'win' ? 3 : m.outcome === 'draw' ? 1 : 0),
      0,
    );
    const pointsPerGame = recent.length ? points / recent.length : null;

    const coachScore = coach.score ?? 0;
    const trend = current.score - previous.score;

    // Each component maps to 0..1 where 1 is maximum pressure.
    const coachComponent = (1 - coachScore) / 2;
    const formComponent = pointsPerGame === null ? 0.5 : 1 - pointsPerGame / 3;

    // A trend computed from a handful of documents is noise, and it was letting
    // thinly-covered clubs top the barometer on the strength of two articles.
    // Below the coverage floor the trend contributes nothing either way.
    const trendIsMeaningful = current.documents >= 8 && previous.documents >= 8;
    const trendComponent = trendIsMeaningful
      ? Math.max(0, Math.min(1, -trend * 2 + 0.5))
      : 0.5;

    // With little or no coach commentary the direct signal is noise, so lean on
    // form and trend instead of pretending the silence means anything.
    const coachWeight = coach.documents >= 3 ? 0.5 : 0.15;
    const rest = 1 - coachWeight;
    const index =
      (coachComponent * coachWeight +
        trendComponent * (0.3 / 0.5) * rest +
        formComponent * (0.2 / 0.5) * rest) *
      100;

    const clamped = Math.max(0, Math.min(100, index));
    const band: PressureRow['band'] =
      clamped >= 80
        ? 'critical'
        : clamped >= 65
          ? 'hot'
          : clamped >= 50
            ? 'warm'
            : clamped >= 35
              ? 'watch'
              : 'safe';

    return {
      club: club.id,
      name: club.shortName,
      index: Number(clamped.toFixed(1)),
      band,
      coachSentiment: Number(coachScore.toFixed(3)),
      coachDocuments: coach.documents,
      trend: trendIsMeaningful ? Number(trend.toFixed(3)) : 0,
      coverage: current.documents,
      pointsPerGame: pointsPerGame === null ? null : Number(pointsPerGame.toFixed(2)),
      recentForm: recent
        .map((m) => (m.outcome === 'win' ? 'W' : m.outcome === 'draw' ? 'G' : 'V'))
        .join(''),
    };
  }).sort((a, b) => b.index - a.index);
}

/* ------------------------------------------------------------- reactivity */

export interface ReactivityRow {
  club: ClubId;
  name: string;
  /** Mean absolute sentiment swing around a match — how reactive the fanbase is. */
  swing: number;
  afterWin: number | null;
  afterDraw: number | null;
  afterLoss: number | null;
  samples: number;
}

/**
 * Do fans overreact?
 *
 * For every match with a result, compares weighted sentiment in the 48 hours
 * after kick-off against the 72 hours before it, then averages those swings by
 * outcome. A fanbase whose mood moves +0.6 after a win and -0.7 after a defeat
 * is measurably more reactive than one that barely moves.
 */
export function reactivity(): ReactivityRow[] {
  const rows: ReactivityRow[] = [];

  for (const club of CLUBS) {
    const swings: Array<{ outcome: NonNullable<ClubMatch['outcome']>; delta: number }> = [];

    for (const match of matchesForClub(club.id)) {
      if (!match.outcome) continue;

      const before = sentimentBetween(club.id, shift(match.playedAt, -72), match.playedAt);
      const after = sentimentBetween(club.id, match.playedAt, shift(match.playedAt, 48));

      // Both sides need enough documents for the comparison to mean anything.
      if (before.documents < 2 || after.documents < 2) continue;
      swings.push({ outcome: match.outcome, delta: after.score - before.score });
    }

    if (swings.length === 0) {
      rows.push({
        club: club.id,
        name: club.shortName,
        swing: 0,
        afterWin: null,
        afterDraw: null,
        afterLoss: null,
        samples: 0,
      });
      continue;
    }

    const mean = (list: number[]) =>
      list.length ? Number((list.reduce((a, b) => a + b, 0) / list.length).toFixed(3)) : null;
    const pick = (outcome: string) =>
      swings.filter((s) => s.outcome === outcome).map((s) => s.delta);

    rows.push({
      club: club.id,
      name: club.shortName,
      swing: Number(
        (swings.reduce((sum, s) => sum + Math.abs(s.delta), 0) / swings.length).toFixed(3),
      ),
      afterWin: mean(pick('win')),
      afterDraw: mean(pick('draw')),
      afterLoss: mean(pick('loss')),
      samples: swings.length,
    });
  }

  // A swing averaged over one match is an anecdote, not a reactivity figure —
  // and it sorts straight to the top, where it reads as the headline. Three is
  // still thin, but it is the point where a single freak result stops
  // dominating; the sample count travels with every row regardless.
  const MIN_SAMPLES = 3;
  return rows.filter((r) => r.samples >= MIN_SAMPLES).sort((a, b) => b.swing - a.swing);
}

/* -------------------------------------------------------------- predictive */

export interface PredictiveRow {
  club: ClubId;
  name: string;
  /** Correlation between pre-match sentiment and points taken, -1..1. */
  correlation: number | null;
  samples: number;
  meanBeforeWin: number | null;
  meanBeforeLoss: number | null;
}

/**
 * Does pre-match mood carry any information about the result?
 *
 * Almost certainly weak, quite possibly zero — the honest answer is the point.
 * Sentiment in the three days before kick-off is correlated against points
 * taken. Reported with the sample count so a correlation from nine matches is
 * not mistaken for a finding.
 */
export function predictive(): PredictiveRow[] {
  const rows: PredictiveRow[] = [];

  for (const club of CLUBS) {
    const pairs: Array<{ mood: number; points: number }> = [];

    for (const match of matchesForClub(club.id)) {
      if (!match.outcome) continue;
      const before = sentimentBetween(club.id, shift(match.playedAt, -72), match.playedAt);
      if (before.documents < 3) continue;
      pairs.push({
        mood: before.score,
        points: match.outcome === 'win' ? 3 : match.outcome === 'draw' ? 1 : 0,
      });
    }

    if (pairs.length < 5) {
      rows.push({
        club: club.id,
        name: club.shortName,
        correlation: null,
        samples: pairs.length,
        meanBeforeWin: null,
        meanBeforeLoss: null,
      });
      continue;
    }

    const meanMood = pairs.reduce((s, p) => s + p.mood, 0) / pairs.length;
    const meanPoints = pairs.reduce((s, p) => s + p.points, 0) / pairs.length;
    let cov = 0;
    let varMood = 0;
    let varPoints = 0;
    for (const p of pairs) {
      cov += (p.mood - meanMood) * (p.points - meanPoints);
      varMood += (p.mood - meanMood) ** 2;
      varPoints += (p.points - meanPoints) ** 2;
    }
    const denominator = Math.sqrt(varMood * varPoints);

    const wins = pairs.filter((p) => p.points === 3).map((p) => p.mood);
    const losses = pairs.filter((p) => p.points === 0).map((p) => p.mood);
    const mean = (list: number[]) =>
      list.length ? Number((list.reduce((a, b) => a + b, 0) / list.length).toFixed(3)) : null;

    rows.push({
      club: club.id,
      name: club.shortName,
      correlation: denominator === 0 ? null : Number((cov / denominator).toFixed(3)),
      samples: pairs.length,
      meanBeforeWin: mean(wins),
      meanBeforeLoss: mean(losses),
    });
  }

  return rows.sort((a, b) => b.samples - a.samples);
}

/* ------------------------------------------------------------------ derby */

export interface DerbyReport {
  id: string;
  name: string;
  clubs: [ClubId, ClubId];
  playedAt: string | null;
  scoreline: string | null;
  sides: Array<{
    club: ClubId;
    name: string;
    before: number;
    after: number;
    swing: number;
    documents: number;
  }>;
}

/**
 * Derby weeks have their own emotional physics — this pulls the most recent
 * meeting for each rivalry and shows both fanbases either side of kick-off.
 */
export function derbies(): DerbyReport[] {
  return DERBIES.map((derby) => {
    const [a, b] = derby.clubs;
    const meetings = matchesForClub(a).filter((m) => m.opponentClub === b);
    const last = meetings.filter((m) => m.outcome !== null).at(-1) ?? meetings.at(-1) ?? null;

    if (!last) {
      return { ...derby, playedAt: null, scoreline: null, sides: [] };
    }

    const sides = derby.clubs.map((club) => {
      const before = sentimentBetween(club, shift(last.playedAt, -72), last.playedAt);
      const after = sentimentBetween(club, last.playedAt, shift(last.playedAt, 48));
      return {
        club,
        name: CLUB_BY_ID.get(club)?.shortName ?? club,
        before: Number(before.score.toFixed(3)),
        after: Number(after.score.toFixed(3)),
        swing: Number((after.score - before.score).toFixed(3)),
        documents: before.documents + after.documents,
      };
    });

    const scoreline =
      last.goalsFor !== null && last.goalsAgainst !== null
        ? `${last.goalsFor}-${last.goalsAgainst}`
        : null;

    return { ...derby, playedAt: last.playedAt, scoreline, sides };
  });
}

/* ------------------------------------------------------------ leaderboards */

export interface WeekRecord {
  club: ClubId;
  name: string;
  weekStart: string;
  score: number;
  documents: number;
}

/**
 * Best and worst weeks on record. Writes its own headlines once there is
 * enough history — "the worst week Ajax has had since collection began".
 */
export function extremeWeeks(limit = 5): { best: WeekRecord[]; worst: WeekRecord[] } {
  const rows = db()
    .prepare(
      `SELECT dc.club AS club,
              date(d.published_at, 'weekday 1', '-7 days') AS weekStart,
              SUM(s.score * ${WEIGHT}) / NULLIF(SUM(${WEIGHT}), 0) AS score,
              COUNT(*) AS documents
         FROM documents d
         JOIN document_clubs dc ON dc.document_id = d.id
         JOIN sentiments s      ON s.document_id  = d.id
        GROUP BY dc.club, weekStart
        HAVING documents >= 5
        ORDER BY score DESC`,
    )
    .all() as Array<{ club: ClubId; weekStart: string; score: number | null; documents: number }>;

  // A week whose documents all scored zero confidence divides by a zero weight,
  // which NULLIF turns into NULL. Such a week is not a "best" or "worst" week —
  // nothing in it was readable — so it is dropped rather than coerced to 0,
  // where it would sit in the middle of the ranking pretending to be neutral.
  const scored = rows.filter(
    (row): row is typeof row & { score: number } => row.score !== null,
  );

  const decorate = (row: (typeof scored)[number]): WeekRecord => ({
    club: row.club,
    name: CLUB_BY_ID.get(row.club)?.shortName ?? row.club,
    weekStart: row.weekStart,
    score: Number(row.score.toFixed(3)),
    documents: row.documents,
  });

  return {
    best: scored.slice(0, limit).map(decorate),
    worst: scored.slice(-limit).reverse().map(decorate),
  };
}

/* ---------------------------------------------------------------- players */

export interface PlayerRow {
  player: string;
  club: ClubId | null;
  clubName: string | null;
  mentions: number;
  score: number;
}

/**
 * Player mention leaderboard.
 *
 * Names are merged on their trailing tokens, because coverage alternates
 * between "Marc ter Stegen" and "ter Stegen" for the same person; the longest
 * observed form becomes the display name. A minimum mention count keeps
 * one-off extraction noise off the board.
 */
export function players(days = 30, club?: ClubId, minMentions = 2): PlayerRow[] {
  const clause = club ? 'AND dp.club = ?' : '';
  const params: unknown[] = [`-${days} days`];
  if (club) params.push(club);

  const rows = db()
    .prepare(
      `SELECT dp.player AS player,
              dp.club   AS club,
              COUNT(*)  AS mentions,
              SUM(s.score * ${WEIGHT}) / NULLIF(SUM(${WEIGHT}), 0) AS score
         FROM document_players dp
         JOIN documents d  ON d.id = dp.document_id
         JOIN sentiments s ON s.document_id = d.id
        WHERE d.published_at >= datetime('now', ?) ${clause}
        GROUP BY dp.player, dp.club`,
    )
    .all(...params) as Array<{
    player: string;
    club: ClubId | null;
    mentions: number;
    score: number | null;
  }>;

  // Merge "ter Stegen" into "Marc ter Stegen": key on the last two tokens.
  const merged = new Map<
    string,
    { display: string; club: ClubId | null; mentions: number; weighted: number }
  >();

  for (const row of rows) {
    const tokens = row.player.split(' ');
    const key = `${row.club ?? ''}:${tokens.slice(-2).join(' ').toLowerCase()}`;
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, {
        display: row.player,
        club: row.club,
        mentions: row.mentions,
        weighted: (row.score ?? 0) * row.mentions,
      });
      continue;
    }

    if (row.player.length > existing.display.length) existing.display = row.player;
    existing.mentions += row.mentions;
    existing.weighted += (row.score ?? 0) * row.mentions;
  }

  return [...merged.values()]
    .filter((entry) => entry.mentions >= minMentions)
    .map((entry) => ({
      player: entry.display,
      club: entry.club,
      clubName: entry.club ? (CLUB_BY_ID.get(entry.club)?.shortName ?? null) : null,
      mentions: entry.mentions,
      score: Number((entry.weighted / entry.mentions).toFixed(3)),
    }))
    .sort((a, b) => b.mentions - a.mentions);
}

/* ----------------------------------------------------------- transfer hype */

export interface TransferHypeRow {
  player: string;
  club: ClubId | null;
  clubName: string | null;
  mentions: number;
  score: number;
}

/**
 * Transfer hype: player mentions restricted to documents tagged with the
 * transfer topic. High mention count plus high sentiment is a fanbase that
 * wants a signing; high mentions with low sentiment is one that dreads it.
 */
export function transferHype(days = 30, limit = 12): TransferHypeRow[] {
  const rows = db()
    .prepare(
      `SELECT dp.player AS player,
              dp.club   AS club,
              COUNT(*)  AS mentions,
              SUM(s.score * ${WEIGHT}) / NULLIF(SUM(${WEIGHT}), 0) AS score
         FROM document_players dp
         JOIN documents d        ON d.id = dp.document_id
         JOIN sentiments s       ON s.document_id = d.id
         JOIN document_topics dt ON dt.document_id = d.id AND dt.topic = 'transfers'
        WHERE d.published_at >= datetime('now', ?)
        GROUP BY dp.player, dp.club
       HAVING mentions >= 2
        ORDER BY mentions DESC
        LIMIT ?`,
    )
    .all(`-${days} days`, limit) as Array<{
    player: string;
    club: ClubId | null;
    mentions: number;
    score: number | null;
  }>;

  return rows.map((row) => ({
    player: row.player,
    club: row.club,
    clubName: row.club ? (CLUB_BY_ID.get(row.club)?.shortName ?? null) : null,
    mentions: row.mentions,
    score: Number((row.score ?? 0).toFixed(3)),
  }));
}

/* -------------------------------------------------------- match annotations */

export interface MatchMarker {
  playedAt: string;
  club: ClubId;
  opponent: string;
  home: boolean;
  outcome: string | null;
  scoreline: string | null;
}

/** Match markers for the timeline, so every spike has an explanation next to it. */
export function matchMarkers(clubs: ClubId[], days: number): MatchMarker[] {
  const since = Date.now() - days * 864e5;
  const markers: MatchMarker[] = [];

  for (const club of clubs) {
    for (const match of matchesForClub(club)) {
      if (new Date(match.playedAt).getTime() < since) continue;
      markers.push({
        playedAt: match.playedAt,
        club,
        opponent: match.opponent,
        home: match.home,
        outcome: match.outcome,
        scoreline:
          match.goalsFor !== null && match.goalsAgainst !== null
            ? `${match.goalsFor}-${match.goalsAgainst}`
            : null,
      });
    }
  }

  return markers.sort((a, b) => a.playedAt.localeCompare(b.playedAt));
}
