import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { exportStandalone } from '../src/export.ts';

/**
 * The standalone export bundles two ES modules into one classic script, which
 * is where the interesting failures live: both bugs found while building it
 * (`$$` eaten by a replacement string, and a `fmt` helper defined in both
 * modules) were compile-time SyntaxErrors that produced a blank page. Compiling
 * the emitted script is therefore the test that matters most.
 */

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../web');

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
  // 21: the 18 currently in the Eredivisie plus the three relegated after
  // 2025-26, which stay so their history and press mentions still resolve.
  assert.equal(snapshot.meta.clubs.length, 21);

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

test('every chip group is wired to an attribute that exists in the markup', () => {
  // The smoothing chips carry `data-smooth` while the state field is
  // `smoothing`. Deriving the dataset key from the state key read
  // `dataset.smoothing`, got undefined, and set the state to NaN — the buttons
  // highlighted correctly and changed nothing, which is invisible to a
  // compile check and to any test that only looks at markup.
  const app = readFileSync(resolve(webRoot, 'js/app.js'), 'utf8');
  const markup = readFileSync(resolve(webRoot, 'index.html'), 'utf8');

  const calls = [...app.matchAll(/toggleGroup\(\s*'\[data-([\w-]+)\]'\s*,\s*'(\w+)'\s*,\s*'(\w+)'/g)];
  assert.ok(calls.length >= 3, `expected the chip groups to be wired, found ${calls.length}`);

  for (const [, attribute, , datasetKey] of calls) {
    // data-foo-bar reaches JS as dataset.fooBar.
    const expected = attribute!.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    assert.equal(
      datasetKey,
      expected,
      `toggleGroup('[data-${attribute}]', …) must read dataset.${expected}, not dataset.${datasetKey}`,
    );
    assert.ok(markup.includes(`data-${attribute}=`), `no data-${attribute} in index.html`);
  }
});

test('escapes markup so a document title cannot break out of the payload', () => {
  const payload = /<script type="application\/json" id="stemming-data">([\s\S]*?)<\/script>/.exec(
    html,
  )![1]!;
  assert.ok(!payload.includes('<'), 'raw < in the JSON payload could terminate the script tag');
});
