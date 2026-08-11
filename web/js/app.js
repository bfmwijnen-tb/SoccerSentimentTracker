import { lineChart, topicChart, hideTooltip } from './charts.js';

const CLUB_COLORS = {
  ajax: 'var(--club-ajax)',
  psv: 'var(--club-psv)',
  feyenoord: 'var(--club-feyenoord)',
};

const state = {
  days: 30,
  clubs: new Set(['ajax', 'psv', 'feyenoord']),
  sources: '',
  meta: null,
};

const $ = (selector) => document.querySelector(selector);

async function api(path, params = {}) {
  const query = new URLSearchParams({ days: String(state.days), ...params });
  if (state.sources) query.set('sources', state.sources);
  const response = await fetch(`${path}?${query}`);
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.json();
}

const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(2);

/** Plain-language reading of a score, so the number is never the only cue. */
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

function activeClubs() {
  return state.meta.clubs.map((c) => c.id).filter((id) => state.clubs.has(id));
}

function clubLabels() {
  return Object.fromEntries(state.meta.clubs.map((c) => [c.id, c.shortName]));
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
        score: 0,
        documents: 0,
        delta: 0,
        volatility: 0,
        positive: 0,
        negative: 0,
      };
      const direction = row.delta > 0.02 ? 'up' : row.delta < -0.02 ? 'down' : 'flat';
      const arrow = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→';
      const needle = ((row.score + 1) / 2) * 100;

      return `
        <article class="card tile">
          <div class="club-name">
            <span class="crest" style="background:${CLUB_COLORS[id]}"></span>
            ${labels[id]}
          </div>
          <div class="score" style="color:${polarityColor(row.score)}">${fmt(row.score)}</div>
          <div class="verdict">${verdict(row.score, row.documents)}</div>
          <div class="meter" role="img" aria-label="Sentiment ${fmt(row.score)} op een schaal van -1 tot +1">
            <span class="needle" style="left:${needle}%"></span>
          </div>
          <div class="meta">
            <div>
              <b>${row.documents}</b>
              berichten
            </div>
            <div>
              <b class="delta ${direction}">${arrow} ${fmt(row.delta)}</b>
              vs vorige ${state.days}d
            </div>
            <div>
              <b>${row.volatility.toFixed(2)}</b>
              wisselvalligheid
            </div>
          </div>
        </article>`;
    })
    .join('');
}

/* --------------------------------------------------------------- timeline */

function renderTimeline(points) {
  const ids = activeClubs();
  const labels = clubLabels();
  const series = ids.map((id) => ({
    key: id,
    points: points.filter((p) => p.club === id),
  }));

  lineChart($('#timeline'), { series, colors: CLUB_COLORS, labels });

  $('#timeline-legend').innerHTML = ids
    .map(
      (id) =>
        `<span class="item"><span class="key" style="background:${CLUB_COLORS[id]}"></span>${labels[id]}</span>`,
    )
    .join('');
}

/* ----------------------------------------------------------------- topics */

function renderTopics(rows) {
  const ids = activeClubs();
  const labels = clubLabels();

  const grouped = new Map();
  for (const row of rows) {
    if (!state.clubs.has(row.club)) continue;
    if (!grouped.has(row.topic)) grouped.set(row.topic, { topic: row.topic, byClub: {}, total: 0 });
    const entry = grouped.get(row.topic);
    entry.byClub[row.club] = { score: row.score, documents: row.documents };
    entry.total += row.documents;
  }

  const topics = [...grouped.values()].sort((a, b) => b.total - a.total).slice(0, 7);

  topicChart($('#topics'), {
    topics,
    clubs: ids,
    colors: CLUB_COLORS,
    labels,
    topicLabels: state.meta.topics,
  });

  $('#topics-legend').innerHTML = ids
    .map(
      (id) =>
        `<span class="item"><span class="key square" style="background:${CLUB_COLORS[id]}"></span>${labels[id]}</span>`,
    )
    .join('');
}

/* ------------------------------------------------------------- divergence */

