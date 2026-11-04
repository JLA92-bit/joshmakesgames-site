// River Watch - analysis layer: what happens next, how unusual it is, conditions vs past floods.
// Everything here is worked out from the site's own records. None of it is an official forecast.
// Created by Josh Avard
import path from 'node:path';
import fs from 'node:fs';
import { CFG, DATA, HOUR, DAY, readJson, readCsv, localDate, round } from './lib.mjs';
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
  // 24-hour change, measured directly
  const dayAgo = series.find((p) => p[0] >= last[0] - 24 * HOUR);
  if (dayAgo && last[0] - dayAgo[0] >= 18 * HOUR) out.change24 = round(last[1] - dayAgo[1], 3);
  if (r6 > 0.003) {
    for (const k of ['minor', 'moderate', 'major']) {
      const thr = site[k];
      if (thr == null || thr <= last[1]) continue;
      const h = (thr - last[1]) / r6;
      if (h <= 96) out.toLevels.push({ level: k, value: thr, hours: round(h, 1), at: Math.round(last[0] + h * HOUR) });
    }
  }
  return out;
}

// ------------------------------------------------------------ 2. upstream travel-time outlook
// Pairs of gauges where water passes from one to the next. Lags come from the site's own past floods.
const PAIRS = [
  ['406213', '406283', 'Redesdale', 'Rochester Town'],
  ['406207', '406283', 'Below Lake Eppalock', 'Rochester Town'],
  ['406201', '406283', 'Barnadown', 'Rochester Town'],
  ['406201', '406202', 'Barnadown', 'Rochester Syphon'],
  ['406283', '406265', 'Rochester Town', 'Echuca (Campaspe)'],
  ['409202', '409200', 'Tocumwal', 'Echuca Wharf'],
  ['409200', '409207', 'Echuca Wharf', 'Torrumbarry Weir'],
  ['409207', '409204', 'Torrumbarry Weir', 'Swan Hill']
];

/** For each pair: typical lag and peak relationship across past floods, plus a live reading when upstream is high. */
export function travelOutlook(liveSites, events) {
  const live = Object.fromEntries(liveSites.map((s) => [s.id, s]));
  const out = [];
  for (const [up, down, upName, downName] of PAIRS) {
    const hist = [];
    for (const e of events) {
      if (!e.measured || !e.peaks) continue;
      const a = e.peaks[up], b = e.peaks[down];
      if (!a || !b) continue;
      const lag = b.h - a.h;
      if (lag < -6 || lag > 14 * 24) continue; // not the same wave
      hist.push({ id: e.id, name: e.name, upPeak: a.v, downPeak: b.v, lag });
    }
    if (!hist.length) continue;
    const lags = hist.map((h) => h.lag).sort((x, y) => x - y);
    const item = {
      up, down, upName, downName, n: hist.length,
      lagMin: lags[0], lagMax: lags[lags.length - 1], lagMedian: lags[Math.floor(lags.length / 2)],
      events: hist.sort((x, y) => y.upPeak - x.upPeak).slice(0, 8)
    };
    // live: highest reading upstream in the last 48 hours
    const u = live[up];
    if (u && u.series && u.series.length) {
      const recent = u.series.filter((p) => p[0] >= u.series[u.series.length - 1][0] - 48 * HOUR);
      const top = recent.reduce((m, p) => (p[1] > m[1] ? p : m), recent[0]);
      // "elevated" means at least as high as the smallest flood wave this gauge has carried (less 0.3 m)
      const lowestFloodPeak = Math.min(...hist.map((h) => h.upPeak));
      const elevated = top[1] >= lowestFloodPeak - 0.3;
      const near = hist.map((h) => ({ ...h, d: Math.abs(h.upPeak - top[1]) })).sort((x, y) => x.d - y.d).slice(0, 3);
      item.live = {
        upTop: round(top[1], 3), upTopT: top[0], upTrend: u.trend, elevated: !!elevated,
        analogs: near.map(({ d, ...h }) => h),
        downRange: near.length ? [Math.min(...near.map((h) => h.downPeak)), Math.max(...near.map((h) => h.downPeak))] : null,
        etaRange: near.length ? [top[0] + Math.min(...near.map((h) => h.lag)) * HOUR, top[0] + Math.max(...near.map((h) => h.lag)) * HOUR] : null
      };
    }
    out.push(item);
  }
  return out;
}

