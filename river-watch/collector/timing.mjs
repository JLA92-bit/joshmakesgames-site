// Temporary timing test (read-only).
const VIC = 'https://data.water.vic.gov.au/WMIS/cgi/webservice.exe?';
const pad = (n) => String(n).padStart(2, '0');
const ts = (y, m = 1) => `${y}${pad(m)}01000000`;
async function one(site, ds, vf, vt, y0, y1, dt) {
  const p = { function: 'get_ts_traces', version: '2', params: { site_list: site, datasource: ds, varfrom: vf, varto: vt, start_time: ts(y0), end_time: ts(y1), interval: 'day', multiplier: '1', data_type: dt } };
  const t0 = Date.now();
  try {
    const r = await fetch(VIC + encodeURIComponent(JSON.stringify(p)), { signal: AbortSignal.timeout(240000) });
    const txt = await r.text();
    let n = 0, err = '';
    try { const j = JSON.parse(txt); err = j.error_msg || ''; for (const tr of (j.return && j.return.traces) || []) { n += (tr.trace || []).length; if (tr.error_msg) err = tr.error_msg; } } catch { err = txt.slice(0, 120); }
    console.log(site, ds, vf + '->' + vt, y0 + '-' + y1, dt, ((Date.now() - t0) / 1000).toFixed(1) + 's', 'points', n, err.slice(0, 140));
  } catch (e) { console.log(site, ds, vf + '->' + vt, y0 + '-' + y1, dt, ((Date.now() - t0) / 1000).toFixed(1) + 's', 'ERR', e.message); }
}
await one('406213', 'PUBLISH', '100.00', '141.00', 1970, 1975, 'mean');
await one('406213', 'PUBLISH', '100.00', '141.00', 2000, 2005, 'mean');
await one('406213', 'PUBLISH', '100.00', '141.00', 2000, 2001, 'mean');
await one('406213', 'PUBLISH', '141.50', '141.50', 1960, 1976, 'mean');
await one('406213', 'A', '100.00', '141.00', 2000, 2001, 'mean');
await one('406201', 'PUBLISH', '100.00', '141.00', 2000, 2005, 'mean');
await one('406201', 'PUBLISH', '100.00', '100.00', 2000, 2005, 'max');