function renderDivergence(rows) {
  const host = $('#divergence');
  const labels = clubLabels();
  const usable = rows.filter((r) => r.fanDocuments > 0 && r.mediaDocuments > 0);

  if (usable.length === 0) {
    const off = state.meta.collectors.filter((c) => !c.configured || c.reason);
    host.innerHTML = `
      <div class="note">
        <b>Nog geen fanbronnen actief.</b> Deze vergelijking heeft zowel mediaberichten als
        fanreacties nodig. Op dit moment komt alles uit de media, dus er valt niets te vergelijken.
        <p style="margin:12px 0 0">Schakel een fanbron in:</p>
        <ul style="margin:6px 0 0;padding-left:20px">
          ${off.map((c) => `<li><b>${c.id}</b> — ${c.reason ?? 'niet geconfigureerd'}</li>`).join('')}
        </ul>
      </div>`;
    return;
  }

  host.innerHTML = usable
    .map((row) => {
      const gap = row.gap;
      const reading =
        Math.abs(gap) < 0.1
          ? 'Media en fans zitten op één lijn.'
          : gap < 0
            ? 'Fans zijn negatiever dan de pers.'
            : 'Fans zijn positiever dan de pers.';
      return `
        <div style="padding:14px 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px">
            <span style="display:inline-flex;align-items:center;gap:8px;font-weight:620">
              <span class="crest" style="background:${CLUB_COLORS[row.club]};width:10px;height:10px;border-radius:3px"></span>
              ${labels[row.club]}
            </span>
            <span class="delta ${gap > 0 ? 'up' : gap < 0 ? 'down' : 'flat'}">${fmt(gap)}</span>
          </div>
          <div style="font-size:.82rem;color:var(--text-secondary);margin-top:6px">
            Media <b style="color:${polarityColor(row.mediaScore)}">${fmt(row.mediaScore)}</b>
            (${row.mediaDocuments}) ·
            Fans <b style="color:${polarityColor(row.fanScore)}">${fmt(row.fanScore)}</b>
            (${row.fanDocuments}) — ${reading}
          </div>
        </div>`;
    })
    .join('');
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
      const text = item.title || item.body.slice(0, 140);

      return `
        <a class="feed-item" href="${item.url}" target="_blank" rel="noopener noreferrer">
          <span class="rail" style="background:${polarityColor(item.score)}"></span>
          <span class="val" style="color:${polarityColor(item.score)}">${fmt(item.score)}</span>
          <span>
            <span class="title">${escapeHtml(text)}</span>
            <span class="foot">
              ${clubs
                .map(
                  (club) =>
                    `<span class="tag club"><span class="dot" style="background:${CLUB_COLORS[club]}"></span>${labels[club]}</span>`,
                )
                .join('')}
              ${topics.map((topic) => `<span class="tag">${state.meta.topics[topic] ?? topic}</span>`).join('')}
              ${item.ambiguous ? '<span class="tag warn">mogelijk ironisch</span>' : ''}
              <span>${item.sourceName} · ${when}</span>
            </span>
          </span>
        </a>`;
    })
    .join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/* ---------------------------------------------------------------- sources */

function renderCollectors() {
  $('#collectors').innerHTML = state.meta.collectors
    .map(
      (collector) => `
        <div class="source-status">
          <span class="dot ${collector.configured ? 'on' : 'off'}"></span>
          <b style="min-width:74px">${collector.id}</b>
          <span class="why">${collector.reason ?? 'Actief'}</span>
        </div>`,
    )
    .join('');
}

function renderSourceTable(sources) {
  $('#source-table tbody').innerHTML = sources
    .map(
      (source) => `
        <tr>
          <td>${escapeHtml(source.sourceName)}</td>
          <td>${source.sourceKind}</td>
          <td class="num">${source.documents}</td>
          <td class="num" style="color:${polarityColor(source.score)}">${fmt(source.score)}</td>
        </tr>`,
    )
    .join('');
}

/* ------------------------------------------------------------------- boot */

async function refresh() {
  hideTooltip();
  try {
    const clubsParam = { clubs: activeClubs().join(',') };
    const [overview, timeline, topics, documents, divergence, sources] = await Promise.all([
      api('/api/overview'),
      api('/api/timeseries', clubsParam),
      api('/api/topics', clubsParam),
      api('/api/documents', { ...clubsParam, limit: '120' }),
      api('/api/divergence'),
      api('/api/sources'),
    ]);

    renderTiles(overview);
    renderTimeline(timeline);
    renderTopics(topics);
    renderDivergence(divergence);
    renderFeed(documents);
    renderSourceTable(sources);
  } catch (error) {
    $('#tiles').innerHTML = `<p class="loading">Kon data niet laden: ${escapeHtml(error.message)}</p>`;
  }
}

function wireControls() {
  for (const button of document.querySelectorAll('[data-days]')) {
    button.addEventListener('click', () => {
      state.days = Number(button.dataset.days);
      document
        .querySelectorAll('[data-days]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      refresh();
    });
  }

  for (const button of document.querySelectorAll('[data-source]')) {
    button.addEventListener('click', () => {
      state.sources = button.dataset.source;
      document
        .querySelectorAll('[data-source]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      refresh();
    });
  }

  // Club toggles keep their colour when others are switched off — the hue
  // belongs to the club, not to its position in the current selection.
  const host = $('#club-filters');
  for (const club of state.meta.clubs) {
    const button = document.createElement('button');
    button.className = 'chip';
    button.setAttribute('aria-pressed', 'true');
    button.innerHTML = `<span class="swatch" style="background:${CLUB_COLORS[club.id]}"></span>${club.shortName}`;
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

async function boot() {
  state.meta = await (await fetch('/api/meta')).json();
  renderCollectors();
  wireControls();
  await refresh();
}

boot();
