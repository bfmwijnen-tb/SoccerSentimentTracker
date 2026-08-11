import type { ClubId } from './types.ts';

export interface Club {
  id: ClubId;
  name: string;
  shortName: string;
  city: string;
  /** Crest colours. Deliberately NOT used to colour chart series — see below. */
  brand: { primary: string; secondary: string };
  /** Case-insensitive whole-word patterns that identify the club. */
  aliases: string[];
  subreddits: string[];
  /** Official YouTube channel ids, used by the YouTube collector. */
  youtubeChannels: string[];
}

/**
 * Note on colour: Ajax, PSV and Feyenoord all play in red-and-white. Using crest
 * colours for the chart series would put three near-identical reds on one axis —
 * unreadable normally and hopeless under colour-vision deficiency. Chart series
 * therefore use the validated categorical palette (see web/css/tokens.css) and
 * club identity is carried by the crest chip and direct labels instead.
 */
export const CLUBS: Club[] = [
  {
    id: 'ajax',
    name: 'AFC Ajax',
    shortName: 'Ajax',
    city: 'Amsterdam',
    brand: { primary: '#d2122e', secondary: '#ffffff' },
    aliases: ['ajax', 'afc ajax', 'de godenzonen', 'amsterdammers', 'ajacieden', 'ajacied'],
    subreddits: ['Ajax'],
    youtubeChannels: ['UCiIlU9ijJhBGkPvHzIfW-cA'],
  },
  {
    id: 'psv',
    name: 'PSV Eindhoven',
    shortName: 'PSV',
    city: 'Eindhoven',
    brand: { primary: '#ed1c24', secondary: '#ffffff' },
    aliases: ['psv', 'psv eindhoven', 'boeren', 'eindhovenaren', 'philips sport vereniging'],
    subreddits: ['PSV'],
    youtubeChannels: ['UCg6D7-CjkYuFDGpTIrxQXEA'],
  },
  {
    id: 'feyenoord',
    name: 'Feyenoord Rotterdam',
    shortName: 'Feyenoord',
    city: 'Rotterdam',
    brand: { primary: '#e30613', secondary: '#000000' },
    aliases: ['feyenoord', 'feijenoord', 'de stadionclub', 'rotterdammers', 'kuip', 'de kuip'],
    subreddits: ['Feyenoord'],
    youtubeChannels: ['UCf6b6bAn8QRHNiZ0zbYq0hg'],
  },
];

export const CLUB_IDS = CLUBS.map((c) => c.id);
export const CLUB_BY_ID = new Map<ClubId, Club>(CLUBS.map((c) => [c.id, c]));

/** Shared Eredivisie feeds worth scanning for all three clubs. */
export const NEUTRAL_SUBREDDITS = ['Eredivisie', 'FootballNL'];

/**
 * Contexts where an alias means something other than the football club.
 * "Ajax" in particular is a cleaning product, a Greek hero and an HTTP technique.
 */
const FALSE_POSITIVES = [
  /ajax\s+(cape\s+town|amsterdam\s+dames)/i,
  /\bajax\b[^.]{0,20}\b(request|call|javascript|jquery|schoonmaak)\b/i,
  /\bpsv\b[^.]{0,20}\b(pressure\s+support|ventilation)\b/i,
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ALIAS_PATTERNS: Array<{ club: ClubId; re: RegExp }> = CLUBS.flatMap((club) =>
  club.aliases.map((alias) => ({
    club: club.id,
    // Unicode-aware word boundaries so "Ajax," and "(Ajax)" match but
    // "Ajaxian" does not.
    re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(alias)}(?![\\p{L}\\p{N}])`, 'iu'),
  })),
);

/**
 * Reserve/youth sides ("Jong Ajax", "Ajax O19") carry their own fanbase mood and
 * would otherwise pollute the first-team signal.
 */
const RESERVE_TEAM = /\b(jong|o1[5-9]|onder\s?1[5-9]|vrouwen|dames)\s+(ajax|psv|feyenoord)\b/iu;

export interface ClubMatch {
  club: ClubId;
  /** True when the club is the subject rather than an aside. */
  primary: boolean;
}

/**
 * Identifies which clubs a document is about.
 *
 * A document mentioning two clubs (a match report, a transfer between them) is
 * attributed to both, but only the club named in the title — or named first — is
 * marked primary, so "Ajax beat PSV" does not read as PSV content.
 */
export function detectClubs(title: string | null, body: string): ClubMatch[] {
  const haystack = `${title ?? ''}\n${body}`;
  if (FALSE_POSITIVES.some((re) => re.test(haystack))) return [];
  if (RESERVE_TEAM.test(haystack)) return [];

  const found = new Map<ClubId, number>();
  for (const { club, re } of ALIAS_PATTERNS) {
    const match = re.exec(haystack);
    if (!match) continue;
    const at = match.index;
    const existing = found.get(club);
    if (existing === undefined || at < existing) found.set(club, at);
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
