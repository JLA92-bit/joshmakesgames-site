// River Watch - shared helpers
// Created by Josh Avard
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mock from './mock.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.RW_DATA_DIR ? path.resolve(process.env.RW_DATA_DIR) : path.join(ROOT, 'data');
export const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'sites.json'), 'utf8'));
export const MOCK = process.env.RW_MOCK === '1';
export const HOUR = 3600e3, DAY = 24 * HOUR;
const OFFSET = CFG.hydstraOffsetHours * HOUR;
const UA = 'RiverWatch/1.0 (Rochester community flood awareness project)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

// ------------------------------------------------------------ files
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
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
  return rows.slice(1); // drop header
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
export async function getJson(url, tries = 3, timeoutMs = 45000) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { err = e; await sleep(1500 * (i + 1)); }
  }
  throw err;
}
export async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

// ------------------------------------------------------------ hydstra (WMIS / WaterNSW)
const COMBO_FILE = () => path.join(DATA, 'state', 'combos.json');
let combos = null;
export function saveState() { if (combos) writeJson(COMBO_FILE(), combos, true); }

export function toDatum(site, v) {
  // BoM publishes some flood levels in AHD; convert if the service returns gauge height.
  if (site.datum === 'AHD' && v < 50 && site.gaugeZero) return v + site.gaugeZero;
  return v;
}
export const unitFor = (site) => (site.datum === 'AHD' ? 'm AHD' : 'm');

/**
 * Level ('level') or flow ('flow') series for one site.
 * Tries each portal and data source until one returns data; remembers what worked.
 * Returns { points: [{t, v, q}], name, portal }.
 */
export async function traces(site, kind, start, end, interval, dataType, opts = {}) {
  if (MOCK) return mock.traces(site, kind, start, end, interval);
  if (!combos) combos = readJson(COMBO_FILE(), {});
  const tries = [];
  // remember what worked for each site and variable, and try that first
  const key = kind === 'level' ? site.id : site.id + ':flow';
  const rem = combos[key] || combos[site.id];
  if (rem) tries.push(rem);
  for (const pk of site.portals) for (const ds of CFG.portals[pk].datasources) {
    if (!rem || rem.portal !== pk || rem.ds !== ds) tries.push({ portal: pk, ds });
  }
  let lastErr = 'no data returned';
  // once a source has worked, only use that source (saves minutes of retries on long back-fills)
  const list = opts.onlyRemembered && combos[key] ? [combos[key]] : tries;
  for (const c of list) {
    try {
      const payload = {
        function: 'get_ts_traces', version: '2',
        params: {
          site_list: site.id, datasource: c.ds,
          varfrom: CFG.vars.level, varto: kind === 'level' ? CFG.vars.level : CFG.vars.flow,
          start_time: hydstraTime(start), end_time: hydstraTime(end),
          interval, multiplier: '1', data_type: dataType
        }
      };
      const j = await getJson(CFG.portals[c.portal].url + encodeURIComponent(JSON.stringify(payload)), opts.tries || 2, opts.timeoutMs || 45000);
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
        combos[key] = c;
        return { points, name, portal: `${c.portal}:${c.ds}` };
      }
    } catch (e) { lastErr = String(e.message || e); }
  }
  throw new Error(lastErr);
}

/** Variables available at a site (for finding storage, rainfall etc). */
export async function variableList(portalKey, ds, siteId) {
  const payload = { function: 'get_variable_list', version: '1', params: { site_list: siteId, datasource: ds } };
  return getJson(CFG.portals[portalKey].url + encodeURIComponent(JSON.stringify(payload)), 2);
}

// ------------------------------------------------------------ rain (Open-Meteo, CC BY 4.0)
const pts = () => CFG.rainPoints;
const coordQuery = (list) => 'latitude=' + list.map((p) => p.lat).join(',') + '&longitude=' + list.map((p) => p.lon).join(',');

/** Recent (past 30 days, model estimate) and next 8 days forecast for every rain point. */
export async function rainForecast() {
  if (MOCK) return mock.rainForecast(pts());
  const url = 'https://api.open-meteo.com/v1/forecast?' + coordQuery(pts()) +
    '&daily=precipitation_sum,precipitation_probability_max&past_days=30&forecast_days=8&timezone=' + encodeURIComponent(CFG.timezone);
  let data = await getJson(url);
  if (!Array.isArray(data)) data = [data];
  return pts().map((p, i) => ({ id: p.id, name: p.name, catchment: p.catchment, daily: data[i].daily }));
}

