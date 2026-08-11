/**
 * Hand-rolled SVG charts.
 *
 * Mark specs follow one rule set throughout: 2px lines, >=8px hover markers,
 * a 2px surface-coloured ring where marks overlap, a 2px surface gap between
 * adjacent bars, recessive grid and axes, and direct labels rather than a
 * number on every point.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  if (parent) parent.appendChild(node);
  return node;
}

/** Single shared tooltip element — one node, repositioned, never re-created. */
let tooltipNode = null;
function tooltip() {
  if (!tooltipNode) {
    tooltipNode = document.createElement('div');
    tooltipNode.className = 'tooltip';
    tooltipNode.setAttribute('role', 'status');
    document.body.appendChild(tooltipNode);
  }
  return tooltipNode;
}

function showTooltip(html, event) {
  const node = tooltip();
  node.innerHTML = html;
  node.dataset.visible = 'true';

  // Flip the tooltip to the other side of the cursor near the viewport edge so
  // it never gets clipped.
  const rect = node.getBoundingClientRect();
  const pad = 14;
  let left = event.clientX + pad;
  let top = event.clientY + pad;
  if (left + rect.width > window.innerWidth - 8) left = event.clientX - rect.width - pad;
  if (top + rect.height > window.innerHeight - 8) top = event.clientY - rect.height - pad;
  node.style.left = `${Math.max(8, left)}px`;
  node.style.top = `${Math.max(8, top)}px`;
}

function hideTooltip() {
  if (tooltipNode) tooltipNode.dataset.visible = 'false';
}

/**
 * SVG presentation attributes (`stroke="..."`, `fill="..."`) cannot hold a
 * `var()` reference, so resolving tokens to hex at render time was baking the
 * current theme into the chart: switching to dark left light-mode grid lines
 * glowing on a dark surface and axis labels almost invisible. Writing the token
 * into the `style` attribute instead keeps the reference live, so charts follow
 * both the toggle and an OS-level theme change with no re-render.
 */
function paint(properties) {
  return Object.entries(properties)
    .map(([property, token]) => `${property}:var(${token})`)
    .join(';');
}

const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(2);

