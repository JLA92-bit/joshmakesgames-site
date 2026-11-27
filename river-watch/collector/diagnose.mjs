// River Watch - one-off diagnosis, round 2. Read-only: writes no files.
// Created by Josh Avard
import { CFG, getJson } from './lib.mjs';

const line = (...a) => console.log(...a);
const wmis = (fn, params) => getJson(CFG.portals.vic.url + encodeURIComponent(JSON.stringify({ function: fn, version: '1', params })), 2);
const kiwis = (params) => getJson(CFG.storageCfg.kiwis.url + '?' + new URLSearchParams({ service: 'kisters', type: 'QueryServices', format: 'json', ...params }).toString(), 2);
const table = (j) => (Array.isArray(j) && j.length > 1 ? j.slice(1).map((r) => Object.fromEntries(j[0].map((h, i) => [h, r[i]]))) : []);

line('=== 1. Victorian (WMIS) Campaspe basin sites with McIvor, Coliban, Mount Pleasant or Axe in the name');
try {
  const j = await wmis('get_site_list', { site_list: 'MATCH(406*)', fields: ['station', 'stname', 'latitude', 'longitude'] });
  const sites = (j.return && j.return.sites) || [];
  line(`  ${sites.length} sites in basin 406`);
  for (const s of sites) if (/IVOR|COLIBAN|PLEASANT|AXE|CAMPASPE.*(EPPALOCK|REDESDALE)/i.test(s.stname || '')) line(`  ${s.station} ${s.stname} (${s.latitude},${s.longitude})`);
} catch (e) { line('  ERROR ' + e.message); }
for (const id of ['406215', '406200', '406222', '406231', '406237']) {
  try {
    const j = await wmis('get_variable_list', { site_list: id, datasource: 'PUBLISH' });
    const v = ((j.return && j.return.sites && j.return.sites[0] && j.return.sites[0].variables) || []).map((x) => `${x.variable} ${String(x.name).slice(0, 22)} ${x.period_start}-${x.period_end}`);
    line(`  ${id}: ${v.join(' | ') || 'none'}`);
  } catch (e) { line(`  ${id}: ERROR ${e.message}`); }
}

line('=== 2. BoM Water Data Online time series for the NSW-only Murray gauges');
for (const id of ['409001', '409017', '409002', '409025', '409003', '409005']) {
  try {
    const list = table(await kiwis({ request: 'getTimeseriesList', station_no: id, parametertype_name: 'Water Course Level', returnfields: 'ts_id,ts_name,coverage', }));
    line(`  ${id}: ` + (list.map((t) => `${t.ts_name} [${t.ts_id}] ${t.from || ''}..${t.to || ''}`).join(' | ') || 'none'));
    const raw = list.find((t) => /AsStored|Merged/.test(t.ts_name) && !/Daily|Monthly|Yearly|24HR/i.test(t.ts_name)) || list[0];
    if (raw) {
      const from = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
      const v = await kiwis({ request: 'getTimeseriesValues', ts_id: raw.ts_id, from, returnfields: 'Timestamp,Value' });
      const data = ((Array.isArray(v) ? v[0] : v) || {}).data || [];
      line(`    ${raw.ts_name}: ${data.length} values since ${from}; last ${JSON.stringify(data.slice(-2))}`);
    }
  } catch (e) { line(`  ${id}: ERROR ${e.message}`); }
}
