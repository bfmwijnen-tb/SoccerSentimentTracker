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
export function lineChart(container, { series, colors, labels }) {
  container.innerHTML = '';

  const days = [...new Set(series.flatMap((s) => s.points.map((p) => p.bucket)))].sort();
  if (days.length === 0) {
    container.innerHTML = '<p class="loading">Nog geen data voor deze periode.</p>';
    return;
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

  // Series lines. Gaps in a club's coverage break the line rather than
  // interpolating across them — a straight line over a silent week would invent
  // sentiment that was never measured.
  const endLabels = [];
  for (const s of series) {
    const byDay = new Map(s.points.map((p) => [p.bucket, p]));
    const segments = [];
    let current = [];
    for (const day of days) {
      const point = byDay.get(day);
      if (point) current.push(point);
      else if (current.length) {
        segments.push(current);
        current = [];
      }
    }
    if (current.length) segments.push(current);

    for (const segment of segments) {
      if (segment.length === 1) {
        el('circle', {
          cx: x(segment[0].bucket),
          cy: y(segment[0].score),
          r: 3,
          fill: colors[s.key],
        }, svg);
        continue;
      }
      el('path', {
        d: segment.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.bucket)},${y(p.score)}`).join(' '),
        fill: 'none',
        stroke: colors[s.key],
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }, svg);
    }

    const last = s.points[s.points.length - 1];
    if (last) endLabels.push({ key: s.key, y: y(last.score) });
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
  // If the stack overflowed the plot, shift the whole run back up so no label
  // escapes the chart.
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

  const markers = series.map((s) =>
    el('circle', {
      r: 4.5,
      fill: colors[s.key],
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
    series.forEach((s, i) => {
      const point = s.points.find((p) => p.bucket === day);
      const marker = markers[i];
      if (!point) {
        marker.setAttribute('opacity', 0);
        return;
      }
      marker.setAttribute('cx', x(day));
      marker.setAttribute('cy', y(point.score));
      marker.setAttribute('opacity', 1);
      rows.push(
        `<div class="tt-row"><span class="lbl"><span class="key" style="background:${colors[s.key]}"></span>${labels[s.key]}</span>` +
          `<span class="val">${fmt(point.score)} <span style="color:var(--text-muted);font-weight:400">· ${point.documents}</span></span></div>`,
      );
    });

    showTooltip(
      `<div class="tt-title">${formatDay(day)}</div>${rows.join('') || '<div class="tt-row"><span class="lbl">Geen data</span></div>'}`,
      event,
    );
  });

  overlay.addEventListener('pointerleave', () => {
    crosshair.setAttribute('opacity', 0);
    markers.forEach((m) => m.setAttribute('opacity', 0));
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
