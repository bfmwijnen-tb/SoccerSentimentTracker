import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLUBS, DERBIES } from './clubs.ts';
import { TOPIC_LABELS } from './sentiment/topics.ts';
import { COLLECTORS } from './collectors/index.ts';
import { countDocuments } from './db/index.ts';
import { countMatches, coverage } from './collectors/fixtures.ts';
import {
  clubOverview,
  dailyScores,
  topicBreakdown,
  recentDocuments,
  sourceHealth,
  mediaVsFans,
  type Filters,
} from './db/queries.ts';
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
} from './analysis/index.ts';
import { recentAlerts } from './alerts.ts';

/**
 * Builds a standalone single-file dashboard.
 *
 * The live dashboard needs Node and SQLite because the queries run per request.
 * This bakes the answers instead: every (period x source) combination is
 * precomputed, inlined next to the stylesheet and the scripts, and written out
 * as one HTML file that opens straight from disk with no server, no install and
 * no network.
 *
 * The two never drift apart, because the export reuses the same query functions
 * and ships the same render code — only the transport changes.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../web');

/** Club filtering happens in the browser, so snapshots vary only on these. */
const PERIODS = [7, 30, 90, 180, 365];
const SOURCES = ['', 'news', 'reddit,youtube,bluesky'];

/** Documents dominate the file size, so the export carries fewer than the API. */
const DOCUMENT_LIMIT = 80;

function buildData(): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const allClubs = CLUBS.map((c) => c.id);

  for (const days of PERIODS) {
    for (const sources of SOURCES) {
      const filters: Filters = {
        days,
        sourceKinds: sources ? sources.split(',') : undefined,
      };
      const key = (path: string) => `${path}|${days}|${sources}`;

      data[key('/api/overview')] = clubOverview(filters);
      data[key('/api/timeseries')] = dailyScores(filters);
      data[key('/api/topics')] = topicBreakdown(filters);
      data[key('/api/documents')] = recentDocuments(filters, DOCUMENT_LIMIT);
      data[key('/api/sources')] = sourceHealth(days);
      data[key('/api/divergence')] = mediaVsFans(days);
      data[key('/api/matches')] = matchMarkers(allClubs, days);
      data[key('/api/table')] = leagueTable(days);
      data[key('/api/pressure')] = pressureIndex(days);
      data[key('/api/players')] = players(days);
      data[key('/api/transfers')] = transferHype(days);

      // These ignore the period entirely, but the client still keys on it.
      data[key('/api/reactivity')] = reactivity();
      data[key('/api/predictive')] = predictive();
      data[key('/api/derbies')] = derbies();
      data[key('/api/records')] = extremeWeeks(5);
      data[key('/api/alerts')] = recentAlerts(20);
    }
  }

  return data;
}

/**
 * Bundles the two ES modules into one classic script.
 *
 * Inlined code cannot use `import`, and a `type="module"` block loaded from
 * file:// is blocked as a cross-origin request by every browser — which is
 * exactly the failure this export exists to avoid.
 *
 * Plain concatenation is not enough: both modules legitimately define helpers
 * with the same names (`fmt`), which as separate modules is fine and in one
 * shared scope is a duplicate-identifier crash. Wrapping the dependency in an
 * IIFE that returns its exports restores real module scoping, so the two files
 * can keep evolving independently without the bundler needing to know anything
 * about their internals.
 */
function inlineScripts(): string {
  const chartsSource = readFileSync(resolve(webRoot, 'js/charts.js'), 'utf8');

  // Discover the export list from the source rather than hard-coding it, so a
  // new chart type does not silently fail to reach the app.
  const named = [...chartsSource.matchAll(/^export\s+function\s+([A-Za-z_$][\w$]*)/gm)].map(
    (match) => match[1]!,
  );
  const listed = [...chartsSource.matchAll(/^export\s*\{([^}]*)\};?\s*$/gm)].flatMap((match) =>
    match[1]!.split(',').map((name) => name.trim()).filter(Boolean),
  );
  const exported = [...new Set([...named, ...listed])];

  const chartsBody = chartsSource
    .replace(/^export\s+function/gm, 'function')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

  const appBody = readFileSync(resolve(webRoot, 'js/app.js'), 'utf8').replace(
    /^import\s+\{[^}]*\}\s+from\s+'\.\/charts\.js';\s*$/gm,
    '',
  );

  return `const __charts = (() => {
${chartsBody}
return { ${exported.join(', ')} };
})();
const { ${exported.join(', ')} } = __charts;

${appBody}`;
}

export function exportStandalone(outputPath: string): { path: string; bytes: number } {
  const meta = {
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
  };

  const snapshot = {
    generatedAt: new Date().toISOString(),
    meta,
    data: buildData(),
  };

  const css = [
    readFileSync(resolve(webRoot, 'css/tokens.css'), 'utf8'),
    readFileSync(resolve(webRoot, 'css/app.css'), 'utf8'),
  ].join('\n');

  // The payload goes in a JSON script tag rather than a JS literal so no amount
  // of odd punctuation in an article title can break out of it; escaping `<`
  // stops a literal "</script>" inside a title from ending the block early.
  const payload = JSON.stringify(snapshot).replace(/</g, '\\u003c');

  const body = `<script type="application/json" id="stemming-data">${payload}</script>
<script>window.__STEMMING__ = JSON.parse(document.getElementById('stemming-data').textContent);</script>
<script>\n${inlineScripts()}\n</script>
</body>`;

  // Every injection below passes a *function* to replace(). With a replacement
  // string, `$$` is an escape sequence for a literal `$` — which silently
  // rewrote `const $$ = ...` in the app source to `const $ = ...` and produced a
  // duplicate-identifier crash in the exported file. A replacer function is
  // handed the text verbatim and never interprets `$` patterns.
  const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8')
    .replace(/<link rel="stylesheet"[^>]*>\s*/g, '')
    .replace(/<script type="module"[^>]*><\/script>\s*/g, '')
    .replace('</head>', () => `<style>\n${css}\n</style>\n</head>`)
    .replace('</body>', () => body);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html, 'utf8');

  return { path: outputPath, bytes: Buffer.byteLength(html, 'utf8') };
}
