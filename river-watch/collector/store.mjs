// River Watch - dataset files
// Created by Josh Avard
import fs from 'node:fs';
import path from 'node:path';
import { DATA, CFG, readCsv, writeCsv, localDate, unitFor, round } from './lib.mjs';

const fmtLocalTime = (t) => new Intl.DateTimeFormat('en-CA', {
  timeZone: CFG.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
}).format(new Date(t)).replace(',', '');

// ---------------- hourly readings: data/hourly/YYYY-MM/DD.csv (UTC days, one row per site, variable, hour)
// Small daily files keep each hourly git commit tiny.
const HOURLY_HEADER = ['time_utc', 'time_local', 'site', 'variable', 'value', 'unit', 'quality'];
export function upsertHourly(site, kind, points) {
  const byMonth = {};
  for (const p of points) {
    const iso = new Date(p.t).toISOString();
    (byMonth[iso.slice(0, 10)] ||= []).push([iso.slice(0, 16) + 'Z', fmtLocalTime(p.t), site.id, kind, p.v, kind === 'level' ? unitFor(site) : 'ML/day', p.q]);
  }
  let added = 0;
  for (const [day, rows] of Object.entries(byMonth)) {
    const file = path.join(DATA, 'hourly', day.slice(0, 7), day.slice(8, 10) + '.csv');
    const map = new Map(readCsv(file).map((r) => [r[0] + '|' + r[2] + '|' + r[3], r]));
    for (const r of rows) { const k = r[0] + '|' + r[2] + '|' + r[3]; if (!map.has(k)) added++; map.set(k, r); }
    const all = [...map.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[2] < b[2] ? -1 : 1));
    writeCsv(file, HOURLY_HEADER, all);
  }
  return added;
}

/** Last `days` of hourly values for one site and variable, as [[t, v], ...]. */
export function recentHourly(siteId, kind, nDays, now = Date.now()) {
  const cutoff = now - nDays * 864e5;
  const days = new Set();
  for (let t = cutoff - 864e5; t <= now + 864e5; t += 864e5) days.add(new Date(t).toISOString().slice(0, 10));
  const out = [];
  for (const d of days) {
    for (const r of readCsv(path.join(DATA, 'hourly', d.slice(0, 7), d.slice(8, 10) + '.csv'))) {
      if (r[2] !== siteId || r[3] !== kind) continue;
      const t = Date.parse(r[0]);
      if (t >= cutoff) out.push([t, Number(r[4])]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// ---------------- daily history: data/daily/<site>.csv
const DAILY_HEADER = ['date', 'level_max', 'flow_mean'];
export function readDaily(siteId) {
  return readCsv(path.join(DATA, 'daily', siteId + '.csv')).map((r) => ({
    date: r[0], level: r[1] === '' ? null : Number(r[1]), flow: r[2] === '' ? null : Number(r[2])
  }));
}
export function upsertDaily(siteId, kind, points) {
  const map = new Map(readDaily(siteId).map((d) => [d.date, d]));
  for (const p of points) {
    const date = localDate(p.t + 12 * 3600e3); // Hydstra day values are stamped at the start of the day
    const row = map.get(date) || { date, level: null, flow: null };
    row[kind] = kind === 'level' ? round(p.v) : Math.round(p.v);
    map.set(date, row);
  }
  const rows = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((d) => [d.date, d.level, d.flow]);
  writeCsv(path.join(DATA, 'daily', siteId + '.csv'), DAILY_HEADER, rows);
  return rows.length;
}

// ---------------- rain: data/rain/daily.csv (date, point, mm, source) + forecast snapshots
const RAIN_HEADER = ['date', 'point', 'rain_mm', 'source'];
export function readRainDaily() {
  return readCsv(path.join(DATA, 'rain', 'daily.csv')).map((r) => ({ date: r[0], point: r[1], mm: r[2] === '' ? null : Number(r[2]), source: r[3] }));
}
export function upsertRainDaily(rows) {
  const map = new Map(readRainDaily().map((r) => [r.date + '|' + r.point, r]));
  for (const r of rows) {
    const k = r.date + '|' + r.point;
    const old = map.get(k);
    if (old && old.source === 'era5' && r.source !== 'era5') continue; // keep reanalysis once it exists
    map.set(k, r);
  }
  const all = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.point < b.point ? -1 : 1));
  writeCsv(path.join(DATA, 'rain', 'daily.csv'), RAIN_HEADER, all.map((r) => [r.date, r.point, r.mm, r.source]));
}
export function appendForecastSnapshot(fetchedIso, rows) {
  const file = path.join(DATA, 'rain', 'forecasts', fetchedIso.slice(0, 7) + '.csv');
  const existing = readCsv(file);
  writeCsv(file, ['fetched_utc', 'point', 'date', 'rain_mm', 'chance_pct'], existing.concat(rows));
}

// ---------------- warnings
export function appendWarnings(fetchedIso, items) {
  const file = path.join(DATA, 'warnings.csv');
  const existing = readCsv(file);
  const seen = new Set(existing.map((r) => r[2] + '|' + r[1]));
  const fresh = items.filter((w) => !seen.has(w.title + '|' + w.published));
  writeCsv(file, ['fetched_utc', 'published', 'title', 'link'], existing.concat(fresh.map((w) => [fetchedIso, w.published, w.title, w.link])));
  return fresh.length;
}

// ---------------- reference table for dataset users
export function writeSitesTable() {
  writeCsv(path.join(DATA, 'sites.csv'),
    ['site', 'bom_number', 'name', 'river', 'datum', 'gauge_zero_m_ahd', 'minor', 'moderate', 'major', 'note'],
    CFG.sites.map((s) => [s.id, s.bom, s.name, s.river, s.datum, s.gaugeZero, s.minor, s.moderate, s.major, s.note]));
}

export function listFiles(dir) {
  try { return fs.readdirSync(path.join(DATA, dir)).sort(); } catch { return []; }
}
