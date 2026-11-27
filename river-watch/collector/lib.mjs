// River Watch - shared helpers and data sources
// Created by Josh Avard
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mock from './mock.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.RW_DATA_DIR ? path.resolve(process.env.RW_DATA_DIR) : path.join(ROOT, 'data');
const readCfg = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', f), 'utf8'));
const SITES_CFG = readCfg('sites.json');
const STORAGE_CFG = readCfg('storages.json');
const CATCH_CFG = readCfg('catchments.json');
export const KNOW = readCfg('knowledge.json');
export const CFG = {
  ...SITES_CFG,
  storageCfg: STORAGE_CFG,
  storages: STORAGE_CFG.storages,
  catchments: CATCH_CFG.catchments,
  rainPoints: CATCH_CFG.rainPoints,
  climate: CATCH_CFG.climate,
  riverModel: CATCH_CFG.riverModel || []
};
export const MOCK = process.env.RW_MOCK === '1';
export const HOUR = 3600e3, DAY = 24 * HOUR;
const OFFSET = CFG.hydstraOffsetHours * HOUR;
const UA = 'RiverWatch/2.0 (Rochester community flood awareness project)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round = (v, d = 3) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
export const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

// ------------------------------------------------------------ files
export function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
export function writeJson(file, obj, pretty = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, pretty ? 1 : 0));
}
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function writeCsv(file, header, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
}
export function readCsv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.slice(1);
}

// ------------------------------------------------------------ dates
export function localDate(t) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CFG.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}
export function hydstraTime(d) {
  const l = new Date(d.getTime() + OFFSET);
  const p = (n) => String(n).padStart(2, '0');
  return `${l.getUTCFullYear()}${p(l.getUTCMonth() + 1)}${p(l.getUTCDate())}${p(l.getUTCHours())}${p(l.getUTCMinutes())}${p(l.getUTCSeconds())}`;
}
export function parseHydstraTime(s) {
  s = String(s);
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +(s.slice(8, 10) || 0), +(s.slice(10, 12) || 0), +(s.slice(12, 14) || 0)) - OFFSET;
}

// ------------------------------------------------------------ http
export async function getJson(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { err = e; await sleep(1500 * (i + 1)); }
  }
  throw err;
}
export async function getText(url, tries = 2) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) { err = e; await sleep(1500 * (i + 1)); }
  }
  throw err;
}

// ------------------------------------------------------------ gauges and discovery
const DISC_FILE = () => path.join(DATA, 'state', 'discovered.json');

/** All gauges with ids resolved. Gauges still to be discovered are left out. */
export function sites() {
  const disc = readJson(DISC_FILE(), {});
  return CFG.sites.map((s) => {
    if (s.id) return { ...s, short: s.short || s.name };
    const d = disc[s.slug];
    return d && d.id ? { ...s, id: d.id, discoveredName: d.name, short: s.short || s.name } : null;
  }).filter(Boolean);
}
export function siteBySlugOrId(key) {
  const all = sites();
  return all.find((s) => s.id === key || s.slug === key) || null;
}

/** Find gauges listed with 'discover' through BoM Water Data Online station search. */
export async function discoverSites(force = false) {
  const disc = readJson(DISC_FILE(), {});
  let changed = false;
  for (const s of CFG.sites.filter((x) => x.discover)) {
    const prev = disc[s.slug];
    const inBasin = (id) => !s.discover.basin || String(id || '').startsWith(s.discover.basin);
    if (!force && prev && ((prev.id && inBasin(prev.id)) || (!prev.id && Date.now() - (prev.tried || 0) < 7 * DAY))) continue;
    try {
      const up = (x) => String(x || '').toUpperCase();
      const word = up(s.discover.search.replace(/\*/g, '').trim());
      const raw = MOCK ? mock.kiwisStations(s.discover.search) : await kiwisStations(s.discover.search, 'Water Course Level');
      const list = raw.filter((st) => up(st.station_name).includes(word) && inBasin(st.station_no)); // never accept a gauge on another stream or in another basin
      let pick = null;
      for (const pref of s.discover.prefer || []) { pick = list.find((st) => up(st.station_name).includes(pref)); if (pick) break; }
      pick = pick || list[0];
      disc[s.slug] = pick ? { id: String(pick.station_no), name: pick.station_name, tried: Date.now() } : { id: null, tried: Date.now() };
    } catch (e) {
      disc[s.slug] = { id: prev && prev.id ? prev.id : null, name: prev && prev.name, tried: Date.now(), error: String(e.message || e) };
    }
    changed = true;
  }
  if (changed) writeJson(DISC_FILE(), disc, true);
  return disc;
}