// ------------------------------------------------------------ 3. BoM predicted heights, read from warning text
const RIVERS = 'Campaspe|Murray|Coliban|Goulburn|Ovens|Kiewa';
/**
 * Pull predicted heights out of BoM flood warning text.
 * BoM wording is like: "The Campaspe River at Rochester Town is expected to peak near 114.20 m AHD Friday morning."
 * Numbers in brackets are flood class levels, not predictions, so they are removed first.
 */
export function parsePredictions(text, issuedT) {
  const out = [];
  if (!text) return out;
  const clean = text.replace(/\s+/g, ' ').replace(/\([^)]*\)/g, ' ');
  const sentences = clean.split(/(?<=[.!?])\s+(?=[A-Z])/);
  let current = null;
  for (const sRaw of sentences) {
    const s = sRaw.trim();
    const at = s.match(new RegExp('(' + RIVERS + ') River (?:at|near|downstream of|upstream of|below|above) ([A-Z][A-Za-z\' ()]+?)(?= is| was| has| may| will| remains| reached| peaked| are| could|,|\\.|$)'));
    if (at) current = { river: at[1], place: at[2].trim() };
    if (!current) continue;
    const m = s.match(/(expected to|likely to|may|could|forecast to|predicted to)\s+(?:remain\s+)?(peak|reach|exceed|rise to|rise above)[^.]*?(\d{1,3}\.\d{1,2})\s*(?:m\b|metres)\s*(AHD)?/i);
    if (!m) continue;
    const site = matchSite(current.river, current.place);
    if (!site) continue;
    let v = Number(m[3]);
    if (site.datum === 'AHD' && v < 50 && site.gaugeZero) v = round(v + site.gaugeZero, 2);
    const when = (s.slice(s.indexOf(m[3]) + m[3].length).match(/(?:on |during |by |from |later )?((?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day(?: (?:morning|afternoon|evening|night|overnight))?|(?:this|tomorrow) (?:morning|afternoon|evening)|tonight|today|tomorrow|overnight[^,.]*)/i) || [])[1] || '';
    const head = s.slice(0, s.indexOf(m[3]));
    const verbs = [...head.matchAll(/(peak|reach|exceed|rise to|rise above)/gi)], hedges = [...head.matchAll(/(expected to|likely to|may|could|forecast to|predicted to)/gi)];
    out.push({ site: site.id, river: current.river, place: current.place, kind: verbs[verbs.length - 1][1].toLowerCase(), certainty: hedges[hedges.length - 1][1].toLowerCase(), level: v, when, window: whenWindow(when, issuedT), sentence: s.slice(0, 400) });
  }
  // keep the highest prediction per site
  const best = {};
  for (const p of out) if (!best[p.site] || p.level > best[p.site].level) best[p.site] = p;
  return Object.values(best);
}
function matchSite(river, place) {
  const p = place.toLowerCase();
  const cand = CFG.sites.filter((s) => s.river === river);
  for (const s of cand) for (const n of (s.bomNames || [])) if (p === n.toLowerCase()) return s;
  for (const s of cand) for (const n of (s.bomNames || [])) if (p.startsWith(n.toLowerCase()) || n.toLowerCase().startsWith(p)) return s;
  return null;
}
/** Rough local time window for phrases like "Friday morning" relative to when the warning was issued. */
export function whenWindow(when, issuedT) {
  if (!when || !issuedT) return null;
  const w = when.toLowerCase();
  const parts = { morning: [6, 12], afternoon: [12, 18], evening: [18, 23], night: [20, 30], overnight: [22, 30] };
  const local = new Date(issuedT + CFG.hydstraOffsetHours * HOUR); // AEST is close enough for a window
  const dow = local.getUTCDay();
  let dayOffset = null;
  const days = ['sun', 'mon', 'tues', 'wednes', 'thurs', 'fri', 'satur'];
  const di = days.findIndex((d) => w.startsWith(d));
  if (di >= 0) dayOffset = (di - dow + 7) % 7;
  else if (/today|this|tonight/.test(w)) dayOffset = 0;
  else if (/tomorrow/.test(w)) dayOffset = 1;
  else if (/overnight/.test(w)) dayOffset = 0;
  if (dayOffset == null) return null;
  const part = Object.keys(parts).find((k) => w.includes(k)) || (/tonight/.test(w) ? 'night' : null);
  const [h0, h1] = part ? parts[part] : [0, 24];
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - CFG.hydstraOffsetHours * HOUR + dayOffset * DAY;
  return [midnight + h0 * HOUR, midnight + h1 * HOUR];
}

