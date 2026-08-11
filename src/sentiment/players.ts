import { CLUBS } from '../clubs.ts';

/**
 * Player-name extraction.
 *
 * There is no free Eredivisie squad API worth depending on, so names are
 * extracted from the text itself rather than matched against a roster. That
 * turns out to be an advantage: it picks up loan targets, transfer rumours and
 * youth debutants the moment they are written about, without anyone
 * maintaining a list.
 *
 * The method is deliberately conservative — a false positive here becomes a
 * fake "player" on the leaderboard, which is worse than missing one. Names must
 * survive a blocklist, and the query layer additionally requires a name to
 * appear across several documents before it is reported.
 */

/** Dutch surname particles, which are lowercase and part of the name. */
const PARTICLES = new Set([
  'van',
  'de',
  'den',
  'der',
  'het',
  'ten',
  'ter',
  'te',
  'op',
  'aan',
  "'t",
  'du',
  'da',
  'di',
  'el',
  'al',
]);

/**
 * Capitalised words that are not people. Football copy is dense with these —
 * competitions, cities, outlets, weekdays — and every one of them would
 * otherwise look exactly like a surname.
 */
const BLOCKLIST = new Set(
  [
    // Competitions and football vocabulary
    'eredivisie', 'champions', 'league', 'europa', 'conference', 'uefa', 'fifa', 'knvb',
    'keuken', 'kampioen', 'divisie', 'supercup', 'beker', 'johan', 'cruijff', 'schaal',
    'klassieker', 'topper', 'derby', 'transfermarkt', 'var',
    // NB: "jong" is deliberately NOT blocked. It would kill "de Jong", one of
    // the most common surnames in Dutch football. Reserve sides ("Jong Ajax")
    // are rejected anyway because the club token beside it is blocked, and
    // detectClubs() filters those documents out before this ever runs.
    // Cities, regions, countries
    'amsterdam', 'rotterdam', 'eindhoven', 'alkmaar', 'enschede', 'utrecht', 'groningen',
    'nijmegen', 'deventer', 'sittard', 'almelo', 'breda', 'zwolle', 'volendam', 'velsen',
    'heerenveen', 'tilburg', 'arnhem', 'den', 'haag', 'brabant', 'limburg', 'twente',
    'nederland', 'nederlandse', 'holland', 'oranje', 'belgie', 'duitsland', 'engeland',
    'spanje', 'italie', 'frankrijk', 'portugal', 'europa', 'europees',
    // Outlets and programmes
    'telegraaf', 'volkskrant', 'algemeen', 'dagblad', 'voetbal', 'international',
    'voetbalzone', 'voetbalprimeur', 'soccernews', 'fcupdate', 'espn', 'ziggo', 'sport',
    'studio', 'rondo', 'inside', 'nos', 'nu', 'ad', 'vi', 'google', 'news', 'youtube',
    'reddit', 'bluesky', 'twitter', 'instagram', 'transfer', 'update', 'live',
    // Calendar
    'januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus',
    'september', 'oktober', 'november', 'december', 'maandag', 'dinsdag', 'woensdag',
    'donderdag', 'vrijdag', 'zaterdag', 'zondag',
    // Sentence-initial and filler capitals
    'de', 'het', 'een', 'dit', 'dat', 'deze', 'die', 'er', 'en', 'maar', 'want', 'ook',
    'na', 'voor', 'met', 'zonder', 'tegen', 'over', 'onder', 'bij', 'door', 'uit', 'in',
    'op', 'aan', 'om', 'te', 'als', 'toen', 'nu', 'nog', 'wel', 'niet', 'geen', 'wat',
    'wie', 'hoe', 'waarom', 'waar', 'wanneer', 'hij', 'zij', 'ze', 'we', 'wij', 'ik',
    'je', 'jij', 'u', 'men', 'zo', 'dus', 'toch', 'echt', 'weer', 'alweer', 'volgens',
    'tijdens', 'ondanks', 'vanwege', 'sinds', 'terwijl', 'omdat', 'zodat', 'hoewel',
    'trainer', 'coach', 'directeur', 'bondscoach', 'aanvoerder', 'keeper', 'spits',
    'verdediger', 'middenvelder', 'aanvaller', 'speler', 'talent', 'club', 'ploeg',
    'elftal', 'selectie', 'basiself', 'wedstrijd', 'duel', 'seizoen', 'contract',
    // Position nouns, which sit directly in front of a name in football copy
    'doelman', 'vleugelverdediger', 'vleugelspeler', 'centrumverdediger', 'linksback',
    'rechtsback', 'linksbuiten', 'rechtsbuiten', 'controleur', 'sluitpost', 'buitenspeler',
    'centrumspits', 'middenvelders', 'verdedigers', 'aanvallers', 'international',
    'routinier', 'invaller', 'huurling', 'aanwinst', 'target', 'toptalent', 'jeugdspeler',
    // Verbs and auxiliaries that open a sentence right before a name
    'heeft', 'hebben', 'is', 'zijn', 'was', 'waren', 'wordt', 'worden', 'werd', 'komt',
    'komen', 'kwam', 'gaat', 'gaan', 'ging', 'wil', 'willen', 'wilde', 'kan', 'kunnen',
    'moet', 'moeten', 'zegt', 'zeggen', 'zei', 'meldt', 'melden', 'meldde', 'staat',
    'stond', 'blijft', 'blijven', 'bleef', 'maakt', 'maken', 'maakte', 'ziet', 'zien',
    'doet', 'doen', 'deed', 'krijgt', 'krijgen', 'kreeg', 'haalt', 'halen', 'haalde',
    'speelt', 'spelen', 'speelde', 'tekent', 'tekenen', 'tekende', 'vertrekt', 'woedende',
  ].map((w) => w.toLowerCase()),
);