// ------------------------------------------------------------ hydstra (WMIS / WaterNSW)
const COMBO_FILE = () => path.join(DATA, 'state', 'combos.json');
let combos = null;
export function saveState() { if (combos) writeJson(COMBO_FILE(), combos, true); }

/** Convert gauge height to AHD where flood levels are published in AHD. */
export function toDatum(site, v) {
  if (site.datum === 'AHD' && v < 50 && site.gaugeZero) return v + site.gaugeZero;
  return v;
}
/** True when an AHD site returned what looks like gauge height and we cannot convert it. */
export function datumProblem(site, v) {
  return site.datum === 'AHD' && !site.gaugeZero && v != null && v < 50;
}
export const unitFor = (site) => (site.datum === 'AHD' ? 'm AHD' : 'm');

/**
 * Level ('level') or flow ('flow') series for one site.
 * Tries each portal and data source until one returns data; remembers what worked.
 * Returns { points: [{t, v, q}], name, portal }.
 */
export async function traces(site, kind, start, end, interval, dataType) {
  if (MOCK) return mock.traces(site, kind, start, end, interval);
  if (kind === 'flow' && site.noFlow) throw new Error('no flow record');
  if (!combos) combos = readJson(COMBO_FILE(), {});
  const tries = [];
  const rem = combos[site.id];
  if (rem) tries.push(rem);
  for (const pk of site.portals) for (const ds of CFG.portals[pk].datasources) {
    if (!rem || rem.portal !== pk || rem.ds !== ds) tries.push({ portal: pk, ds });
  }
  let lastErr = 'no data returned';
  for (const c of tries) {
    try {
      const payload = {
        function: 'get_ts_traces', version: '2',
        params: {
          site_list: site.id, datasource: c.ds,
          varfrom: site.levelVar || CFG.vars.level, varto: kind === 'level' ? (site.levelVar || CFG.vars.level) : CFG.vars.flow,
          start_time: hydstraTime(start), end_time: hydstraTime(end),
          interval, multiplier: '1', data_type: dataType
        }
      };
      const j = await getJson(CFG.portals[c.portal].url + encodeURIComponent(JSON.stringify(payload)), 2);
      if (j.error_num) throw new Error(j.error_msg || 'error ' + j.error_num);
      const points = [];
      let name = '';
      for (const tr of (j.return && j.return.traces) || []) {
        if (tr.error_num) continue;
        if (tr.site_details && tr.site_details.name) name = tr.site_details.name;
        for (const r of tr.trace || []) {
          const q = Number(r.q), v = parseFloat(r.v);
          if (q === 255 || Number.isNaN(v)) continue; // 255 = missing
          points.push({ t: parseHydstraTime(r.t), v: round(kind === 'level' ? toDatum(site, v) : v), q });
        }
      }
      if (points.length) {
        if (kind === 'level') combos[site.id] = c;
        return { points, name, portal: `${c.portal}:${c.ds}` };
      }
    } catch (e) { lastErr = String(e.message || e); }
  }
  // WaterNSW blocks cloud servers, so NSW gauges fall back to BoM Water Data Online (a few days behind).
  if (kind === 'level' && site.portals.includes('nsw')) {
    try {
      const points = await bomLevels(site, start, end, interval);
      if (points.length) return { points, name: '', portal: 'bom', delayed: true };
      lastErr += '; BoM Water Data Online: no recent values';
    } catch (e) { lastErr += '; BoM Water Data Online: ' + String(e.message || e); }
  }
  throw new Error(lastErr);
}

