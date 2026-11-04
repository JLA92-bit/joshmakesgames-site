// Temporary discovery script (read-only). Prints what the public data services offer.
const UA = 'RiverWatch/1.0 (Rochester community flood awareness project)';
const VIC = 'https://data.water.vic.gov.au/WMIS/cgi/webservice.exe?';
const NSW = 'https://realtimedata.waternsw.com.au/cgi/webservice.exe?';
const get = async (u, opt = {}) => { try { const r = await fetch(u, { headers: { 'User-Agent': UA, ...opt }, signal: AbortSignal.timeout(25000) }); return { status: r.status, text: await r.text() }; } catch (e) { return { status: 'ERR ' + e.message, text: '' }; } };
const hyd = async (base, payload) => { try { const r = await get(base + encodeURIComponent(JSON.stringify(payload))); return r.text; } catch (e) { return 'ERR ' + e.message; } };
const cut = (s, n = 3000) => (s.length > n ? s.slice(0, n) + ' ...[' + s.length + ']' : s);
const sec = (t) => console.log('\n=================== ' + t);

sec('WMIS site names via get_db_info');
for (const p of [
  { function: 'get_db_info', version: '3', params: { table_name: 'site', return_type: 'array', field_list: ['station', 'stname'], complex_filter: [{ fieldname: 'stname', operator: 'CONTAINS', value: 'EPPALOCK' }] } },
  { function: 'get_db_info', version: '3', params: { table_name: 'site', return_type: 'array', field_list: ['station', 'stname'], complex_filter: [{ fieldname: 'station', operator: 'STARTS', value: '4062' }] } },
  { function: 'get_site_list', version: '1', params: { site_list: 'MATCH(4062*)' } },
]) console.log(JSON.stringify(p.params).slice(0, 120), '\n', cut(await hyd(VIC, p), 6000));

sec('WMIS names for candidate ids');
const ids = ['406200','406207','406208','406209','406210','406211','406212','406215','406216','406219','406220','406221','406222','406224','406226','406235','406236','406276','406277','406278','406279','406280','405232','405204','405200','405201','405203','403241','403200','403224','405234','405276','405219','409200','409016','409017','409001'];
for (const ds of ['PUBLISH']) {
  console.log(cut(await hyd(VIC, { function: 'get_site_list', version: '1', params: { site_list: ids.join(','), datasource: ds } }), 2000));
  console.log(cut(await hyd(VIC, { function: 'get_db_info', version: '3', params: { table_name: 'site', return_type: 'array', field_list: ['station', 'stname', 'latitude', 'longitude'], filter_values: { station: ids.join(',') } } }), 6000));
}
sec('WMIS variable lists');
for (const id of ['406200', '406207', '406224', '405232', '405204', '403241', '406213']) {
  const t = await hyd(VIC, { function: 'get_variable_list', version: '1', params: { site_list: id, datasource: 'PUBLISH' } });
  console.log(id, cut(t, 1800));
}
sec('WaterNSW variable lists');
for (const id of ['409016', '409017', '409001', '401027', '409025']) {
  const t = await hyd(NSW, { function: 'get_variable_list', version: '1', params: { site_list: id, datasource: 'CP' } });
  console.log(id, cut(t, 1500));
}

sec('BoM warnings RSS');
const rss = await get('http://www.bom.gov.au/fwo/IDZ00059.warnings_vic.xml');
console.log(rss.status, cut(rss.text, 4000));
for (const m of rss.text.matchAll(/<link>([^<]+)<\/link>/g)) {
  const u = m[1].trim(); if (!/IDV|products/.test(u)) continue;
  const r = await get(u); console.log('\n--- ' + u, r.status, cut(r.text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), 2500));
  const txt = u.replace(/\.(shtml|html)$/, '.txt').replace('/products/', '/fwo/');
  const r2 = await get(txt); console.log('--- TXT ' + txt, r2.status, cut(r2.text, 1500));
}
sec('BoM flood class page');
const fc = await get('http://www.bom.gov.au/vic/flood/floodclass_north.shtml');
console.log(fc.status);
const plain = fc.text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
for (const k of ['McCoy', 'Shepparton', 'Peechelba', 'Wangaratta', 'Seymour', 'Heywood', 'Malmsbury', 'Lyal', 'Eppalock', 'Rochester', 'Echuca']) {
  for (const m of plain.matchAll(new RegExp('.{0,140}' + k + '.{0,160}', 'g'))) console.log('[' + k + ']', m[0]);
}
sec('BoM flood warning product list');
const fw = await get('http://www.bom.gov.au/vic/flood/'); console.log(fw.status, cut(fw.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), 1500));

