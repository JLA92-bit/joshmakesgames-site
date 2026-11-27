// River Watch - derived flood factors (inflow budget, Echuca backwater, upstream signals, wetness, intensity, factor board)
// Created by Josh Avard
import { CFG, KNOW, HOUR, DAY, round, median, percentileOf, classify, trend, localDate, climatePhase } from './lib.mjs';

const ord = (n) => { const v = n % 100; return (v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'); };
const last = (a) => (a && a.length ? a[a.length - 1] : null);
/** Value of a series at (or just before) time t. */
export function valueAt(series, t, toleranceH = 6) {
  if (!series || !series.length) return null;
  let best = null;
  for (const p of series) { if (p[0] <= t) best = p; else break; }
  return best && t - best[0] <= toleranceH * HOUR ? best[1] : null;
}

// ------------------------------------------------------------ travel times
/** Peak travel times: median of past floods when measured at least twice, otherwise the plan's approximate figure. */
export function travelTimes(eventsIndex) {
  const out = {};
  for (const p of KNOW.travel.pairs) {
    const key = p.from + '>' + p.to;
    const vals = (eventsIndex.events || []).map((e) => e.travel && e.travel[key]).filter((v) => v != null && v > -48 && v < 400);
    if (vals.length >= 2) out[key] = { hours: median(vals), source: `Measured: median of ${vals.length} past floods`, n: vals.length, label: p.label };
    else if (p.hours != null) out[key] = { hours: p.hours, source: p.source || 'Approximate', n: 0, label: p.label };
    else out[key] = { hours: null, source: 'Not yet measured', n: 0, label: p.label };
  }
  return out;
}

// ------------------------------------------------------------ where Rochester's water comes from
export function resolveBudgetSite(comp, siteList) {
  if (comp.site) return siteList.find((s) => s.id === comp.site) || null;
  for (const id of comp.candidates || []) {
    const s = siteList.find((x) => x.id === id);
    if (!s) continue;
    const nm = String(s.discoveredName || s.wmisName || s.name).toUpperCase();
    if (!comp.nameMatch || nm.includes(comp.nameMatch)) return s;
  }
  return siteList.find((x) => x.id === (comp.candidates || []).slice(-1)[0]) || null;
}
export function budget(recent, siteList, travel, now) {
  const cfg = KNOW.budget;
  const target = siteList.find((s) => s.id === cfg.target);
  const tFlow = recent[cfg.target] && recent[cfg.target].flow;
  const targetNow = last(tFlow);
  const comps = cfg.components.map((c) => {
    const s = resolveBudgetSite(c, siteList);
    const tr = c.lagPair && travel[c.lagPair] && travel[c.lagPair].hours != null ? travel[c.lagPair].hours : c.lagHours;
    const lagSource = c.lagPair && travel[c.lagPair] && travel[c.lagPair].n ? 'measured' : 'assumed';
    const series = s && recent[s.id] && recent[s.id].flow;
    const v = series ? valueAt(series, (targetNow ? targetNow[0] : now) - tr * HOUR, 8) : null;
    return { key: c.key, label: c.label, site: s ? s.id : null, siteName: s ? (s.discoveredName || s.wmisName || s.name) : null, lagHours: tr, lagSource, flow: v == null ? null : Math.round(v), nowFlow: series && last(series) ? Math.round(last(series)[1]) : null };
  });
  const known = comps.reduce((a, c) => a + (c.flow || 0), 0);
  const remainder = targetNow ? Math.max(0, Math.round(targetNow[1] - known)) : null;
  // inflow to Lake Eppalock now
  const inflowParts = cfg.eppalockInflow.map((k) => {
    const s = siteList.find((x) => x.id === k || x.slug === k);
    const f = s && recent[s.id] && last(recent[s.id].flow);
    return { label: s ? (s.short || s.name) : k, site: s ? s.id : null, flow: f ? Math.round(f[1]) : null };
  });
  const outflow = recent['406207'] && last(recent['406207'].flow);
  return {
    target: target ? target.name : cfg.target, targetFlow: targetNow ? Math.round(targetNow[1]) : null, targetTime: targetNow ? targetNow[0] : null,
    components: comps, remainder, remainderLabel: cfg.remainderLabel,
    eppalock: { inflow: inflowParts, inflowTotal: inflowParts.some((p) => p.flow != null) ? inflowParts.reduce((a, p) => a + (p.flow || 0), 0) : null, outflow: outflow ? Math.round(outflow[1]) : null }
  };
}

// ------------------------------------------------------------ Echuca: Campaspe against the Murray
export function backwater(recent) {
  const c = recent['406265'] && recent['406265'].level, m = recent['409200'] && recent['409200'].level;
  if (!c || !m || !c.length || !m.length) return null;
  const mMap = new Map(m.map((p) => [Math.round(p[0] / HOUR), p[1]]));
  const series = [];
  for (const p of c) {
    const mv = mMap.get(Math.round(p[0] / HOUR));
    if (mv != null && p[1] > 50 && mv > 50) series.push([p[0], round(p[1], 3), round(mv, 3), round(p[1] - mv, 3)]);
  }
  if (!series.length) return { ok: false, reason: 'One of the two Echuca gauges is not reporting in m AHD yet.' };
  const lastRow = last(series);
  const heads = series.map((r) => r[3]);
  return {
    ok: true, time: lastRow[0], campaspe: lastRow[1], murray: lastRow[2], head: lastRow[3],
    headMin7: round(Math.min(...heads), 3), headMax7: round(Math.max(...heads), 3),
    series: series.filter((r, i) => i % 2 === 0 || i === series.length - 1)
  };
}

// ------------------------------------------------------------ upstream signals
export function signals(recent, siteList, travel, now) {
  const mk = (from, to, toName) => {
    const s = siteList.find((x) => x.id === from);
    if (!s) return null;
    const lv = recent[s.id] && recent[s.id].level, fl = recent[s.id] && recent[s.id].flow;
    const l = last(lv);
    const tr = travel[from + '>' + to] || { hours: null, source: 'Not yet measured' };
    return {
      id: s.id, name: s.short || s.name, river: s.river, to: toName, level: l ? l[1] : null, unit: s.datum === 'AHD' ? 'm AHD' : 'm',
      flow: last(fl) ? Math.round(last(fl)[1]) : null, trend: trend(lv), flowTrend: trend(fl, 6, 50),
      status: classify(s, l ? l[1] : null), travelHours: tr.hours, travelSource: tr.source,
      arrives: tr.hours != null && l ? l[0] + tr.hours * HOUR : null
    };
  };
  return {
    rochester: [mk('406207', '406283', 'Rochester'), mk('406201', '406283', 'Rochester'), mk('406224', '406283', 'Rochester')].filter(Boolean),
    echuca: [mk('406265', '409200', 'Echuca Wharf'), mk('405204', '405232', 'McCoys Bridge'), mk('405232', '409200', 'Echuca Wharf'), mk('409202', '409200', 'Echuca Wharf'), mk('409215', '409200', 'Echuca Wharf')].filter(Boolean)
  };
}

// ------------------------------------------------------------ rain intensity from hourly forecasts
function maxRolling(vals, n) {
  let best = 0, sum = 0;
  for (let i = 0; i < vals.length; i++) { sum += vals[i] || 0; if (i >= n) sum -= vals[i - n] || 0; if (sum > best) best = sum; }
  return round(best, 1);
}
export function intensity(point, nowLocalHour) {
  const h = point.hourly;
  if (!h || !h.time) return null;
  const past = [], next = [];
  const pastStart = new Date(Date.parse(nowLocalHour + ':00Z') - 7 * DAY).toISOString().slice(0, 13) + ':00';
  const nextEnd = new Date(Date.parse(nowLocalHour + ':00Z') + 3 * DAY).toISOString().slice(0, 13) + ':00';
  h.time.forEach((t, i) => {
    const v = h.precipitation[i];
    if (t >= pastStart && t < nowLocalHour) past.push(v);
    else if (t >= nowLocalHour && t < nextEnd) next.push(v);
  });
  return { max1hPast: maxRolling(past, 1), max24hPast: maxRolling(past, 24), max1hNext: maxRolling(next, 1), max24hNext: maxRolling(next, 24) };
}

// ------------------------------------------------------------ factor board
const lvl = (v, watch, high) => (v == null ? 'unknown' : v >= high ? 'high' : v >= watch ? 'watch' : 'calm');
export function factorBoard(ctx) {
  const T = KNOW.thresholds;
  const { storages, catchments, sitesOut, climate, backwaterRes, refEvent } = ctx;
  const tiles = [];
  const ref = refEvent ? refEvent.name : 'October 2022';
  const fmt = (v, d = 0) => (v == null ? '-' : Number(v).toFixed(d));

  const ep = storages.find((s) => s.id === 'eppalock');
  const epHead = sitesOut.find((s) => s.id === '406219');
  const epPct = ep && ep.pct != null ? ep.pct : null;
  const spill = epHead && epHead.latest && epHead.storageHead ? epHead.latest.v - epHead.storageHead.fsl : null;
  tiles.push({
    id: 'eppalock', title: 'Lake Eppalock', value: epPct != null ? fmt(epPct, 1) : '-', unit: '% full',
    detail: spill != null ? (spill >= 0 ? `Spilling, ${spill.toFixed(2)} m above full supply` : `${(-spill).toFixed(2)} m below the spillway`) : 'Dam level not reporting',
    level: epPct == null ? 'unknown' : epPct >= T.eppalockHighPct || (spill != null && spill >= 0) ? 'high' : epPct >= T.eppalockWatchPct ? 'watch' : 'calm',
    compare: refEvent && refEvent.eppalockBefore != null ? `Before ${ref}: ${fmt(refEvent.eppalockBefore, 2)} m ${refEvent.eppalockBefore >= 0 ? 'above' : 'below'} full` : 'Before October 2022: full and spilling for two weeks',
    why: 'When the lake is full, rain on the upper catchment flows straight through to Rochester.'
  });

  const up = catchments.find((c) => c.id === 'upper-campaspe');
  const soil = up && up.soil;
  tiles.push({
    id: 'soil', title: 'Ground wetness', value: soil && soil.pct != null ? soil.pct + ord(soil.pct) : '-', unit: soil && soil.pct != null ? 'percentile' : '',
    detail: soil && soil.mm != null ? `${fmt(soil.mm)} mm of water in the top metre, upper Campaspe (${soil.date})` : 'Soil moisture not loaded yet',
    level: soil ? lvl(soil.pct, T.soilWatchPct, T.soilHighPct) : 'unknown',
    compare: refEvent && refEvent.soilPct != null ? `Before ${ref}: ${refEvent.soilPct}${ord(refEvent.soilPct)} percentile` : 'Before October 2022: saturated after months of rain',
    why: 'Wet ground turns more of the next rain into runoff.'
  });

  tiles.push({
    id: 'rain7', title: 'Rain coming', value: up && up.rainNext7 != null ? fmt(up.rainNext7) : '-', unit: 'mm, next 7 days',
    detail: up ? `Upper Campaspe average. Next 3 days: ${fmt(up.rainNext3)} mm` : '',
    level: up ? lvl(up.rainNext7, T.rain7Watch, T.rain7High) : 'unknown',
    compare: refEvent && refEvent.rainPre7 != null ? `7 days before ${ref}: ${fmt(refEvent.rainPre7)} mm` : '',
    why: 'Forecast rain over the hills above Lake Eppalock.'
  });

  const maxNext24 = Math.max(...catchments.map((c) => c.max24hNext3 || 0));
  const max1 = Math.max(...catchments.map((c) => c.max1hNext3 || 0));
  tiles.push({
    id: 'intensity', title: 'Heaviest burst', value: fmt(maxNext24), unit: 'mm in 24 hours',
    detail: `Heaviest forecast hour: ${fmt(max1, 1)} mm (any catchment, next 3 days)`,
    level: lvl(maxNext24, T.rain24Watch, T.rain24High),
    compare: refEvent && refEvent.max24 != null ? `Before ${ref}: ${fmt(refEvent.max24)} mm in 24 hours` : '',
    why: 'Short, heavy bursts fill creeks quickly, even when the dam is not spilling.'
  });

  const creekIds = sitesOut.filter((s) => s.group === 'creeks');
  const creekPcts = creekIds.map((s) => s.flowPct).filter((v) => v != null);
  const topCreek = creekIds.filter((s) => s.flowPct != null).sort((a, b) => b.flowPct - a.flowPct)[0];
  tiles.push({
    id: 'creeks', title: 'Creek flows', value: topCreek ? topCreek.flowPct + ord(topCreek.flowPct) : '-', unit: topCreek ? 'percentile' : '',
    detail: topCreek ? `Highest relative flow: ${topCreek.short || topCreek.name}, ${Math.round(topCreek.flowLatest.v).toLocaleString('en-AU')} ML/day` : 'Creek flow history loads with the back-fill',
    level: creekPcts.length ? lvl(Math.max(...creekPcts), T.flowWatchPct, T.flowHighPct) : 'unknown',
    compare: 'October 2022: creeks below the dam added about 30,000 ML/day',
    why: 'Axe, Mount Pleasant and Forest creeks join below the dam, so they reach Rochester without passing through Eppalock.'
  });

  const gb = sitesOut.find((s) => s.id === '405232');
  tiles.push({
    id: 'goulburn', title: 'Goulburn at McCoys Bridge', value: gb && gb.latest ? fmt(gb.latest.v, 2) : '-', unit: 'm',
    detail: gb ? `${gb.status.label}${gb.trend !== 'unknown' ? ', ' + gb.trend : ''}. About 4 to 5 days to Echuca` : '',
    level: gb ? ({ major: 'high', moderate: 'high', minor: 'watch', near: 'watch' }[gb.status.code] || (gb.status.code === 'nodata' ? 'unknown' : 'calm')) : 'unknown',
    compare: '', why: 'The Goulburn joins the Murray just above Echuca and can hold the Campaspe back.'
  });

  const hume = storages.find((s) => s.id === 'hume');
  const toc = sitesOut.find((s) => s.id === '409202');
  tiles.push({
    id: 'murray', title: 'Upper Murray', value: hume && hume.pct != null ? fmt(hume.pct, 1) : '-', unit: '% Hume full',
    detail: toc ? `Tocumwal ${toc.latest ? fmt(toc.latest.v, 2) + ' m, ' : ''}${toc.status.label.toLowerCase()}` : '',
    level: (toc && ['minor', 'moderate', 'major'].includes(toc.status.code)) ? 'high' : (hume && hume.pct >= T.storageWatchPct) || (toc && toc.status.code === 'near') ? 'watch' : hume || toc ? 'calm' : 'unknown',
    compare: '', why: 'A full Hume means Murray inflows pass downstream. Tocumwal peaks reach Echuca in 3 to 4 days.'
  });

  const ew = sitesOut.find((s) => s.id === '409200');
  tiles.push({
    id: 'backwater', title: 'Murray at Echuca', value: ew && ew.latest ? fmt(ew.latest.v, 2) : '-', unit: 'm AHD',
    detail: backwaterRes && backwaterRes.ok ? `Campaspe sits ${fmt(backwaterRes.head, 2)} m above the Murray at Echuca` : (ew ? ew.status.label : ''),
    level: ew ? ({ major: 'high', moderate: 'high', minor: 'watch', near: 'watch' }[ew.status.code] || (ew.status.code === 'nodata' || ew.status.code === 'info' ? 'unknown' : 'calm')) : 'unknown',
    compare: '', why: 'A high Murray slows the Campaspe draining away, so water backs up towards Echuca.'
  });

  const wet = climate ? ['oni', 'dmi', 'sam'].filter((k) => climate[k] && climate[k].phase.code === 'wet') : [];
  tiles.push({
    id: 'climate', title: 'Climate drivers', value: climate ? String(wet.length) : '-', unit: 'of 3 lean wet',
    detail: climate ? ['oni', 'dmi', 'sam'].map((k) => climate[k] ? climate[k].phase.label : '').filter(Boolean).join(' · ') : 'Climate indices not loaded yet',
    level: !climate ? 'unknown' : wet.length >= 2 ? 'high' : wet.length === 1 ? 'watch' : 'calm',
    compare: 'October 2022: La Niña (third year) and a negative IOD',
    why: 'La Niña, a negative Indian Ocean Dipole and a positive SAM all tend to bring wetter seasons to northern Victoria.'
  });
  return tiles;
}

export { localDate, climatePhase, percentileOf };