/** Historical daily rain (ERA5 reanalysis) for one point. */
export async function rainArchive(point, startDate, endDate) {
  if (MOCK) return mock.rainArchive(point, startDate, endDate);
  const url = 'https://archive-api.open-meteo.com/v1/archive?latitude=' + point.lat + '&longitude=' + point.lon +
    '&start_date=' + startDate + '&end_date=' + endDate + '&daily=precipitation_sum&timezone=' + encodeURIComponent(CFG.timezone);
  const j = await getJson(url);
  return j.daily.time.map((d, i) => [d, j.daily.precipitation_sum[i]]);
}

// ------------------------------------------------------------ warnings (BoM RSS)
export async function warnings() {
  if (MOCK) return [];
  const xml = await getText(CFG.warningsRss);
  const items = [];
  const tag = (block, name) => {
    const m = block.match(new RegExp('<' + name + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</' + name + '>'));
    return m ? m[1].trim() : '';
  };
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = tag(m[1], 'title');
    const low = title.toLowerCase();
    if (CFG.warningKeywords.some((k) => low.includes(k))) items.push({ title, link: tag(m[1], 'link'), published: tag(m[1], 'pubDate') });
  }
  return items;
}

// ------------------------------------------------------------ status
export function classify(site, v) {
  if (v === null || v === undefined) return { code: 'nodata', label: 'No recent data' };
  if (site.major != null && v >= site.major) return { code: 'major', label: 'Major flood level' };
  if (site.moderate != null && v >= site.moderate) return { code: 'moderate', label: 'Moderate flood level' };
  if (site.minor != null && v >= site.minor) return { code: 'minor', label: 'Minor flood level' };
  if (site.minor != null && v >= site.minor - CFG.nearMinorMarginM) return { code: 'near', label: `Within ${CFG.nearMinorMarginM} m of minor` };
  if (site.minor == null) return { code: 'info', label: 'No flood levels set' };
  return { code: 'normal', label: 'Below minor flood level' };
}
export function floodClass(site, v) {
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

// ------------------------------------------------------------ any Hydstra variable (storages)
/** Raw series for one site and variable (e.g. storage level or volume). Returns [{t, v}]. */
export async function varTrace(portalKey, ds, siteId, varfrom, varto, start, end, interval, dataType) {
  if (MOCK) return mock.storageTrace(siteId, varto, start, end, interval);
  const payload = {
    function: 'get_ts_traces', version: '2',
    params: { site_list: siteId, datasource: ds, varfrom, varto, start_time: hydstraTime(start), end_time: hydstraTime(end), interval, multiplier: '1', data_type: dataType }
  };
  const j = await getJson(CFG.portals[portalKey].url + encodeURIComponent(JSON.stringify(payload)), 2);
  if (j.error_num) throw new Error(j.error_msg || 'error ' + j.error_num);
  const out = [];
  for (const tr of (j.return && j.return.traces) || []) {
    if (tr.error_num) continue;
    for (const r of tr.trace || []) {
      const q = Number(r.q), v = parseFloat(r.v);
      if (q === 255 || Number.isNaN(v)) continue;
      out.push({ t: parseHydstraTime(r.t), v: round(v) });
    }
  }
  if (!out.length) throw new Error('no data returned');
  return out;
}

// ------------------------------------------------------------ soil moisture (Open-Meteo ERA5, CC BY 4.0)
/** Daily mean root-zone soil moisture (m3/m3, 0 to 100 cm) for one point. */
export async function soilArchive(point, startDate, endDate) {
  if (MOCK) return mock.soilArchive(point, startDate, endDate);
  const url = 'https://archive-api.open-meteo.com/v1/archive?latitude=' + point.lat + '&longitude=' + point.lon +
    '&start_date=' + startDate + '&end_date=' + endDate + '&daily=' + CFG.soil.variable + '&timezone=' + encodeURIComponent(CFG.timezone);
  const j = await getJson(url);
  return j.daily.time.map((d, i) => [d, j.daily[CFG.soil.variable][i]]);
}

// ------------------------------------------------------------ BoM warning text
/** Full text of a BoM warning product, from its link in the RSS feed. */
export async function warningText(link) {
  if (MOCK) return '';
  // The plain-text version of a product (…/fwo/IDV36xxx.txt) is cleaner than the web page.
  const id = (link.match(/(ID[A-Z]\d{5})/) || [])[1];
  if (id) { try { return (await getText('http://www.bom.gov.au/fwo/' + id + '.txt')).replace(/\r/g, ''); } catch { /* fall back to the page */ } }
  const html = await getText(link);
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').trim();
}
