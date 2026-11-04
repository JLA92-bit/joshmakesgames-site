// Temporary discovery script (read-only), round 3.
const UA = 'RiverWatch/1.0 (Rochester community flood awareness project)';
const VIC = 'https://data.water.vic.gov.au/WMIS/cgi/webservice.exe?';
const get = async (u, opt = {}) => { try { const r = await fetch(u, { headers: { 'User-Agent': UA, Origin: 'https://joshmakesgames.app', ...opt }, signal: AbortSignal.timeout(25000) }); return { status: r.status, cors: r.headers.get('access-control-allow-origin'), type: r.headers.get('content-type'), text: await r.text() }; } catch (e) { return { status: 'ERR ' + e.message, text: '' }; } };
const hyd = async (p) => (await get(VIC + encodeURIComponent(JSON.stringify(p)))).text;
const cut = (s, n = 3000) => (s.length > n ? s.slice(0, n) + ' ...[' + s.length + ']' : s);
const sec = (t) => console.log('\n=================== ' + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

sec('variable lists');
for (const id of ['406219', '406225', '405232', '405204', '403200']) {
  const t = await hyd({ function: 'get_variable_list', version: '1', params: { site_list: id, datasource: 'PUBLISH' } });
  try { const j = JSON.parse(t); for (const s of j.return.sites) { console.log(id, s.site_details.name); for (const v of s.variables) console.log('   ', v.variable, v.name, v.units, v.period_start, '->', v.period_end, v.subdesc); } } catch { console.log(id, cut(t, 600)); }
  await sleep(1500);
}
sec('storage trace tests 406219');
for (const [vf, vt] of [['130.00', '130.00'], ['130.00', '136.00'], ['100.00', '100.00'], ['130.00', '137.00']]) {
  const now = new Date(), s = new Date(now - 5 * 864e5);
  const fmt = (d) => { const l = new Date(d.getTime() + 10 * 3600e3); const p = (n) => String(n).padStart(2, '0'); return `${l.getUTCFullYear()}${p(l.getUTCMonth() + 1)}${p(l.getUTCDate())}000000`; };
  const t = await hyd({ function: 'get_ts_traces', version: '2', params: { site_list: '406219', datasource: 'PUBLISH', varfrom: vf, varto: vt, start_time: fmt(s), end_time: fmt(now), interval: 'day', multiplier: '1', data_type: 'mean' } });
  console.log(vf, vt, cut(t, 700));
  await sleep(1500);
}
sec('flood map services + CORS');
const B = '16090000,-4355000,16115000,-4335000';
for (const u of [
  'https://spatial.planning.vic.gov.au/server/rest/services/planning_flood_control/MapServer?f=json',
  'https://spatial.planning.vic.gov.au/server/rest/services/planning_flood_control/MapServer/export?bbox=' + B + '&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&layers=show:6&f=image',
  'https://spatial.planning.vic.gov.au/server/rest/services/planning_flood_control/MapServer/identify?geometry=144.70,-36.363&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=2&mapExtent=144.6,-36.45,144.8,-36.3&imageDisplay=600,400,96&returnGeometry=false&f=json',
  'https://opendata.maps.vic.gov.au/geoserver/wms?service=WMS&version=1.1.1&request=GetMap&layers=open-data-platform:vic_flood_history_public&styles=&srs=EPSG:3857&bbox=' + B + '&width=256&height=256&format=image/png&transparent=true',
  'https://opendata.maps.vic.gov.au/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=open-data-platform:vic_flood_history_public&count=2&outputFormat=application/json&bbox=-36.40,144.65,-36.33,144.75,EPSG:4326',
  'https://nominatim.openstreetmap.org/search?q=Ramsay%20Street%20Rochester%20VIC&format=json&limit=1',
  'https://tiles.openfreemap.org/styles/positron',
  'http://reg.bom.gov.au/fwo/IDV36750.txt',
]) {
  const x = await get(u);
  console.log('\n' + u.slice(0, 160), '\n  status', x.status, 'cors', x.cors, 'type', x.type, 'len', x.text.length);
  if (!/image/.test(x.type || '')) console.log(cut(x.text.replace(/\s+/g, ' '), u.includes('MapServer?f=json') ? 6000 : 1500));
}
