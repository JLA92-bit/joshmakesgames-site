// River Watch - analysis layer: rate of rise, BoM predicted heights, how unusual today is,
// the rain forecast report card, and a global-model river outlook (GloFAS).
// Everything here is worked out from the site's own records or open model data. None of it is an official forecast.
// Created by Josh Avard
import path from 'node:path';
import fs from 'node:fs';
import { CFG, DATA, MOCK, HOUR, DAY, readJson, writeJson, readCsv, writeCsv, getText, getJson, localDate, round, sites } from './lib.mjs';
import { readDaily, readRainDaily } from './store.mjs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// ------------------------------------------------------------ 1. rate of rise and time to flood levels
/** Least-squares slope (m per hour) over the last `hours` of an hourly [[t, v]] series. */
export function slope(series, hours = 6) {
  if (!series || series.length < 3) return null;
  const end = series[series.length - 1][0];
  const pts = series.filter((p) => p[0] >= end - hours * HOUR);
  if (pts.length < 3 || end - pts[0][0] < 2 * HOUR) return null;
  const xs = pts.map((p) => (p[0] - end) / HOUR), ys = pts.map((p) => p[1]);
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? num / den : null;
}

/** Rate of rise plus hours until each flood level at the current rate (only while rising). */
export function rise(site, series) {
  const last = series && series.length ? series[series.length - 1] : null;
  const r6 = slope(series, 6), r24 = slope(series, 24);
  const out = { mPerHour6: r6 == null ? null : round(r6, 4), mPerDay24: r24 == null ? null : round(r24 * 24, 3), toLevels: [] };
  if (!last || r6 == null) return out;
  const dayAgo = series.find((p) => p[0] >= last[0] - 24 * HOUR);
  if (dayAgo && last[0] - dayAgo[0] >= 18 * HOUR) out.change24 = round(last[1] - dayAgo[1], 3);
  if (r6 > 0.003 && !site.storageHead) {
    for (const k of ['minor', 'moderate', 'major']) {
      const thr = site[k];
      if (thr == null || thr <= last[1]) continue;
      const h = (thr - last[1]) / r6;
      if (h <= 96) out.toLevels.push({ level: k, value: thr, hours: round(h, 1), at: Math.round(last[0] + h * HOUR) });
    }
  }
  return out;
}

// ------------------------------------------------------------ 2. BoM predicted heights, read from warning text
const RIVERS = 'Campaspe|Murray|Coliban|Goulburn|Ovens|Kiewa|Broken|Loddon|Edward|Mitta Mitta';

/** Plain text of a BoM warning product. The .txt version (…/fwo/IDV36xxx.txt) is cleaner than the web page. */
export async function warningText(link) {
  if (MOCK) return '';
  const id = (String(link).match(/(ID[A-Z]\d{5})/) || [])[1];
  if (id) { try { return (await getText('http://www.bom.gov.au/fwo/' + id + '.txt')).replace(/\r/g, ''); } catch { /* fall back to the page */ } }
  const html = await getText(link);
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').trim();
}

/**
 * Pull predicted heights out of BoM flood warning text.
 * BoM wording is like: "The Campaspe River at Rochester Town is expected to peak near 114.20 m AHD Friday morning."
 * Numbers in brackets are flood class levels, not predictions, so they are removed first.
 */
