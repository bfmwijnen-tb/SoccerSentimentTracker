import type { TopicId } from '../types.ts';

/**
 * Topic keywords. Sentiment on its own says a fanbase is unhappy; topic tags say
 * whether they are unhappy about the manager, the board, or the referee — which
 * is the difference between a bad week and a structural crisis.
 */
const TOPIC_TERMS: Record<TopicId, string[]> = {
  results: [
    'wedstrijd', 'duel', 'gewonnen', 'verloren', 'gelijkspel', 'doelpunt', 'goal',
    'uitslag', 'competitie', 'eredivisie', 'stand', 'punten', 'koploper', 'zege',
    'nederlaag', 'overwinning', 'klassieker', 'derby',
  ],
  transfers: [
    'transfer', 'aankoop', 'aanwinst', 'contract', 'huur', 'verhuurd', 'tekent',
    'vertrek', 'miljoen', 'transfermarkt', 'deal', 'clausule', 'transferperiode',
    'transfersom', 'medische keuring', 'overname', 'gehaald', 'versterking',
  ],
  coach: [
    'trainer', 'coach', 'tactiek', 'opstelling', 'wissel', 'wissels', 'systeem',
    'bondscoach', 'hoofdtrainer', 'staf', 'assistent', 'speelwijze', 'basiself',
    'formatie', 'aanpak',
  ],
  board: [
    'directeur', 'bestuur', 'technisch directeur', 'algemeen directeur', 'rvc',
    'aandeelhouders', 'begroting', 'salaris', 'clubleiding', 'beleid', 'raad van commissarissen',
  ],
  referee: [
    'scheidsrechter', 'var', 'arbiter', 'penalty', 'strafschop', 'buitenspel',
    'rode kaart', 'gele kaart', 'kaart', 'handsbal', 'overtreding', 'fluit',
  ],
  injuries: [
    'blessure', 'geblesseerd', 'revalidatie', 'kruisband', 'hamstring',
    'uitgevallen', 'ziekenboeg', 'herstel', 'operatie', 'twijfelgeval',
  ],
  europe: [
    'champions league', 'europa league', 'conference league', 'uefa', 'europees',
    'poule', 'groepsfase', 'knock-out', 'play-off', 'europa', 'coëfficiënt',
  ],
  youth: [
    'jeugd', 'opleiding', 'academie', 'doorbraak', 'toekomst', 'debuut',
    'jeugdspeler', 'talentvol', 'toptalent',
  ],
  fans: [
    'supporters', 'fans', 'publiek', 'stadion', 'uitvak', 'sfeer', 'spandoek',
    'kaartjes', 'seizoenkaart', 'tribune', 'vak', 'supportersvereniging',
  ],
};

const COMPILED: Array<{ topic: TopicId; re: RegExp }> = (
  Object.entries(TOPIC_TERMS) as Array<[TopicId, string[]]>
).map(([topic, terms]) => ({
  topic,
  re: new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'giu',
  ),
}));

/**
 * Returns every topic present, strongest first. Documents routinely span more
 * than one ("trainer under pressure after another defeat" is coach + results),
 * so this is deliberately multi-label rather than a single classification.
 */
export function detectTopics(text: string): TopicId[] {
  const scored: Array<{ topic: TopicId; count: number }> = [];
  for (const { topic, re } of COMPILED) {
    re.lastIndex = 0;
    const count = (text.match(re) ?? []).length;
    if (count > 0) scored.push({ topic, count });
  }
  return scored
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((s) => s.topic);
}

export const TOPIC_LABELS: Record<TopicId, string> = {
  results: 'Resultaten',
  transfers: 'Transfers',
  coach: 'Trainer & tactiek',
  board: 'Clubleiding',
  referee: 'Arbitrage',
  injuries: 'Blessures',
  europe: 'Europees',
  youth: 'Jeugd & talent',
  fans: 'Supporters',
};
