'use strict';
// Lightweight, dependency-free SVG chart helpers. No client-side JS/canvas
// libraries — everything is plain server-rendered SVG so it works offline
// and needs no CDN. Follows the house palette: fixed categorical hue order,
// one axis, thin marks, a legend whenever more than one series is shown.

const { esc, fmtMoney } = require('./render');

// Validated categorical palette (fixed order — never cycle/reorder per series
// identity; a filter that drops a series must not repaint the survivors).
const CATEGORICAL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const INK_MUTED = '#898781';
const INK_SECONDARY = '#52514e';
const GRIDLINE = '#e1e0d9';
const BASELINE = '#c3c2b7';
const SEQUENTIAL_BLUE = '#2a78d6';

function colorForIndex(i) {
  return CATEGORICAL[i % CATEGORICAL.length];
}

function niceMax(rawMax) {
  if (rawMax <= 0) return 10;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const norm = rawMax / magnitude;
  let niceNorm;
  if (norm <= 1) niceNorm = 1;
  else if (norm <= 2) niceNorm = 2;
  else if (norm <= 5) niceNorm = 5;
  else niceNorm = 10;
  return niceNorm * magnitude;
}

// Multi-series line chart. series: [{ name, values: number[] }], labels: string[]
// yMax: optional fixed max (e.g. 100 for percentages); yFmt: value formatter.
function svgLineChart({ series, labels, width = 640, height = 220, yMax, yFmt, emptyText }) {
  const hasData = series.some((s) => s.values.some((v) => v !== null && v !== undefined));
  if (!hasData || labels.length === 0) {
    return `<div class="chart-empty" style="height:${height}px">${esc(emptyText || 'Not enough data yet.')}</div>`;
  }
  const padL = 44;
  const padR = 16;
  const padT = 16;
  const padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const allValues = series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined));
  const dataMax = Math.max(...allValues, 0);
  const max = yMax !== undefined ? yMax : niceMax(dataMax);
  const n = labels.length;
  const xStep = n > 1 ? plotW / (n - 1) : 0;
  const xAt = (i) => padL + xStep * i;
  const yAt = (v) => padT + plotH - (Math.max(0, Math.min(v, max)) / max) * plotH;
  const fmt = yFmt || ((v) => String(Math.round(v)));

  const yTicks = 4;
  const gridLines = [];
  for (let t = 0; t <= yTicks; t++) {
    const v = (max / yTicks) * t;
    const y = yAt(v);
    gridLines.push(
      `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="${GRIDLINE}" stroke-width="1"/>` +
        `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="${INK_MUTED}">${esc(fmt(v))}</text>`
    );
  }

  // Show at most ~7 x-axis labels to avoid crowding.
  const labelStride = Math.max(1, Math.ceil(n / 7));
  const xLabels = labels
    .map((l, i) => (i % labelStride === 0 || i === n - 1 ? `<text x="${xAt(i)}" y="${height - 8}" text-anchor="middle" font-size="11" fill="${INK_MUTED}">${esc(l)}</text>` : ''))
    .join('');

  const lines = series
    .map((s, si) => {
      const color = colorForIndex(si);
      const pts = s.values
        .map((v, i) => (v === null || v === undefined ? null : `${xAt(i)},${yAt(v)}`))
        .filter(Boolean)
        .join(' ');
      const dots = s.values
        .map((v, i) =>
          v === null || v === undefined
            ? ''
            : `<circle cx="${xAt(i)}" cy="${yAt(v)}" r="3" fill="${color}"><title>${esc(s.name)} · ${esc(labels[i])}: ${esc(fmt(v))}</title></circle>`
        )
        .join('');
      return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
    })
    .join('');

  const legend =
    series.length > 1
      ? `<div class="chart-legend">${series
          .map((s, si) => `<span class="chart-legend-item"><span class="chart-swatch" style="background:${colorForIndex(si)}"></span>${esc(s.name)}</span>`)
          .join('')}</div>`
      : '';

  return `
  <div class="chart-wrap">
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${esc(series.map((s) => s.name).join(', '))} chart">
      <line x1="${padL}" y1="${padT + plotH}" x2="${width - padR}" y2="${padT + plotH}" stroke="${BASELINE}" stroke-width="1"/>
      ${gridLines.join('')}
      ${lines}
      ${xLabels}
    </svg>
    ${legend}
  </div>`;
}

// Single-series bar chart. data: [{ label, value }]
function svgBarChart({ data, width = 640, height = 220, color = SEQUENTIAL_BLUE, valueFmt, emptyText }) {
  if (!data.length || data.every((d) => !d.value)) {
    return `<div class="chart-empty" style="height:${height}px">${esc(emptyText || 'Not enough data yet.')}</div>`;
  }
  const padL = 52;
  const padR = 16;
  const padT = 20;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const max = niceMax(Math.max(...data.map((d) => d.value), 0));
  const fmt = valueFmt || ((v) => String(Math.round(v)));
  const n = data.length;
  const gap = 10;
  const barW = Math.max(6, (plotW - gap * (n - 1)) / n);
  const yAt = (v) => padT + plotH - (Math.max(0, v) / max) * plotH;

  const yTicks = 4;
  const gridLines = [];
  for (let t = 0; t <= yTicks; t++) {
    const v = (max / yTicks) * t;
    const y = yAt(v);
    gridLines.push(
      `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="${GRIDLINE}" stroke-width="1"/>` +
        `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="${INK_MUTED}">${esc(fmt(v))}</text>`
    );
  }

  const bars = data
    .map((d, i) => {
      const x = padL + i * (barW + gap);
      const y = yAt(d.value);
      const h = padT + plotH - y;
      return `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(0, h)}" rx="4" fill="${color}"><title>${esc(d.label)}: ${esc(fmt(d.value))}</title></rect>
        <text x="${x + barW / 2}" y="${height - 8}" text-anchor="middle" font-size="11" fill="${INK_MUTED}">${esc(d.label)}</text>`;
    })
    .join('');

  return `
  <div class="chart-wrap">
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Bar chart">
      <line x1="${padL}" y1="${padT + plotH}" x2="${width - padR}" y2="${padT + plotH}" stroke="${BASELINE}" stroke-width="1"/>
      ${gridLines.join('')}
      ${bars}
    </svg>
  </div>`;
}

// A small inline magnitude bar for use inside a table cell (vendor comparison, etc).
function miniBar(value, max, color = SEQUENTIAL_BLUE) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return `<div class="mini-bar-track"><div class="mini-bar-fill" style="width:${pct}%;background:${color}"></div></div>`;
}

module.exports = { svgLineChart, svgBarChart, miniBar, colorForIndex, fmtMoney };