function escapeText(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Fills a series onto every day in the domain.
 *
 * Days with no coverage get a linearly interpolated value and are flagged, so
 * the line stays continuous while the tooltip can still say the number was
 * inferred rather than measured. Leading and trailing gaps are left empty —
 * extrapolating past the ends of the data would be inventing, not smoothing.
 */
function fillGaps(points, days) {
  const byDay = new Map(points.map((p) => [p.bucket, p]));
  const known = days.map((day, index) => (byDay.has(day) ? index : -1)).filter((i) => i >= 0);
  if (known.length === 0) return [];

  const first = known[0];
  const last = known[known.length - 1];
  const filled = [];

  for (let index = first; index <= last; index += 1) {
    const day = days[index];
    const point = byDay.get(day);

    if (point) {
      filled.push({ ...point, measured: true });
      continue;
    }

    const before = known.filter((k) => k < index).pop();
    const after = known.find((k) => k > index);
    const a = byDay.get(days[before]);
    const b = byDay.get(days[after]);
    const ratio = (index - before) / (after - before);

    filled.push({
      bucket: day,
      score: a.score + (b.score - a.score) * ratio,
      documents: 0,
      measured: false,
    });
  }

  return filled;
}

/**
 * Centred rolling mean. Daily sentiment is genuinely spiky — a single strongly
 * worded article moves a thin day a long way — and the shape of the trend is
 * what the chart is for, so smoothing over a few days reads far better than the
 * raw sawtooth. The underlying values stay available in the tooltip.
 */
function rollingMean(points, window) {
  if (window <= 1) return points;
  const half = Math.floor(window / 2);

  return points.map((point, index) => {
    const from = Math.max(0, index - half);
    const to = Math.min(points.length, index + half + 1);
    const slice = points.slice(from, to);
    const mean = slice.reduce((sum, p) => sum + p.score, 0) / slice.length;
    return { ...point, raw: point.score, score: mean };
  });
}

/**
 * Monotone cubic path (Fritsch–Carlson).
 *
 * A plain cubic spline overshoots around sharp changes, which on a bounded
 * -1..1 sentiment axis would draw the line outside the range the data can even
 * occupy. The monotone variant keeps the curve inside the values it connects,
 * so it looks fluent without ever implying a score that never happened.
 */
function monotonePath(coordinates) {
  const n = coordinates.length;
  if (n === 0) return '';
  if (n === 1) return `M${coordinates[0].x},${coordinates[0].y}`;
  if (n === 2) return `M${coordinates[0].x},${coordinates[0].y}L${coordinates[1].x},${coordinates[1].y}`;

  const dx = [];
  const dy = [];
  const slope = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = coordinates[i + 1].x - coordinates[i].x;
    dy[i] = coordinates[i + 1].y - coordinates[i].y;
    slope[i] = dy[i] / dx[i];
  }

  const tangent = [slope[0]];
  for (let i = 1; i < n - 1; i += 1) {
    if (slope[i - 1] * slope[i] <= 0) {
      tangent[i] = 0; // local extremum: flatten so the curve cannot overshoot
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangent[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }
  tangent[n - 1] = slope[n - 2];

  let path = `M${coordinates[0].x},${coordinates[0].y}`;
  for (let i = 0; i < n - 1; i += 1) {
    const c1x = coordinates[i].x + dx[i] / 3;
    const c1y = coordinates[i].y + (tangent[i] * dx[i]) / 3;
    const c2x = coordinates[i + 1].x - dx[i] / 3;
    const c2y = coordinates[i + 1].y - (tangent[i + 1] * dx[i]) / 3;
    path += `C${c1x},${c1y} ${c2x},${c2y} ${coordinates[i + 1].x},${coordinates[i + 1].y}`;
  }
  return path;
}

function formatDay(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('nl-NL', {
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Multi-series sentiment timeline.
 *
 * A shared y-domain of [-1, 1] with an emphasised zero line: the whole point of
 * the chart is which side of zero a fanbase sits on, so the baseline is the
 * reference the eye should snap to, not the bottom of the plot.
 */
export function lineChart(container, { series, colors, labels, markers = [], smoothing = 3 }) {
  container.innerHTML = '';

  // A continuous date axis: every day between the first and last observation,
  // whether or not anything was published on it. Without this a quiet week
  // silently compresses on the x-axis and the trend reads faster than it was.
  const observed = [...new Set(series.flatMap((s) => s.points.map((p) => p.bucket)))].sort();
  if (observed.length === 0) {
    container.innerHTML = '<p class="loading">Nog geen data voor deze periode.</p>';
    return;
  }

  const days = [];
  for (
    let cursor = new Date(`${observed[0]}T00:00:00Z`);
    cursor <= new Date(`${observed[observed.length - 1]}T00:00:00Z`);
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    days.push(cursor.toISOString().slice(0, 10));
  }

  const W = 900;
  const H = 340;
  const M = { top: 16, right: 96, bottom: 34, left: 44 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  const svg = el('svg', {
    class: 'chart',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': `Sentiment per dag voor ${series.map((s) => labels[s.key]).join(', ')}`,
  });

  const x = (day) =>
    M.left + (days.length === 1 ? plotW / 2 : (days.indexOf(day) / (days.length - 1)) * plotW);
  const y = (value) => M.top + ((1 - value) / 2) * plotH;

  // Grid + y axis.
  for (const tick of [1, 0.5, 0, -0.5, -1]) {
    const yy = y(tick);
    el('line', {
      x1: M.left,
      x2: M.left + plotW,
      y1: yy,
      y2: yy,
      style: paint({ stroke: tick === 0 ? '--axis' : '--grid' }),
      'stroke-width': tick === 0 ? 1.5 : 1,
    }, svg);
    el('text', {
      x: M.left - 10,
      y: yy + 4,
      'text-anchor': 'end',
      'font-size': 11,
      style: paint({ fill: '--text-muted' }),
    }, svg).textContent = tick === 0 ? '0' : fmt(tick);
  }

  // x axis: at most 7 labels, evenly spaced, so they never collide.
  const step = Math.max(1, Math.ceil(days.length / 7));
  days.forEach((day, index) => {
    if (index % step !== 0 && index !== days.length - 1) return;
    el('text', {
      x: x(day),
      y: H - 12,
      'text-anchor': 'middle',
      'font-size': 11,
      style: paint({ fill: '--text-muted' }),
    }, svg).textContent = formatDay(day);
  });

  // Match markers first, so they sit behind the data lines. Past a few dozen
  // they stop being annotation and become a hatch pattern across the plot, so
  // the guide lines are dropped and only the axis dots remain — the tooltip
  // still reports the fixture for whatever day is hovered.
  const denseMarkers = markers.length > 30;

  for (const marker of markers) {
    const day = marker.playedAt.slice(0, 10);
    if (!days.includes(day)) continue;
    const mx = x(day);
    if (!denseMarkers) {
      el('line', {
        x1: mx, x2: mx, y1: M.top, y2: M.top + plotH,
        style: paint({ stroke: '--grid' }),
        'stroke-width': 1,
        'stroke-dasharray': '3 4',
      }, svg);
    }
    el('circle', {
      cx: mx, cy: M.top + plotH + 10, r: denseMarkers ? 2 : 3.5,
      fill: colors[marker.club] ?? 'var(--neutral)',
      style: paint({ stroke: '--surface-1' }),
      'stroke-width': 1.5,
    }, svg);
  }

  // Series lines. Sparse days are bridged and the result is smoothed, so the
  // trend reads as a continuous shape rather than a sawtooth; interpolated days
  // are flagged in the tooltip so a bridged value is never mistaken for a
  // measured one.
  const endLabels = [];
  const prepared = new Map();

  for (const s2 of series) {
    const filled = fillGaps(s2.points, days);
    const smoothed = rollingMean(filled, smoothing);
    prepared.set(s2.key, smoothed);
    if (smoothed.length === 0) continue;

    const coordinates = smoothed.map((p) => ({ x: x(p.bucket), y: y(p.score) }));

    el('path', {
      d: monotonePath(coordinates),
      fill: 'none',
      stroke: colors[s2.key],
      'stroke-width': 2,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    }, svg);

    const last = smoothed[smoothed.length - 1];
    endLabels.push({ key: s2.key, y: y(last.score) });
  }

  // Direct labels at the line ends — this is what carries identity when a
  // colour is hard to distinguish, and the relief for aqua's contrast on the
  // light surface. Clubs converging on a similar score would otherwise print
  // their labels on top of each other, so nudge them apart: sort by position,
  // then walk down enforcing a minimum gap.
  const LABEL_GAP = 15;
  endLabels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < endLabels.length; i += 1) {
    const gap = endLabels[i].y - endLabels[i - 1].y;
    if (gap < LABEL_GAP) endLabels[i].y = endLabels[i - 1].y + LABEL_GAP;
  }
  const overflow = endLabels[endLabels.length - 1]?.y - (M.top + plotH);
  if (overflow > 0) for (const label of endLabels) label.y -= overflow;

  for (const label of endLabels) {
    el('text', {
      x: M.left + plotW + 10,
      y: label.y + 4,
      'font-size': 12,
      'font-weight': 620,
      fill: colors[label.key],
    }, svg).textContent = labels[label.key];
  }

  // Crosshair + hover layer.
  const crosshair = el('line', {
    y1: M.top,
    y2: M.top + plotH,
    style: paint({ stroke: '--border-strong' }),
    'stroke-width': 1,
    opacity: 0,
  }, svg);

  const markers2 = series.map((s2) =>
    el('circle', {
      'data-series': s2.key,
      r: 4.5,
      fill: colors[s2.key],
      style: paint({ stroke: '--surface-1' }),
      'stroke-width': 2,
      opacity: 0,
    }, svg),
  );

  const overlay = el('rect', {
    x: M.left,
    y: M.top,
    width: plotW,
    height: plotH,
    fill: 'transparent',
    style: 'cursor:crosshair',
  }, svg);

  overlay.addEventListener('pointermove', (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    const ratio = (px - M.left) / plotW;
    const index = Math.max(0, Math.min(days.length - 1, Math.round(ratio * (days.length - 1))));
    const day = days[index];

    crosshair.setAttribute('x1', x(day));
    crosshair.setAttribute('x2', x(day));
    crosshair.setAttribute('opacity', 1);

    const rows = [];
    series.forEach((s2, i) => {
      const smoothed = prepared.get(s2.key) ?? [];
      const point = smoothed.find((p) => p.bucket === day);
      const marker = markers2[i];
      if (!point) {
        marker.setAttribute('opacity', 0);
        return;
      }
      marker.setAttribute('cx', x(day));
      marker.setAttribute('cy', y(point.score));
      marker.setAttribute('opacity', point.measured ? 1 : 0.35);

      const value = point.raw ?? point.score;
      const note = point.measured
        ? `<span style="color:var(--text-muted);font-weight:400">· ${point.documents}</span>`
        : '<span style="color:var(--text-muted);font-weight:400">· geen data</span>';
      rows.push(
        `<div class="tt-row"><span class="lbl"><span class="key" style="background:${colors[s2.key]}"></span>${labels[s2.key]}</span>` +
          `<span class="val">${fmt(value)} ${note}</span></div>`,
      );
    });

    const played = markers.filter((m) => m.playedAt.slice(0, 10) === day);
    const fixtures = played
      .map((m) => {
        const verdict = m.outcome === 'win' ? 'W' : m.outcome === 'draw' ? 'G' : m.outcome === 'loss' ? 'V' : '';
        const score = m.scoreline ? ` ${m.scoreline}` : '';
        return `<div class="tt-row"><span class="lbl">${m.home ? 'thuis' : 'uit'} v ${escapeText(m.opponent)}</span><span class="val">${verdict}${score}</span></div>`;
      })
      .join('');

    showTooltip(
      `<div class="tt-title">${formatDay(day)}</div>${rows.join('') || '<div class="tt-row"><span class="lbl">Geen data</span></div>'}${fixtures ? `<div class="tt-sep"></div>${fixtures}` : ''}`,
      event,
    );
  });

  overlay.addEventListener('pointerleave', () => {
    crosshair.setAttribute('opacity', 0);
    markers2.forEach((m) => m.setAttribute('opacity', 0));
    hideTooltip();
  });

  container.appendChild(svg);
}

/**
 * Grouped diverging bars: one row per topic, one bar per club, anchored to a
 * centre zero line so "what are they angry about" reads as direction and
 * length at once.
 */
export function topicChart(container, { topics, clubs, colors, labels, topicLabels }) {
  container.innerHTML = '';
  if (topics.length === 0) {
    container.innerHTML = '<p class="loading">Nog geen onderwerpen gevonden.</p>';
    return;
  }

  const rowH = 22;
  const groupGap = 14;
  const W = 900;
  const M = { top: 8, right: 20, bottom: 30, left: 130 };
  const groupH = clubs.length * rowH + groupGap;
  const H = M.top + topics.length * groupH + M.bottom;
  const plotW = W - M.left - M.right;
  const centre = M.left + plotW / 2;

  const svg = el('svg', {
    class: 'chart',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': 'Sentiment per onderwerp per club',
  });

  const scale = (value) => (value / 1) * (plotW / 2);

  for (const tick of [-1, -0.5, 0, 0.5, 1]) {
    const xx = centre + scale(tick);
    el('line', {
      x1: xx,
      x2: xx,
      y1: M.top,
      y2: H - M.bottom,
      style: paint({ stroke: tick === 0 ? '--axis' : '--grid' }),
      'stroke-width': tick === 0 ? 1.5 : 1,
    }, svg);
    el('text', {
      x: xx,
      y: H - 12,
      'text-anchor': 'middle',
      'font-size': 11,
      style: paint({ fill: '--text-muted' }),
    }, svg).textContent = tick === 0 ? '0' : fmt(tick);
  }

  topics.forEach((topic, ti) => {
    const groupTop = M.top + ti * groupH;

    el('text', {
      x: M.left - 12,
      y: groupTop + (clubs.length * rowH) / 2 + 4,
      'text-anchor': 'end',
      'font-size': 12,
      'font-weight': 600,
      style: paint({ fill: '--text-primary' }),
    }, svg).textContent = topicLabels[topic.topic] ?? topic.topic;

    clubs.forEach((club, ci) => {
      const entry = topic.byClub[club];
      if (!entry) return;

      const barH = rowH - 6;
      const yTop = groupTop + ci * rowH + 3;
      const width = Math.abs(scale(entry.score));
      const negative = entry.score < 0;

      // A 2px surface-coloured gap keeps adjacent club bars from reading as
      // one continuous block.
      el('rect', {
        x: negative ? centre - width : centre,
        y: yTop,
        width: Math.max(width, 1.5),
        height: barH,
        rx: 4,
        fill: colors[club],
        stroke: 'var(--surface-1)',
        'stroke-width': 2,
        'paint-order': 'stroke',
        style: 'cursor:pointer',
      }, svg).addEventListener('pointerenter', function handler(event) {
        showTooltip(
          `<div class="tt-title">${topicLabels[topic.topic] ?? topic.topic}</div>` +
            `<div class="tt-row"><span class="lbl"><span class="key square" style="background:${colors[club]}"></span>${labels[club]}</span>` +
            `<span class="val">${fmt(entry.score)}</span></div>` +
            `<div class="tt-row"><span class="lbl">Berichten</span><span class="val">${entry.documents}</span></div>`,
          event,
        );
        this.addEventListener('pointerleave', hideTooltip, { once: true });
      });
    });
  });

  container.appendChild(svg);
}

export { hideTooltip };
