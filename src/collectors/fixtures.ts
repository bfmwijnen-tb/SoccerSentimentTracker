import { politeFetch } from './http.ts';
import { db } from '../db/index.ts';
import { CLUB_BY_FIXTURE_NAME } from '../clubs.ts';
import type { ClubId } from '../types.ts';

/**
 * Eredivisie fixtures and results, from the openfootball dataset.
 *
 * This is the keystone of every derived metric in src/analysis/: sentiment on
 * its own shows a dip without explaining it, and a match day is the explanation
 * roughly nine times out of ten. It is a plain JSON file on a CDN — no API key,
 * no rate limit, no terms to accept.
 */
const OPENFOOTBALL = 'https://raw.githubusercontent.com/openfootball/football.json/master';

/**
 * ESPN's public scoreboard. This is the primary source, because openfootball
 * publishes a season only once it is well underway — during August it still had
 * nothing for 2026-27, which left the league table, the pressure barometer and
 * every form figure showing last season months after it ended. ESPN carries the
 * full fixture list from the day it is announced, results included.
 */
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer/ned.1/scoreboard';

interface OpenFootballMatch {
  round?: string;
  date: string;
  time?: string;
  team1: string;
  team2: string;
  score?: { ft?: [number, number]; ht?: [number, number] };
}