// Club aliases are names too — "Go Ahead Eagles" must never become a player.
for (const club of CLUBS) {
  for (const alias of [...club.aliases, ...(club.strictAliases ?? []), club.shortName, club.name]) {
    for (const word of alias.toLowerCase().split(/\s+/)) BLOCKLIST.add(word);
  }
}

const CAPITALISED = /\p{Lu}[\p{L}'’-]+/u;

function isCapitalised(token: string): boolean {
  return CAPITALISED.test(token) && token === token.replace(/^(\p{Ll})/u, (m) => m.toUpperCase());
}

function normalise(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/** Demonyms and adjectives that follow an article exactly like a surname does. */
const ADJECTIVE_ENDING = /(?:se|sche|ers|aren|ers|se)$/i;

function isBlocked(word: string): boolean {
  const lower = word.toLowerCase();
  if (BLOCKLIST.has(lower)) return true;
  // "Eredivisie-seizoen" is not a person; check each half of a compound.
  return lower.split('-').some((part) => part.length > 2 && BLOCKLIST.has(part));
}

/**
 * Turns a raw capitalised run into a name, or rejects it.
 *
 * The hard case is a leading particle, because Dutch spells the preposition and
 * the name particle identically. In "transfer van Youri Baas" the `van` is a
 * preposition and the name is "Youri Baas"; in "van Persie" it is part of the
 * name. The distinguishing signal is how many capitals follow: a real particle
 * name has exactly one ("van Persie", "van der Vaart"), while a preposition is
 * followed by a full forename-plus-surname.
 */
function refine(parts: string[]): string | null {
  // Collapse a repeated particle: "transfer van van Bronckhorst" tokenises to
  // ['van','van','Bronckhorst'] and would otherwise rebuild with both.
  let words = parts.filter(
    (part, index) => index === 0 || part.toLowerCase() !== parts[index - 1]!.toLowerCase(),
  );

  const leadingParticles = [];
  while (words.length && PARTICLES.has(words[0]!.toLowerCase())) {
    leadingParticles.push(words.shift()!);
  }

  // Strip a leading capitalised non-name rather than rejecting the whole run:
  // "Heeft Peter Bosz" and "Vleugelverdediger Filip Kostic" both carry a real
  // name after a word that merely happened to be capitalised.
  while (words.length > 1 && isBlocked(words[0]!)) words.shift();

  if (words.length === 0) return null;
  if (words.some(isBlocked)) return null;

  if (leadingParticles.length > 0) {
    // More than one capital after the particles means it was a preposition —
    // keep the name, drop the particles.
    if (words.length >= 2) return normalise(words.join(' '));

    // Exactly one capital: a particle name, unless the word is really an
    // adjective or demonym ("de Rotterdamse", "de Duitse").
    if (ADJECTIVE_ENDING.test(words[0]!)) return null;
    return normalise([...leadingParticles, ...words].join(' '));
  }

  // No particles: a plain name needs at least a forename and a surname.
  return words.length >= 2 ? normalise(words.join(' ')) : null;
}

/**
 * Extracts probable player names.
 *
 * Requires at least two name tokens ("Steven Berghuis", "Cody Gakpo") or a
 * particle construction ("Van Persie", "De Jong"). A lone capitalised word is
 * rejected: Dutch football copy refers to players by surname constantly, but so
 * many other things are capitalised that single tokens are not worth the noise.
 */
export function extractPlayers(text: string): string[] {
  const found = new Set<string>();
  // Strip quoted speech markers and punctuation that would break token runs,
  // but keep sentence boundaries so we can discount sentence-initial capitals.
  const sentences = text.split(/(?<=[.!?:;])\s+|\n+/);

  for (const sentence of sentences) {
    const tokens = sentence.split(/[\s,()"“”„]+/).filter(Boolean);

    let index = 0;
    while (index < tokens.length) {
      const raw = tokens[index]!.replace(/[^\p{L}'’-]/gu, '');
      if (!raw) {
        index += 1;
        continue;
      }

      const isParticle = PARTICLES.has(raw.toLowerCase());
      const startsName = isCapitalised(raw) || isParticle;

      if (!startsName) {
        index += 1;
        continue;
      }

      const parts: string[] = [];
      let cursor = index;
      let sawCapital = false;

      while (cursor < tokens.length) {
        const token = tokens[cursor]!.replace(/[^\p{L}'’-]/gu, '');
        if (!token) break;
        const lower = token.toLowerCase();

        if (PARTICLES.has(lower)) {
          // A particle only belongs to the name if a capital follows it.
          const next = tokens[cursor + 1]?.replace(/[^\p{L}'’-]/gu, '') ?? '';
          if (!next || !isCapitalised(next)) break;
          parts.push(lower);
          cursor += 1;
          continue;
        }

        if (!isCapitalised(token)) break;
        parts.push(token);
        sawCapital = true;
        cursor += 1;
      }

      if (sawCapital) {
        const candidate = refine(parts);
        if (candidate) found.add(candidate);
      }

      index = Math.max(cursor, index + 1);
    }
  }

  return [...found];
}
