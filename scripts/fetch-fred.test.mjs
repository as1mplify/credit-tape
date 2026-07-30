import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFredCsv, toBasisPoints } from './fetch-fred.mjs';

test('parses the modern observation_date header', () => {
  const csv = ['observation_date,BAMLH0A0HYM2', '2026-07-27,2.81', '2026-07-28,2.94'].join('\n');
  const rows = parseFredCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], 2.94);
});

test('parses the legacy DATE header', () => {
  const csv = ['DATE,BAMLC0A0CM', '1996-12-31,1.02'].join('\n');
  assert.equal(parseFredCsv(csv).length, 1);
});

test('skips missing observations published as "."', () => {
  const csv = ['observation_date,X', '2026-07-27,3.10', '2026-07-28,.', '2026-07-29,3.15'].join('\n');
  const rows = parseFredCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r[1]), [3.1, 3.15]);
});

test('sorts ascending and emits epoch millis in UTC', () => {
  const csv = ['observation_date,X', '2026-07-29,2', '2026-07-27,1'].join('\n');
  const rows = parseFredCsv(csv);
  assert.equal(rows[0][1], 1);
  assert.equal(new Date(rows[0][0]).toISOString(), '2026-07-27T00:00:00.000Z');
});

test('converts percentage points to basis points', () => {
  const rows = toBasisPoints([[0, 3.42]], 'percent');
  assert.equal(rows[0][1], 342);
});

test('leaves already-bps series alone', () => {
  assert.equal(toBasisPoints([[0, 342]], 'bps')[0][1], 342);
});

test('throws on an empty or malformed feed', () => {
  assert.throws(() => parseFredCsv('observation_date,X'), /no observations/);
  assert.throws(() => parseFredCsv('observation_date,X\n2026-07-28,.'), /no numeric rows/);
});
