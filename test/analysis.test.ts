import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPlayers } from '../src/sentiment/players.ts';
import { detectClubs, CLUBS, CLUB_BY_FIXTURE_NAME } from '../src/clubs.ts';
import { currentSeason } from '../src/collectors/fixtures.ts';
import { seasonReview } from '../src/analysis/index.ts';
import { stripHtml } from '../src/collectors/http.ts';

/* ------------------------------------------------------------ player names */

test('extracts a plain forename-surname pair', () => {
  assert.ok(extractPlayers('Wout Weghorst kopte de gelijkmaker binnen.').includes('Wout Weghorst'));
});

test('keeps Dutch particle names intact', () => {
  const names = extractPlayers('Een prachtige actie van Persie, aangegeven door de Jong.');
  assert.ok(names.includes('van Persie'), `got ${names.join(', ')}`);
  assert.ok(names.includes('de Jong'), `got ${names.join(', ')}`);
});

test('treats a particle before a full name as a preposition', () => {
  // "de transfer van Youri Baas" — "van" is a preposition, not part of the name.
  const names = extractPlayers('Ajax bevestigde de transfer van Youri Baas.');
  assert.ok(names.includes('Youri Baas'), `got ${names.join(', ')}`);
  assert.ok(!names.some((n) => n.startsWith('van ')), `leaked a preposition: ${names.join(', ')}`);
});

test('collapses a repeated particle', () => {
  const names = extractPlayers('Het vertrouwen in van van Bronckhorst is groot.');
  assert.ok(!names.some((n) => n.includes('van van')), `got ${names.join(', ')}`);
});

test('strips a leading verb or position noun from a name', () => {
  const verb = extractPlayers('Heeft Peter Bosz nog krediet bij de leiding?');
  assert.ok(verb.includes('Peter Bosz'), `got ${verb.join(', ')}`);

  const position = extractPlayers('Vleugelverdediger Filip Kostic tekende voor twee jaar.');
  assert.ok(position.includes('Filip Kostic'), `got ${position.join(', ')}`);
});

test('rejects clubs, competitions and demonyms as players', () => {
  const text =
    'Go Ahead Eagles speelde in de Champions League. De Rotterdammers waren de Duitse ploeg de baas.';
  const names = extractPlayers(text);
  for (const bad of ['Go Ahead', 'Champions League', 'de Rotterdammers', 'de Duitse']) {
    assert.ok(!names.includes(bad), `should not extract "${bad}" — got ${names.join(', ')}`);
  }
});

test('rejects a lone capitalised word', () => {
  assert.deepEqual(extractPlayers('Berghuis scoorde.'), []);
});

/* ------------------------------------------------------------------- clubs */

test('every club maps back from every fixture-source spelling', () => {
  // 21 rather than 18: the three clubs relegated after 2025-26 stay in the list
  // so their history, derbies and press mentions still resolve.
  assert.equal(CLUBS.length, 21);
  for (const club of CLUBS) {
    assert.ok(club.fixtureNames.length > 0, `${club.id} needs a fixture name`);
    for (const name of club.fixtureNames) {
      assert.equal(
        CLUB_BY_FIXTURE_NAME.get(name),
        club.id,
        `"${name}" must resolve to ${club.id}`,
      );
    }
  }
});

test('short acronyms only match in upper case', () => {
  // "nec" is Latin and appears in boilerplate; "NEC" is the club.
  assert.deepEqual(detectClubs('sine qua nec possum', ''), []);
  assert.deepEqual(detectClubs('NEC pakt een punt', ''), [{ club: 'nec', primary: true }]);
});

test('disambiguates clubs that share a name with foreign sides', () => {
  assert.deepEqual(detectClubs('Sparta Praag verloor in Europa', ''), []);
  assert.deepEqual(detectClubs('Fortuna Düsseldorf degradeerde', ''), []);
});

