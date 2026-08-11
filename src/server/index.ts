import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { CLUBS, DERBIES } from '../clubs.ts';
import { TOPIC_LABELS } from '../sentiment/topics.ts';
import { COLLECTORS } from '../collectors/index.ts';
import { countDocuments } from '../db/index.ts';
import {
  clubOverview,
  dailyScores,
  topicBreakdown,
  recentDocuments,
  drivingDocuments,
  sourceHealth,
  mediaVsFans,
  type Filters,
} from '../db/queries.ts';
import {
  leagueTable,
  pressureIndex,
  reactivity,
  predictive,
  derbies,
  extremeWeeks,
  players,
  transferHype,
  matchMarkers,
} from '../analysis/index.ts';
import { countMatches, coverage } from '../collectors/fixtures.ts';
import { recentAlerts } from '../alerts.ts';
import type { ClubId } from '../types.ts';

const webRoot = resolve(fileURLToPath(new URL('../../web', import.meta.url)));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function parseFilters(url: URL): Filters {
  const clubsParam = url.searchParams.get('clubs');
  const kindsParam = url.searchParams.get('sources');

  return {
    days: Math.min(Math.max(Number(url.searchParams.get('days') ?? 30), 1), 365),
    clubs: clubsParam ? (clubsParam.split(',').filter(Boolean) as ClubId[]) : undefined,
    sourceKinds: kindsParam ? kindsParam.split(',').filter(Boolean) : undefined,
    primaryOnly: url.searchParams.get('primaryOnly') === 'true',
    minConfidence: url.searchParams.has('minConfidence')
      ? Number(url.searchParams.get('minConfidence'))
      : undefined,
  };
}

const routes: Record<string, (url: URL) => unknown> = {
  '/api/meta': () => ({
    clubs: CLUBS.map(({ id, name, shortName, city, brand, featured }) => ({
      id,
      name,
      shortName,
      city,
      brand,
      featured,
    })),
    derbies: DERBIES,
    topics: TOPIC_LABELS,
    totalDocuments: countDocuments(),
    totalMatches: countMatches(),
    coverage: coverage(),
    collectors: COLLECTORS.map((collector) => ({
      id: collector.id,
      kind: collector.kind,
      configured: collector.isConfigured(),
      reason: collector.unavailableReason(),
    })),
  }),

  '/api/overview': (url) => clubOverview(parseFilters(url)),

  '/api/timeseries': (url) => dailyScores(parseFilters(url)),

  '/api/topics': (url) => topicBreakdown(parseFilters(url)),

  '/api/documents': (url) =>
    recentDocuments(
      parseFilters(url),
      Math.min(Number(url.searchParams.get('limit') ?? 60), 300),
      Number(url.searchParams.get('offset') ?? 0),
    ),

  '/api/drivers': (url) => ({
    positive: drivingDocuments(parseFilters(url), 'positive'),
    negative: drivingDocuments(parseFilters(url), 'negative'),
  }),

  '/api/sources': (url) => sourceHealth(parseFilters(url).days),

  '/api/divergence': (url) => mediaVsFans(parseFilters(url).days),

  '/api/table': (url) => leagueTable(parseFilters(url).days),

  '/api/pressure': (url) => pressureIndex(parseFilters(url).days),

  '/api/reactivity': () => reactivity(),

  '/api/predictive': () => predictive(),

  '/api/derbies': () => derbies(),

  '/api/records': () => extremeWeeks(5),

  '/api/players': (url) => {
    const filters = parseFilters(url);
    return players(filters.days, filters.clubs?.length === 1 ? filters.clubs[0] : undefined);
  },

  '/api/transfers': (url) => transferHype(parseFilters(url).days),

  '/api/matches': (url) => {
    const filters = parseFilters(url);
    return matchMarkers(filters.clubs ?? CLUBS.map((c) => c.id), filters.days);
  },

  '/api/alerts': () => recentAlerts(20),
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  const handler = routes[url.pathname];
  if (handler) {
    try {
      const payload = handler(url);
      const body = JSON.stringify(payload);
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(body);
    } catch (error) {
      console.error(`API error on ${url.pathname}:`, error);
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: (error as Error).message }));
    }
    return;
  }

  // Static files. normalize() plus the prefix check keeps ../ traversal out.
  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = normalize(join(webRoot, requestedPath));

  if (!filePath.startsWith(webRoot)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
    });
    response.end(file);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

server.listen(config.port, () => {
  console.log(`\n  SoccerSentimentTracker`);
  console.log(`  → http://localhost:${config.port}`);
  console.log(`  → ${countDocuments()} documents, ${countMatches()} matches`);
  console.log(`  → ${config.dbPath}\n`);
});
