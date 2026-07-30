#!/usr/bin/env node
/**
 * Pulls end-of-day credit spread series from FRED and writes static JSON
 * into public/data/. No API key required — fredgraph.csv is a public endpoint.
 *
 * Run: npm run fetch
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'public/data');

/**
 * unit: 'percent' means FRED publishes the value in percentage points and we
 * multiply by 100 to get basis points. 'bps' means it is already in bps.
 *
 * Note on the source doc: BAMLEMHBHYCRPIUSHPTRIV is a total-return index level,
 * not a spread — charting it next to OAS series is meaningless. Replaced with
 * BAMLEMCBPIOAS (ICE BofA Emerging Markets Corporate Plus Index OAS).
 */
const SERIES = [
  {
    id: 'BAMLH0A0HYM2',
    short: 'US HY',
    label: 'US High Yield OAS',
    note: 'Closest free daily proxy for CDX.NA.HY',
    unit: 'percent',
    color: '#E8833A',
  },
  {
    id: 'BAMLC0A0CM',
    short: 'US IG',
    label: 'US Investment Grade OAS',
    note: 'Closest free daily proxy for CDX.NA.IG',
    unit: 'percent',
    color: '#4FC3B0',
  },
  {
    id: 'BAMLC0A4CBBB',
    short: 'BBB',
    label: 'BBB Corporate OAS',
    note: 'The IG/HY boundary — first to gap in a downgrade cycle',
    unit: 'percent',
    color: '#7AA2F7',
  },
  {
    id: 'BAMLH0A3CCC',
    short: 'CCC',
    label: 'CCC & Lower High Yield OAS',
    note: 'Distress tail. Leads HY at turning points',
    unit: 'percent',
    color: '#C792EA',
  },
  {
    id: 'BAMLEMCBPIOAS',
    short: 'EM Corp',
    label: 'Emerging Markets Corporate OAS',
    note: 'Sovereign and corporate EM credit risk',
    unit: 'percent',
    color: '#F7C948',
  },
  {
    id: 'BAMLH0A0HYM2EY',
    short: 'HY Yield',
    label: 'US High Yield Effective Yield',
    note: 'All-in yield, not a spread — shown in bps for scale consistency',
    unit: 'percent',
    color: '#8FA3BF',
  },
];

const FRED_CSV = (id) =>
  `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`;

/**
 * FRED's CSV is two columns. The date header has been both `DATE` and
 * `observation_date` over the years, so we key off position, not name.
 * Missing observations are published as a bare `.`.
 *
 * @returns {[number, number][]} [epochMillis, value] pairs, ascending.
 */
export function parseFredCsv(csv) {
  const rows = csv.trim().split(/\r?\n/);
  if (rows.length < 2) throw new Error('CSV has no observations');

  const header = rows[0].split(',');
  if (header.length < 2) throw new Error(`Unexpected CSV header: ${rows[0]}`);

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const line = rows[i];
    if (!line) continue;
    const comma = line.indexOf(',');
    if (comma === -1) continue;

    const rawDate = line.slice(0, comma).trim();
    const rawValue = line.slice(comma + 1).trim();
    if (rawValue === '.' || rawValue === '') continue;

    const value = Number(rawValue);
    const ts = Date.parse(`${rawDate}T00:00:00Z`);
    if (!Number.isFinite(value) || !Number.isFinite(ts)) continue;

    out.push([ts, value]);
  }

  if (out.length === 0) throw new Error('CSV parsed but contained no numeric rows');
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** Converts published units to basis points and rounds to 0.1bp. */
export function toBasisPoints(observations, unit) {
  const factor = unit === 'percent' ? 100 : 1;
  return observations.map(([ts, v]) => [ts, Math.round(v * factor * 10) / 10]);
}

/** Value as of N calendar days before the last observation (last on/before). */
function valueDaysAgo(observations, days) {
  const lastTs = observations[observations.length - 1][0];
  const target = lastTs - days * 86_400_000;
  for (let i = observations.length - 1; i >= 0; i--) {
    if (observations[i][0] <= target) return observations[i][1];
  }
  return null;
}

/** Where today sits inside its trailing 3-year range, 0–1. */
function rangeStats(observations, days = 1095) {
  const cutoff = observations[observations.length - 1][0] - days * 86_400_000;
  const window = observations.filter(([ts]) => ts >= cutoff);
  const values = window.map(([, v]) => v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const latest = values[values.length - 1];
  const pct = max === min ? 0.5 : (latest - min) / (max - min);
  return { min, max, percentile: Math.round(pct * 1000) / 1000 };
}

async function fetchWithRetry(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          // FRED rejects some default agents outright.
          'User-Agent': 'eod-credit-dashboard/1.0 (+https://github.com)',
          Accept: 'text/csv,*/*',
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        const backoff = 1000 * 2 ** (attempt - 1);
        console.warn(`  retry ${attempt}/${attempts - 1} in ${backoff}ms — ${err.message}`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastError;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: 'Federal Reserve Economic Data (FRED), ICE BofA index families',
    series: [],
  };
  const failures = [];

  for (const spec of SERIES) {
    process.stdout.write(`Fetching ${spec.id} (${spec.label})… `);
    try {
      const csv = await fetchWithRetry(FRED_CSV(spec.id));
      const observations = toBasisPoints(parseFredCsv(csv), spec.unit);

      const latest = observations[observations.length - 1];
      const prev = observations.length > 1 ? observations[observations.length - 2][1] : latest[1];
      const stats = rangeStats(observations);

      await writeFile(
        resolve(OUT_DIR, `${spec.id}.json`),
        JSON.stringify({
          id: spec.id,
          label: spec.label,
          unit: 'bps',
          observations,
        })
      );

      manifest.series.push({
        id: spec.id,
        short: spec.short,
        label: spec.label,
        note: spec.note,
        color: spec.color,
        unit: 'bps',
        latest: latest[1],
        latestDate: new Date(latest[0]).toISOString().slice(0, 10),
        change1d: Math.round((latest[1] - prev) * 10) / 10,
        change1w: diff(latest[1], valueDaysAgo(observations, 7)),
        change1m: diff(latest[1], valueDaysAgo(observations, 30)),
        change1y: diff(latest[1], valueDaysAgo(observations, 365)),
        low3y: stats.min,
        high3y: stats.max,
        percentile3y: stats.percentile,
        points: observations.length,
      });

      console.log(`ok — ${observations.length} obs, latest ${latest[1]}bps`);
    } catch (err) {
      console.error(`FAILED — ${err.message}`);
      failures.push({ id: spec.id, error: err.message });
    }
  }

  if (manifest.series.length === 0) {
    console.error('\nEvery series failed. Not overwriting manifest.json.');
    process.exit(1);
  }

  manifest.failures = failures;
  await writeFile(resolve(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(
    `\nWrote ${manifest.series.length}/${SERIES.length} series to public/data/` +
      (failures.length ? ` (${failures.length} failed)` : '')
  );
}

function diff(latest, past) {
  if (past === null) return null;
  return Math.round((latest - past) * 10) / 10;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
