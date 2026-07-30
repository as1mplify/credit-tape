/* Credit Tape — reads the JSON produced by scripts/fetch-fred.mjs */

const WINDOWS = [
  { key: '1M', label: '1M', days: 30 },
  { key: '3M', label: '3M', days: 91 },
  { key: '6M', label: '6M', days: 182 },
  { key: '1Y', label: '1Y', days: 365 },
  { key: '3Y', label: '3Y', days: 1095 },
  { key: 'MAX', label: 'Max', days: null },
];

const state = {
  manifest: null,
  cache: new Map(),
  window: '1Y',
  active: new Set(),
  chart: null,
};

const el = {
  cards: document.getElementById('cards'),
  windows: document.getElementById('windows'),
  toggles: document.getElementById('toggles'),
  canvas: document.getElementById('chart'),
  stampMark: document.getElementById('stamp-mark'),
  stampPulled: document.getElementById('stamp-pulled'),
};

const fmtBps = (n) => `${Math.round(n).toLocaleString('en-US')}`;
const fmtDelta = (n) => (n === null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n))}`);
const dirClass = (n) => (n === null ? 'flat' : n > 0.5 ? 'up' : n < -0.5 ? 'down' : 'flat');

function fmtDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/* ---------- boot ---------- */

async function init() {
  let manifest;
  try {
    const res = await fetch('data/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    manifest = await res.json();
  } catch {
    el.cards.innerHTML =
      '<p class="state">No data files yet. Run <code>npm run fetch</code> to pull the latest ' +
      'end-of-day marks from FRED, then reload.</p>';
    return;
  }

  state.manifest = manifest;
  manifest.series.slice(0, 2).forEach((s) => state.active.add(s.id));

  el.stampMark.textContent = fmtDate(
    manifest.series.reduce((a, s) => (s.latestDate > a ? s.latestDate : a), '0000-00-00')
  );
  el.stampPulled.textContent = new Date(manifest.generatedAt).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';

  renderCards();
  renderControls();
  await renderChart();
}

/* ---------- board ---------- */

function renderCards() {
  el.cards.innerHTML = '';

  state.manifest.series.forEach((s, i) => {
    const card = document.createElement('article');
    card.className = 'card';
    card.style.animationDelay = `${i * 55}ms`;

    // Where a month ago sat inside the same 3y range — the ghost tick.
    const then = s.change1m === null ? null : s.latest - s.change1m;
    const span = s.high3y - s.low3y || 1;
    const pctNow = Math.min(1, Math.max(0, (s.latest - s.low3y) / span));
    const pctThen = then === null ? null : Math.min(1, Math.max(0, (then - s.low3y) / span));

    card.innerHTML = `
      <div class="card-head">
        <span class="card-swatch" style="background:${s.color}"></span>
        <span class="card-name">${s.short}</span>
      </div>

      <div class="card-figure">
        <span class="card-value">${fmtBps(s.latest)}</span>
        <span class="card-unit">bps</span>
      </div>

      <dl class="card-deltas">
        <div><dt>1d</dt><dd class="${dirClass(s.change1d)}">${fmtDelta(s.change1d)}</dd></div>
        <div><dt>1w</dt><dd class="${dirClass(s.change1w)}">${fmtDelta(s.change1w)}</dd></div>
        <div><dt>1m</dt><dd class="${dirClass(s.change1m)}">${fmtDelta(s.change1m)}</dd></div>
        <div><dt>1y</dt><dd class="${dirClass(s.change1y)}">${fmtDelta(s.change1y)}</dd></div>
      </dl>

      <div class="rail">
        <div class="rail-track">
          <div class="rail-line"></div>
          ${pctThen === null ? '' : `<div class="rail-tick is-then" style="left:${pctThen * 100}%" title="One month ago"></div>`}
          <div class="rail-tick is-now" style="left:0%;background:${s.color}"></div>
        </div>
        <div class="rail-scale">
          <span>${fmtBps(s.low3y)}</span>
          <span>${fmtBps(s.high3y)}</span>
        </div>
        <p class="rail-caption">${percentileSentence(s.percentile3y)} of its 3-year range. ${s.note}.</p>
      </div>
    `;

    el.cards.appendChild(card);

    // Animate the live tick into place after paint.
    const tick = card.querySelector('.is-now');
    requestAnimationFrame(() => { tick.style.left = `${pctNow * 100}%`; });
  });
}

function percentileSentence(p) {
  const pct = Math.round(p * 100);
  if (pct <= 10) return `Pinned near the tight end — ${pct}th percentile`;
  if (pct >= 90) return `At the wide end — ${pct}th percentile`;
  return `${pct}th percentile`;
}

/* ---------- controls ---------- */

function renderControls() {
  WINDOWS.forEach((w) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = w.label;
    b.setAttribute('aria-pressed', String(w.key === state.window));
    b.addEventListener('click', () => {
      state.window = w.key;
      el.windows.querySelectorAll('.chip').forEach((c) =>
        c.setAttribute('aria-pressed', String(c.textContent === w.label))
      );
      renderChart();
    });
    el.windows.appendChild(b);
  });

  state.manifest.series.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('aria-pressed', String(state.active.has(s.id)));
    b.innerHTML = `<span class="chip-dot" style="background:${s.color}"></span>${s.short}`;
    b.addEventListener('click', () => {
      if (state.active.has(s.id)) {
        if (state.active.size === 1) return; // keep at least one line on the chart
        state.active.delete(s.id);
      } else {
        state.active.add(s.id);
      }
      b.setAttribute('aria-pressed', String(state.active.has(s.id)));
      renderChart();
    });
    el.toggles.appendChild(b);
  });
}

/* ---------- chart ---------- */

async function loadSeries(id) {
  if (state.cache.has(id)) return state.cache.get(id);
  const res = await fetch(`data/${id}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${id}`);
  const json = await res.json();
  state.cache.set(id, json);
  return json;
}

async function renderChart() {
  const win = WINDOWS.find((w) => w.key === state.window);
  const specs = state.manifest.series.filter((s) => state.active.has(s.id));
  const loaded = await Promise.all(specs.map((s) => loadSeries(s.id)));

  const datasets = loaded.map((json, i) => {
    const cutoff = win.days ? Date.now() - win.days * 86_400_000 : -Infinity;
    return {
      label: specs[i].short,
      data: json.observations
        .filter(([ts]) => ts >= cutoff)
        .map(([ts, v]) => ({ x: ts, y: v })),
      borderColor: specs[i].color,
      backgroundColor: specs[i].color,
      borderWidth: 1.6,
      pointRadius: 0,
      pointHitRadius: 12,
      tension: 0,
    };
  });

  if (state.chart) state.chart.destroy();

  const grid = { color: '#16202e', drawTicks: false };
  const ticks = { color: '#5b6b81', font: { family: '"IBM Plex Mono", monospace', size: 10 } };

  state.chart = new Chart(el.canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 400 },
      scales: {
        x: {
          type: 'linear',
          grid,
          border: { color: '#1e2a3c' },
          ticks: {
            ...ticks,
            maxTicksLimit: 8,
            autoSkip: true,
            callback: (v) =>
              new Date(v).toLocaleDateString('en-GB', {
                month: 'short',
                year: win.days && win.days <= 182 ? undefined : '2-digit',
                day: win.days && win.days <= 91 ? '2-digit' : undefined,
                timeZone: 'UTC',
              }),
          },
        },
        y: {
          grid,
          border: { display: false },
          ticks: { ...ticks, callback: (v) => `${v}` },
          title: {
            display: true,
            text: 'bps',
            color: '#5b6b81',
            font: { family: '"IBM Plex Mono", monospace', size: 10 },
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#121a27',
          borderColor: '#1e2a3c',
          borderWidth: 1,
          titleColor: '#8698b0',
          bodyColor: '#dce3ed',
          titleFont: { family: '"IBM Plex Mono", monospace', size: 10 },
          bodyFont: { family: '"IBM Plex Mono", monospace', size: 12 },
          padding: 10,
          displayColors: true,
          boxWidth: 8,
          boxHeight: 8,
          callbacks: {
            title: (items) =>
              new Date(items[0].parsed.x).toLocaleDateString('en-GB', {
                day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
              }),
            label: (item) => ` ${item.dataset.label}  ${Math.round(item.parsed.y)} bps`,
          },
        },
      },
    },
  });
}

init();
