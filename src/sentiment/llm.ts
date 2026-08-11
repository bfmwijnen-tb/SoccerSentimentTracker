import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import type { SentimentLabel } from '../types.ts';

/**
 * Optional second scoring pass.
 *
 * The lexicon handles the bulk of documents well and costs nothing, but it is
 * structurally blind to irony — and Dutch football commentary runs on irony.
 * "Geweldig hoor, weer zo'n briljante wissel" scores +0.89 on its face and is
 * one of the most negative things a fan can say.
 *
 * Rather than send every document to an LLM, the analyzer flags the ones it
 * cannot resolve (irony markers, or high emotional magnitude with a near-zero
 * net score) and only those are re-read here. On a typical week that is well
 * under 10% of the corpus, which keeps this affordable while fixing the cases
 * where the lexicon is not just imprecise but actively wrong.
 */

const SYSTEM_PROMPT = `Je bent een analist die publieke sentiment over Nederlandse voetbalclubs beoordeelt.

Je krijgt korte teksten uit Nederlandse media, forums en sociale media over Ajax, PSV of Feyenoord.

Beoordeel per tekst hoe de schrijver zich voelt over de club waar het over gaat:
- score: -1.0 (woedend, rampzalig) tot +1.0 (euforisch, lovend). 0.0 is neutraal of puur feitelijk.
- Let specifiek op ironie en sarcasme. Nederlandse voetbalfans gebruiken vaak lovende woorden
  sarcastisch ("geweldig hoor", "weer zo'n briljante wissel"). Scoor de bedoelde betekenis,
  niet de letterlijke woorden.
- Een neutraal nieuwsbericht zonder oordeel is 0.0, ook als het over een nederlaag gaat.
  Het gaat om het sentiment van de schrijver, niet om de uitslag.
- confidence: hoe zeker je bent, 0.0 tot 1.0.`;

interface ScoredItem {
  id: number;
  score: number;
  confidence: number;
  sarcasm: boolean;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'The document id given in the input' },
          score: { type: 'number', description: 'Sentiment from -1.0 to 1.0' },
          confidence: { type: 'number', description: 'Certainty from 0.0 to 1.0' },
          sarcasm: { type: 'boolean', description: 'True if the text is ironic or sarcastic' },
        },
        required: ['id', 'score', 'confidence', 'sarcasm'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

function labelFor(score: number): SentimentLabel {
  if (score <= -0.5) return 'very_negative';
  if (score <= -0.15) return 'negative';
  if (score < 0.15) return 'neutral';
  if (score < 0.5) return 'positive';
  return 'very_positive';
}

export async function rescoreAmbiguous(limit = 200): Promise<number> {
  if (!config.llm.apiKey) {
    console.log(
      'No ANTHROPIC_API_KEY set — skipping. The lexicon scores stay as they are;\n' +
        'set the key in .env to re-read the documents it flagged as ambiguous.',
    );
    return 0;
  }

  const conn = db();
  const rows = conn
    .prepare(
      `SELECT d.id, d.title, d.body
         FROM documents d
         JOIN sentiments s ON s.document_id = d.id
        WHERE s.ambiguous = 1
          AND s.method = 'lexicon'
        ORDER BY d.published_at DESC
        LIMIT ?`,
    )
    .all(Math.min(limit, config.llm.rescoreLimit)) as Array<{
    id: number;
    title: string | null;
    body: string;
  }>;

  if (rows.length === 0) {
    console.log('No ambiguous documents to re-score.');
    return 0;
  }

  console.log(`Re-scoring ${rows.length} ambiguous documents with ${config.llm.model}…`);

  const client = new Anthropic({ apiKey: config.llm.apiKey });
  const update = conn.prepare(
    `UPDATE sentiments
        SET score = ?, label = ?, confidence = ?, method = 'llm',
            ambiguous = ?, scored_at = datetime('now')
      WHERE document_id = ?`,
  );

  // Batching keeps the request count (and the per-request system-prompt cost)
  // low; 20 is small enough that one malformed document cannot poison a run.
  const BATCH_SIZE = 20;
  let updated = 0;

  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const payload = batch
      .map((row) => {
        const text = `${row.title ?? ''}\n${row.body}`.trim().slice(0, 1200);
        return `<doc id="${row.id}">\n${text}\n</doc>`;
      })
      .join('\n\n');

    try {
      const response = await client.messages.create({
        model: config.llm.model,
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        thinking: { type: 'adaptive' },
        output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
        messages: [
          {
            role: 'user',
            content: `Beoordeel elk van deze ${batch.length} teksten:\n\n${payload}`,
          },
        ],
      });

      if (response.stop_reason === 'refusal') {
        console.warn(`  batch ${offset / BATCH_SIZE + 1}: declined, skipping`);
        continue;
      }

      const textBlock = response.content.find((block) => block.type === 'text');
      if (!textBlock || textBlock.type !== 'text') continue;

      const parsed = JSON.parse(textBlock.text) as { items: ScoredItem[] };

      const apply = conn.transaction((items: ScoredItem[]) => {
        for (const item of items) {
          const score = Math.max(-1, Math.min(1, item.score));
          update.run(
            score,
            labelFor(score),
            Math.max(0, Math.min(1, item.confidence)),
            item.sarcasm ? 1 : 0,
            item.id,
          );
        }
      });

      apply(parsed.items);
      updated += parsed.items.length;
      console.log(`  batch ${offset / BATCH_SIZE + 1}: ${parsed.items.length} re-scored`);
    } catch (error) {
      console.warn(`  batch ${offset / BATCH_SIZE + 1} failed: ${(error as Error).message}`);
    }
  }

  console.log(`\n${updated} documents re-scored.`);
  return updated;
}
