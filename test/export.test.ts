import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { exportStandalone } from '../src/export.ts';

/**
 * The standalone export bundles two ES modules into one classic script, which
 * is where the interesting failures live: both bugs found while building it
 * (`$$` eaten by a replacement string, and a `fmt` helper defined in both
 * modules) were compile-time SyntaxErrors that produced a blank page. Compiling
 * the emitted script is therefore the test that matters most.
 */

function buildOnce(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stemming-export-'));
  try {
    const result = exportStandalone(join(dir, 'out.html'));
    return readFileSync(result.path, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The bundle is the last <script> block; the ones before it carry the data. */
function extractBundle(html: string): string {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  assert.ok(blocks.length >= 2, 'expected a data-loader script and a bundle script');
  return blocks[blocks.length - 1]!;
}

const html = buildOnce();

test('the emitted bundle compiles', () => {
  // Compiling catches duplicate top-level identifiers across the two inlined
  // modules — the exact failure that shipped a blank page.
  assert.doesNotThrow(() => new vm.Script(extractBundle(html)), 'bundle must be valid JavaScript');
});

test('injection does not mangle $$ in the source', () => {
  // `$$` inside a String.replace replacement is an escape for a literal `$`,
  // which silently rewrote `const $$ = ...` to `const $ = ...`.
  assert.ok(
    extractBundle(html).includes('const $$ = (selector)'),
    '$$ helper was mangled during injection',
  );
});

test('carries no module syntax that file:// would reject', () => {
  const bundle = extractBundle(html);
  assert.ok(!/^\s*import\s/m.test(bundle), 'import statements cannot run in a classic script');
  assert.ok(!/^\s*export\s/m.test(bundle), 'export statements cannot run in a classic script');
  assert.ok(!html.includes('type="module"'), 'a module script is blocked over file://');
});

test('is fully self-contained', () => {
  assert.ok(!/<link[^>]+stylesheet/.test(html), 'stylesheets must be inlined');
  assert.ok(!/<script[^>]+src=/.test(html), 'scripts must be inlined');
  assert.ok(html.includes('<style>'), 'expected inlined CSS');
});

test('embeds a parseable snapshot with every view represented', () => {
  const payload = /<script type="application\/json" id="stemming-data">([\s\S]*?)<\/script>/.exec(
    html,
  );
  assert.ok(payload, 'snapshot payload missing');

  const snapshot = JSON.parse(payload[1]!);
  assert.ok(snapshot.generatedAt, 'snapshot must record when it was taken');
  assert.equal(snapshot.meta.clubs.length, 18);

  for (const path of [
    '/api/overview',
    '/api/timeseries',
    '/api/table',
    '/api/pressure',
    '/api/players',
    '/api/derbies',
    '/api/records',
  ]) {
    assert.ok(snapshot.data[`${path}|30|`], `snapshot missing ${path} for the default view`);
  }
});

test('escapes markup so a document title cannot break out of the payload', () => {
  const payload = /<script type="application\/json" id="stemming-data">([\s\S]*?)<\/script>/.exec(
    html,
  )![1]!;
  assert.ok(!payload.includes('<'), 'raw < in the JSON payload could terminate the script tag');
});
