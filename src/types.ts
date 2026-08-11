export type ClubId =
  | 'ajax'
  | 'psv'
  | 'feyenoord'
  | 'az'
  | 'twente'
  | 'utrecht'
  | 'groningen'
  | 'heerenveen'
  | 'nec'
  | 'goahead'
  | 'sparta'
  | 'fortuna'
  | 'heracles'
  | 'nac'
  | 'pec'
  | 'volendam'
  | 'excelsior'
  | 'telstar';

export type MatchOutcome = 'win' | 'draw' | 'loss';

export interface Fixture {
  id: number;
  season: string;
  round: string | null;
  playedAt: string;
  homeClub: ClubId | null;
  awayClub: ClubId | null;
  homeName: string;
  awayName: string;
  homeGoals: number | null;
  awayGoals: number | null;
}

export type SourceKind = 'news' | 'reddit' | 'youtube' | 'bluesky' | 'forum';

/** A single piece of collected text, before scoring. */
export interface RawDocument {
  /** Stable id from the origin platform; used to deduplicate across runs. */
  externalId: string;
  sourceKind: SourceKind;
  /** Human-readable origin, e.g. "r/Ajax" or "AD Sport". */
  sourceName: string;
  url: string;
  title: string | null;
  body: string;
  author: string | null;
  publishedAt: string;
  /** Platform engagement (upvotes, likes). Used to weight sentiment. */
  engagement: number;
  lang: string;
}

export type SentimentLabel = 'very_negative' | 'negative' | 'neutral' | 'positive' | 'very_positive';

export type ScoringMethod = 'lexicon' | 'llm';

export interface SentimentResult {
  /** Normalised polarity in [-1, 1]. */
  score: number;
  /** Raw emotional intensity before normalisation; high magnitude + near-zero
   *  score means the text is genuinely mixed rather than genuinely neutral. */
  magnitude: number;
  label: SentimentLabel;
  method: ScoringMethod;
  /** How much of the text the analyzer actually recognised, in [0, 1]. */
  confidence: number;
  /** Lexicon terms that drove the score, for the "why" tooltip in the UI. */
  drivers: Array<{ term: string; weight: number }>;
}

export type TopicId =
  | 'results'
  | 'transfers'
  | 'coach'
  | 'board'
  | 'referee'
  | 'injuries'
  | 'europe'
  | 'youth'
  | 'fans';

/** A document after collection + scoring, as stored and served. */
export interface ScoredDocument extends RawDocument {
  id: number;
  club: ClubId;
  sentiment: SentimentResult;
  topics: TopicId[];
}

export interface CollectorContext {
  userAgent: string;
  /** Resolves after the configured politeness delay for this host. */
  throttle: (host: string) => Promise<void>;
  since: Date;
}

export interface Collector {
  readonly id: string;
  readonly kind: SourceKind;
  /** False when the collector's credentials are absent; it is then skipped. */
  isConfigured(): boolean;
  /** Why the collector is unavailable, surfaced in the dashboard. */
  unavailableReason(): string | null;
  collect(ctx: CollectorContext): Promise<RawDocument[]>;
}