export function parsePredictions(text, issuedT, siteList = sites()) {
  const out = [];
  if (!text) return out;
  const clean = text.replace(/\s+/g, ' ').replace(/\([^)]*\)/g, ' ');
  const sentences = clean.split(/(?<=[.!?])\s+(?=[A-Z])/);
  let current = null;
  for (const sRaw of sentences) {
    const s = sRaw.trim();
    const at = s.match(new RegExp('(' + RIVERS + ') (?:River|Creek) (?:at|near|downstream of|upstream of|below|above) ([A-Z][A-Za-z\' ()]+?)(?= is| was| has| may| will| remains| reached| peaked| are| could|,|\\.|$)'));
    if (at) current = { river: at[1], place: at[2].trim() };
    if (!current) continue;
    const m = s.match(/(expected to|likely to|may|could|forecast to|predicted to)\s+(?:remain\s+)?(peak|reach|exceed|rise to|rise above)[^.]*?(\d{1,3}\.\d{1,2})\s*(?:m\b|metres)\s*(AHD)?/i);
    if (!m) continue;
    const site = matchSite(current.river, current.place, siteList);
    if (!site) continue;
    let v = Number(m[3]);
    if (site.datum === 'AHD' && v < 50 && site.gaugeZero) v = round(v + site.gaugeZero, 2);
    const when = (s.slice(s.indexOf(m[3]) + m[3].length).match(/(?:on |during |by |from |later )?((?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day(?: (?:morning|afternoon|evening|night|overnight))?|(?:this|tomorrow) (?:morning|afternoon|evening)|tonight|today|tomorrow|overnight[^,.]*)/i) || [])[1] || '';
    const head = s.slice(0, s.indexOf(m[3]));
    const verbs = [...head.matchAll(/(peak|reach|exceed|rise to|rise above)/gi)], hedges = [...head.matchAll(/(expected to|likely to|may|could|forecast to|predicted to)/gi)];
    out.push({ site: site.id, river: current.river, place: current.place, kind: verbs[verbs.length - 1][1].toLowerCase(), certainty: hedges[hedges.length - 1][1].toLowerCase(), level: v, when, window: whenWindow(when, issuedT), sentence: s.slice(0, 400) });
  }
  const best = {};
  for (const p of out) if (!best[p.site] || p.level > best[p.site].level) best[p.site] = p;
  return Object.values(best);
}
function namesFor(s) {
  const extra = (CFG.bomNames && CFG.bomNames[s.id]) || [];
  return [...extra, s.name, s.short].filter(Boolean).map((n) => String(n).replace(/\s*\(.*?\)\s*/g, ' ').trim().toLowerCase());
}
function matchSite(river, place, siteList) {
  const p = place.toLowerCase();
  const cand = siteList.filter((s) => String(s.river).toLowerCase() === river.toLowerCase());
  for (const s of cand) for (const n of namesFor(s)) if (p === n) return s;
  for (const s of cand) for (const n of namesFor(s)) if (n && (p.startsWith(n) || n.startsWith(p))) return s;
  return null;
}
/** Rough local time window for phrases like "Friday morning" relative to when the warning was issued. */
export function whenWindow(when, issuedT) {
  if (!when || !issuedT) return null;
  const w = when.toLowerCase();
  const parts = { morning: [6, 12], afternoon: [12, 18], evening: [18, 23], night: [20, 30], overnight: [22, 30] };
  const local = new Date(issuedT + CFG.hydstraOffsetHours * HOUR);
  const dow = local.getUTCDay();
  let dayOffset = null;
  const days = ['sun', 'mon', 'tues', 'wednes', 'thurs', 'fri', 'satur'];
  const di = days.findIndex((d) => w.startsWith(d));
  if (di >= 0) dayOffset = (di - dow + 7) % 7;
  else if (/today|this|tonight|overnight/.test(w)) dayOffset = 0;
  else if (/tomorrow/.test(w)) dayOffset = 1;
  if (dayOffset == null) return null;
  const part = Object.keys(parts).find((k) => w.includes(k)) || (/tonight/.test(w) ? 'night' : null);
  const [h0, h1] = part ? parts[part] : [0, 24];
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - CFG.hydstraOffsetHours * HOUR + dayOffset * DAY;
  return [midnight + h0 * HOUR, midnight + h1 * HOUR];
}
/** Keep every prediction, so they can be checked later against what happened. */
export function appendPredictions(fetchedIso, items) {
  const file = path.join(DATA, 'predictions.csv');
  const existing = readCsv(file);
  const seen = new Set(existing.map((r) => r[1] + '|' + r[2] + '|' + r[4]));
  const fresh = items.filter((p) => !seen.has(p.issued + '|' + p.site + '|' + p.level));
  writeCsv(file, ['fetched_utc', 'issued', 'site', 'kind', 'level', 'when', 'window_start_utc', 'window_end_utc', 'sentence'],
    existing.concat(fresh.map((p) => [fetchedIso, p.issued, p.site, p.kind, p.level, p.when, p.window ? new Date(p.window[0]).toISOString() : '', p.window ? new Date(p.window[1]).toISOString() : '', p.sentence])));
}

// ------------------------------------------------------------ 3. how unusual: annual maxima and return periods
/** Water year runs July to June, which keeps one winter-spring flood season in one year. */
const waterYear = (date) => { const y = +date.slice(0, 4), m = +date.slice(5, 7); return m >= 7 ? y : y - 1; };

