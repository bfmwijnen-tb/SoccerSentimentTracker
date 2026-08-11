import { db } from './db/index.ts';
import { config } from './config.ts';
import { CLUBS, CLUB_BY_ID } from './clubs.ts';
import { sentimentBetween } from './analysis/index.ts';
import type { ClubId } from './types.ts';

/**
 * Sentiment alerting.
 *
 * Turns the dashboard from something you visit into something that tells you
 * when to look. Two triggers:
 *
 *   drop  — sentiment fell by more than the threshold in 24 hours
 *   floor — sentiment is below the absolute floor, however it got there
 *
 * A cooldown stops a sustained slump firing every run: once a club has alerted
 * on a given trigger, it stays quiet for COOLDOWN_HOURS unless it drops another
 * full threshold below where it alerted.
 */

const COOLDOWN_HOURS = 12;

export interface Alert {
  club: ClubId;
  name: string;
  kind: 'drop' | 'floor';
  score: number;
  delta: number;
  documents: number;
  message: string;
}

export interface AlertOptions {
  dropThreshold?: number;
  floor?: number;
  minDocuments?: number;
  /** Evaluate and report without recording or sending anything. */
  dryRun?: boolean;
}

export async function checkAlerts(options: AlertOptions = {}): Promise<Alert[]> {
  const {
    dropThreshold = config.alerts.dropThreshold,
    floor = config.alerts.floor,
    minDocuments = 5,
    dryRun = false,
  } = options;

  const now = Date.now();
  const conn = db();
  const fired: Alert[] = [];

  for (const club of CLUBS) {
    const current = sentimentBetween(
      club.id,
      new Date(now - 24 * 3600_000).toISOString(),
      new Date(now).toISOString(),
    );
    // Too little coverage makes the average meaningless — a single grumpy post
    // should never page anyone.
    if (current.documents < minDocuments) continue;

    const previous = sentimentBetween(
      club.id,
      new Date(now - 48 * 3600_000).toISOString(),
      new Date(now - 24 * 3600_000).toISOString(),
    );
    const delta = current.score - previous.score;

    const kind: Alert['kind'] | null =
      delta <= -dropThreshold ? 'drop' : current.score <= floor ? 'floor' : null;
    if (!kind) continue;

    const last = conn
      .prepare(
        `SELECT score, fired_at FROM alert_log
          WHERE club = ? AND kind = ? AND fired_at >= datetime('now', ?)
          ORDER BY fired_at DESC LIMIT 1`,
      )
      .get(club.id, kind, `-${COOLDOWN_HOURS} hours`) as { score: number } | undefined;

    // Still in cooldown, and not meaningfully worse than when we last alerted.
    if (last && current.score > last.score - dropThreshold) continue;

    const name = CLUB_BY_ID.get(club.id)?.shortName ?? club.id;
    const message =
      kind === 'drop'
        ? `${name}: sentiment fell ${Math.abs(delta).toFixed(2)} in 24h to ${current.score.toFixed(2)} (${current.documents} berichten)`
        : `${name}: sentiment at ${current.score.toFixed(2)}, below the ${floor.toFixed(2)} floor (${current.documents} berichten)`;

    const alert: Alert = {
      club: club.id,
      name,
      kind,
      score: Number(current.score.toFixed(3)),
      delta: Number(delta.toFixed(3)),
      documents: current.documents,
      message,
    };
    fired.push(alert);

    if (dryRun) continue;

    conn
      .prepare(
        `INSERT INTO alert_log (club, kind, score, delta, message) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(alert.club, alert.kind, alert.score, alert.delta, alert.message);

    await deliver(alert);
  }

  return fired;
}

async function deliver(alert: Alert): Promise<void> {
  if (!config.alerts.webhookUrl) return;

  try {
    const response = await fetch(config.alerts.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Slack and Discord both render a bare `text` field, so one payload
      // covers the two most likely destinations without configuration.
      body: JSON.stringify({
        text: alert.message,
        content: alert.message,
        club: alert.club,
        kind: alert.kind,
        score: alert.score,
        delta: alert.delta,
      }),
    });
    if (!response.ok) console.warn(`  webhook returned HTTP ${response.status}`);
  } catch (error) {
    console.warn(`  webhook failed: ${(error as Error).message}`);
  }
}

export function recentAlerts(limit = 20): Alert[] {
  return (
    db()
      .prepare(
        `SELECT club, kind, score, delta, message, fired_at AS firedAt
           FROM alert_log ORDER BY fired_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Alert & { firedAt: string }>
  ).map((row) => ({ ...row, name: CLUB_BY_ID.get(row.club)?.shortName ?? row.club }));
}
