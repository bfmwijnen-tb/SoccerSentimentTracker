import type { ClubId } from './types.ts';

export interface Club {
  id: ClubId;
  name: string;
  shortName: string;
  city: string;
  /** The three the tracker leads with; the rest fill the league view. */
  featured: boolean;
  brand: { primary: string; secondary: string };
  /** Case-insensitive whole-word patterns. */
  aliases: string[];
  /**
   * Case-SENSITIVE patterns, for acronyms that collide with ordinary words.
   * "NEC" is a club; "nec" is Latin and appears in boilerplate. "AZ" is a club;
   * "az" turns up inside slugs and abbreviations.
   */
  strictAliases?: string[];
  subreddits: string[];
  youtubeChannels: string[];
  /**
   * Every name the fixture sources use for this club. ESPN and openfootball
   * disagree constantly ("AFC Ajax" vs "Ajax Amsterdam", "Telstar 1963" vs
   * "Telstar"), so both spellings live here and either one resolves.
   */
  fixtureNames: string[];
}

/**
 * Note on colour: the featured clubs all play in red-and-white, so crest
 * colours are deliberately NOT used for chart series — three near-identical
 * reds on one axis are unreadable, and hopeless under colour-vision deficiency.
 * See web/css/tokens.css for the palette that is used instead.
 */