// ------------------------------------------------------------ 4. how unusual: annual maxima and return periods
/** Water year runs July to June, which keeps one winter-spring flood season in one year. */
const waterYear = (date) => { const y = +date.slice(0, 4), m = +date.slice(5, 7); return m >= 7 ? y : y - 1; };

export function frequency(siteId, kind) {
  const days = readDaily(siteId).filter((d) => d[kind] != null);
  if (!days.length) return null;
  const byYear = {};
  for (const d of days) {
    const wy = waterYear(d.date);
    (byYear[wy] ||= { n: 0, max: -Infinity, date: null }).n++;
    if (d[kind] > byYear[wy].max) Object.assign(byYear[wy], { max: d[kind], date: d.date });
  }
  // only count years with most days recorded
  const years = Object.entries(byYear).filter(([, v]) => v.n >= 300).map(([y, v]) => ({ wy: +y, max: v.max, date: v.date }));
  if (years.length < 15) return null;
  const sorted = [...years].sort((a, b) => b.max - a.max);
  const N = sorted.length;
  const curve = sorted.map((y, i) => ({ wy: y.wy, date: y.date, v: y.max, aep: round((i + 1) / (N + 1), 4), ari: round((N + 1) / (i + 1), 1) }));
  return { site: siteId, kind, years: N, from: Math.min(...years.map((y) => y.wy)), to: Math.max(...years.map((y) => y.wy)), curve };
}

/** How often a value has been reached: "k of N years", and an approximate 1-in-X years. */
export function rarity(freq, v) {
  if (!freq || v == null) return null;
  const k = freq.curve.filter((c) => c.v >= v).length;
  const N = freq.years;
  return { reachedYears: k, years: N, oneIn: k ? round((N + 1) / k, 1) : null, beyondRecord: k === 0 };
}

// ------------------------------------------------------------ 5. catchment state: storage and soil moisture
export function readStorage(id) {
  return readCsv(path.join(DATA, 'storage', id + '.csv')).map((r) => ({ date: r[0], level: r[1] === '' ? null : +r[1], volume: r[2] === '' ? null : +r[2], pct: r[3] === '' ? null : +r[3] }));
}
export function readSoil() {
  return readCsv(path.join(DATA, 'soil', 'daily.csv')).map((r) => ({ date: r[0], catchment: r[1], sm: r[2] === '' ? null : +r[2] }));
}
/** Percentile of a soil moisture value against the same calendar month in the record (0 = driest, 100 = wettest). */
export function soilPercentile(soil, catchment, date, v) {
  const m = date.slice(5, 7);
  const ref = soil.filter((r) => r.catchment === catchment && r.date.slice(5, 7) === m && r.sm != null).map((r) => r.sm).sort((a, b) => a - b);
  if (ref.length < 300 || v == null) return null;
  let lo = 0;
  while (lo < ref.length && ref[lo] < v) lo++;
  return Math.round((lo / ref.length) * 100);
}

export function catchmentState() {
  const storages = (CFG.storages || []).map((st) => {
    const rows = readStorage(st.id).filter((r) => r.volume != null || r.level != null);
    if (!rows.length) return { id: st.id, name: st.name, capacity: st.capacityML, note: st.note, latest: null };
    const last = rows[rows.length - 1];
    const pct = last.pct != null ? last.pct : last.volume != null && st.capacityML ? round((last.volume / st.capacityML) * 100, 1) : null;
    const weekAgo = rows.find((r) => r.date >= localDate(Date.parse(last.date) - 7 * DAY));
    const spilling = st.fullSupplyLevel != null && last.level != null ? last.level >= st.fullSupplyLevel - 0.02 : pct != null ? pct >= 99.5 : null;
    return {
      id: st.id, name: st.name, capacity: st.capacityML, fullSupplyLevel: st.fullSupplyLevel, note: st.note,
      latest: { date: last.date, level: last.level, volume: last.volume, pct },
      change7: weekAgo && weekAgo.volume != null && last.volume != null ? last.volume - weekAgo.volume : null,
      spilling, series: rows.slice(-120).map((r) => [r.date, r.pct != null ? r.pct : r.volume != null && st.capacityML ? round((r.volume / st.capacityML) * 100, 1) : null])
    };
  });
  const soil = readSoil();
  const catchments = [...new Set(soil.map((r) => r.catchment))];
  const soilNow = catchments.map((c) => {
    const rows = soil.filter((r) => r.catchment === c && r.sm != null);
    const last = rows[rows.length - 1];
    return last ? { catchment: c, date: last.date, sm: last.sm, percentile: soilPercentile(soil, c, last.date, last.sm), series: rows.slice(-90).map((r) => [r.date, r.sm]) } : null;
  }).filter(Boolean);
  return { storages, soil: soilNow };
}

