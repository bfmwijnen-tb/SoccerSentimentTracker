import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, analyzeDocument } from '../src/sentiment/analyzer.ts';
import { detectClubs } from '../src/clubs.ts';
import { detectTopics } from '../src/sentiment/topics.ts';
import { parseFeed } from '../src/collectors/rss.ts';

test('scores catastrophe vocabulary strongly negative', () => {
  const result = analyze('Wat een dramatische vertoning, kansloos onderuit.');
  assert.ok(result.score < -0.6, `expected < -0.6, got ${result.score}`);
  assert.equal(result.label, 'very_negative');
});

test('scores terrace praise strongly positive', () => {
  const result = analyze('Ouderwets genieten in De Kuip, klasse apart! 🔥');
  assert.ok(result.score > 0.6, `expected > 0.6, got ${result.score}`);
  assert.equal(result.label, 'very_positive');
});

test('negation flips polarity but dampens it', () => {
  const plain = analyze('Een slechte wedstrijd.');
  const negated = analyze('Niet slecht, die wedstrijd.');
  assert.ok(plain.score < 0, 'baseline should be negative');
  assert.ok(negated.score > 0, 'negated form should flip positive');
  assert.ok(
    Math.abs(negated.score) < Math.abs(plain.score) + 0.3,
    'negation should not overshoot the plain form',
  );
});

test('intensifiers amplify and diminishers soften', () => {
  const base = analyze('Een zwakke wedstrijd.').score;
  const strong = analyze('Een heel zwakke wedstrijd.').score;
  const weak = analyze('Een beetje zwakke wedstrijd.').score;
  assert.ok(strong < base, `intensified ${strong} should be below base ${base}`);
  assert.ok(weak > base, `diminished ${weak} should be above base ${base}`);
});

test('the clause after a contrast marker carries the verdict', () => {
  // "prima" before "maar" is a concession; the drama after it is the point.
  const result = analyze('Eerste helft prima, maar daarna volledig door het putje.');
  assert.ok(result.score < -0.3, `expected clearly negative, got ${result.score}`);
});

test('scores stay off the rails — nothing clamps to exactly ±1', () => {
  // A hard clamp used to pin every strongly-worded document to ±1.000, which
  // collapsed "bad" and "catastrophic" onto one value and flattened the charts.
  const extreme = analyze(
    'Dramatisch, kansloos, waardeloos, schandalig, een totale afgang en wanprestatie.',
  );
  assert.ok(extreme.score > -1, 'must not saturate at exactly -1');
  assert.ok(extreme.score < -0.8, 'but should still read as severe');
});

test('flags irony the lexicon cannot resolve', () => {
  const result = analyze("Geweldig hoor, weer zo'n briljante wissel 🙄");
  assert.equal(result.ambiguous, true, 'sarcasm markers should set the ambiguous flag');
});

test('text with no known terms is neutral with zero confidence', () => {
  const result = analyze('De aftrap is om 14:30 uur in Rotterdam.');
  assert.equal(result.score, 0);
  assert.equal(result.confidence, 0);
});

test('title outweighs body when both carry signal', () => {
  const result = analyzeDocument(
    'Dramatische nederlaag voor Ajax',
    'De ploeg speelde een degelijke eerste helft.',
  );
  assert.ok(result.score < 0, 'the headline verdict should dominate');
});

test('stems inflected forms onto their base entry', () => {
  for (const form of ['dramatisch', 'dramatische', 'zwak', 'zwakke', 'blessures']) {
    assert.ok(analyze(`Een ${form} moment.`).confidence > 0, `"${form}" should be recognised`);
  }
});

test('attributes a match report to both clubs, primary from the title', () => {
  const matches = detectClubs('Ajax wint de Klassieker', 'Feyenoord kwam niet in het stuk voor.');
  const byClub = Object.fromEntries(matches.map((m) => [m.club, m.primary]));
  assert.equal(byClub['ajax'], true);
  assert.equal(byClub['feyenoord'], false);
});

test('ignores reserve and women teams', () => {
  assert.deepEqual(detectClubs('Jong Ajax verliest van Jong PSV', ''), []);
});

test('ignores non-football uses of "Ajax"', () => {
  assert.deepEqual(detectClubs('Een Ajax request met jQuery', 'javascript voorbeeld'), []);
});

test('does not match a club inside a longer word', () => {
  assert.deepEqual(detectClubs('De Ajacieden-achtige speelstijl van PSVers', ''), [
    { club: 'ajax', primary: true },
  ]);
});

test('detects multiple topics per document', () => {
  const topics = detectTopics(
    'De trainer ligt onder vuur na de nederlaag; de technisch directeur zwijgt.',
  );
  assert.ok(topics.includes('coach'));
  assert.ok(topics.includes('results'));
});

test('parses RSS items including CDATA titles', () => {
  const xml = `<rss><channel>
    <item>
      <title><![CDATA[Ajax wint met 3-0]]></title>
      <link>https://example.nl/a</link>
      <description>Een sterke tweede helft.</description>
      <pubDate>Mon, 11 Aug 2026 12:00:00 +0200</pubDate>
      <guid>abc-123</guid>
    </item>
  </channel></rss>`;

  const docs = parseFeed(xml, 'Test');
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.title, 'Ajax wint met 3-0');
  assert.equal(docs[0]!.externalId, 'rss:abc-123');
  assert.equal(docs[0]!.url, 'https://example.nl/a');
});

test('parses Atom entries, where the link is an attribute', () => {
  const xml = `<feed>
    <entry>
      <title>PSV boekt zege</title>
      <link href="https://example.nl/b"/>
      <summary>Overtuigend gewonnen.</summary>
      <published>2026-08-11T10:00:00Z</published>
      <id>tag:example,2026:b</id>
    </entry>
  </feed>`;

  const docs = parseFeed(xml, 'Test');
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.url, 'https://example.nl/b');
});

test('decodes HTML entities in feed text', () => {
  const xml = `<rss><channel><item>
    <title>Feyenoord &amp; Ajax in actie &#8212; de Klassieker</title>
    <link>https://example.nl/c</link>
    <description>Caf&eacute;praat</description>
    <guid>c</guid>
  </item></channel></rss>`;

  const docs = parseFeed(xml, 'Test');
  assert.equal(docs[0]!.title, 'Feyenoord & Ajax in actie — de Klassieker');
  assert.equal(docs[0]!.body, 'Cafépraat');
});
