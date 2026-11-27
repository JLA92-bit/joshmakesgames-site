// River Watch - hourly collection run (GitHub Actions, or `npm run collect` locally)
// Created by Josh Avard
import path from 'node:path';
import {
  CFG, KNOW, DATA, MOCK, HOUR, DAY, readJson, writeJson, traces, saveState, rainForecast, warnings, classify, trend, unitFor,
  localDate, readCsv, sites, discoverSites, gmwStorages, storageHistory, soilArchive, climateIndex, climatePhase, percentileOf, round
} from './lib.mjs';
import {
  upsertHourly, recentHourlyAll, upsertRainDaily, appendForecastSnapshot, appendWarnings, writeReferenceTables,
  upsertStorageDaily, readStorageDaily, upsertSoilDaily, readSoilDaily, readClimate, writeClimate, stats, quantiles
} from './store.mjs';
import { travelTimes, budget, backwater, signals, intensity, factorBoard } from './derive.mjs';
import { rise, warningText, parsePredictions, appendPredictions, frequency, rarity, forecastSkill, riverModelOutlook, appendModelSnapshot } from './insights.mjs';

const now = new Date();
const today = localDate(now.getTime());
const log = [];
const note = (level, msg) => { log.push({ t: now.toISOString(), level, msg }); console.log(level, msg); };
const statePath = path.join(DATA, 'state', 'collect.json');
const st = readJson(statePath, { noFlow: {}, names: {}, daily: {} });
st.daily ||= {};
const dueToday = (key) => st.daily[key] !== today;

// ---------------- gauges
await discoverSites();
const siteList = sites().map((s) => ({ ...s, wmisName: st.names[s.id] }));
const start = new Date(now.getTime() - 72 * HOUR);
let added = 0, failed = 0;
for (const site of siteList) {
  if (site.offline) continue;
  for (const kind of ['level', 'flow']) {
    if (kind === 'flow' && (site.noFlow || (st.noFlow[site.id] || 0) > now.getTime() - DAY)) continue;
    try {
      const res = await traces(site, kind, start, now, 'hour', kind === 'level' ? 'max' : 'mean');
      if (res.name && site.autoName) { st.names[site.id] = res.name; site.wmisName = res.name; }
      added += upsertHourly(site, kind, res.points);
      if (kind === 'flow') delete st.noFlow[site.id];
    } catch (e) {
      if (kind === 'level') { failed++; note('WARN', `${site.id} ${site.name} level: ${e.message}`); }
      else st.noFlow[site.id] = now.getTime();
    }
  }
}
// one more try, after a pause, for gauges whose level failed (the state server sometimes times out)
const retry = siteList.filter((s) => log.some((l) => l.msg.startsWith(`${s.id} ${s.name} level:`)));
if (retry.length && !MOCK) {
  await new Promise((r) => setTimeout(r, 20000));
  for (const site of retry) {
    try {
      const res = await traces(site, 'level', start, now, 'hour', 'max');
      added += upsertHourly(site, 'level', res.points); failed--;
      const i = log.findIndex((l) => l.msg.startsWith(`${site.id} ${site.name} level:`)); if (i > -1) log.splice(i, 1);
    } catch { /* still not reporting; the first warning stays in the log */ }
  }
}
note('INFO', `Gauges: ${added} new hourly values from ${siteList.length} gauges (${failed} not reporting)`);

const recent = recentHourlyAll(7, now.getTime());
const S = stats.read();
const eventsIndex = readJson(path.join(DATA, 'events', 'index.json'), { events: [] });
const travel = travelTimes(eventsIndex);

