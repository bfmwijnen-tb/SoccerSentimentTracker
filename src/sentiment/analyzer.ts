import type { SentimentLabel, SentimentResult } from '../types.ts';
import {
  LEXICON,
  PHRASES,
  INTENSIFIERS,
  DIMINISHERS,
  NEGATORS,
  CONTRAST_MARKERS,
  EMOJI,
  SARCASM_MARKERS,
} from './lexicon.nl.ts';

/** How far back a negator or intensifier reaches, in tokens. */
const MODIFIER_WINDOW = 3;

/**
 * Dutch inflection is regular enough that suffix stripping beats a full stemmer
 * here: the lexicon stores base forms and this reduces "dramatische",
 * "teleurstellende", "blessures" onto them. Order matters — longest first.
 */
const SUFFIXES = ['sten', 'ste', 'ere', 'er', 'en', 'es', 'e', 's'];

const VOWELS = 'aeiou';

/**
 * Candidate base forms for a stripped stem, in order of likelihood.
 *
 * Dutch inflection does two things that plain suffix-stripping gets wrong, and
 * both are common in exactly the words this lexicon cares about:
 *
 *   consonant doubling  zwak  -> zwakke   (strip -e leaves "zwakk")
 *   vowel shortening    groot -> grote    (strip -e leaves "grot")
 *
 * Without these, "zwakke wedstrijd" and "grote fout" score zero — the term is
 * in the lexicon but the inflected form never reaches it.
 */
function baseCandidates(stripped: string): string[] {
  const candidates = [stripped, `${stripped}e`];

  const last = stripped.at(-1) ?? '';
  if (last && last === stripped.at(-2) && !VOWELS.includes(last)) {
    candidates.push(stripped.slice(0, -1));
  }

  // Re-lengthen the final vowel: "grot" -> "groot", "hop" -> "hoop".
  const match = /^(.*?)([aeiou])([^aeiou]+)$/.exec(stripped);
  if (match) candidates.push(`${match[1]}${match[2]}${match[2]}${match[3]}`);

  return candidates;
}

function stem(token: string): string {
  if (LEXICON[token] !== undefined) return token;
  for (const suffix of SUFFIXES) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      const stripped = token.slice(0, -suffix.length);
      for (const candidate of baseCandidates(stripped)) {
        if (LEXICON[candidate] !== undefined) return candidate;
      }
    }
  }
  return token;
}

const EMOJI_KEYS = Object.keys(EMOJI);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function labelFor(score: number): SentimentLabel {
  if (score <= -0.5) return 'very_negative';
  if (score <= -0.15) return 'negative';
  if (score < 0.15) return 'neutral';
  if (score < 0.5) return 'positive';
  return 'very_positive';
}

export interface AnalyzeOptions {
  /** Documents flagged ambiguous are candidates for the LLM re-score pass. */
  detectSarcasm?: boolean;
}

export interface LexiconAnalysis extends SentimentResult {
  /** True when the text carries irony markers the lexicon cannot resolve. */
  ambiguous: boolean;
  tokenCount: number;
}

/**
 * Scores Dutch text on a -1..1 polarity axis.
 *
 * The pipeline is: phrase match -> emoji -> token scan with negation and
 * intensifier lookback -> contrast reweighting -> normalisation. Normalisation
 * divides by sqrt(hits) rather than by token count, so a long balanced match
 * report and a three-word verdict end up on comparable scales instead of long
 * texts collapsing toward zero.
 */
