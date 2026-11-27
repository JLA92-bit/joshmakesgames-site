// River Watch - dataset files
// Created by Josh Avard
import fs from 'node:fs';
import path from 'node:path';
import { DATA, CFG, readCsv, writeCsv, readJson, writeJson, localDate, unitFor, round, sites } from './lib.mjs';

const fmtLocalTime = (t) => new Intl.DateTimeFormat('en-CA', {
  timeZone: CFG.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
}).format(new Date(t)).replace(',', '');

// ---------------- hourly readings: data/hourly/YYYY-MM/DD.csv (UTC days)
// Small daily files keep each hourly git commit tiny.
const HOURLY_HEADER = ['time_utc', 'time_local', 'site', 'variable', 'value', 'unit', 'quality'];
export function upsertHourly(site, kind, points) {
  const byDay = {};
  for (const p of points) {
    const iso = new Date(p.t).toISOString();
    (byDay[iso.slice(0, 10)] ||= []).push([iso.slice(0, 16) + 'Z', fmtLocalTime(p.t), site.id, kind, p.v, kind === 'level' ? unitFor(site) : 'ML/day', p.q]);
  }
  let added = 0;
  for (const [day, rows] of Object.entries(byDay)) {
    const file = path.join(DATA, 'hourly', day.slice(0, 7), day.slice(8, 10) + '.csv');
    const map = new Map(readCsv(file).map((r) => [r[0] + '|' + r[2] + '|' + r[3], r]));
    for (const r of rows) { const k = r[0] + '|' + r[2] + '|' + r[3]; if (!map.has(k)) added++; map.set(k, r); }
    const all = [...map.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[2] < b[2] ? -1 : 1));
    writeCsv(file, HOURLY_HEADER, all);
  }
  return added;
}

/** Recent hourly values for every site: { siteId: { level: [[t,v]], flow: [[t,v]] } }. One pass over the files. */
export function recentHourlyAll(nDays, now = Date.now()) {
  const cutoff = now - nDays * 864e5;
  const out = {};
  for (let t = cutoff - 864e5; t <= now + 864e5; t += 864e5) {
    const d = new Date(t).toISOString().slice(0, 10);
    for (const r of readCsv(path.join(DATA, 'hourly', d.slice(0, 7), d.slice(8, 10) + '.csv'))) {
      const tt = Date.parse(r[0]);
      if (tt < cutoff) continue;
      ((out[r[2]] ||= { level: [], flow: [] })[r[3]] ||= []).push([tt, Number(r[4])]);
    }
  }
  for (const s of Object.values(out)) for (const k of Object.keys(s)) {
    const seen = new Map(); s[k].forEach((p) => seen.set(p[0], p)); s[k] = [...seen.values()].sort((a, b) => a[0] - b[0]);
  }
  return out;
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
  writeCsv(file, ['fetched_utc', 'point', 'date', 'rain_mm', 'chance_pct', 'max_hour_mm'], readCsv(file).concat(rows));
}

// ---------------- soil moisture: data/soil/daily.csv (date, catchment, soil_mm in top metre)
export function readSoilDaily() {
  return readCsv(path.join(DATA, 'soil', 'daily.csv')).map((r) => ({ date: r[0], catchment: r[1], mm: Number(r[2]) }));
}
export function upsertSoilDaily(catchmentId, rows) {
  const map = new Map(readSoilDaily().map((r) => [r.date + '|' + r.catchment, r]));
  for (const [date, mm] of rows) if (mm != null) map.set(date + '|' + catchmentId, { date, catchment: catchmentId, mm });
  const all = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.catchment < b.catchment ? -1 : 1));
  writeCsv(path.join(DATA, 'soil', 'daily.csv'), ['date', 'catchment', 'soil_water_mm_top_1m'], all.map((r) => [r.date, r.catchment, r.mm]));
}

// ---------------- storages: data/storages/daily.csv
export function readStorageDaily() {
  return readCsv(path.join(DATA, 'storages', 'daily.csv')).map((r) => ({
    date: r[0], storage: r[1], pct: r[2] === '' ? null : Number(r[2]), volume: r[3] === '' ? null : Number(r[3]), level: r[4] === '' ? null : Number(r[4]), source: r[5]
  }));
}
export function upsertStorageDaily(rows) {
  const map = new Map(readStorageDaily().map((r) => [r.date + '|' + r.storage, r]));
  for (const r of rows) {
    const k = r.date + '|' + r.storage;
    const old = map.get(k);
    if (old && old.source === 'gmw' && r.source !== 'gmw') continue; // prefer the operator's own figure
    map.set(k, { ...old, ...r });
  }
  const all = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.storage < b.storage ? -1 : 1));
  writeCsv(path.join(DATA, 'storages', 'daily.csv'), ['date', 'storage', 'pct_full', 'volume_ml', 'level_m_ahd', 'source'],
    all.map((r) => [r.date, r.storage, r.pct, r.volume, r.level, r.source]));
}

// ---------------- climate drivers: data/climate/indices.csv (month, oni, dmi, sam)
export function readClimate() {
  const out = {};
  for (const r of readCsv(path.join(DATA, 'climate', 'indices.csv'))) {
    out[r[0]] = { oni: r[1] === '' ? null : Number(r[1]), dmi: r[2] === '' ? null : Number(r[2]), sam: r[3] === '' ? null : Number(r[3]) };
  }
  return out;
}
export function writeClimate(byKey) {
  const months = new Set();
  for (const m of Object.values(byKey)) Object.keys(m || {}).forEach((k) => months.add(k));
  const rows = [...months].sort().map((m) => [m, byKey.oni && byKey.oni[m], byKey.dmi && byKey.dmi[m], byKey.sam && byKey.sam[m]]);
  writeCsv(path.join(DATA, 'climate', 'indices.csv'), ['month', 'oni', 'dmi', 'sam'], rows);
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

// ---------------- statistics used for percentiles (built by the back-fill)
export const stats = {
  read: () => readJson(path.join(DATA, 'state', 'stats.json'), { flow: {}, soil: {} }),
  write: (s) => writeJson(path.join(DATA, 'state', 'stats.json'), s)
};
/** 101 quantiles of a list, so a percentile can be looked up later without the full list. */
export function quantiles(values) {
  const s = values.filter((v) => v != null && !Number.isNaN(v)).sort((a, b) => a - b);
  if (s.length < 30) return null;
  return Array.from({ length: 101 }, (_, i) => s[Math.min(s.length - 1, Math.round((i / 100) * (s.length - 1)))]);
}

// ---------------- reference tables for dataset users
export function writeReferenceTables() {
  writeCsv(path.join(DATA, 'sites.csv'),
    ['site', 'bom_number', 'name', 'river', 'group', 'datum', 'gauge_zero_m_ahd', 'minor', 'moderate', 'major', 'note'],
    sites().map((s) => [s.id, s.bom, s.discoveredName || s.name, s.river, s.group, s.datum, s.gaugeZero, s.minor, s.moderate, s.major, s.note]));
  writeCsv(path.join(DATA, 'storages.csv'), ['storage', 'name', 'system', 'capacity_ml', 'full_supply_level_m_ahd', 'role'],
    CFG.storages.map((s) => [s.id, s.name, s.system, s.capacity, s.fsl, s.role]));
  writeCsv(path.join(DATA, 'rain-points.csv'), ['point', 'name', 'catchment', 'lat', 'lon'],
    CFG.rainPoints.map((p) => [p.id, p.name, p.catchment, p.lat, p.lon]));
}

export function listFiles(dir) { try { return fs.readdirSync(path.join(DATA, dir)).sort(); } catch { return []; } }
