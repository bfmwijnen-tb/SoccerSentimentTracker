import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Minimal .env reader so the project stays dependency-free for config. */
function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const env = (key: string, fallback = ''): string => process.env[key]?.trim() || fallback;

export const config = {
  dbPath: resolve(env('DB_PATH', './data/sentiment.db')),
  port: Number(env('PORT', '8787')),
  userAgent: env(
    'USER_AGENT',
    'SoccerSentimentTracker/0.1 (+https://github.com/bfmwijnen-tb/soccersentimenttracker)',
  ),
  requestDelayMs: Number(env('REQUEST_DELAY_MS', '1200')),

  reddit: {
    clientId: env('REDDIT_CLIENT_ID'),
    clientSecret: env('REDDIT_CLIENT_SECRET'),
  },
  youtube: { apiKey: env('YOUTUBE_API_KEY') },
  bluesky: {
    identifier: env('BLUESKY_IDENTIFIER'),
    appPassword: env('BLUESKY_APP_PASSWORD'),
  },
  llm: {
    apiKey: env('ANTHROPIC_API_KEY'),
    model: env('LLM_MODEL', 'claude-opus-5'),
    rescoreLimit: Number(env('LLM_RESCORE_LIMIT', '200')),
  },
} as const;

export function ensureDataDir(): void {
  mkdirSync(dirname(config.dbPath), { recursive: true });
}