export function analyze(text: string, options: AnalyzeOptions = {}): LexiconAnalysis {
  const { detectSarcasm = true } = options;
  const drivers: Array<{ term: string; weight: number }> = [];
  let total = 0;
  let magnitude = 0;
  let hits = 0;

  const lowered = text.toLowerCase();

  // 1. Phrases first — they subsume their component tokens.
  let remaining = lowered;
  for (const [phrase, weight] of Object.entries(PHRASES)) {
    let index = remaining.indexOf(phrase);
    while (index !== -1) {
      total += weight;
      magnitude += Math.abs(weight);
      hits += 1;
      drivers.push({ term: phrase, weight });
      remaining = `${remaining.slice(0, index)} ${remaining.slice(index + phrase.length)}`;
      index = remaining.indexOf(phrase);
    }
  }

  // 2. Emoji, which survive the token filter poorly and are worth scoring raw.
  for (const glyph of EMOJI_KEYS) {
    const count = text.split(glyph).length - 1;
    if (count === 0) continue;
    // Repeated emoji intensify, but with diminishing returns.
    const weight = EMOJI[glyph]! * Math.min(1 + (count - 1) * 0.3, 2);
    total += weight;
    magnitude += Math.abs(weight);
    hits += 1;
    drivers.push({ term: glyph, weight: Number(weight.toFixed(2)) });
  }

  // 3. Token scan.
  const tokens = tokenize(remaining);
  const contrastAt = tokens.findIndex((t) => CONTRAST_MARKERS.has(t));

  for (let i = 0; i < tokens.length; i += 1) {
    const stemmed = stem(tokens[i]!);
    const base = LEXICON[stemmed];
    if (base === undefined) continue;

    let weight = base;
    let negated = false;

    for (let back = 1; back <= MODIFIER_WINDOW && i - back >= 0; back += 1) {
      const prev = tokens[i - back]!;
      if (NEGATORS.has(prev)) {
        negated = true;
        continue;
      }
      const intensifier = INTENSIFIERS[prev];
      if (intensifier !== undefined) {
        weight *= intensifier;
        continue;
      }
      const diminisher = DIMINISHERS[prev];
      if (diminisher !== undefined) weight *= diminisher;
    }

    // Negation in Dutch dampens as well as flips: "niet goed" is worse than
    // neutral but milder than "slecht".
    if (negated) weight *= -0.8;

    // Everything before a contrast marker is the concession, not the verdict.
    if (contrastAt !== -1) weight *= i < contrastAt ? 0.5 : 1.4;

    total += weight;
    magnitude += Math.abs(weight);
    hits += 1;
    if (drivers.length < 24) drivers.push({ term: stemmed, weight: Number(weight.toFixed(2)) });
  }

  if (hits === 0) {
    return {
      score: 0,
      magnitude: 0,
      label: 'neutral',
      method: 'lexicon',
      confidence: 0,
      drivers: [],
      ambiguous: false,
      tokenCount: tokens.length,
    };
  }

  // tanh rather than a hard clamp: a hard clamp pinned any document with two
  // strong terms to exactly ±1, collapsing "bad" and "catastrophic" onto the
  // same value and flattening every chart built on top of it. tanh keeps the
  // scale open-ended while preserving separation in the middle of the range.
  const score = Math.tanh(total / (Math.sqrt(hits) * 3));

  // Confidence reflects lexical coverage: a 400-word article with two matched
  // terms is a weak read even if those two terms are strong.
  const coverage = tokens.length === 0 ? 0 : hits / Math.sqrt(tokens.length + 1);
  const confidence = Math.max(0.05, Math.min(1, coverage * 0.8));

  const ironyFlag = detectSarcasm && SARCASM_MARKERS.some((re) => re.test(text));
  // Strong positives phrased ironically are the classic failure; mixed signals
  // (high magnitude, near-zero net) are the other.
  const mixed = magnitude > 6 && Math.abs(score) < 0.15;

  return {
    score: Number(score.toFixed(4)),
    magnitude: Number(magnitude.toFixed(2)),
    label: labelFor(score),
    method: 'lexicon',
    confidence: Number(confidence.toFixed(3)),
    drivers: drivers.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 8),
    ambiguous: Boolean(ironyFlag || mixed),
    tokenCount: tokens.length,
  };
}

/**
 * Combines a title and body, weighting the title higher. Headlines carry the
 * editorial verdict and are written to be unambiguous, so they are a cleaner
 * signal than the article body, which quotes both sides.
 */
export function analyzeDocument(title: string | null, body: string): LexiconAnalysis {
  if (!title) return analyze(body);

  const titleResult = analyze(title);
  const bodyResult = analyze(body);

  if (titleResult.confidence === 0) return bodyResult;
  if (bodyResult.confidence === 0) return titleResult;

  const titleWeight = 0.6;
  const score = titleResult.score * titleWeight + bodyResult.score * (1 - titleWeight);

  return {
    score: Number(score.toFixed(4)),
    magnitude: Number((titleResult.magnitude + bodyResult.magnitude).toFixed(2)),
    label: labelFor(score),
    method: 'lexicon',
    confidence: Number(Math.max(titleResult.confidence, bodyResult.confidence).toFixed(3)),
    drivers: [...titleResult.drivers, ...bodyResult.drivers]
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
      .slice(0, 8),
    ambiguous: titleResult.ambiguous || bodyResult.ambiguous,
    tokenCount: titleResult.tokenCount + bodyResult.tokenCount,
  };
}