/** Annual maxima curve from [[date, value]] rows. Years need `minDays` values to count. */
export function annualCurve(rows, minDays = 300) {
  const byYear = {};
  for (const [date, v] of rows) {
    if (v == null || Number.isNaN(v)) continue;
    const wy = waterYear(date);
    const b = (byYear[wy] ||= { n: 0, max: -Infinity, date: null });
    b.n++;
    if (v > b.max) { b.max = v; b.date = date; }
  }
  const years = Object.entries(byYear).filter(([, v]) => v.n >= minDays).map(([y, v]) => ({ wy: +y, max: v.max, date: v.date }));
  if (years.length < 15) return null;
  const sorted = [...years].sort((a, b) => b.max - a.max);
  const N = sorted.length;
  return {
    years: N, from: Math.min(...years.map((y) => y.wy)), to: Math.max(...years.map((y) => y.wy)),
    curve: sorted.map((y, i) => ({ wy: y.wy, date: y.date, v: round(y.max, 3), aep: round((i + 1) / (N + 1), 4), ari: round((N + 1) / (i + 1), 1) }))
  };
}
export function frequency(siteId, kind) {
  const c = annualCurve(readDaily(siteId).map((d) => [d.date, d[kind]]));
  return c ? { site: siteId, kind, ...c } : null;
}
/** How often a value has been reached: "k of N years", and an approximate 1-in-X years. */
export function rarity(freq, v) {
  if (!freq || v == null) return null;
  const k = freq.curve.filter((c) => c.v >= v).length;
  const N = freq.years;
  return { reachedYears: k, years: N, oneIn: k ? round((N + 1) / k, 1) : null, beyondRecord: k === 0 };
}

// ------------------------------------------------------------ 4. rain forecast report card
/** Compare each saved rain forecast with the rain later recorded for that place and day. */
export function forecastSkill() {
  const dir = path.join(DATA, 'rain', 'forecasts');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).sort(); } catch { return null; }
  const actual = {};
  for (const r of readRainDaily()) if (r.mm != null) actual[r.date + '|' + r.point] = r.mm;
  const today = localDate(Date.now());
  const byLead = {};
  for (const f of files) {
    for (const r of readCsv(path.join(dir, f))) {
      const issued = localDate(Date.parse(r[0]));
      const date = r[2];
      if (!date || date >= today) continue;
      const lead = Math.round((Date.parse(date) - Date.parse(issued)) / DAY);
      if (lead < 1 || lead > 5) continue;
      const a = actual[date + '|' + r[1]], fc = r[3] === '' ? null : +r[3];
      if (a == null || fc == null) continue;
      const b = (byLead[lead] ||= { lead, n: 0, absErr: 0, bias: 0, hits: 0, misses: 0, falseAlarms: 0, quietRight: 0 });
      b.n++; b.absErr += Math.abs(fc - a); b.bias += fc - a;
      const F = fc >= 10, A = a >= 10;
      if (F && A) b.hits++; else if (!F && A) b.misses++; else if (F && !A) b.falseAlarms++; else b.quietRight++;
    }
  }
  const leads = Object.values(byLead).sort((x, y) => x.lead - y.lead).map((b) => ({
    lead: b.lead, n: b.n, mae: round(b.absErr / b.n, 1), bias: round(b.bias / b.n, 1),
    hits: b.hits, misses: b.misses, falseAlarms: b.falseAlarms, quietRight: b.quietRight,
    heavyCaught: b.hits + b.misses ? Math.round((b.hits / (b.hits + b.misses)) * 100) : null
  }));
  return { threshold: 10, leads, days: leads.length ? Math.max(...leads.map((l) => l.n)) : 0 };
}

// ------------------------------------------------------------ 5. global-model river outlook (GloFAS via Open-Meteo)
// GloFAS is a global 5 km river model run by Copernicus (EU). It is coarse and not tuned for these rivers,
// so its numbers are only compared with the model's OWN record since 1984, never with gauge readings.
const ML_PER_DAY = 86.4; // 1 m3/s = 86.4 ML/day
const FLOOD_API = 'https://flood-api.open-meteo.com/v1/flood';
const MODEL_VARS = ['river_discharge', 'river_discharge_median', 'river_discharge_p25', 'river_discharge_p75', 'river_discharge_max'];
const modelStatsFile = () => path.join(DATA, 'state', 'model-stats.json');

function mockModel(points, startDate, days, history) {
  return points.map((p, k) => {
    const time = [], cols = Object.fromEntries(MODEL_VARS.map((v) => [v, []]));
    const t0 = Date.parse(startDate + 'T00:00:00Z');
    for (let i = 0; i < days; i++) {
      const d = new Date(t0 + i * DAY).toISOString().slice(0, 10);
      time.push(d);
      const season = 1 + 0.8 * Math.sin(((+d.slice(5, 7) - 3) / 12) * 2 * Math.PI);
      const yearly = history ? Math.exp(Math.sin(+d.slice(0, 4) * 2.3 + k) * 1.1) : 1;
      const wave = history ? 1 : 1 + 2.5 * Math.exp(-(((i - 18) / 4) ** 2));
      const base = (p.mockBase || 20) * season * yearly * wave * (1 + 0.15 * Math.sin(i / 3 + k));
      cols.river_discharge.push(round(base, 2));
      cols.river_discharge_median.push(round(base, 2));
      cols.river_discharge_p25.push(round(base * 0.7, 2));
      cols.river_discharge_p75.push(round(base * 1.45, 2));
      cols.river_discharge_max.push(round(base * 2.4, 2));
    }
    return { daily: { time, ...cols } };
  });
}
const coordQuery = (list) => 'latitude=' + list.map((p) => p.lat).join(',') + '&longitude=' + list.map((p) => p.lon).join(',');