sec('Open-Meteo soil moisture');
let t0 = Date.now();
let r = await get('https://api.open-meteo.com/v1/forecast?latitude=-37.24&longitude=144.45&hourly=soil_moisture_9_to_27cm,soil_moisture_27_to_81cm&past_days=7&forecast_days=3');
console.log(r.status, Date.now() - t0, cut(r.text, 600));
t0 = Date.now();
r = await get('https://archive-api.open-meteo.com/v1/archive?latitude=-37.24&longitude=144.45&start_date=2022-01-01&end_date=2022-12-31&daily=soil_moisture_0_to_100cm_mean,soil_moisture_0_to_7cm_mean&timezone=Australia%2FMelbourne');
console.log('daily mean', r.status, Date.now() - t0, cut(r.text, 600));
t0 = Date.now();
r = await get('https://archive-api.open-meteo.com/v1/archive?latitude=-37.24&longitude=144.45&start_date=2022-01-01&end_date=2022-12-31&hourly=soil_moisture_28_to_100cm,soil_moisture_7_to_28cm&timezone=Australia%2FMelbourne');
console.log('hourly 1y', r.status, Date.now() - t0, r.text.length, cut(r.text, 300));

sec('Flood maps WMS');
for (const u of [
  'https://opendata.maps.vic.gov.au/geoserver/wms?service=WMS&request=GetCapabilities',
  'https://services.land.vic.gov.au/catalogue/publicproxy/guest/dv_geoserver/wms?service=WMS&request=GetCapabilities',
]) {
  try { const x = await get(u); console.log(u, x.status, x.text.length); for (const m of x.text.matchAll(/<Name>([^<]*(?:flood|FLOOD|ari|ARI|aep|AEP)[^<]*)<\/Name>/g)) console.log('  layer', m[1]); } catch (e) { console.log(u, 'ERR', e.message); }
}
sec('Geocoder');
r = await get('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent('Ramsay Street Rochester VIC') + '&format=json&limit=1', { Accept: 'application/json' });
console.log(r.status, cut(r.text, 400));
sec('GMW storage page');
for (const u of ['https://www.g-mwater.com.au/water-resources/catchments/storage-levels', 'https://waterstatus.g-mwater.com.au/waterstatus/']) { try { const x = await get(u); console.log(u, x.status, cut(x.text.replace(/<script[\s\S]*?<\/script>/g,'').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), 1500)); } catch (e) { console.log(u, 'ERR', e.message); } }

sec('Planning flood overlays (ArcGIS REST)');
for (const u of [
  'https://spatial.planning.vic.gov.au/server/rest/services/planning_flood_control/MapServer/layers?f=json',
  'https://spatial.planning.vic.gov.au/server/rest/services/planning_flood_control/MapServer/identify?geometry=144.70,-36.363&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=2&mapExtent=144.6,-36.45,144.8,-36.3&imageDisplay=600,400,96&returnGeometry=false&f=json',
  'https://data.gov.au/geoserver/aep-flood-extent-north-central-cma-region-victoria-1/wms?service=WMS&request=GetCapabilities',
  'https://opendata.maps.vic.gov.au/geoserver/wfs?service=WFS&request=GetCapabilities',
]) { const x = await get(u); console.log('\n' + u, x.status, x.text.length); console.log(cut(x.text.replace(/\s+/g, ' '), 2500)); for (const m of x.text.matchAll(/<(?:Name|Title)>([^<]*(?:lood|FLOOD|AEP|aep)[^<]*)<\/(?:Name|Title)>/g)) console.log('  layer', m[1]); }
