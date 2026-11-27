// River Watch - one-off diagnosis of gauges and model points that return nothing. Read-only: writes no files.
// Created by Josh Avard
import { CFG, getJson, getText, kiwisStations, variableList } from './lib.mjs';

const line = (...a) => console.log(...a);
const vars = (j) => {
  const out = [];
  for (const s of (j && j.return && j.return.sites) || []) for (const v of s.variables || []) out.push(`${v.variable} ${String(v.name || '').slice(0, 30)} ${v.period_start || ''}-${v.period_end || ''}`);
  return out;
};

line('=== 1. variables each failing gauge records');
for (const id of ['406219', '406218', '406265', '409005', '405200', '405237', '405269', '409017', '409001', '409002', '409025', '409003']) {
  for (const [pk, p] of Object.entries(CFG.portals)) {
    for (const ds of p.datasources) {
      try {
        const v = vars(await variableList(pk, ds, id));
        line(`${id} ${pk}:${ds} -> ${v.length ? v.join(' | ') : 'none'}`);
      } catch (e) { line(`${id} ${pk}:${ds} -> ERROR ${String(e.message).slice(0, 80)}`); }
    }
  }
}

line('=== 2. WaterNSW access with different request headers');
const nswUrl = CFG.portals.nsw.url + encodeURIComponent(JSON.stringify({ function: 'get_variable_list', version: '1', params: { site_list: '409001', datasource: 'CP' } }));
for (const [name, headers] of [['site UA', { 'User-Agent': 'RiverWatch/2.0 (Rochester community flood awareness project)' }], ['no UA', {}], ['browser UA', { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', Accept: 'application/json,text/plain,*/*' }]]) {
  try { const r = await fetch(nswUrl, { headers }); const t = await r.text(); line(`${name}: HTTP ${r.status} ${t.slice(0, 120).replace(/\s+/g, ' ')}`); }
  catch (e) { line(`${name}: ERROR ${e.message}`); }
}
try { const t = await getText('https://realtimedata.waternsw.com.au/'); line('WaterNSW home page: ' + t.slice(0, 80).replace(/\s+/g, ' ')); } catch (e) { line('WaterNSW home page: ' + e.message); }

line('=== 3. BoM Water Data Online stations for the creeks');
for (const q of ['*Coliban*', '*COLIBAN*', '*McIvor*', '*MCIVOR*', '*Campaspe*']) {
  try {
    const list = await kiwisStations(q, 'Water Course Level');
    line(`${q}: ` + (list.map((s) => `${s.station_no} ${s.station_name} (${s.station_latitude},${s.station_longitude})`).join(' | ') || 'none'));
  } catch (e) { line(`${q}: ERROR ${e.message}`); }
}

line('=== 4. GloFAS cells near each model point (mean flow, last 30 days, m3/s)');
for (const p of CFG.riverModel) {
  const cand = [];
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) cand.push({ lat: +(p.lat + dy * 0.025).toFixed(4), lon: +(p.lon + dx * 0.025).toFixed(4) });
  try {
    let data = await getJson('https://flood-api.open-meteo.com/v1/flood?latitude=' + cand.map((c) => c.lat).join(',') + '&longitude=' + cand.map((c) => c.lon).join(',') + '&daily=river_discharge&past_days=30&forecast_days=1');
    if (!Array.isArray(data)) data = [data];
    const scored = cand.map((c, i) => { const v = (data[i] && data[i].daily && data[i].daily.river_discharge || []).filter((x) => x != null); return { ...c, mean: v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0, glat: data[i] && data[i].latitude, glon: data[i] && data[i].longitude }; });
    const here = scored[Math.floor(scored.length / 2)];
    scored.sort((a, b) => b.mean - a.mean);
    line(`${p.id}: configured (${p.lat},${p.lon}) mean ${here.mean.toFixed(2)}; best: ` + scored.slice(0, 5).map((c) => `(${c.lat},${c.lon}) ${c.mean.toFixed(1)}`).join(' | '));
  } catch (e) { line(`${p.id}: ERROR ${e.message}`); }
}
