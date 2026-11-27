// River Watch - one-off diagnosis, round 3: checks the fixes against the live services. Read-only: writes no data files.
// Created by Josh Avard
import { CFG, sites, traces, getJson, HOUR } from './lib.mjs';

const line = (...a) => console.log(...a);
const now = new Date(), start = new Date(now.getTime() - 72 * HOUR);
const fmt = (t) => new Date(t).toISOString().slice(0, 16);

line('=== 1. gauges that failed before');
const all = sites();
for (const id of ['406219', '406218', '409017', '409001', '409002', '409025', '409003', '409005', '405200', '405237', '405269']) {
  const s = all.find((x) => x.id === id);
  if (!s) { line(id, 'not in config'); continue; }
  try { const r = await traces(s, 'level', start, now, 'hour', 'max'); const l = r.points[r.points.length - 1]; line(`${id} ${s.name}: ${r.points.length} values via ${r.portal}, last ${l.v} at ${fmt(l.t)}`); }
  catch (e) { line(`${id} ${s.name}: FAILED ${String(e.message).slice(0, 140)}`); }
}

line('=== 2. McIvor Creek candidates in BoM Water Data Online');
for (const q of ['*IVOR*', '*Ivor*', '*MC IVOR*', '*HEATHCOTE*', '*Heathcote*']) {
  try {
    const j = await getJson(CFG.storageCfg.kiwis.url + '?' + new URLSearchParams({ service: 'kisters', type: 'QueryServices', format: 'json', request: 'getStationList', parameterType_name: 'Water Course Level', station_name: q, returnfields: 'station_name,station_no' }).toString(), 2);
    line(`${q}: ` + ((Array.isArray(j) ? j.slice(1) : []).map((r) => r.join(' ')).join(' | ') || 'none'));
  } catch (e) { line(`${q}: ERROR ${e.message}`); }
}

line('=== 3. river model points');
const pts = CFG.riverModel;
let data = await getJson('https://flood-api.open-meteo.com/v1/flood?latitude=' + pts.map((p) => p.lat).join(',') + '&longitude=' + pts.map((p) => p.lon).join(',') + '&daily=river_discharge,river_discharge_median,river_discharge_p25,river_discharge_p75,river_discharge_max&past_days=7&forecast_days=3');
if (!Array.isArray(data)) data = [data];
pts.forEach((p, i) => line(`${p.id}: ${JSON.stringify(data[i].daily.river_discharge)} median ${JSON.stringify(data[i].daily.river_discharge_median)}`));