/** Level from BoM Water Data Online: hourly means, or daily highs for 'day'. Station numbers match the state gauge numbers. */
async function bomLevels(site, start, end, interval) {
  const tsName = interval === 'day' ? 'DMQaQc.Merged.DailyMax.24HR' : 'DMQaQc.Merged.HourlyMean.HR';
  const file = path.join(DATA, 'state', 'kiwis-gauges.json');
  const known = readJson(file, {});
  const key = site.id + '|' + tsName;
  if (!known[key]) {
    const list = kiwisTable(await getJson(kiwisUrl({ request: 'getTimeseriesList', station_no: site.id, parametertype_name: 'Water Course Level', ts_name: tsName, returnfields: 'ts_id,ts_name' }), 2));
    if (!list.length) throw new Error('no ' + tsName + ' series');
    known[key] = list[0].ts_id; writeJson(file, known, true);
  }
  const iso = (d) => new Date(d.getTime() + OFFSET).toISOString().slice(0, 19) + '+10:00';
  const v = await getJson(kiwisUrl({ request: 'getTimeseriesValues', ts_id: known[key], from: iso(interval === 'day' ? start : new Date(Math.min(start.getTime(), end.getTime() - 7 * DAY))), to: iso(end), returnfields: 'Timestamp,Value,Quality Code' }), 2);
  const block = Array.isArray(v) ? v[0] : v;
  return ((block && block.data) || []).filter((r) => r[1] != null).map((r) => ({ t: Date.parse(r[0]), v: round(toDatum(site, Number(r[1]))), q: r[2] == null ? '' : r[2] }));
}

export async function variableList(portalKey, ds, siteId) {
  const payload = { function: 'get_variable_list', version: '1', params: { site_list: siteId, datasource: ds } };
  return getJson(CFG.portals[portalKey].url + encodeURIComponent(JSON.stringify(payload)), 2);
}