const sitesOut = siteList.map((s) => {
  const lv = (recent[s.id] && recent[s.id].level) || [];
  const fl = (recent[s.id] && recent[s.id].flow) || [];
  const l = lv.length ? lv[lv.length - 1] : null;
  const f = fl.length ? fl[fl.length - 1] : null;
  const thin = (a) => a.filter((p, i) => i % 2 === 0 || i === a.length - 1);
  return {
    id: s.id, slug: s.slug || null, bom: s.bom, name: s.wmisName && s.autoName ? titleCase(s.wmisName) : (s.discoveredName ? s.name : s.name),
    short: s.autoName && s.wmisName ? titleCase(s.wmisName).replace(/ @ /, ' at ') : s.short, gaugeName: s.discoveredName || s.wmisName || null,
    river: s.river, group: s.group, role: s.role, note: s.note, key: !!s.key,
    datum: s.datum, unit: unitFor(s), minor: s.minor, moderate: s.moderate, major: s.major, storageHead: s.storageHead || null,
    latest: l ? { t: l[0], v: l[1] } : null, trend: trend(lv), status: s.offline && !l ? { code: 'nodata', label: s.offline } : l && now.getTime() - l[0] > 6 * HOUR ? { code: 'nodata', label: 'Last reading ' + new Intl.DateTimeFormat('en-AU', { timeZone: CFG.timezone, day: 'numeric', month: 'short', hour: 'numeric' }).format(new Date(l[0])) } : classify(s, l ? l[1] : null), offline: s.offline || null, stale: !!(l && now.getTime() - l[0] > 6 * HOUR),
    flowLatest: f ? { t: f[0], v: f[1] } : null, flowTrend: trend(fl, 6, Math.max(5, (f ? f[1] : 0) * 0.03)),
    flowPct: f && S.flow && S.flow[s.id] ? percentileOf(S.flow[s.id], f[1]) : null,
    series: thin(lv), flowSeries: thin(fl).map((p) => [p[0], Math.round(p[1])]),
    record: S.record && S.record[s.id] ? S.record[s.id] : null,
    rise: rise(s, lv)
  };
});
function titleCase(x) { return String(x).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bD\/s\b/g, 'D/S').replace(/\(example\)/i, '(example)'); }

// ---------------- storages
let storagesPublished = null;
try {
  const g = await gmwStorages();
  const rows = [];
  for (const s of CFG.storages.filter((x) => x.rss)) {
    const r = g[s.rss];
    if (!r) continue;
    storagesPublished = r.published || storagesPublished;
    rows.push({ date: today, storage: s.id, pct: r.pct, volume: r.volume, level: r.level, source: 'gmw' });
  }
  upsertStorageDaily(rows);
} catch (e) { note('WARN', 'GMW storages: ' + e.message); }
if (dueToday('bomStorages')) {
  // Coliban Water storages are not in the GMW feed; take the last 30 days from BoM Water Data Online once a day.
  const from = localDate(now.getTime() - 30 * DAY);
  for (const s of CFG.storages.filter((x) => !x.rss && x.kiwis)) {
    try {
      const vals = await storageHistory(s, from, today);
      upsertStorageDaily(vals.map(([date, vol]) => ({ date, storage: s.id, volume: Math.round(vol), pct: s.capacity ? round((vol / s.capacity) * 100, 2) : null, source: 'bom' })));
    } catch (e) { note('WARN', `BoM storage ${s.name}: ${e.message}`); }
  }
  st.daily.bomStorages = today;
}
const storeRows = readStorageDaily();
const storagesOut = CFG.storages.map((s) => {
  const hist = storeRows.filter((r) => r.storage === s.id).slice(-400);
  const lastRow = hist[hist.length - 1] || null;
  const yearAgo = hist.find((r) => r.date >= localDate(now.getTime() - 365 * DAY));
  const headSite = s.headGauge ? sitesOut.find((x) => x.id === s.headGauge) : null;
  const level = headSite && headSite.latest && headSite.latest.v > 50 ? headSite.latest.v : lastRow && lastRow.level;
  return {
    id: s.id, name: s.name, system: s.system, role: s.role, owner: s.owner || 'Goulburn-Murray Water', key: !!s.key, capacity: s.capacity, fsl: s.fsl,
    pct: lastRow ? lastRow.pct : null, volume: lastRow ? lastRow.volume : null, level: level ?? null, date: lastRow ? lastRow.date : null,
    belowFsl: s.fsl && level != null ? round(s.fsl - level, 2) : null,
    pctYearAgo: yearAgo ? yearAgo.pct : null,
    history: hist.filter((r, i) => i % 3 === 0 || i === hist.length - 1).map((r) => [r.date, r.pct != null ? r.pct : r.volume])
  };
});