/** Model history since 1984 for one point -> annual maxima curve (ML/day). Fetched once, then kept. */
async function modelHistory(point) {
  const end = localDate(Date.now() - 60 * DAY);
  let data;
  if (MOCK) data = mockModel([point], '1984-01-01', Math.round((Date.parse(end) - Date.parse('1984-01-01')) / DAY), true)[0];
  else data = await getJson(FLOOD_API + '?latitude=' + point.lat + '&longitude=' + point.lon + '&daily=river_discharge&start_date=1984-01-01&end_date=' + end);
  const rows = data.daily.time.map((d, i) => [d, data.daily.river_discharge[i] == null ? null : data.daily.river_discharge[i] * ML_PER_DAY]);
  return annualCurve(rows, 330);
}

/** 30-day ensemble outlook for each model point, compared with the model's own yearly peaks. */
export async function riverModelOutlook(note) {
  const points = CFG.riverModel || [];
  if (!points.length) return null;
  const stats = readJson(modelStatsFile(), {});
  let changed = false;
  for (const p of points) {
    const s = stats[p.id];
    if (s && s.curve && Date.now() - (s.built || 0) < 180 * DAY) continue;
    try { const c = await modelHistory(p); if (c) { stats[p.id] = { ...c, built: Date.now() }; changed = true; } }
    catch (e) { note('WARN', `River model history ${p.name}: ${e.message}`); }
  }
  if (changed) writeJson(modelStatsFile(), stats, true);

  const startDate = localDate(Date.now() - 14 * DAY);
  let data;
  if (MOCK) data = mockModel(points, startDate, 45, false);
  else {
    data = await getJson(FLOOD_API + '?' + coordQuery(points) + '&daily=' + MODEL_VARS.join(',') + '&past_days=14&forecast_days=30');
    if (!Array.isArray(data)) data = [data];
  }
  const today = localDate(Date.now());
  const out = points.map((p, i) => {
    const d = data[i] && data[i].daily;
    if (!d || !d.time) return { id: p.id, name: p.name, river: p.river, site: p.site || null, days: [] };
    const ml = (v) => (v == null ? null : Math.round(v * ML_PER_DAY));
    const days = d.time.map((t, k) => ({
      date: t, past: t < today,
      q: ml(d.river_discharge && d.river_discharge[k]), median: ml(d.river_discharge_median && d.river_discharge_median[k]),
      p25: ml(d.river_discharge_p25 && d.river_discharge_p25[k]), p75: ml(d.river_discharge_p75 && d.river_discharge_p75[k]),
      max: ml(d.river_discharge_max && d.river_discharge_max[k])
    }));
    const ahead = days.filter((x) => !x.past);
    const pick = (k) => ahead.reduce((m, x) => (x[k] != null && (!m || x[k] > m[k]) ? x : m), null);
    const peakMedian = pick('median') || pick('q'), peakHigh = pick('p75');
    const nowDay = days.filter((x) => x.past && x.q != null).pop() || ahead[0] || null;
    const st = stats[p.id];
    const r = (v) => (st && v != null ? rarity(st, v) : null);
    return {
      id: p.id, name: p.name, river: p.river, site: p.site || null, note: p.note || null,
      now: nowDay ? nowDay.q : null,
      peak: peakMedian ? { date: peakMedian.date, v: peakMedian.median ?? peakMedian.q, rarity: r(peakMedian.median ?? peakMedian.q) } : null,
      peakHigh: peakHigh ? { date: peakHigh.date, v: peakHigh.p75, rarity: r(peakHigh.p75) } : null,
      modelYears: st ? st.years : null, modelMedianYearPeak: st ? st.curve[Math.floor(st.curve.length / 2)].v : null,
      days
    };
  });
  return { fetched: new Date().toISOString(), source: 'GloFAS v4 (Copernicus Emergency Management Service) via Open-Meteo, CC BY 4.0', unit: 'ML/day', points: out };
}

/** Keep one model snapshot a day, like the rain forecasts, so the model can be checked against the gauges later. */
export function appendModelSnapshot(fetchedIso, outlook) {
  if (!outlook) return;
  const file = path.join(DATA, 'model', 'glofas-' + fetchedIso.slice(0, 7) + '.csv');
  const rows = [];
  for (const p of outlook.points) for (const d of p.days) if (!d.past) rows.push([fetchedIso, p.id, d.date, d.median ?? d.q, d.p25, d.p75, d.max]);
  writeCsv(file, ['fetched_utc', 'point', 'date', 'median_ml_day', 'p25_ml_day', 'p75_ml_day', 'max_ml_day'], readCsv(file).concat(rows));
}