// ------------------------------------------------------------ BoM Water Data Online (KiWIS)
function kiwisUrl(params) {
  const q = new URLSearchParams({ service: 'kisters', type: 'QueryServices', format: 'json', ...params });
  return CFG.storageCfg.kiwis.url + '?' + q.toString();
}
function kiwisTable(json) {
  if (!Array.isArray(json) || !json.length || json[0] === 'No matches.') return [];
  const head = json[0];
  return json.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
export async function kiwisStations(nameSearch, parameterType) {
  const j = await getJson(kiwisUrl({ request: 'getStationList', parameterType_name: parameterType, station_name: nameSearch, returnfields: 'station_name,station_no,station_id,station_latitude,station_longitude' }), 2);
  return kiwisTable(j);
}
/** Daily series for a station and parameter type, as [[date, value], ...]. */
export async function kiwisDaily(stationNo, parameterType, fromDate, toDate) {
  const list = kiwisTable(await getJson(kiwisUrl({ request: 'getTimeseriesList', station_no: stationNo, parametertype_name: parameterType, ts_name: CFG.storageCfg.kiwis.tsName, returnfields: 'ts_id,ts_name' }), 2));
  if (!list.length) throw new Error('no ' + parameterType + ' series');
  const v = await getJson(kiwisUrl({ request: 'getTimeseriesValues', ts_id: list[0].ts_id, from: fromDate, to: toDate, returnfields: 'Timestamp,Value,Quality Code' }), 2);
  const block = Array.isArray(v) ? v[0] : v;
  return ((block && block.data) || []).filter((r) => r[1] != null).map((r) => [localDate(Date.parse(r[0])), Number(r[1])]);
}

/** Daily storage volume history for one storage (from BoM). */
export async function storageHistory(storage, fromDate, toDate) {
  if (MOCK) return mock.storageHistory(storage, fromDate, toDate);
  if (!storage.kiwis) throw new Error('no BoM search set');
  const stFile = path.join(DATA, 'state', 'kiwis-storages.json');
  const known = readJson(stFile, {});
  let st = known[storage.id];
  if (!st) {
    const list = await kiwisStations(storage.kiwis, CFG.storageCfg.kiwis.volume);
    if (!list.length) throw new Error('storage not found in BoM Water Data Online');
    st = { station_no: list[0].station_no, name: list[0].station_name };
    known[storage.id] = st; writeJson(stFile, known, true);
  }
  return kiwisDaily(st.station_no, CFG.storageCfg.kiwis.volume, fromDate, toDate);
}

// ------------------------------------------------------------ GMW storages (current, RSS)
export async function gmwStorages() {
  if (MOCK) return mock.gmwStorages();
  const xml = await getText(CFG.storageCfg.gmwRss);
  const out = {};
  const pub = (xml.match(/<pubDate>([^<]+)<\/pubDate>/) || [])[1] || '';
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = ((m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
    const desc = ((m[1].match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '');
    const num = (re) => { const x = desc.match(re); return x ? Number(x[1].replace(/,/g, '')) : null; };
    out[title] = {
      pct: num(/%Full=\s*([\d.,-]+)/), volume: num(/Volume \(ML\)=\s*([\d.,-]+)/), level: num(/Level \(mAHD\)=\s*([\d.,-]+)/), published: pub
    };
  }
  return out;
}

// ------------------------------------------------------------ rain (Open-Meteo, CC BY 4.0)
const coordQuery = (list) => 'latitude=' + list.map((p) => p.lat).join(',') + '&longitude=' + list.map((p) => p.lon).join(',');
const tzq = () => '&timezone=' + encodeURIComponent(CFG.timezone);

/** Past 30 days (model estimate) and next 8 days, daily and hourly, for every rain point. */
export async function rainForecast() {
  const pts = CFG.rainPoints;
  if (MOCK) return mock.rainForecast(pts);
  const url = 'https://api.open-meteo.com/v1/forecast?' + coordQuery(pts) +
    '&daily=precipitation_sum,precipitation_probability_max&hourly=precipitation&past_days=30&forecast_days=8' + tzq();
  let data = await getJson(url);
  if (!Array.isArray(data)) data = [data];
  return pts.map((p, i) => ({ ...p, daily: data[i].daily, hourly: data[i].hourly }));
}

/** Historical daily rain (ERA5) for one point. */
export async function rainArchive(point, startDate, endDate) {
  if (MOCK) return mock.rainArchive(point, startDate, endDate);
  const url = 'https://archive-api.open-meteo.com/v1/archive?latitude=' + point.lat + '&longitude=' + point.lon +
    '&start_date=' + startDate + '&end_date=' + endDate + '&daily=precipitation_sum' + tzq();
  const j = await getJson(url);
  return j.daily.time.map((d, i) => [d, j.daily.precipitation_sum[i]]);
}

/** Historical hourly rain (ERA5) for many points at once: { pointId: [[isoHour, mm], ...] }. */
export async function rainArchiveHourly(points, startDate, endDate) {
  if (MOCK) return mock.rainArchiveHourly(points, startDate, endDate);
  const url = 'https://archive-api.open-meteo.com/v1/archive?' + coordQuery(points) +
    '&start_date=' + startDate + '&end_date=' + endDate + '&hourly=precipitation' + tzq();
  let data = await getJson(url);
  if (!Array.isArray(data)) data = [data];
  const out = {};
  points.forEach((p, i) => { out[p.id] = data[i].hourly.time.map((t, k) => [t, data[i].hourly.precipitation[k]]); });
  return out;
}

// ------------------------------------------------------------ soil moisture (Open-Meteo ERA5)
// Water held in the top metre of soil, in mm: 0-7 cm, 7-28 cm and 28-100 cm layers.
const SOIL_LAYERS = [['soil_moisture_0_to_7cm', 70], ['soil_moisture_7_to_28cm', 210], ['soil_moisture_28_to_100cm', 720]];
export async function soilArchive(catchment, startDate, endDate) {
  if (MOCK) return mock.soilArchive(catchment, startDate, endDate);
  const url = 'https://archive-api.open-meteo.com/v1/archive?latitude=' + catchment.lat + '&longitude=' + catchment.lon +
    '&start_date=' + startDate + '&end_date=' + endDate + '&hourly=' + SOIL_LAYERS.map((l) => l[0]).join(',') + tzq();
  const j = await getJson(url);
  const byDay = {};
  j.hourly.time.forEach((t, i) => {
    let mm = 0, ok = true;
    for (const [name, depth] of SOIL_LAYERS) { const v = j.hourly[name][i]; if (v == null) { ok = false; break; } mm += v * depth; }
    if (!ok) return;
    const d = t.slice(0, 10);
    (byDay[d] ||= []).push(mm);
  });
  return Object.entries(byDay).map(([d, a]) => [d, round(a.reduce((x, y) => x + y, 0) / a.length, 1)]);
}

// ------------------------------------------------------------ climate drivers (NOAA)
const SEASON_MID = { DJF: 1, JFM: 2, FMA: 3, MAM: 4, AMJ: 5, MJJ: 6, JJA: 7, JAS: 8, ASO: 9, SON: 10, OND: 11, NDJ: 12 };
/** Monthly values { 'YYYY-MM': value } for 'oni', 'dmi' or 'sam'. */
export async function climateIndex(key) {
  if (MOCK) return mock.climateIndex(key);
  const text = await getText(CFG.climate[key].url);
  const out = {};
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (key === 'oni') {
    // SEAS YR TOTAL ANOM ; value stamped on the middle month of the 3-month season
    for (const l of lines) {
      const m = l.match(/^([A-Z]{3})\s+(\d{4})\s+(-?[\d.]+)\s+(-?[\d.]+)/);
      if (!m || !SEASON_MID[m[1]]) continue;
      let y = +m[2], mo = SEASON_MID[m[1]];
      if (m[1] === 'DJF') mo = 1; // centred on January of that year
      out[`${y}-${String(mo).padStart(2, '0')}`] = Number(m[4]);
    }
  } else if (key === 'dmi') {
    // PSL standard format: "year v1 ... v12", missing values large negative
    for (const l of lines) {
      const p = l.split(/\s+/);
      if (p.length !== 13 || !/^\d{4}$/.test(p[0])) continue;
      for (let i = 1; i <= 12; i++) { const v = Number(p[i]); if (v > -90) out[`${p[0]}-${String(i).padStart(2, '0')}`] = v; }
    }
  } else if (key === 'sam') {
    // "year month value"
    for (const l of lines) {
      const p = l.split(/\s+/);
      if (p.length < 3 || !/^\d{4}$/.test(p[0])) continue;
      const v = Number(p[2]);
      if (!Number.isNaN(v) && v > -90) out[`${p[0]}-${String(+p[1]).padStart(2, '0')}`] = v;
    }
  }
  if (!Object.keys(out).length) throw new Error('could not read ' + key);
  return out;
}
export function climatePhase(key, v) {
  const c = CFG.climate[key];
  if (v == null) return { code: 'unknown', label: 'No data' };
  if (c.wetBelow != null && v <= c.wetBelow) return { code: 'wet', label: c.wetLabel };
  if (c.dryAbove != null && v >= c.dryAbove) return { code: 'dry', label: c.dryLabel };
  if (c.wetAbove != null && v >= c.wetAbove) return { code: 'wet', label: c.wetLabel };
  if (c.dryBelow != null && v <= c.dryBelow) return { code: 'dry', label: c.dryLabel };
  return { code: 'neutral', label: 'Neutral' };
}

// ------------------------------------------------------------ warnings (BoM RSS)
export async function warnings() {
  if (MOCK) return [];
  const xml = await getText(KNOW.warningsRss);
  const items = [];
  const tag = (block, name) => {
    const m = block.match(new RegExp('<' + name + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</' + name + '>'));
    return m ? m[1].trim() : '';
  };
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = tag(m[1], 'title');
    const low = title.toLowerCase();
    if (KNOW.warningKeywords.some((k) => low.includes(k))) items.push({ title, link: tag(m[1], 'link'), published: tag(m[1], 'pubDate') });
  }
  return items;
}

// ------------------------------------------------------------ status
export function classify(site, v) {
  if (v === null || v === undefined) return { code: 'nodata', label: 'No recent data' };
  if (datumProblem(site, v)) return { code: 'info', label: 'Height in gauge metres; flood levels are in m AHD' };
  if (site.storageHead) {
    const d = v - site.storageHead.fsl;
    return d >= 0 ? { code: 'minor', label: `Spilling, ${d.toFixed(2)} m above full` } : { code: 'normal', label: `${(-d).toFixed(2)} m below full` };
  }
  if (site.major != null && v >= site.major) return { code: 'major', label: 'Major flood level' };
  if (site.moderate != null && v >= site.moderate) return { code: 'moderate', label: 'Moderate flood level' };
  if (site.minor != null && v >= site.minor) return { code: 'minor', label: 'Minor flood level' };
  if (site.minor != null && v >= site.minor - CFG.nearMinorMarginM) return { code: 'near', label: `Within ${CFG.nearMinorMarginM} m of minor` };
  if (site.minor == null) return { code: 'info', label: 'No flood levels set' };
  return { code: 'normal', label: 'Below minor flood level' };
}
export function floodClass(site, v) {
  if (site.storageHead) return null;
  const c = classify(site, v).code;
  return ['minor', 'moderate', 'major'].includes(c) ? c : null;
}
export function trend(series, hours = 3, threshold = 0.02) {
  if (!series || series.length < 2) return 'unknown';
  const last = series[series.length - 1];
  let prev = series[0];
  for (let i = series.length - 2; i >= 0; i--) if (series[i][0] <= last[0] - hours * HOUR) { prev = series[i]; break; }
  const d = last[1] - prev[1];
  return d > threshold ? 'rising' : d < -threshold ? 'falling' : 'steady';
}
/** Percentile (0-100) of v within a sorted array. */
export function percentileOf(sorted, v) {
  if (!sorted || !sorted.length || v == null) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
  return Math.round((lo / sorted.length) * 100);
}