export const CLUBS: Club[] = [
  {
    id: 'ajax',
    name: 'AFC Ajax',
    shortName: 'Ajax',
    city: 'Amsterdam',
    featured: true,
    brand: { primary: '#d2122e', secondary: '#ffffff' },
    aliases: ['ajax', 'afc ajax', 'de godenzonen', 'amsterdammers', 'ajacieden', 'ajacied'],
    subreddits: ['Ajax'],
    youtubeChannels: ['UCiIlU9ijJhBGkPvHzIfW-cA'],
    fixtureNames: ['AFC Ajax', 'Ajax Amsterdam', 'Ajax'],
  },
  {
    id: 'psv',
    name: 'PSV Eindhoven',
    shortName: 'PSV',
    city: 'Eindhoven',
    featured: true,
    brand: { primary: '#ed1c24', secondary: '#ffffff' },
    aliases: ['psv eindhoven', 'philips sport vereniging', 'boeren', 'eindhovenaren'],
    strictAliases: ['PSV'],
    subreddits: ['PSV'],
    youtubeChannels: ['UCg6D7-CjkYuFDGpTIrxQXEA'],
    fixtureNames: ['PSV', 'PSV Eindhoven'],
  },
  {
    id: 'feyenoord',
    name: 'Feyenoord Rotterdam',
    shortName: 'Feyenoord',
    city: 'Rotterdam',
    featured: true,
    brand: { primary: '#e30613', secondary: '#000000' },
    aliases: ['feyenoord', 'feijenoord', 'de stadionclub', 'de kuip'],
    subreddits: ['Feyenoord'],
    youtubeChannels: ['UCf6b6bAn8QRHNiZ0zbYq0hg'],
    fixtureNames: ['Feyenoord Rotterdam', 'Feyenoord'],
  },
  {
    id: 'az',
    name: 'AZ Alkmaar',
    shortName: 'AZ',
    city: 'Alkmaar',
    featured: false,
    brand: { primary: '#ec1c24', secondary: '#ffffff' },
    aliases: ['az alkmaar', 'alkmaar zaanstreek'],
    strictAliases: ['AZ'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['AZ', 'AZ Alkmaar'],
  },
  {
    id: 'twente',
    name: 'FC Twente',
    shortName: 'Twente',
    city: 'Enschede',
    featured: false,
    brand: { primary: '#e2001a', secondary: '#ffffff' },
    aliases: ['fc twente', 'twente', 'tukkers'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ["FC Twente '65", 'FC Twente', 'Twente'],
  },
  {
    id: 'utrecht',
    name: 'FC Utrecht',
    shortName: 'Utrecht',
    city: 'Utrecht',
    featured: false,
    brand: { primary: '#e2001a', secondary: '#ffffff' },
    aliases: ['fc utrecht', 'domstedelingen'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['FC Utrecht', 'Utrecht'],
  },
  {
    id: 'groningen',
    name: 'FC Groningen',
    shortName: 'Groningen',
    city: 'Groningen',
    featured: false,
    brand: { primary: '#00a94f', secondary: '#ffffff' },
    aliases: ['fc groningen', 'trots van het noorden'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['FC Groningen', 'Groningen'],
  },
  {
    id: 'heerenveen',
    name: 'SC Heerenveen',
    shortName: 'Heerenveen',
    city: 'Heerenveen',
    featured: false,
    brand: { primary: '#005ca9', secondary: '#ffffff' },
    aliases: ['sc heerenveen', 'heerenveen'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['SC Heerenveen', 'Heerenveen'],
  },
  {
    id: 'nec',
    name: 'NEC Nijmegen',
    shortName: 'NEC',
    city: 'Nijmegen',
    featured: false,
    brand: { primary: '#e2001a', secondary: '#008d36' },
    aliases: ['nec nijmegen'],
    strictAliases: ['NEC'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['NEC', 'NEC Nijmegen'],
  },
  {
    id: 'goahead',
    name: 'Go Ahead Eagles',
    shortName: 'Go Ahead',
    city: 'Deventer',
    featured: false,
    brand: { primary: '#e2001a', secondary: '#ffe500' },
    aliases: ['go ahead eagles', 'go ahead'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['Go Ahead Eagles'],
  },
  {
    id: 'sparta',
    name: 'Sparta Rotterdam',
    shortName: 'Sparta',
    city: 'Rotterdam',
    featured: false,
    brand: { primary: '#e2001a', secondary: '#ffffff' },
    aliases: ['sparta rotterdam', 'kasteelheren'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['Sparta Rotterdam'],
  },
  {
    id: 'fortuna',
    name: 'Fortuna Sittard',
    shortName: 'Fortuna',
    city: 'Sittard',
    featured: false,
    brand: { primary: '#f9e300', secondary: '#00954c' },
    aliases: ['fortuna sittard'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['Fortuna Sittard'],
  },
  {
    id: 'heracles',
    name: 'Heracles Almelo',
    shortName: 'Heracles',
    city: 'Almelo',
    featured: false,
    brand: { primary: '#000000', secondary: '#ffffff' },
    aliases: ['heracles almelo', 'heracles'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['Heracles Almelo', 'Heracles'],
  },
  {
    id: 'nac',
    name: 'NAC Breda',
    shortName: 'NAC',
    city: 'Breda',
    featured: false,
    brand: { primary: '#f7d117', secondary: '#000000' },
    aliases: ['nac breda'],
    strictAliases: ['NAC'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['NAC Breda', 'NAC'],
  },
  {
    id: 'pec',
    name: 'PEC Zwolle',
    shortName: 'PEC',
    city: 'Zwolle',
    featured: false,
    brand: { primary: '#0066b3', secondary: '#ffffff' },
    aliases: ['pec zwolle'],
    strictAliases: ['PEC'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['PEC Zwolle'],
  },
  {
    id: 'volendam',
    name: 'FC Volendam',
    shortName: 'Volendam',
    city: 'Volendam',
    featured: false,
    brand: { primary: '#e2001a', secondary: '#ffffff' },
    aliases: ['fc volendam', 'volendam'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['FC Volendam', 'Volendam'],
  },
  {
    id: 'excelsior',
    name: 'SBV Excelsior',
    shortName: 'Excelsior',
    city: 'Rotterdam',
    featured: false,
    brand: { primary: '#e2001a', secondary: '#000000' },
    aliases: ['sbv excelsior', 'excelsior'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['SBV Excelsior', 'Excelsior'],
  },
  {
    id: 'telstar',
    name: 'Telstar',
    shortName: 'Telstar',
    city: 'Velsen',
    featured: false,
    brand: { primary: '#ffffff', secondary: '#000000' },
    aliases: ['telstar'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['Telstar 1963', 'Telstar'],
  },
  {
    id: 'ado',
    name: 'ADO Den Haag',
    shortName: 'ADO',
    city: 'Den Haag',
    featured: false,
    brand: { primary: '#009036', secondary: '#f9e300' },
    aliases: ['ado den haag', 'ado'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['ADO Den Haag', 'ADO'],
  },
  {
    id: 'cambuur',
    name: 'SC Cambuur',
    shortName: 'Cambuur',
    city: 'Leeuwarden',
    featured: false,
    brand: { primary: '#f9e300', secondary: '#005ca9' },
    aliases: ['sc cambuur', 'cambuur'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['SC Cambuur', 'Cambuur'],
  },
  {
    id: 'willem2',
    name: 'Willem II',
    shortName: 'Willem II',
    city: 'Tilburg',
    featured: false,
    brand: { primary: '#e2001a', secondary: '#005ca9' },
    aliases: ['willem ii', 'willem 2', 'tricolores'],
    subreddits: [],
    youtubeChannels: [],
    fixtureNames: ['Willem II'],
  },
];

export const CLUB_IDS = CLUBS.map((c) => c.id);
export const CLUB_BY_ID = new Map<ClubId, Club>(CLUBS.map((c) => [c.id, c]));
export const FEATURED_CLUBS = CLUBS.filter((c) => c.featured);
export const CLUB_BY_FIXTURE_NAME = new Map(
  CLUBS.flatMap((c) => c.fixtureNames.map((name) => [name, c.id] as const)),
);

export const NEUTRAL_SUBREDDITS = ['Eredivisie', 'FootballNL'];

/**
 * The rivalries with their own emotional physics. A derby week does not behave
 * like an ordinary week, so the dashboard treats these as first-class events.
 */
export interface Derby {
  id: string;
  name: string;
  clubs: [ClubId, ClubId];
}

export const DERBIES: Derby[] = [
  { id: 'klassieker', name: 'De Klassieker', clubs: ['ajax', 'feyenoord'] },
  { id: 'topper', name: 'De Topper', clubs: ['psv', 'ajax'] },
  { id: 'rotterdam', name: 'Rotterdamse derby', clubs: ['feyenoord', 'sparta'] },
  { id: 'brabant', name: 'Brabantse derby', clubs: ['psv', 'nac'] },
  { id: 'twentse', name: 'Twentse derby', clubs: ['twente', 'heracles'] },
];

/** Contexts where an alias means something other than the football club. */
const FALSE_POSITIVES = [
  /ajax\s+(cape\s+town|amsterdam\s+dames)/i,
  /\bajax\b[^.]{0,20}\b(request|call|javascript|jquery|schoonmaak)\b/i,
  /\bsparta\s+(praag|prague|moskou|rotterdam\s+dames)\b/i,
  /\bfortuna\s+(d[üu]sseldorf|k[öo]ln)\b/i,
  /\bexcelsior\s+(maassluis|rotterdam\s+dames)\b/i,
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Unicode-aware boundaries so "Ajax," matches but "Ajaxian" does not. */
function wordPattern(alias: string, flags: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(alias)}(?![\\p{L}\\p{N}])`, flags);
}

const ALIAS_PATTERNS: Array<{ club: ClubId; re: RegExp }> = CLUBS.flatMap((club) => [
  ...club.aliases.map((alias) => ({ club: club.id, re: wordPattern(alias, 'iu') })),
  ...(club.strictAliases ?? []).map((alias) => ({ club: club.id, re: wordPattern(alias, 'u') })),
]);

/** Reserve and women's sides carry their own mood and would pollute the signal. */
const RESERVE_TEAM =
  /\b(jong|o1[5-9]|onder\s?1[5-9]|vrouwen|dames)\s+(ajax|psv|feyenoord|az|utrecht|twente)\b/iu;

export interface ClubMatch {
  club: ClubId;
  primary: boolean;
}

/**
 * Identifies which clubs a document is about.
 *
 * A document mentioning two clubs (a match report, a transfer between them) is
 * attributed to both, but only the club named in the title — or named first —
 * is marked primary, so "Ajax beat PSV" does not read as PSV content.
 */
export function detectClubs(title: string | null, body: string): ClubMatch[] {
  const haystack = `${title ?? ''}\n${body}`;
  if (FALSE_POSITIVES.some((re) => re.test(haystack))) return [];
  if (RESERVE_TEAM.test(haystack)) return [];

  const found = new Map<ClubId, number>();
  for (const { club, re } of ALIAS_PATTERNS) {
    const match = re.exec(haystack);
    if (!match) continue;
    const existing = found.get(club);
    if (existing === undefined || match.index < existing) found.set(club, match.index);
  }
  if (found.size === 0) return [];

  const titleText = title ?? '';
  const inTitle = new Set<ClubId>(
    ALIAS_PATTERNS.filter(({ re }) => re.test(titleText)).map(({ club }) => club),
  );

  const ordered = [...found.entries()].sort((a, b) => a[1] - b[1]);
  const firstMentioned = ordered[0]![0];

  return ordered.map(([club]) => ({
    club,
    primary: inTitle.size > 0 ? inTitle.has(club) : club === firstMentioned,
  }));
}