// ---------------- rain: daily, hourly intensity and catchment totals
let rain = readJson(path.join(DATA, 'latest.json'), {}).rain || null;
let pointIntensity = {};
try {
  const pts = await rainForecast();
  const past = [], snap = [];
  const nowLocalHour = new Intl.DateTimeFormat('sv-SE', { timeZone: CFG.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .format(now).replace(' ', 'T').slice(0, 13) + ':00';
  for (const p of pts) {
    pointIntensity[p.id] = intensity(p, nowLocalHour);
    p.daily.time.forEach((d, i) => {
      const mm = p.daily.precipitation_sum[i];
      if (d < today) past.push({ date: d, point: p.id, mm, source: 'forecast-model' });
      else {
        const hours = p.hourly ? p.hourly.time.map((t, k) => (t.startsWith(d) ? p.hourly.precipitation[k] : null)).filter((v) => v != null) : [];
        snap.push([now.toISOString(), p.id, d, mm, p.daily.precipitation_probability_max ? p.daily.precipitation_probability_max[i] : '', hours.length ? Math.max(...hours) : '']);
      }
    });
  }
  upsertRainDaily(past);
  if (dueToday('forecastSnapshot')) { appendForecastSnapshot(now.toISOString(), snap); st.daily.forecastSnapshot = today; }
  rain = {
    fetched: now.toISOString(),
    points: pts.map((p) => ({
      id: p.id, name: p.name, catchment: p.catchment, intensity: pointIntensity[p.id],
      days: p.daily.time.map((d, i) => ({ date: d, type: d < today ? 'past' : d === today ? 'today' : 'forecast', mm: p.daily.precipitation_sum[i], prob: p.daily.precipitation_probability_max ? p.daily.precipitation_probability_max[i] : null }))
    }))
  };
} catch (e) { note('WARN', 'Rain: ' + e.message); }

// ---------------- soil moisture (ERA5, about 5 days behind; refreshed once a day)
if (dueToday('soil')) {
  for (const c of CFG.catchments) {
    try { upsertSoilDaily(c.id, await soilArchive(c, localDate(now.getTime() - 75 * DAY), localDate(now.getTime() - DAY))); }
    catch (e) { note('WARN', `Soil moisture ${c.name}: ${e.message}`); }
  }
  // percentiles for each catchment and calendar month, from the whole history
  const all = readSoilDaily();
  S.soil = {};
  for (const c of CFG.catchments) {
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const q = quantiles(all.filter((r) => r.catchment === c.id && r.date.slice(5, 7) === mm).map((r) => r.mm));
      if (q) (S.soil[c.id] ||= {})[mm] = q;
    }
  }
  stats.write(S);
  st.daily.soil = today;
}
const soilAll = readSoilDaily();

// ---------------- climate drivers (monthly; refreshed once a day)
if (dueToday('climate')) {
  const existing = readClimate();
  const byKey = { oni: {}, dmi: {}, sam: {} };
  for (const [m, v] of Object.entries(existing)) for (const k of Object.keys(byKey)) if (v[k] != null) byKey[k][m] = v[k];
  for (const k of Object.keys(byKey)) {
    try { Object.assign(byKey[k], await climateIndex(k)); } catch (e) { note('WARN', `Climate index ${k}: ${e.message}`); }
  }
  writeClimate(byKey);
  st.daily.climate = today;
}
const clim = readClimate();
const climMonths = Object.keys(clim).sort();
let climate = null;
if (climMonths.length) {
  climate = {};
  for (const k of ['oni', 'dmi', 'sam']) {
    const withVal = climMonths.filter((m) => clim[m][k] != null);
    if (!withVal.length) continue;
    const m = withVal[withVal.length - 1];
    climate[k] = { name: CFG.climate[k].name, month: m, value: clim[m][k], phase: climatePhase(k, clim[m][k]), series: withVal.slice(-36).map((x) => [x, clim[x][k]]) };
  }
}

// ---------------- catchments
const catchmentsOut = CFG.catchments.map((c) => {
  const pts = rain ? rain.points.filter((p) => p.catchment === c.id) : [];
  const avg = (fn) => (pts.length ? round(pts.reduce((a, p) => a + fn(p), 0) / pts.length, 1) : null);
  const sum = (p, from, to) => { let k = 0, s = 0; p.days.forEach((d) => { if (d.type === 'past' && from === 'past') s += d.mm || 0; if (d.type !== 'past' && from === 'next') { if (k < to) s += d.mm || 0; k++; } }); return s; };
  const soilRows = soilAll.filter((r) => r.catchment === c.id);
  const soilLast = soilRows[soilRows.length - 1];
  const q = soilLast && S.soil && S.soil[c.id] ? S.soil[c.id][soilLast.date.slice(5, 7)] : null;
  const maxOf = (k) => (pts.length ? Math.max(...pts.map((p) => (p.intensity && p.intensity[k]) || 0)) : null);
  return {
    id: c.id, name: c.name, feeds: c.feeds, key: !!c.key, points: pts.map((p) => p.name),
    rainPast30: avg((p) => sum(p, 'past')), rainNext3: avg((p) => sum(p, 'next', 3)), rainNext7: avg((p) => sum(p, 'next', 7)),
    max1hPast7: maxOf('max1hPast'), max24hPast7: maxOf('max24hPast'), max1hNext3: maxOf('max1hNext'), max24hNext3: maxOf('max24hNext'),
    soil: soilLast ? { mm: soilLast.mm, date: soilLast.date, pct: q ? percentileOf(q, soilLast.mm) : null, series: soilRows.slice(-90).map((r) => [r.date, r.mm]) } : null
  };
});

// ---------------- warnings
let warn = { fetched: now.toISOString(), ok: false, items: [] };
try {
  const items = await warnings();
  appendWarnings(now.toISOString(), items);
  // predicted heights, read from the text of current flood warnings
  const predictions = [];
  for (const w of items) {
    if (!w.link || !/flood/i.test(w.title)) continue;
    try {
      const issued = Date.parse(w.published) || now.getTime();
      for (const p of parsePredictions(await warningText(w.link), issued, siteList)) predictions.push({ ...p, issued: new Date(issued).toISOString(), title: w.title, link: w.link });
    } catch (e) { note('WARN', 'Warning text: ' + e.message); }
  }
  if (predictions.length) appendPredictions(now.toISOString(), predictions);
  warn = { fetched: now.toISOString(), ok: true, items, predictions };
} catch (e) { note('WARN', 'Warnings: ' + e.message + ' (BoM may block automated requests)'); }

// ---------------- how unusual today is (yearly highest values on record)
const freq = {};
for (const s of siteList) {
  const f = s.storageHead ? null : (frequency(s.id, 'flow') || frequency(s.id, 'level'));
  if (f) freq[s.id] = f;
}
for (const s of sitesOut) {
  const f = freq[s.id];
  if (!f) continue;
  const v = f.kind === 'flow' ? (s.flowLatest && s.flowLatest.v) : (s.latest && s.latest.v);
  s.rarity = { kind: f.kind, value: v, ...rarity(f, v) };
}
writeJson(path.join(DATA, 'frequency.json'), { generated: now.toISOString(), note: 'Annual (July to June) highest daily values. aep = chance in any year of reaching that value, from rank (Weibull plotting position).', sites: freq });

// ---------------- rain forecast report card
let skill = null;
try { skill = forecastSkill(); } catch (e) { note('WARN', 'Forecast report card: ' + e.message); }

// ---------------- global river model outlook (GloFAS), compared only with its own record
let riverModel = readJson(path.join(DATA, 'latest.json'), {}).riverModel || null;
try {
  riverModel = await riverModelOutlook(note);
  if (dueToday('modelSnapshot')) { appendModelSnapshot(now.toISOString(), riverModel); st.daily.modelSnapshot = today; }
} catch (e) { note('WARN', 'River model: ' + e.message); }

// ---------------- derived factors
const backwaterRes = backwater(recent);
const refEvent = (() => {
  // the biggest measured flood at Rochester Town, for comparisons
  const m = (eventsIndex.events || []).filter((e) => e.measured && e.peaks && e.peaks['406283']);
  if (!m.length) return null;
  const e = m.sort((a, b) => b.peaks['406283'].v - a.peaks['406283'].v)[0];
  const up = e.rain && e.rain['upper-campaspe'];
  return { name: e.name, eppalockBefore: e.before ? e.before.eppalockVsFsl : null, soilPct: e.before ? e.before.soilPct : null, rainPre7: up ? up.pre7 : null, max24: e.intensity && e.intensity['upper-campaspe'] ? e.intensity['upper-campaspe'].max24 : null };
})();
const factors = factorBoard({ storages: storagesOut, catchments: catchmentsOut, sitesOut, climate, backwaterRes, refEvent });

// ---------------- write
writeReferenceTables();
writeJson(path.join(DATA, 'latest.json'), {
  generated: now.toISOString(),
  example: MOCK,
  groups: CFG.groups,
  sites: sitesOut,
  storages: storagesOut, storagesPublished,
  rain, catchments: catchmentsOut, climate,
  budget: budget(recent, siteList, travel, now.getTime()),
  backwater: backwaterRes,
  signals: signals(recent, siteList, travel, now.getTime()),
  travel,
  factors, refEvent,
  skill, riverModel,
  warnings: warn,
  events: (eventsIndex.events || []).map((e) => ({ id: e.id, name: e.name, anchor: e.anchor })),
  knowledge: {
    impacts: KNOW.impacts, historicPeaks: KNOW.historicPeaks, leadTimes: KNOW.leadTimes, leadTimeSource: KNOW.leadTimeSource,
    links: KNOW.links, thresholds: KNOW.thresholds, curated: KNOW.curatedEvents.map((c) => ({ date: c.date, name: c.name, facts: c.facts || [], factSource: c.factSource || null }))
  },
  log
});
writeJson(statePath, st, true);
saveState();
