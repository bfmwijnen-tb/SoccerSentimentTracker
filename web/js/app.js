import { lineChart, topicChart, hideTooltip } from './charts.js';

/**
 * Club colours.
 *
 * Only the three featured clubs get a dedicated hue: the validated categorical
 * palette carries exactly three all-pairs-distinct slots, and a fourth would
 * put two confusable colours on the same axis. Every other club renders in a
 * neutral tone and is identified by name — which is also why the timeline caps
 * its selection at three series.
 */
const CLUB_COLORS = {
  ajax: 'var(--club-ajax)',
  psv: 'var(--club-psv)',
  feyenoord: 'var(--club-feyenoord)',
};
const NEUTRAL_CLUB = 'var(--neutral)';
const colorFor = (club) => CLUB_COLORS[club] ?? NEUTRAL_CLUB;

const MAX_SERIES = 3;

/**
 * Sensible smoothing for a given window.
 *
 * A three-day mean over six months is a sawtooth: the eye sees noise where the
 * chart is meant to show a trend. The default therefore scales with the period,
 * while an explicit choice by the reader is always respected (see
 * state.smoothingPinned).
 */
function defaultSmoothing(days) {
  if (days <= 30) return 3;
  if (days <= 90) return 7;
  return 14;
}

const state = {
  days: 30,
  clubs: new Set(['ajax', 'psv', 'feyenoord']),
  sources: '',
  smoothing: 3,
  /** True once the reader picks a smoothing window themselves. */
  smoothingPinned: false,
  view: 'overview',
  meta: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

/**
 * Fetches an API payload, or reads it from the embedded snapshot.
 *
 * `npm run export` bakes every (period x source) combination into a single
 * self-contained HTML file that runs from file:// with no server. When that
 * snapshot is present the same render code reads from it instead, so the export
 * and the live dashboard never drift apart. Club filtering is done in the
 * browser either way, which is why the snapshot only varies on period and
 * source rather than on every possible club selection.
 */
async function api(path, params = {}) {
  const snapshot = window.__STEMMING__;

  if (snapshot) {
    const key = `${path}|${state.days}|${state.sources}`;
    const payload = snapshot.data[key] ?? snapshot.data[`${path}|${state.days}|`];
    if (payload === undefined) throw new Error(`Niet in de export: ${path}`);
    return payload;
  }

  const query = new URLSearchParams({ days: String(state.days), ...params });
  if (state.sources) query.set('sources', state.sources);
  const response = await fetch(`${path}?${query}`);
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.json();
}

const fmt = (n) => (n >= 0 ? '+' : '') + Number(n).toFixed(2);

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

function verdict(score, documents) {
  if (documents === 0) return 'Geen berichten gevonden';
  if (score <= -0.5) return 'Zwaar negatief — crisisstemming';
  if (score <= -0.15) return 'Negatief — er is onvrede';
  if (score < 0.15) return 'Neutraal — weinig uitgesproken';
  if (score < 0.5) return 'Positief — tevreden';
  return 'Zeer positief — euforie';
}

function polarityColor(score) {
  if (score <= -0.5) return 'var(--neg-strong)';
  if (score <= -0.15) return 'var(--neg)';
  if (score < 0.15) return 'var(--neutral)';
  if (score < 0.5) return 'var(--pos)';
  return 'var(--pos-strong)';
}

const activeClubs = () => state.meta.clubs.map((c) => c.id).filter((id) => state.clubs.has(id));
const clubLabels = () => Object.fromEntries(state.meta.clubs.map((c) => [c.id, c.shortName]));

/**
 * Explains why a match-anchored view is empty.
 *
 * The usual cause is not a bug: fixture data covers a whole past season while
 * document collection starts the day you first run the collector, so until the
 * two date ranges overlap there is genuinely nothing to compare.
 */
function coverageNote(what) {
  const c = state.meta.coverage ?? {};
  const day = (iso) =>
    iso ? new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

  if (!c.matchesFrom) {
    return `<div class="note"><b>Nog geen wedstrijdgegevens.</b> Draai <code>npm run fixtures</code> om de Eredivisie-uitslagen op te halen.</div>`;
  }

  if (!c.overlappingMatches) {
    return `<div class="note">
      <b>${what} heeft overlap nodig tussen wedstrijden en berichten — die is er nog niet.</b>
      <p style="margin:10px 0 0">
        Wedstrijden lopen van ${day(c.matchesFrom)} tot ${day(c.matchesTo)}; berichten van
        ${day(c.documentsFrom)} tot ${day(c.documentsTo)}. RSS-feeds gaan maar een dag of twee terug,
        dus de berichtgeschiedenis begint bij je eerste run en groeit vanaf daar.
      </p>
      <p style="margin:10px 0 0">
        Dit vult zich vanzelf zodra het seizoen loopt en je de collector een tijdje hebt draaien —
        zet <code>npm run collect</code> in cron.
      </p>
    </div>`;
  }

  return `<div class="note"><b>Nog te weinig gegevens.</b> Er zijn meer wedstrijden met voorbeschouwing nodig; dit vult zich naarmate er langer verzameld wordt.</div>`;
}

function formBadge(form) {
  if (!form) return '<span style="color:var(--text-muted)">—</span>';
  return `<span class="form-badge">${[...form].map((c) => `<span class="${c}">${c}</span>`).join('')}</span>`;
}

/* -------------------------------------------------------------- narrative */

/**
 * Turns the numbers into a sentence.
 *
 * A score of +0.28 means nothing on its own — the whole point of the dashboard
 * is whether a fanbase is hopeful, restless or furious, and about what. The
 * bands below are the same ones the rest of the UI colours by, so the words and
 * the colours can never disagree.
 */
function moodPhrase(score, club) {
  if (score <= -0.5) return { word: 'woedend', sentence: `Er heerst crisisstemming rond ${club}` };
  if (score <= -0.25) return { word: 'boos', sentence: `Er wordt boos over ${club} geschreven` };
  if (score <= -0.1) return { word: 'kritisch', sentence: `De toon over ${club} is overwegend kritisch` };
  if (score < 0.1) return { word: 'afwachtend', sentence: `De toon over ${club} is gemengd tot neutraal` };
  if (score < 0.3) return { word: 'tevreden', sentence: `Er wordt licht positief over ${club} geschreven` };
  if (score < 0.55) return { word: 'hoopvol', sentence: `Er spreekt duidelijk vertrouwen uit wat er over ${club} geschreven wordt` };
  return { word: 'euforisch', sentence: `De stemming rond ${club} is uitgelaten` };
}

function trendPhrase(delta, days) {
  const period = `de ${days} dagen daarvoor`;
  if (delta >= 0.15) return `Dat is een flinke stijging ten opzichte van ${period}.`;
  if (delta >= 0.05) return `De stemming loopt op ten opzichte van ${period}.`;
  if (delta <= -0.15) return `Maar de stemming zakt hard weg ten opzichte van ${period}.`;
  if (delta <= -0.05) return `De stemming loopt wel terug ten opzichte van ${period}.`;
  return `De stemming is stabiel ten opzichte van ${period}.`;
}

/**
 * A topic only earns a mention when enough was written about it. One furious
 * article about the referee is not "waar de onvrede over gaat".
 */
const TOPIC_MIN_DOCUMENTS = 5;

function renderSummary(overview, topicRows) {
  const host = $('#summary');
  const labels = clubLabels();
  const byClub = new Map(overview.map((row) => [row.club, row]));
  const ids = activeClubs();

  if (ids.length === 0) {
    host.innerHTML = '<p class="loading">Selecteer minstens één club.</p>';
    return;
  }

  host.innerHTML = ids
    .map((id) => {
      const row = byClub.get(id);
      if (!row || row.documents === 0) {
        return `
          <div class="summary-row">
            <span class="who"><span class="dot" style="background:${colorFor(id)}"></span>${escapeHtml(labels[id])}</span>
            <p>Geen berichten in deze periode gevonden, dus hierover valt niets te zeggen.</p>
          </div>`;
      }

      const mood = moodPhrase(row.score, labels[id]);
      const trend = trendPhrase(row.delta, state.days);

      const mine = topicRows
        .filter((t) => t.club === id && t.documents >= TOPIC_MIN_DOCUMENTS)
        .sort((a, b) => a.score - b.score);
      const worst = mine[0];
      const best = mine[mine.length - 1];

      const topicLabel = (t) => escapeHtml(state.meta.topics[t.topic] ?? t.topic);

      const parts = [];
      if (worst && worst.score < -0.05) {
        parts.push(
          `De meeste onvrede gaat over <b>${topicLabel(worst)}</b> (${fmt(worst.score)}, ${worst.documents} berichten).`,
        );
      }
      if (best && best.score > 0.05 && best !== worst) {
        parts.push(
          `Het meest positief wordt geschreven over <b>${topicLabel(best)}</b> (${fmt(best.score)}, ${best.documents} berichten).`,
        );
      }
      if (parts.length === 0 && mine.length > 0) {
        parts.push('Geen enkel onderwerp springt er duidelijk positief of negatief uit.');
      }

      const volatility = Number(row.volatility);
      const swingNote =
        volatility >= 0.35
          ? ' Van dag tot dag schommelt het sterk.'
          : volatility <= 0.15
            ? ' Van dag tot dag blijft het opvallend vlak.'
            : '';

      return `
        <div class="summary-row">
          <span class="who">
            <span class="dot" style="background:${colorFor(id)}"></span>
            ${escapeHtml(labels[id])}
            <b class="mood" style="color:${polarityColor(row.score)}">${mood.word}</b>
          </span>
          <p>
            ${mood.sentence}, gemeten over ${row.documents} berichten. ${trend}${swingNote}
            ${parts.join(' ')}
          </p>
        </div>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ tiles */

function renderTiles(overview) {
  const host = $('#tiles');
  const labels = clubLabels();
  const byClub = new Map(overview.map((row) => [row.club, row]));
  const ids = activeClubs();

  if (ids.length === 0) {
    host.innerHTML = '<p class="loading">Selecteer minstens één club.</p>';
    return;
  }

  host.innerHTML = ids
    .map((id) => {
      const row = byClub.get(id) ?? {
        score: 0, documents: 0, delta: 0, volatility: 0,
      };
      const direction = row.delta > 0.02 ? 'up' : row.delta < -0.02 ? 'down' : 'flat';
      const arrow = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→';

      return `
        <article class="card tile">
          <div class="club-name">
            <span class="crest" style="background:${colorFor(id)}"></span>
            ${escapeHtml(labels[id])}
          </div>
          <div class="score" style="color:${polarityColor(row.score)}">${fmt(row.score)}</div>
          <div class="verdict">${verdict(row.score, row.documents)}</div>
          <div class="meter" role="img" aria-label="Sentiment ${fmt(row.score)} op een schaal van -1 tot +1">
            <span class="needle" style="left:${((row.score + 1) / 2) * 100}%"></span>
          </div>
          <div class="meta">
            <div><b>${row.documents}</b> berichten</div>
            <div><b class="delta ${direction}">${arrow} ${fmt(row.delta)}</b> vs vorige ${state.days}d</div>
            <div><b>${Number(row.volatility).toFixed(2)}</b> wisselvalligheid</div>
          </div>
        </article>`;
    })
    .join('');
}

/* --------------------------------------------------------------- timeline */

function renderTimeline(points, markers) {
  const ids = activeClubs().slice(0, MAX_SERIES);
  const labels = clubLabels();

  lineChart($('#timeline'), {
    series: ids.map((id) => ({ key: id, points: points.filter((p) => p.club === id) })),
    colors: Object.fromEntries(ids.map((id) => [id, colorFor(id)])),
    labels,
    markers: markers.filter((m) => ids.includes(m.club)),
    smoothing: state.smoothing,
  });

  const capped = activeClubs().length > MAX_SERIES;
  $('#timeline-legend').innerHTML =
    ids
      .map(
        (id) =>
          `<span class="item"><span class="key" style="background:${colorFor(id)}"></span>${escapeHtml(labels[id])}</span>`,
      )
      .join('') +
    (capped
      ? `<span class="item" style="color:var(--text-muted)">Eerste ${MAX_SERIES} clubs getoond — meer lijnen worden onleesbaar</span>`
      : '');

  renderTimelineCoverage(points.filter((p) => ids.includes(p.club)));
}

/**
 * Says so when the chart covers less ground than the button that was pressed.
 *
 * The axis is drawn from the data, not from the requested period, so asking for
 * three months of a source that only has a week of history silently produces a
 * one-week chart — which reads exactly like a broken button. Naming the gap is
 * the difference between "this is broken" and "there is nothing there yet".
 */
function renderTimelineCoverage(points) {
  const host = $('#timeline-coverage');
  const dates = points.map((p) => p.bucket).filter(Boolean).sort();
  host.innerHTML = '';
  if (dates.length === 0) return;

  const first = new Date(dates[0]);
  const covered = Math.round((Date.now() - first.getTime()) / 86400000) + 1;
  // A little slack: the last few days of a period are often simply not collected
  // yet, and flagging that on every view would be noise.
  if (covered >= state.days * 0.8) return;

  const asked =
    state.days >= 365 ? 'het seizoen' : state.days >= 90 ? `${state.days / 30} maanden` : `${state.days} dagen`;

  host.innerHTML = `
    <p class="sub2">
      Je vroeg om ${asked}, maar deze selectie heeft pas
      <b>${covered} ${covered === 1 ? 'dag' : 'dagen'}</b> aan gegevens — de grafiek toont alles
      wat er is. Zodra er langer verzameld is, groeit hij vanzelf mee.
    </p>`;
}

/* ----------------------------------------------------------------- topics */

function renderTopics(rows) {
  const ids = activeClubs().slice(0, MAX_SERIES);
  const labels = clubLabels();
  const grouped = new Map();

  for (const row of rows) {
    if (!ids.includes(row.club)) continue;
    if (!grouped.has(row.topic)) grouped.set(row.topic, { topic: row.topic, byClub: {}, total: 0 });
    const entry = grouped.get(row.topic);
    entry.byClub[row.club] = { score: row.score, documents: row.documents };
    entry.total += row.documents;
  }

  const topics = [...grouped.values()].sort((a, b) => b.total - a.total).slice(0, 7);

  topicChart($('#topics'), {
    topics,
    clubs: ids,
    colors: Object.fromEntries(ids.map((id) => [id, colorFor(id)])),
    labels,
    topicLabels: state.meta.topics,
  });

  $('#topics-legend').innerHTML = ids
    .map(
      (id) =>
        `<span class="item"><span class="key square" style="background:${colorFor(id)}"></span>${escapeHtml(labels[id])}</span>`,
    )
    .join('');
}

/* ------------------------------------------------------------- divergence */

/**
 * Fewest documents on each side before a gap is worth showing.
 *
 * Without a floor this panel happily ranked a club whose "fan mood" came from
 * two posts above one built on a hundred and twenty, and the two-post club won
 * — small samples produce the biggest gaps. The threshold is low enough that
 * the smaller clubs still appear once there is anything to say about them.
 */
const MIN_DIVERGENCE_DOCUMENTS = 5;

function renderDivergence(rows) {
  const host = $('#divergence');
  const labels = clubLabels();
  const present = rows.filter((r) => r.fanDocuments > 0 && r.mediaDocuments > 0);
  const usable = present
    .filter(
      (r) =>
        r.fanDocuments >= MIN_DIVERGENCE_DOCUMENTS &&
        r.mediaDocuments >= MIN_DIVERGENCE_DOCUMENTS,
    )
    // Biggest disagreement first — that is the number the panel exists for.
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

  if (present.length === 0) {
    host.innerHTML = `
      <div class="note">
        <b>Nog geen fanbronnen actief.</b> Deze vergelijking heeft zowel mediaberichten als
        fanreacties nodig. Op dit moment komt alles uit de media, dus er valt niets te vergelijken.
      </div>
      ${fanSourceHelp()}`;
    return;
  }

  if (usable.length === 0) {
    host.innerHTML = `
      <div class="note">
        <b>Nog te weinig fanreacties.</b> Er komen wel fanreacties binnen, maar voor geen enkele
        club nog ${MIN_DIVERGENCE_DOCUMENTS} aan beide kanten — te weinig om een verschil op te
        baseren. Kies een langere periode, of wacht een paar updates af.
      </div>`;
    return;
  }

  const thin = present.length - usable.length;

  host.innerHTML =
    usable
      .map((row) => {
        const reading =
          Math.abs(row.gap) < 0.1
            ? 'Media en fans zitten op één lijn.'
            : row.gap < 0
              ? 'Fans zijn negatiever dan de pers.'
              : 'Fans zijn positiever dan de pers.';
        return `
        <div class="rank-row">
          <span class="who">
            <span class="dot" style="background:${colorFor(row.club)}"></span>
            <span>
              ${escapeHtml(labels[row.club])}
              <span class="sub2">Media ${fmt(row.mediaScore)} (${row.mediaDocuments} berichten) · Fans ${fmt(row.fanScore)} (${row.fanDocuments}) — ${reading}</span>
            </span>
          </span>
          <span class="val delta ${row.gap > 0 ? 'up' : row.gap < 0 ? 'down' : 'flat'}">${fmt(row.gap)}</span>
        </div>`;
      })
      .join('') +
    (thin
      ? `<p class="sub2" style="margin-top:10px">${thin} ${thin === 1 ? 'club is' : 'clubs zijn'}
         weggelaten: minder dan ${MIN_DIVERGENCE_DOCUMENTS} berichten aan één van beide kanten.</p>`
      : '');
}

/* ------------------------------------------------------------------- feed */

function renderFeed(items) {
  const labels = clubLabels();
  const host = $('#feed');
  const visible = items.filter((item) =>
    (item.clubs ?? '').split(',').some((club) => state.clubs.has(club)),
  );

  if (visible.length === 0) {
    host.innerHTML = '<p class="loading">Geen berichten in deze selectie.</p>';
    return;
  }

  host.innerHTML = visible
    .slice(0, 60)
    .map((item) => {
      const clubs = (item.clubs ?? '').split(',').filter((c) => c && state.clubs.has(c));
      const topics = (item.topics ?? '').split(',').filter(Boolean);
      const when = new Date(item.publishedAt).toLocaleDateString('nl-NL', {
        day: 'numeric',
        month: 'short',
      });

      return `
        <a class="feed-item" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">
          <span class="rail" style="background:${polarityColor(item.score)}"></span>
          <span class="val" style="color:${polarityColor(item.score)}">${fmt(item.score)}</span>
          <span>
            <span class="title">${escapeHtml(item.title || item.body.slice(0, 140))}</span>
            <span class="foot">
              ${clubs
                .map(
                  (club) =>
                    `<span class="tag club"><span class="dot" style="background:${colorFor(club)}"></span>${escapeHtml(labels[club])}</span>`,
                )
                .join('')}
              ${topics.map((t) => `<span class="tag">${escapeHtml(state.meta.topics[t] ?? t)}</span>`).join('')}
              ${item.ambiguous ? '<span class="tag warn">mogelijk ironisch</span>' : ''}
              <span>${escapeHtml(item.sourceName)} · ${when}</span>
            </span>
          </span>
        </a>`;
    })
    .join('');
}

/* ---------------------------------------------------------------- sources */

/**
 * The sources that need credentials, and what each one buys.
 *
 * Naming the environment variable is not enough on its own: this dashboard is
 * normally published by GitHub Actions, where there is no .env file to edit and
 * no terminal to export a variable in. Nothing on the page said where the values
 * actually go, so "how do I enable fan sources" had no findable answer.
 */
const FAN_SOURCES = [
  {
    id: 'reddit',
    what: 'Zonder sleutel: posts uit r/AjaxAmsterdam, r/PSV, r/Feyenoord en r/Eredivisie. Met sleutel ook de reacties eronder — daar zit de emotie.',
    where: 'reddit.com/prefs/apps → "create app" → type <b>script</b>',
    secrets: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  },
  {
    id: 'youtube',
    what: 'Reacties onder clipjes en samenvattingen van de clubkanalen.',
    where: 'console.cloud.google.com → APIs &amp; Services → YouTube Data API v3 → API-sleutel',
    secrets: ['YOUTUBE_API_KEY'],
  },
  {
    id: 'bluesky',
    what: 'Korte reacties tijdens en vlak na de wedstrijd.',
    where: 'bsky.app → Settings → App passwords (niet je gewone wachtwoord)',
    secrets: ['BLUESKY_IDENTIFIER', 'BLUESKY_APP_PASSWORD'],
  },
];

/**
 * Step-by-step instructions for switching the fan sources on.
 *
 * It appears both under "Media versus fans" — where the missing data is what
 * prompts the question — and under "Bronnen", where someone would go looking for
 * it. Only the Bronnen copy opens by default; two expanded copies of the same
 * table on one screen is noise.
 */
function fanSourceHelp({ open = false } = {}) {
  const fullyOn = new Set(
    state.meta.collectors.filter((c) => c.configured && !c.reason).map((c) => c.id),
  );
  const missing = FAN_SOURCES.filter((source) => !fullyOn.has(source.id));
  if (missing.length === 0) return '';

  // Open by default only when no fan source is fully configured — count the fan
  // sources, not every collector, or the always-on news feeds keep it shut.
  const anyFanSourceOn = FAN_SOURCES.some((source) => fullyOn.has(source.id));

  return `
    <details class="setup-help"${open && !anyFanSourceOn ? ' open' : ''}>
      <summary>Fanbronnen uitbreiden (${missing.length} nog niet volledig)</summary>
      <p>
        Reddit en Bluesky draaien zonder sleutel, maar beperkt: Reddit levert dan alleen posts
        en geen reacties. Met een gratis sleutel komt er per bron meer binnen. Je zet die één
        keer klaar in je eigen repository; daarna haalt de zesuurlijkse update ze vanzelf op.
      </p>
      <ol class="steps">
        <li>Haal de sleutel op bij de aanbieder (zie hieronder).</li>
        <li>
          Ga in je repository naar <b>Settings → Secrets and variables → Actions</b> en klik
          <b>New repository secret</b>.
        </li>
        <li>Plak de waarde onder <b>exact</b> de naam die hieronder staat — hoofdletters en al.</li>
        <li>
          Ga naar <b>Actions → Collect and publish dashboard → Run workflow</b>. Na een paar
          minuten staan de fanreacties erin.
        </li>
      </ol>
      <table class="setup-table">
        <thead>
          <tr><th>Bron</th><th>Secret-naam</th><th>Waar haal je hem</th></tr>
        </thead>
        <tbody>
          ${missing
            .map(
              (source) => `
                <tr>
                  <td><b>${escapeHtml(source.id)}</b><span class="sub2">${escapeHtml(source.what)}</span></td>
                  <td>${source.secrets.map((name) => `<code>${name}</code>`).join('<br />')}</td>
                  <td>${source.where}</td>
                </tr>`,
            )
            .join('')}
        </tbody>
      </table>
      <p class="sub2" style="margin-top:10px">
        Draai je het lokaal? Dan gaan dezelfde namen in een bestand <code>.env</code> naast
        <code>package.json</code>, als <code>NAAM=waarde</code> per regel.
      </p>
    </details>`;
}

function renderCollectors() {
  $('#collectors').innerHTML =
    state.meta.collectors
      .map(
        (collector) => `
        <div class="source-status">
          <span class="dot ${collector.configured ? (collector.reason ? 'part' : 'on') : 'off'}"></span>
          <b style="min-width:74px">${escapeHtml(collector.id)}</b>
          <span class="why">${escapeHtml(collector.reason ?? 'Actief')}</span>
        </div>`,
      )
      .join('') + fanSourceHelp({ open: true });
}

function renderSourceTable(sources) {
  $('#source-table tbody').innerHTML = sources
    .map(
      (source) => `
        <tr>
          <td>${escapeHtml(source.sourceName)}</td>
          <td>${escapeHtml(source.sourceKind)}</td>
          <td class="num">${source.documents}</td>
          <td class="num" style="color:${polarityColor(source.score)}">${fmt(source.score)}</td>
        </tr>`,
    )
    .join('');
}

/* ----------------------------------------------------------- league table */

function renderLeagueTable(rows) {
  $('#league-table tbody').innerHTML = rows
    .map((row, index) => {
      const diff = row.goalsFor - row.goalsAgainst;
      const mood = row.documents
        ? `<span style="color:${polarityColor(row.sentiment)}">${fmt(row.sentiment)}</span> <span style="color:var(--text-muted)">(${row.documents})</span>`
        : '<span style="color:var(--text-muted)">—</span>';
      return `
        <tr class="${state.clubs.has(row.club) ? 'highlight' : ''}">
          <td class="num">${index + 1}</td>
          <td><span class="clubcell"><span class="dot" style="background:${colorFor(row.club)}"></span>${escapeHtml(row.name)}</span></td>
          <td class="num">${row.played}</td>
          <td class="num">${row.won}</td>
          <td class="num">${row.drawn}</td>
          <td class="num">${row.lost}</td>
          <td class="num">${diff >= 0 ? '+' : ''}${diff}</td>
          <td class="num"><b>${row.points}</b></td>
          <td class="num">${mood}</td>
        </tr>`;
    })
    .join('');
}

/* --------------------------------------------------------------- pressure */

const BAND_COLOR = {
  safe: 'var(--pos)',
  watch: 'var(--pos-soft)',
  warm: 'var(--neutral)',
  hot: 'var(--neg)',
  critical: 'var(--neg-strong)',
};
const BAND_LABEL = {
  safe: 'veilig',
  watch: 'let op',
  warm: 'onrustig',
  hot: 'heet',
  critical: 'kritiek',
};

function renderPressure(rows) {
  $('#pressure').innerHTML = rows
    .map(
      (row) => `
      <div class="baro">
        <span class="who">
          <span class="crest" style="background:${colorFor(row.club)}"></span>
          ${escapeHtml(row.name)}
        </span>
        <span class="track">
          <span class="fill" style="width:${row.index}%;background:${BAND_COLOR[row.band]}"></span>
        </span>
        <span class="idx" style="color:${BAND_COLOR[row.band]}">${row.index.toFixed(0)}</span>
        <span class="detail">
          <span>${BAND_LABEL[row.band]}</span>
          ${formBadge(row.recentForm)}
          <span>${row.pointsPerGame === null ? 'geen uitslagen' : `${row.pointsPerGame.toFixed(2)} ptn/duel`}</span>
          <span>trainerssentiment ${row.coachDocuments >= 3 ? fmt(row.coachSentiment) : 'te weinig data'}</span>
          <span>${row.coverage} berichten</span>
        </span>
      </div>`,
    )
    .join('');
}

/* ------------------------------------------------------------- reactivity */

function renderReactivity(rows) {
  const host = $('#reactivity');
  if (rows.length === 0) {
    host.innerHTML = coverageNote('Deze analyse');
    return;
  }

  const max = Math.max(...rows.map((r) => r.swing), 0.2);

  host.innerHTML = rows
    .slice(0, 10)
    .map((row) => {
      const lane = (value, color) => {
        if (value === null) return '';
        const width = (Math.abs(value) / max) * 50;
        const left = value >= 0 ? 50 : 50 - width;
        return `<i style="left:${left}%;width:${width}%;background:${color}"></i>`;
      };
      return `
        <div class="rank-row" style="grid-template-columns:1fr;gap:6px">
          <span class="who" style="justify-content:space-between">
            <span style="display:inline-flex;align-items:center;gap:9px">
              <span class="dot" style="background:${colorFor(row.club)}"></span>
              ${escapeHtml(row.name)}
            </span>
            <span class="val">${row.swing.toFixed(2)} <span style="color:var(--text-muted);font-weight:400">gem. uitslag · ${row.samples} duels</span></span>
          </span>
          <div class="swing-bar"><span class="name">Winst</span><span class="lane">${lane(row.afterWin, 'var(--pos)')}</span><span class="cap">${row.afterWin === null ? '—' : fmt(row.afterWin)}</span></div>
          <div class="swing-bar"><span class="name">Gelijk</span><span class="lane">${lane(row.afterDraw, 'var(--neutral)')}</span><span class="cap">${row.afterDraw === null ? '—' : fmt(row.afterDraw)}</span></div>
          <div class="swing-bar"><span class="name">Verlies</span><span class="lane">${lane(row.afterLoss, 'var(--neg)')}</span><span class="cap">${row.afterLoss === null ? '—' : fmt(row.afterLoss)}</span></div>
        </div>`;
    })
    .join('');
}

/* -------------------------------------------------------------- predictive */

function renderPredictive(rows) {
  const host = $('#predictive');
  const usable = rows.filter((r) => r.correlation !== null);

  if (usable.length === 0) {
    host.innerHTML = coverageNote('Deze analyse');
    return;
  }

  host.innerHTML =
    usable
      .slice(0, 10)
      .map(
        (row) => `
        <div class="rank-row">
          <span class="who">
            <span class="dot" style="background:${colorFor(row.club)}"></span>
            <span>
              ${escapeHtml(row.name)}
              <span class="sub2">
                vóór winst ${row.meanBeforeWin === null ? '—' : fmt(row.meanBeforeWin)} ·
                vóór verlies ${row.meanBeforeLoss === null ? '—' : fmt(row.meanBeforeLoss)} ·
                ${row.samples} duels
              </span>
            </span>
          </span>
          <span class="val" style="color:${polarityColor(row.correlation)}">r = ${row.correlation.toFixed(2)}</span>
        </div>`,
      )
      .join('') +
    `<p class="sub" style="margin-top:14px">
       Een correlatie uit een handvol duels is geen bevinding — let op het aantal duels.
     </p>`;
}

/* ---------------------------------------------------------------- players */

function renderPlayers(rows) {
  const host = $('#players');
  if (rows.length === 0) {
    host.innerHTML = '<p class="loading">Nog geen spelers gevonden in deze periode.</p>';
    return;
  }

  host.innerHTML = rows
    .slice(0, 14)
    .map(
      (row) => `
      <div class="rank-row">
        <span class="who">
          <span class="dot" style="background:${colorFor(row.club)}"></span>
          <span>
            ${escapeHtml(row.player)}
            <span class="sub2">${escapeHtml(row.clubName ?? '—')} · ${row.mentions} vermeldingen</span>
          </span>
        </span>
        <span class="val" style="color:${polarityColor(row.score)}">${fmt(row.score)}</span>
      </div>`,
    )
    .join('');
}

function renderTransfers(rows) {
  const host = $('#transfers');
  if (rows.length === 0) {
    host.innerHTML = '<p class="loading">Geen transferberichten met spelersnamen in deze periode.</p>';
    return;
  }

  const max = Math.max(...rows.map((r) => r.mentions));

  host.innerHTML = rows
    .map(
      (row) => `
      <div class="rank-row" style="grid-template-columns:1fr;gap:6px">
        <span class="who" style="justify-content:space-between">
          <span style="display:inline-flex;align-items:center;gap:9px">
            <span class="dot" style="background:${colorFor(row.club)}"></span>
            <span>${escapeHtml(row.player)}<span class="sub2"> ${escapeHtml(row.clubName ?? '')}</span></span>
          </span>
          <span class="val" style="color:${polarityColor(row.score)}">${fmt(row.score)}</span>
        </span>
        <span class="swing-bar">
          <span class="lane"><i style="left:0;width:${(row.mentions / max) * 100}%;background:${colorFor(row.club)};opacity:.75"></i></span>
          <span class="cap">${row.mentions}×</span>
        </span>
      </div>`,
    )
    .join('');
}

/* ---------------------------------------------------------------- derbies */

function renderDerbies(rows) {
  const host = $('#derbies');
  const withData = rows.filter((r) => r.playedAt);

  if (withData.length === 0) {
    host.innerHTML =
      '<div class="note">Nog geen derbygegevens. Draai <code>npm run fixtures</code> om uitslagen op te halen.</div>';
    return;
  }

  const note = state.meta.coverage?.overlappingMatches ? '' : coverageNote('De stemmingsverschuiving');

  host.innerHTML = note + withData
    .map((derby) => {
      const when = new Date(derby.playedAt).toLocaleDateString('nl-NL', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
      const sides = derby.sides
        .map(
          (side) => `
          <div class="side">
            <div class="nm"><span class="crest" style="background:${colorFor(side.club)}"></span>${escapeHtml(side.name)}</div>
            <div class="ba">
              <span>vóór ${fmt(side.before)}</span>
              <span>→</span>
              <b style="color:${polarityColor(side.after)}">${fmt(side.after)}</b>
              <span class="delta ${side.swing > 0 ? 'up' : side.swing < 0 ? 'down' : 'flat'}">${fmt(side.swing)}</span>
            </div>
            <div class="sub" style="margin-top:6px">${side.documents} berichten</div>
          </div>`,
        )
        .join('');

      return `
        <article class="derby">
          <h3>
            <span>${escapeHtml(derby.name)}</span>
            <span class="when">${when}${derby.scoreline ? ` · ${escapeHtml(derby.scoreline)}` : ''}</span>
          </h3>
          <div class="sides">${sides}</div>
        </article>`;
    })
    .join('');
}

/* ---------------------------------------------------------------- records */

function renderRecords(records) {
  const host = $('#records');
  if (records.best.length === 0) {
    host.innerHTML =
      '<div class="note">Nog te weinig geschiedenis. Records verschijnen zodra er weken met minstens vijf berichten zijn.</div>';
    return;
  }

  const block = (title, rows, color) => `
    <h3 style="font-size:.82rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin:18px 0 4px">${title}</h3>
    ${rows
      .map(
        (row) => `
        <div class="rank-row">
          <span class="who">
            <span class="dot" style="background:${colorFor(row.club)}"></span>
            <span>${escapeHtml(row.name)}<span class="sub2"> week van ${new Date(row.weekStart).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} · ${row.documents} berichten</span></span>
          </span>
          <span class="val" style="color:${color}">${fmt(row.score)}</span>
        </div>`,
      )
      .join('')}`;

  host.innerHTML =
    block('Beste weken', records.best, 'var(--pos)') +
    block('Slechtste weken', records.worst, 'var(--neg)');
}

function renderAlerts(rows) {
  const host = $('#alerts');
  if (rows.length === 0) {
    host.innerHTML = `
      <div class="note">
        Nog geen meldingen afgevuurd. Draai <code>npm run alerts</code> (of zet het in cron) om te
        controleren; met <code>ALERT_WEBHOOK_URL</code> gaat elke melding naar Slack of Discord.
      </div>`;
    return;
  }

  host.innerHTML = rows
    .map(
      (row) => `
      <div class="rank-row">
        <span class="who">
          <span class="dot" style="background:${row.kind === 'drop' ? 'var(--neg)' : 'var(--neg-strong)'}"></span>
          <span>${escapeHtml(row.message)}<span class="sub2"> ${new Date(row.firedAt + 'Z').toLocaleString('nl-NL')}</span></span>
        </span>
        <span class="val">${escapeHtml(row.kind)}</span>
      </div>`,
    )
    .join('');
}

/* ------------------------------------------------------------------- boot */

/** Each view declares what it needs, so switching tabs fetches only that. */
const LOADERS = {
  overview: async () => {
    const clubsParam = { clubs: activeClubs().join(',') };
    const [overview, timeline, markers, topics, documents, divergence, sources] = await Promise.all([
      api('/api/overview'),
      api('/api/timeseries', clubsParam),
      api('/api/matches', clubsParam),
      api('/api/topics', clubsParam),
      api('/api/documents', { ...clubsParam, limit: '120' }),
      api('/api/divergence'),
      api('/api/sources'),
    ]);
    renderTiles(overview);
    renderSummary(overview, topics);
    renderTimeline(timeline, markers);
    renderTopics(topics);
    renderDivergence(divergence);
    renderFeed(documents);
    renderSourceTable(sources);
  },

  league: async () => renderLeagueTable(await api('/api/table')),

  pressure: async () => {
    const [pressure, react, predict] = await Promise.all([
      api('/api/pressure'),
      api('/api/reactivity'),
      api('/api/predictive'),
    ]);
    renderPressure(pressure);
    renderReactivity(react);
    renderPredictive(predict);
  },

  players: async () => {
    const clubs = activeClubs();
    const [list, transfers] = await Promise.all([
      api('/api/players', clubs.length === 1 ? { clubs: clubs[0] } : {}),
      api('/api/transfers'),
    ]);
    renderPlayers(list);
    renderTransfers(transfers);
  },

  derbies: async () => renderDerbies(await api('/api/derbies')),

  records: async () => {
    const [records, alerts] = await Promise.all([api('/api/records'), api('/api/alerts')]);
    renderRecords(records);
    renderAlerts(alerts);
  },
};

async function refresh() {
  hideTooltip();
  try {
    await LOADERS[state.view]();
  } catch (error) {
    const host = $(`.view[data-view="${state.view}"]`);
    host.insertAdjacentHTML(
      'afterbegin',
      `<div class="note" style="margin-bottom:16px"><b>Kon data niet laden.</b> ${escapeHtml(error.message)}</div>`,
    );
  }
}

function setView(view) {
  state.view = view;
  for (const tab of $$('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  for (const panel of $$('.view')) panel.hidden = panel.dataset.view !== view;
  refresh();
}

/**
 * Wires a row of chips to a piece of state.
 *
 * `datasetKey` is passed explicitly rather than derived from the state key:
 * the smoothing chips carry `data-smooth` while the state field is `smoothing`,
 * so deriving it read `dataset.smoothing`, got undefined, and set the state to
 * NaN — the buttons highlighted correctly and changed nothing.
 */
function toggleGroup(selector, stateKey, datasetKey, cast = String) {
  for (const button of $$(selector)) {
    button.addEventListener('click', () => {
      const raw = button.dataset[datasetKey];
      if (raw === undefined) return;
      state[stateKey] = cast(raw);
      // Compare by value, not identity: the same control appears both in the
      // sticky bar and beside the chart, and clicking one must light up its
      // twin rather than switching it off.
      for (const other of $$(selector)) {
        other.setAttribute('aria-pressed', String(other.dataset[datasetKey] === raw));
      }
      refresh();
    });
  }
}

function wireControls() {
  toggleGroup('[data-days]', 'days', 'days', Number);

  // Changing the period re-picks the smoothing default, unless the reader has
  // already expressed a preference.
  for (const button of $$('[data-days]')) {
    button.addEventListener('click', () => {
      if (state.smoothingPinned) return;
      state.smoothing = defaultSmoothing(Number(button.dataset.days));
      for (const chip of $$('[data-smooth]')) {
        chip.setAttribute('aria-pressed', String(Number(chip.dataset.smooth) === state.smoothing));
      }
    });
  }

  for (const button of $$('[data-smooth]')) {
    button.addEventListener('click', () => {
      state.smoothingPinned = true;
    });
  }
  toggleGroup('[data-source]', 'sources', 'source');
  toggleGroup('[data-smooth]', 'smoothing', 'smooth', Number);

  for (const tab of $$('.tab')) tab.addEventListener('click', () => setView(tab.dataset.view));

  // Featured clubs first, then the rest of the league.
  const host = $('#club-filters');
  const ordered = [...state.meta.clubs].sort(
    (a, b) => Number(b.featured) - Number(a.featured) || a.shortName.localeCompare(b.shortName),
  );

  for (const club of ordered) {
    const button = document.createElement('button');
    button.className = 'chip';
    button.setAttribute('aria-pressed', String(state.clubs.has(club.id)));
    button.innerHTML = `<span class="swatch" style="background:${colorFor(club.id)}"></span>${escapeHtml(club.shortName)}`;
    // Colour follows the club, not its position in the current selection, so
    // toggling one off never repaints the survivors.
    button.addEventListener('click', () => {
      if (state.clubs.has(club.id)) {
        if (state.clubs.size === 1) return;
        state.clubs.delete(club.id);
      } else {
        state.clubs.add(club.id);
      }
      button.setAttribute('aria-pressed', String(state.clubs.has(club.id)));
      refresh();
    });
    host.appendChild(button);
  }

  const stored = localStorage.getItem('theme');
  if (stored) document.documentElement.setAttribute('data-theme', stored);

  $('#theme-toggle').addEventListener('click', () => {
    const current =
      document.documentElement.getAttribute('data-theme') ??
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    refresh();
  });
}

/* ---------------------------------------------------------------- refresh */

function toast(title, detail, isError = false) {
  let node = $('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    node.setAttribute('role', 'status');
    document.body.appendChild(node);
  }
  node.className = `toast${isError ? ' error' : ''}`;
  node.innerHTML = `<b>${escapeHtml(title)}</b><span class="detail">${escapeHtml(detail)}</span>`;
  node.dataset.visible = 'true';
  clearTimeout(node._timer);
  node._timer = setTimeout(() => {
    node.dataset.visible = 'false';
  }, 7000);
}

/**
 * Runs a collection from the dashboard.
 *
 * The request is deliberately long-lived — collecting takes tens of seconds and
 * the server answers only when it is done — so the button reports progress
 * rather than appearing frozen. The server itself is single-flight, so a second
 * click while one is running joins the existing run instead of starting a
 * competing crawl.
 */
async function runRefresh() {
  const button = $('#refresh-btn');
  const label = $('#refresh-label');
  if (!button || button.dataset.busy === 'true') return;

  button.dataset.busy = 'true';
  label.textContent = 'Bezig met ophalen…';

  try {
    const response = await fetch('/api/refresh?days=7', { method: 'POST' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();

    const seconds = Math.round(result.durationMs / 1000);
    const failed = result.sources.filter((s) => s.error);

    toast(
      result.newDocuments > 0
        ? `${result.newDocuments} nieuwe berichten`
        : 'Alles was al up-to-date',
      `${result.documentsAfter} berichten en ${result.matches} wedstrijden in ${seconds}s.` +
        (failed.length ? ` ${failed.length} bron(nen) mislukt.` : ''),
    );

    await refresh();
  } catch (error) {
    toast('Verversen mislukt', error.message, true);
  } finally {
    button.dataset.busy = 'false';
    label.textContent = 'Data verversen';
  }
}

/** Marks an exported page as a snapshot, with the moment it was taken. */
function renderExportBanner(snapshot) {
  const taken = new Date(snapshot.generatedAt).toLocaleString('nl-NL', {
    dateStyle: 'full',
    timeStyle: 'short',
  });
  document.querySelector('.masthead').insertAdjacentHTML(
    'afterend',
    `<div class="note" style="margin-bottom:20px">
       <b>Momentopname</b> — geëxporteerd op ${taken}. Deze pagina draait zonder server en
       ververst zichzelf niet. Draai <code>npm run export</code> opnieuw voor actuele cijfers.
     </div>`,
  );
}

async function boot() {
  const snapshot = window.__STEMMING__;
  state.meta = snapshot ? snapshot.meta : await (await fetch('/api/meta')).json();

  if (snapshot) {
    // A static export has no server to collect with, so the button would be a
    // dead control — it stays hidden there rather than failing on click.
    renderExportBanner(snapshot);
  } else {
    const button = $('#refresh-btn');
    button.hidden = false;
    button.addEventListener('click', runRefresh);

    // A collection started before a reload is still running server-side; pick
    // the button state back up rather than offering to start a second one.
    fetch('/api/refresh-status')
      .then((r) => r.json())
      .then((status) => {
        if (!status.running) return;
        button.dataset.busy = 'true';
        $('#refresh-label').textContent = 'Bezig met ophalen…';
      })
      .catch(() => {});
  }

  renderCollectors();
  wireControls();
  await refresh();
}

boot();
