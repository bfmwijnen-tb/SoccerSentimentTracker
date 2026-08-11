import { config } from '../config.ts';

const lastRequestAt = new Map<string, number>();

/**
 * Per-host politeness throttle. Dutch news sites are small operations and
 * several of them tarpit or block bursty clients; one request per host per
 * REQUEST_DELAY_MS keeps the crawler well inside what their robots.txt asks for.
 */
export async function throttle(host: string): Promise<void> {
  const previous = lastRequestAt.get(host) ?? 0;
  const wait = previous + config.requestDelayMs - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt.set(host, Date.now());
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  method?: string;
  body?: string;
}

export async function politeFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const { host } = new URL(url);
  await throttle(host);

  const headers = {
    'User-Agent': config.userAgent,
    Accept:
      'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8',
    'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.5',
    ...options.headers,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body,
      signal: controller.signal,
      redirect: 'follow',
    });

    // Several large Dutch publishers (DPG Media's ad.nl and nu.nl, telegraaf.nl)
    // sit behind bot filters that fingerprint the TLS handshake rather than the
    // headers: Node's HTTP client is rejected with 403 no matter what it sends,
    // while an ordinary curl of the same URL with the same User-Agent succeeds.
    // Retrying through curl keeps those feeds usable without misrepresenting who
    // we are — same UA, same politeness delay.
    if (response.status === 403 && (options.method ?? 'GET') === 'GET') {
      const viaCurl = await curlFetch(url, headers, options.timeoutMs ?? 20_000);
      if (viaCurl) return viaCurl;
    }

    return response;
  } finally {
    clearTimeout(timer);
  }
}

/** Returns null when curl is unavailable or also fails, so callers can fall back. */
async function curlFetch(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response | null> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  // -f makes curl exit non-zero on 4xx/5xx instead of handing back the error
  // page as a successful body — without it a 403 block page would be parsed as
  // if it were the feed, and the caller would see a JSON/XML syntax error
  // rather than the access problem it actually is.
  const args = ['-fsSL', '--compressed', '-m', String(Math.ceil(timeoutMs / 1000))];
  for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`);
  args.push(url);

  try {
    const { stdout } = await run('curl', args, { maxBuffer: 16 * 1024 * 1024 });
    if (!stdout) return null;
    return new Response(stdout, { status: 200 });
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  eacute: 'é',
  egrave: 'è',
  euml: 'ë',
  iuml: 'ï',
  ouml: 'ö',
  uuml: 'ü',
  auml: 'ä',
  ccedil: 'ç',
  oacute: 'ó',
  iacute: 'í',
  aacute: 'á',
  uacute: 'ú',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

function removeTags(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

/**
 * Strips markup, entity-encoded markup included.
 *
 * Order matters here. Google News (and several other feeds) put HTML inside a
 * CDATA block *and* entity-encode it, so the description arrives as
 * `&lt;a href="..."&gt;`. Decoding after stripping turned that back into live
 * `<a href>` markup in the stored body, which polluted both the sentiment score
 * and player extraction with tag names and colour codes. Stripping either side
 * of the decode handles plain and encoded markup alike.
 */
export function stripHtml(html: string): string {
  return removeTags(decodeEntities(removeTags(html)))
    .replace(/\s+/g, ' ')
    .trim();
}