/** Seasons run Aug–May, so before August the current season started last year. */
export function currentSeason(now = new Date()): string {
  const year = now.getUTCFullYear();
  const startYear = now.getUTCMonth() >= 7 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

interface EspnEvent {
  date: string;
  competitions?: Array<{
    status?: { type?: { completed?: boolean } };
    competitors?: Array<{
      homeAway?: string;
      score?: string;
      team?: { displayName?: string; shortDisplayName?: string };
    }>;
  }>;
}

/** Season bounds: Eredivisie runs August to late May. */
function seasonWindow(season: string): { from: string; to: string } {
  const start = Number(season.slice(0, 4));
  return { from: `${start}0701`, to: `${start + 1}0630` };
}

/**
 * Pulls one season from ESPN. Returns the number of matches stored, or null if
 * the source could not be used at all, so the caller can fall back.
 */
async function collectFromEspn(season: string): Promise<number | null> {
  const { from, to } = seasonWindow(season);

  try {
    const response = await politeFetch(`${ESPN}?dates=${from}-${to}&limit=1000`);
    if (!response.ok) return null;

    const payload = (await response.json()) as { events?: EspnEvent[] };
    const events = payload.events ?? [];
    if (events.length === 0) return null;

    const conn = db();
    const insert = conn.prepare(
      `INSERT OR REPLACE INTO matches
         (season, round, played_at, home_club, away_club, home_name, away_name, home_goals, away_goals)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let stored = 0;

    const run = conn.transaction(() => {
      for (const event of events) {
        const competition = event.competitions?.[0];
        const competitors = competition?.competitors ?? [];
        const home = competitors.find((c) => c.homeAway === 'home');
        const away = competitors.find((c) => c.homeAway === 'away');
        if (!home?.team?.displayName || !away?.team?.displayName) continue;

        // A fixture that has not been played yet still belongs in the table —
        // it just carries no score, which keeps upcoming matches available for
        // the timeline without inventing a result.
        const played = competition?.status?.type?.completed === true;
        const homeGoals = played ? Number(home.score ?? NaN) : NaN;
        const awayGoals = played ? Number(away.score ?? NaN) : NaN;

        insert.run(
          season,
          null,
          new Date(event.date).toISOString(),
          CLUB_BY_FIXTURE_NAME.get(home.team.displayName) ?? null,
          CLUB_BY_FIXTURE_NAME.get(away.team.displayName) ?? null,
          home.team.displayName,
          away.team.displayName,
          Number.isFinite(homeGoals) ? homeGoals : null,
          Number.isFinite(awayGoals) ? awayGoals : null,
        );
        stored += 1;
      }
    });

    run();
    return stored;
  } catch {
    return null;
  }
}

export async function collectFixtures(seasons?: string[]): Promise<number> {
  // Default to this season plus last: the previous season provides the history
  // the reactivity and predictive views need before the new one has any data.
  const targets = seasons ?? [currentSeason(), previousSeason(currentSeason())];
  const conn = db();

  const insert = conn.prepare(
    `INSERT OR REPLACE INTO matches
       (season, round, played_at, home_club, away_club, home_name, away_name, home_goals, away_goals)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let stored = 0;

  for (const season of targets) {
    const viaEspn = await collectFromEspn(season);
    if (viaEspn !== null && viaEspn > 0) {
      stored += viaEspn;
      console.log(`  ✓ ${season}: ${viaEspn} matches (ESPN)`);
      continue;
    }

    try {
      const response = await politeFetch(`${OPENFOOTBALL}/${season}/nl.1.json`);
      if (!response.ok) {
        // A season that has not been published yet is expected, not an error.
        console.log(`  · ${season}: not published yet (HTTP ${response.status})`);
        continue;
      }

      const payload = (await response.json()) as { matches?: OpenFootballMatch[] };
      const matches = payload.matches ?? [];

      const run = conn.transaction((rows: OpenFootballMatch[]) => {
        for (const match of rows) {
          const home = CLUB_BY_FIXTURE_NAME.get(match.team1) ?? null;
          const away = CLUB_BY_FIXTURE_NAME.get(match.team2) ?? null;
          const full = match.score?.ft;

          insert.run(
            season,
            match.round ?? null,
            `${match.date}T${match.time ?? '00:00'}:00Z`,
            home,
            away,
            match.team1,
            match.team2,
            full?.[0] ?? null,
            full?.[1] ?? null,
          );
        }
      });

      run(matches);
      stored += matches.length;
      console.log(`  ✓ ${season}: ${matches.length} matches (openfootball)`);
    } catch (error) {
      console.warn(`  ✗ ${season}: ${(error as Error).message}`);
    }
  }

  return stored;
}

function previousSeason(season: string): string {
  const startYear = Number(season.slice(0, 4)) - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export interface ClubMatch {
  id: number;
  playedAt: string;
  opponent: string;
  opponentClub: ClubId | null;
  home: boolean;
  goalsFor: number | null;
  goalsAgainst: number | null;
  outcome: 'win' | 'draw' | 'loss' | null;
  round: string | null;
}

/**
 * Every match for a club, oldest first, normalised to that club's viewpoint.
 *
 * The season filter matters now that more than one season is stored: without it
 * a league table sums two seasons together and a club's "last five" can reach
 * back across a summer.
 */
export function matchesForClub(
  club: ClubId,
  options: { sinceDays?: number; season?: string } = {},
): ClubMatch[] {
  const conn = db();
  const clauses: string[] = [];
  const params: unknown[] = [club, club];

  if (options.sinceDays) {
    clauses.push(`AND played_at >= datetime('now', '-${Number(options.sinceDays)} days')`);
  }
  if (options.season) {
    clauses.push('AND season = ?');
    params.push(options.season);
  }

  const rows = conn
    .prepare(
      `SELECT id, played_at AS playedAt, round,
              home_club AS homeClub, away_club AS awayClub,
              home_name AS homeName, away_name AS awayName,
              home_goals AS homeGoals, away_goals AS awayGoals
         FROM matches
        WHERE (home_club = ? OR away_club = ?) ${clauses.join(' ')}
        ORDER BY played_at ASC`,
    )
    .all(...params) as Array<{
    id: number;
    playedAt: string;
    round: string | null;
    homeClub: ClubId | null;
    awayClub: ClubId | null;
    homeName: string;
    awayName: string;
    homeGoals: number | null;
    awayGoals: number | null;
  }>;

  return rows.map((row) => {
    const home = row.homeClub === club;
    const goalsFor = home ? row.homeGoals : row.awayGoals;
    const goalsAgainst = home ? row.awayGoals : row.homeGoals;

    let outcome: ClubMatch['outcome'] = null;
    if (goalsFor !== null && goalsAgainst !== null) {
      outcome = goalsFor > goalsAgainst ? 'win' : goalsFor === goalsAgainst ? 'draw' : 'loss';
    }

    return {
      id: row.id,
      playedAt: row.playedAt,
      opponent: home ? row.awayName : row.homeName,
      opponentClub: home ? row.awayClub : row.homeClub,
      home,
      goalsFor,
      goalsAgainst,
      outcome,
      round: row.round,
    };
  });
}

export function countMatches(): number {
  const row = db().prepare(`SELECT COUNT(*) AS n FROM matches`).get() as { n: number };
  return row.n;
}

/**
 * How far the fixture list and the document corpus actually overlap.
 *
 * Every match-anchored view (reactivity, predictive, derby swings, timeline
 * markers) needs both to cover the same dates. Fixture data reaches back a full
 * season while document collection only starts the day you first run it, so
 * early on the overlap is legitimately zero — and an empty chart should say so
 * rather than looking broken.
 */
export function coverage(): {
  matchesFrom: string | null;
  matchesTo: string | null;
  documentsFrom: string | null;
  documentsTo: string | null;
  overlappingMatches: number;
} {
  const conn = db();
  const m = conn
    .prepare(`SELECT MIN(played_at) AS lo, MAX(played_at) AS hi FROM matches`)
    .get() as { lo: string | null; hi: string | null };
  const d = conn
    .prepare(`SELECT MIN(published_at) AS lo, MAX(published_at) AS hi FROM documents`)
    .get() as { lo: string | null; hi: string | null };

  const overlap =
    d.lo && d.hi
      ? (
          conn
            .prepare(`SELECT COUNT(*) AS n FROM matches WHERE played_at >= ? AND played_at <= ?`)
            .get(d.lo, d.hi) as { n: number }
        ).n
      : 0;

  return {
    matchesFrom: m.lo,
    matchesTo: m.hi,
    documentsFrom: d.lo,
    documentsTo: d.hi,
    overlappingMatches: overlap,
  };
}