/** Conditions now next to the conditions in the days before each past flood. */
export function versusPast(events, latestRain) {
  const soil = readSoil();
  const storageId = (CFG.storages || [])[0] && CFG.storages[0].id;
  const storage = storageId ? readStorage(storageId) : [];
  const st = storageId ? CFG.storages[0] : null;
  const pctOn = (date) => {
    const r = [...storage].reverse().find((x) => x.date <= date && (x.pct != null || x.volume != null));
    if (!r || Date.parse(date) - Date.parse(r.date) > 10 * DAY) return null;
    return r.pct != null ? r.pct : st.capacityML ? round((r.volume / st.capacityML) * 100, 1) : null;
  };
  const soilOn = (c, date) => {
    const r = [...soil].reverse().find((x) => x.catchment === c && x.date <= date && x.sm != null);
    return r && Date.parse(date) - Date.parse(r.date) <= 10 * DAY ? soilPercentile(soil, c, r.date, r.sm) : null;
  };
  const upper = CFG.rainPoints[0].catchment;
  const rows = events.filter((e) => e.measured || e.curated).map((e) => {
    const before = localDate(Date.parse(e.anchor + 'T12:00:00Z') - 7 * DAY);
    return {
      id: e.id, name: e.name, anchor: e.anchor,
      rain30: e.rain && e.rain[upper] ? e.rain[upper].pre30 : null,
      rain7: e.rain && e.rain[upper] ? e.rain[upper].pre7 : null,
      storagePct: pctOn(before), soilPct: soilOn(upper, before),
      peak: e.peaks && e.peaks['406283'] ? e.peaks['406283'].v : e.peaks && e.peaks['406202'] ? e.peaks['406202'].v : null,
      peakSite: e.peaks && e.peaks['406283'] ? '406283' : e.peaks && e.peaks['406202'] ? '406202' : null
    };
  });
  // now
  let now = { rain30: null, next3: null, next7: null };
  if (latestRain && latestRain.points) {
    const pts = latestRain.points.filter((p) => p.catchment === upper);
    const sum = (p, pred) => p.days.filter(pred).reduce((a, d) => a + (d.mm || 0), 0);
    now.rain30 = round(mean(pts.map((p) => sum(p, (d) => d.type === 'past'))), 1);
    now.next3 = round(mean(pts.map((p) => sum(p, (d) => d.type !== 'past' && p.days.filter((x) => x.type !== 'past').indexOf(d) < 3))), 1);
    now.next7 = round(mean(pts.map((p) => sum(p, (d) => d.type !== 'past'))), 1);
  }
  const today = localDate(Date.now());
  now.storagePct = pctOn(today);
  const soilRows = soil.filter((r) => r.catchment === upper && r.sm != null);
  const sLast = soilRows[soilRows.length - 1];
  now.soilPct = sLast ? soilPercentile(soil, upper, sLast.date, sLast.sm) : null;
  return { catchment: upper, now, events: rows };
}

// ------------------------------------------------------------ 6. forecast report card
/** Compare each saved rain forecast with the rain that was later recorded for that place and day. */
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
      if (date >= today) continue; // not happened yet
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

// ------------------------------------------------------------ 7. where the rivers meet: Murray backwater at Echuca
export function junction(liveSites) {
  const m = liveSites.find((s) => s.id === '409200'), c = liveSites.find((s) => s.id === '406265');
  const out = { murray: m && m.latest ? { v: m.latest.v, t: m.latest.t, series: m.series } : null, campaspe: c && c.latest ? { v: c.latest.v, t: c.latest.t, series: c.series } : null };
  if (out.murray && out.campaspe) out.diff = round(out.campaspe.v - out.murray.v, 3);
  return out;
}