test('detects the newly added clubs', () => {
  for (const [text, expected] of [
    ['Go Ahead Eagles wint in Deventer', 'goahead'],
    ['AZ boekt een zege', 'az'],
    ['FC Twente pakt een punt', 'twente'],
    ['PEC Zwolle verliest opnieuw', 'pec'],
  ] as const) {
    const found = detectClubs(text, '').map((m) => m.club);
    assert.ok(found.includes(expected), `"${text}" should detect ${expected}, got ${found}`);
  }
});

test('no club points at a subreddit that is not about football', () => {
  // r/Ajax is the town of Ajax, Ontario. Pointing the collector at it filled
  // Ajax's sentiment with Canadian municipal chatter — grocery-store deals and
  // garage-door recommendations scored as fan mood. The club subreddit is
  // r/AjaxAmsterdam. This is a config trap that reads as correct, so it gets a
  // test rather than a comment alone.
  const wrong = new Map([['Ajax', 'AjaxAmsterdam']]);

  for (const club of CLUBS) {
    for (const subreddit of club.subreddits) {
      assert.ok(
        !wrong.has(subreddit),
        `${club.id} points at r/${subreddit}, which is not the club — use r/${wrong.get(subreddit)}`,
      );
    }
  }
});

/* ---------------------------------------------------------------- fixtures */

test('derives the football season from the date', () => {
  // Seasons run August to May, so July still belongs to the season that started
  // the previous calendar year.
  assert.equal(currentSeason(new Date('2026-08-11T00:00:00Z')), '2026-27');
  assert.equal(currentSeason(new Date('2026-05-01T00:00:00Z')), '2025-26');
  assert.equal(currentSeason(new Date('2026-01-15T00:00:00Z')), '2025-26');
});

/* -------------------------------------------------------------------- html */

test('strips entity-encoded markup, not just plain markup', () => {
  // Google News wraps HTML in CDATA *and* entity-encodes it. Decoding before
  // stripping used to leave live tags in the stored body.
  const encoded = '&lt;a href="https://x.nl"&gt;Ajax wint&lt;/a&gt;&nbsp;&lt;font color="#666"&gt;VP&lt;/font&gt;';
  const text = stripHtml(encoded);
  assert.ok(!text.includes('<'), `markup survived: ${text}`);
  assert.ok(!text.includes('font'), `tag name survived: ${text}`);
  assert.ok(text.includes('Ajax wint'));
});

test('strips ordinary markup too', () => {
  assert.equal(stripHtml('<p>Een <b>sterke</b> tweede helft.</p>'), 'Een sterke tweede helft.');
});

/* --------------------------------------------------------- season in review */

test('a season table counts the league programme, not the play-offs', () => {
  // The fixture source carries the end-of-season European play-offs alongside
  // the league programme. Counting them gave Ajax "36 games" in a 34-game
  // league and three points it did not earn in the table, which moved it from
  // fifth to third — a wrong final standing, not a rounding difference.
  const review = seasonReview('2025-26');
  if (review.rows.length === 0) return; // no fixtures collected in this checkout

  const counts = new Set(review.rows.map((row) => row.played));
  assert.equal(
    counts.size,
    1,
    `every club plays the same league programme, got ${[...counts].sort().join('/')}`,
  );

  for (const row of review.rows) {
    assert.ok(
      row.points <= row.played * 3,
      `${row.name}: ${row.points} points from ${row.played} games is impossible`,
    );
  }
});

test('a season is measured over its own months, not the last N days', () => {
  const review = seasonReview('2025-26');
  if (review.rows.length === 0) return;

  // The whole point of the view: a window that ends today would land in the
  // transfer season and describe a squad that has not played yet.
  assert.ok(review.from < review.to, 'season window must run forwards');
  assert.ok(
    new Date(review.to).getTime() - new Date(review.from).getTime() > 180 * 864e5,
    'a full season spans more than six months',
  );
});
