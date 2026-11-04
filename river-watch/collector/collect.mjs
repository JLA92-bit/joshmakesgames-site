// River Watch - hourly collection run (GitHub Actions, or `npm run collect` locally)
// Created by Josh Avard
import path from 'node:path';
import {
  CFG, DATA, MOCK, HOUR, readJson, writeJson, traces, saveState, rainForecast, warnings,
  classify, trend, unitFor, localDate, readCsv
} from './lib.mjs';
import {
  upsertHourly, recentHourly, readDaily, upsertRainDaily, appendForecastSnapshot, appendWarnings, writeSitesTable
} from './store.mjs';

const now = new Date();
const log = [];
const note = (level, msg) => { log.push({ t: now.toISOString(), level, msg }); console.log(level, msg); };
const statePath = path.join(DATA, 'state', 'collect.json');
const st = readJson(statePath, { noFlow: {}, names: {} });

// ---------------- gauges
const start = new Date(now.getTime() - 72 * HOUR);
let added = 0;
for (const site of CFG.sites) {
  for (const kind of ['level', 'flow']) {
    if (kind === 'flow' && (st.noFlow[site.id] || 0) > now.getTime() - 24 * HOUR) continue;
    try {
      const res = await traces(site, kind, start, now, 'hour', kind === 'level' ? 'max' : 'mean');
      if (res.name && site.autoName) st.names[site.id] = res.name;
      added += upsertHourly(site, kind, res.points);
      if (kind === 'flow') delete st.noFlow[site.id];
    } catch (e) {
      if (kind === 'level') note('WARN', `${site.id} ${site.name} level: ${e.message}`);
      else st.noFlow[site.id] = now.getTime();
    }
  }
}
note('INFO', `Gauges: ${added} new hourly values`);

// ---------------- latest snapshot for the page
const eventsIndex = readJson(path.join(DATA, 'events', 'index.json'), { events: [] });
const sites = CFG.sites.map((s) => {
  const series = recentHourly(s.id, 'level', 7, now.getTime());
  const flow = recentHourly(s.id, 'flow', 2, now.getTime());
  const last = series.length ? series[series.length - 1] : null;
  // highest daily value in the history file
  let record = null;
  for (const d of readDaily(s.id)) if (d.level != null && (!record || d.level > record.level)) record = { level: d.level, date: d.date };
  return {
    id: s.id, bom: s.bom, name: st.names[s.id] || s.name, river: s.river, note: s.note, key: !!s.key,
    datum: s.datum, unit: unitFor(s), minor: s.minor, moderate: s.moderate, major: s.major,
    latest: last ? { t: last[0], v: last[1] } : null,
    trend: trend(series),
    status: classify(s, last ? last[1] : null),
    flowLatest: flow.length ? { t: flow[flow.length - 1][0], v: flow[flow.length - 1][1] } : null,
    series: series.filter((p, i) => i % 2 === 0 || i === series.length - 1), // every 2nd hour keeps the file small
    record
  };
});

// ---------------- rain
let rain = readJson(path.join(DATA, 'latest.json'), {}).rain || null;
try {
  const pts = await rainForecast();
  const today = localDate(now.getTime());
  const past = [], snap = [];
  for (const p of pts) {
    p.daily.time.forEach((d, i) => {
      const mm = p.daily.precipitation_sum[i];
      if (d < today) past.push({ date: d, point: p.id, mm, source: 'forecast-model' });
      else snap.push([now.toISOString(), p.id, d, mm, p.daily.precipitation_probability_max ? p.daily.precipitation_probability_max[i] : '']);
    });
  }
  upsertRainDaily(past);
  // keep one forecast snapshot per day so forecasts can later be checked against what fell
  const snapFile = path.join(DATA, 'rain', 'forecasts', now.toISOString().slice(0, 7) + '.csv');
  if (!readCsv(snapFile).some((r) => localDate(Date.parse(r[0])) === today)) appendForecastSnapshot(now.toISOString(), snap);
  rain = {
    fetched: now.toISOString(),
    points: pts.map((p) => ({
      id: p.id, name: p.name, catchment: p.catchment,
      days: p.daily.time.map((d, i) => ({
        date: d, type: d < today ? 'past' : d === today ? 'today' : 'forecast',
        mm: p.daily.precipitation_sum[i], prob: p.daily.precipitation_probability_max ? p.daily.precipitation_probability_max[i] : null
      }))
    }))
  };
} catch (e) { note('WARN', 'Rain: ' + e.message); }

// ---------------- warnings
let warn = { fetched: now.toISOString(), ok: false, items: [] };
try {
  const items = await warnings();
  appendWarnings(now.toISOString(), items);
  warn = { fetched: now.toISOString(), ok: true, items };
} catch (e) { note('WARN', 'Warnings: ' + e.message + ' (BoM may block automated requests)'); }

// ---------------- write
writeSitesTable();
writeJson(path.join(DATA, 'latest.json'), {
  generated: now.toISOString(),
  example: MOCK,
  sites, rain, warnings: warn,
  events: eventsIndex.events.map((e) => ({ id: e.id, name: e.name, anchor: e.anchor })),
  log
});
writeJson(statePath, st, true);
saveState();
