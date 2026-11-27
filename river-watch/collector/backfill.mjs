// River Watch - history back-fill and past-flood builder
//   node collector/backfill.mjs                    everything
//   node collector/backfill.mjs --only daily       daily levels and flows for every gauge
//   node collector/backfill.mjs --only storages    daily dam volumes (BoM Water Data Online)
//   node collector/backfill.mjs --only rain        daily rain history (ERA5)
//   node collector/backfill.mjs --only soil        daily soil moisture history (ERA5)
//   node collector/backfill.mjs --only climate     El Niño / La Niña, IOD and SAM monthly indices
//   node collector/backfill.mjs --only stats       percentiles and records from the history
//   node collector/backfill.mjs --only events      find past floods and build their files
//   add --from 2000 to start later, --force to rebuild flood files that already exist,
//   --gaps to fetch only the 5-year blocks of daily history that are still mostly empty
// Created by Josh Avard
import path from 'node:path';
import fs from 'node:fs';
import {
  CFG, KNOW, DATA, MOCK, HOUR, DAY, traces, saveState, rainArchive, rainArchiveHourly, soilArchive, storageHistory, climateIndex,
  sleep, writeJson, readJson, localDate, floodClass, round, sites, discoverSites, percentileOf
} from './lib.mjs';
import {
  readDaily, upsertDaily, readRainDaily, upsertRainDaily, upsertSoilDaily, readSoilDaily, upsertStorageDaily, readStorageDaily,
  readClimate, writeClimate, stats, quantiles
} from './store.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i > -1 ? args[i + 1] : dflt; };
const only = opt('only', 'all');
const force = args.includes('--force');
const gapsOnly = args.includes('--gaps');
const fromYear = Number(opt('from', CFG.historyStartYear));
const thisYear = new Date().getFullYear();
const polite = MOCK ? 0 : 1500; // ms between requests, keeps well under the state server's hourly download limit
const overLimit = (m) => /over your limit|downloaded .* in the last/i.test(String(m || ''));
const doIt = (k) => only === 'all' || only === k;
const EVENT_VERSION = 2;

await discoverSites();
const siteList = sites();

// ------------------------------------------------------------ 1. daily levels and flows
if (doIt('daily')) {
  for (const site of siteList) {
    for (const kind of ['level', 'flow']) {
      if (kind === 'flow' && site.noFlow) continue;
      let n = 0, skipped = 0, limited = 0;
      const have = gapsOnly ? new Set(readDaily(site.id).filter((d) => d[kind] != null).map((d) => d.date)) : null;
      for (let y = fromYear; y <= thisYear; y += 5) {
        const start = new Date(Date.UTC(y, 0, 1) - CFG.hydstraOffsetHours * HOUR);
        const end = new Date(Math.min(Date.UTC(y + 5, 0, 1) - CFG.hydstraOffsetHours * HOUR, Date.now()));
        if (have) {
          // skip blocks that are already at least 80% filled
          let got = 0, all = 0;
          for (let t = start.getTime() + 12 * HOUR; t < end.getTime(); t += DAY) { all++; if (have.has(localDate(t))) got++; }
          if (all && got / all >= 0.8) { skipped++; continue; }
        }
        const get = () => traces(site, kind, start, end, 'day', kind === 'level' ? 'max' : 'mean');
        try {
          const res = await get();
          upsertDaily(site.id, kind, res.points);
          n += res.points.length;
        } catch (e) {
          if (overLimit(e.message)) {
            // The state server judges each answer by how fast it arrived (0.07 MB in 1 s counts as
            // 247 MB/hour against a 150 MB/hour limit), so waiting does not help a big block.
            // Fetch it again as one-year pieces instead, each with one short retry.
            console.log(`  ${site.id} ${kind} ${y}: refused by the download limit, fetching it one year at a time`);
            await sleep(MOCK ? 0 : 60000);
            let missed = 0;
            for (let yy = y; yy < y + 5 && yy <= thisYear; yy++) {
              const s1 = new Date(Date.UTC(yy, 0, 1) - CFG.hydstraOffsetHours * HOUR);
              const e1 = new Date(Math.min(Date.UTC(yy + 1, 0, 1) - CFG.hydstraOffsetHours * HOUR, Date.now()));
              let ok = false;
              for (let t = 0; t < 2 && !ok; t++) {
                try {
                  const res = await traces(site, kind, s1, e1, 'day', kind === 'level' ? 'max' : 'mean');
                  upsertDaily(site.id, kind, res.points); n += res.points.length; ok = true;
                } catch (e2) {
                  if (!overLimit(e2.message)) { ok = true; break; } // no record for that year
                  await sleep(MOCK ? 0 : 90000);
                }
              }
              if (!ok) missed++;
              await sleep(MOCK ? 0 : 5000);
            }
            if (missed) { limited++; console.log(`  ${site.id} ${kind} ${y}: ${missed} year(s) still refused, left for a later gaps run`); }
          } /* otherwise: no record for this period */
        }
        await sleep(polite);
      }
      console.log(`daily ${site.id} ${site.name} ${kind}: ${n} days` + (skipped ? `, ${skipped} blocks already filled` : '') + (limited ? `, ${limited} blocks left by the download limit` : ''));
    }
  }
  saveState();
}

// ------------------------------------------------------------ 2. dam volumes (BoM Water Data Online)
if (doIt('storages')) {
  const today = localDate(Date.now());
  for (const s of CFG.storages.filter((x) => x.kiwis)) {
    let n = 0;
    for (let y = fromYear; y <= thisYear; y += 10) {
      const from = `${y}-01-01`, to = y + 9 >= thisYear ? today : `${y + 9}-12-31`;
      try {
        const vals = await storageHistory(s, from, to);
        upsertStorageDaily(vals.map(([date, vol]) => ({ date, storage: s.id, volume: Math.round(vol), pct: s.capacity ? round((vol / s.capacity) * 100, 2) : null, source: 'bom' })));
        n += vals.length;
      } catch (e) { console.log(`storage ${s.name} ${from}: ${e.message}`); break; }
      await sleep(MOCK ? 0 : 1500);
    }
    console.log(`storage ${s.name}: ${n} days`);
  }
}

// ------------------------------------------------------------ 3. rain history (ERA5)
if (doIt('rain')) {
  const endDate = localDate(Date.now() - 6 * DAY); // reanalysis runs about 5 days behind
  for (const p of CFG.rainPoints) {
    let n = 0;
    for (let y = Math.max(fromYear, 1950); y <= thisYear; y += 10) {
      const s = `${y}-01-01`, e = y + 9 >= thisYear ? endDate : `${y + 9}-12-31`;
      if (s > endDate) break;
      try {
        const rows = await rainArchive(p, s, e);
        upsertRainDaily(rows.filter((r) => r[1] != null).map(([date, mm]) => ({ date, point: p.id, mm, source: 'era5' })));
        n += rows.length;
      } catch (err) { console.log(`rain ${p.id} ${s}: ${err.message}`); }
      await sleep(MOCK ? 0 : 1200);
    }
    console.log(`rain ${p.name}: ${n} days`);
  }
}

// ------------------------------------------------------------ 4. soil moisture history (ERA5)
if (doIt('soil')) {
  const endDate = localDate(Date.now() - 6 * DAY);
  for (const c of CFG.catchments) {
    let n = 0;
    for (let y = Math.max(fromYear, 1950); y <= thisYear; y += 5) {
      const s = `${y}-01-01`, e = y + 4 >= thisYear ? endDate : `${y + 4}-12-31`;
      if (s > endDate) break;
      try { const rows = await soilArchive(c, s, e); upsertSoilDaily(c.id, rows); n += rows.length; }
      catch (err) { console.log(`soil ${c.id} ${s}: ${err.message}`); }
      await sleep(MOCK ? 0 : 2000);
    }
    console.log(`soil ${c.name}: ${n} days`);
  }
}

// ------------------------------------------------------------ 5. climate drivers
if (doIt('climate')) {
  const existing = readClimate();
  const byKey = { oni: {}, dmi: {}, sam: {} };
  for (const [m, v] of Object.entries(existing)) for (const k of Object.keys(byKey)) if (v[k] != null) byKey[k][m] = v[k];
  for (const k of Object.keys(byKey)) {
    try { Object.assign(byKey[k], await climateIndex(k)); console.log(`climate ${k}: ${Object.keys(byKey[k]).length} months`); }
    catch (e) { console.log(`climate ${k}: ${e.message}`); }
  }
  writeClimate(byKey);
}

// ------------------------------------------------------------ 6. percentiles and records
if (doIt('stats') || doIt('daily') || doIt('soil')) {
  const S = stats.read();
  S.flow = {}; S.record = {};
  for (const s of siteList) {
    const d = readDaily(s.id);
    const q = quantiles(d.map((r) => r.flow));
    if (q) S.flow[s.id] = q;
    if (!s.storageHead) {
      let rec = null;
      for (const r of d) if (r.level != null && r.level > (s.datum === 'AHD' ? 50 : -50) && (!rec || r.level > rec.level)) rec = { level: r.level, date: r.date };
      if (rec) S.record[s.id] = rec;
    }
  }
  const soil = readSoilDaily();
  S.soil = {};
  for (const c of CFG.catchments) for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const q = quantiles(soil.filter((r) => r.catchment === c.id && r.date.slice(5, 7) === mm).map((r) => r.mm));
    if (q) (S.soil[c.id] ||= {})[mm] = q;
  }
  stats.write(S);
  console.log(`stats: flow percentiles for ${Object.keys(S.flow).length} gauges, soil for ${Object.keys(S.soil).length} catchments`);
}

// ------------------------------------------------------------ 7. past floods
if (doIt('events')) {
  const siteById = Object.fromEntries(siteList.map((s) => [s.id, s]));
  const S = stats.read();

  // 7a. peaks above the minor flood level at the event gauges
  const candidates = [];
  for (const gid of CFG.eventGauges) {
    const site = siteById[gid];
    if (!site) continue;
    const days = readDaily(gid).filter((d) => d.level != null && !(site.datum === 'AHD' && d.level < 50));
    let run = null;
    const close = () => { if (run) candidates.push(run.peak); run = null; };
    for (const d of days) {
      if (d.level >= site.minor) {
        const t = Date.parse(d.date + 'T12:00:00Z');
        if (run && t - run.last > 14 * DAY) close();
        if (!run) run = { peak: { site: gid, date: d.date, level: d.level }, last: t };
        run.last = t;
        if (d.level > run.peak.level) run.peak = { site: gid, date: d.date, level: d.level };
      }
    }
    close();
  }

  // 7b. group peaks within 21 days into one flood; anchor on the first gauge in eventGauges order
  candidates.sort((a, b) => (a.date < b.date ? -1 : 1));
  const groups = [];
  for (const c of candidates) {
    const g = groups[groups.length - 1];
    if (g && Date.parse(c.date) - Date.parse(g[g.length - 1].date) <= 21 * DAY) g.push(c);
    else groups.push([c]);
  }
  let events = groups.map((g) => {
    const anchor = CFG.eventGauges.map((id) => g.find((c) => c.site === id)).find(Boolean);
    return { anchor: anchor.date, anchorSite: anchor.site, detected: g };
  });

  // 7c. attach known floods; add any the data did not find
  for (const ce of KNOW.curatedEvents) {
    const tol = (ce.approxDate ? 25 : 20) * DAY;
    const match = events.find((e) => Math.abs(Date.parse(e.anchor) - Date.parse(ce.date)) <= tol);
    if (match) Object.assign(match, { curated: ce });
    else events.push({ anchor: ce.date, anchorSite: ce.reported[0] && ce.reported[0].site, detected: [], curated: ce });
  }
  events.sort((a, b) => (a.anchor < b.anchor ? 1 : -1));

  const monthName = (d) => new Date(d + 'T12:00:00Z').toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const exampleNames = {};
  if (MOCK) [...events].filter((e) => !e.curated).sort((a, b) => (a.anchor < b.anchor ? -1 : 1)).forEach((e, i) => { exampleNames[e.anchor] = 'Example flood ' + letters[i]; });

  const rainByPoint = {};
  for (const r of readRainDaily()) (rainByPoint[r.point] ||= {})[r.date] = r.mm;
  const soilBy = {};
  for (const r of readSoilDaily()) (soilBy[r.catchment] ||= {})[r.date] = r.mm;
  const storeBy = {};
  for (const r of readStorageDaily()) (storeBy[r.storage] ||= {})[r.date] = r;
  const clim = readClimate();

  const index = [];
  for (const ev of events) {
    const id = ev.anchor;
    const name = ev.curated ? ev.curated.name : MOCK ? exampleNames[ev.anchor] : monthName(ev.anchor) + ' flood';
    const measured = !(MOCK && ev.curated); // in example mode, real floods show their reported peaks only
    const anchorT = Date.parse(ev.anchor + 'T02:00:00Z'); // midday AEST
    const start = new Date(anchorT - 10 * DAY), end = new Date(anchorT + 7 * DAY);
    const file = path.join(DATA, 'events', id + '.json');
    let detail = !force && fs.existsSync(file) ? readJson(file, null) : null;
    if (detail && detail.version !== EVENT_VERSION) detail = null;

    if (!detail) {
      detail = { version: EVENT_VERSION, id, name, anchor: ev.anchor, anchorT, example: MOCK, sites: {}, rain: {}, hourlyRain: {} };
      if (measured) {
        for (const site of siteList) {
          const entry = {};
          for (const kind of ['level', 'flow']) {
            if (kind === 'flow' && site.noFlow) continue;
            try {
              const res = await traces(site, kind, start, end, 'hour', kind === 'level' ? 'max' : 'mean');
              entry[kind] = res.points.filter((p, i) => i % 2 === 0).map((p) => [Math.round((p.t - anchorT) / HOUR), kind === 'level' ? round(p.v) : Math.round(p.v)]);
            } catch { /* no data */ }
            await sleep(polite);
          }
          if (entry.level || entry.flow) detail.sites[site.id] = entry;
        }
        // hourly rain for the 14 days before the peak
        try {
          const hr = await rainArchiveHourly(CFG.rainPoints, localDate(anchorT - 14 * DAY), localDate(anchorT + DAY));
          for (const c of CFG.catchments) {
            const ids = CFG.rainPoints.filter((p) => p.catchment === c.id).map((p) => p.id);
            let max1 = 0, max24 = 0;
            for (const pid of ids) {
              const vals = (hr[pid] || []).map((r) => r[1] || 0);
              let sum = 0;
              vals.forEach((v, i) => { sum += v; if (i >= 24) sum -= vals[i - 24]; max1 = Math.max(max1, v); max24 = Math.max(max24, sum); });
            }
            detail.hourlyRain[c.id] = { max1: round(max1, 1), max24: round(max24, 1) };
          }
        } catch (e) { console.log(`event ${id} hourly rain: ${e.message}`); }
      }
      console.log(`event ${id} ${name}: ${Object.keys(detail.sites).length} gauges`);
    }
    detail.name = name;

    // daily catchment rain, 30 days before to 3 days after
    detail.rain = {};
    const rainSummary = {};
    for (const c of measured ? CFG.catchments : []) {
      const ids = CFG.rainPoints.filter((p) => p.catchment === c.id).map((p) => p.id);
      const series = [];
      for (let d = -30; d <= 3; d++) {
        const date = localDate(anchorT + d * DAY);
        const vals = ids.map((pid) => rainByPoint[pid] && rainByPoint[pid][date]).filter((v) => v != null);
        series.push([d, vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length, 1) : null]);
      }
      detail.rain[c.id] = series;
      const sum = (from, to) => { const v = series.filter(([d, mm]) => d >= from && d <= to && mm != null); return v.length ? round(v.reduce((a, [, mm]) => a + mm, 0), 1) : null; };
      rainSummary[c.id] = { pre7: sum(-6, 0), pre30: sum(-29, 0) };
    }

    // peaks, flows and travel times
    const peaks = {}, flowPeaks = {};
    for (const [sid, e] of Object.entries(detail.sites)) {
      const s = siteById[sid];
      if (e.level && e.level.length) {
        const pk = e.level.reduce((a, b) => (b[1] > a[1] ? b : a));
        if (s && !(s.datum === 'AHD' && pk[1] < 50)) peaks[sid] = { v: pk[1], h: pk[0], cls: s ? floodClass(s, pk[1]) : null };
      }
      if (e.flow && e.flow.length) { const fp = e.flow.reduce((a, b) => (b[1] > a[1] ? b : a)); flowPeaks[sid] = { v: fp[1], h: fp[0] }; }
    }
    const travel = {};
    for (const p of KNOW.travel.pairs) if (peaks[p.from] && peaks[p.to]) travel[p.from + '>' + p.to] = peaks[p.to].h - peaks[p.from].h;

    // where Rochester's water came from, at the Rochester flow peak
    let budget = null;
    const tgt = flowPeaks[KNOW.budget.target];
    if (tgt) {
      const at = (sid, h) => { const f = detail.sites[sid] && detail.sites[sid].flow; if (!f) return null; let best = null; for (const p of f) { if (p[0] <= h) best = p; else break; } return best ? best[1] : null; };
      const parts = KNOW.budget.components.map((c) => {
        let sid = c.site;
        if (!sid) sid = (c.candidates || []).find((x) => detail.sites[x] && detail.sites[x].flow && (!c.nameMatch || String((siteById[x] && (siteById[x].discoveredName || siteById[x].name)) || '').toUpperCase().includes(c.nameMatch) || x === c.candidates[c.candidates.length - 1]));
        const lag = c.lagPair && travel[c.lagPair] != null ? travel[c.lagPair] : c.lagHours;
        return { key: c.key, label: c.label, site: sid || null, flow: sid ? at(sid, tgt.h - lag) : null };
      });
      const known = parts.reduce((a, p) => a + (p.flow || 0), 0);
      budget = { target: tgt.v, parts, remainder: Math.max(0, tgt.v - known) };
    }

    // Echuca: lowest head of the Campaspe over the Murray during the flood
    let backwaterMin = null;
    const ce = detail.sites['406265'] && detail.sites['406265'].level, mu = detail.sites['409200'] && detail.sites['409200'].level;
    if (ce && mu) {
      const mm = new Map(mu.map((p) => [p[0], p[1]]));
      for (const p of ce) { const m = mm.get(p[0]); if (m != null && p[1] > 50 && m > 50) { const h = p[1] - m; if (backwaterMin == null || h < backwaterMin.head) backwaterMin = { head: round(h, 2), h: p[0], campaspe: p[1], murray: m }; } }
    }

    // conditions a week before the peak
    const wk = localDate(anchorT - 7 * DAY);
    const epLevel = detail.sites['406219'] && detail.sites['406219'].level;
    const epAt = epLevel ? (epLevel.find((p) => p[0] >= -7 * 24) || epLevel[0]) : null;
    const epMax = epLevel ? epLevel.reduce((a, b) => (b[1] > a[1] ? b : a)) : null;
    const fsl = CFG.storages.find((s) => s.id === 'eppalock').fsl;
    const soilUp = soilBy['upper-campaspe'] && soilBy['upper-campaspe'][wk];
    const q = S.soil && S.soil['upper-campaspe'] && S.soil['upper-campaspe'][wk.slice(5, 7)];
    const month = ev.anchor.slice(0, 7);
    const prevMonth = localDate(anchorT - 31 * DAY).slice(0, 7);
    const cl = (k) => (clim[month] && clim[month][k] != null ? clim[month][k] : clim[prevMonth] && clim[prevMonth][k] != null ? clim[prevMonth][k] : null);
    const pctAt = (sid) => { const r = storeBy[sid] && storeBy[sid][wk]; return r && r.pct != null ? r.pct : null; };
    const before = measured ? {
      eppalockVsFsl: epAt && epAt[1] > 50 ? round(epAt[1] - fsl, 2) : null,
      eppalockMaxVsFsl: epMax && epMax[1] > 50 ? round(epMax[1] - fsl, 2) : null,
      eppalockPct: pctAt('eppalock'), humePct: pctAt('hume'), eildonPct: pctAt('eildon'),
      soilMm: soilUp ?? null, soilPct: soilUp != null && q ? percentileOf(q, soilUp) : null,
      oni: cl('oni'), dmi: cl('dmi'), sam: cl('sam')
    } : null;

    writeJson(file, detail);
    index.push({
      id, name, anchor: ev.anchor, anchorSite: ev.anchorSite, measured, approxDate: !!(ev.curated && ev.curated.approxDate),
      curated: !!ev.curated, notes: ev.curated ? ev.curated.notes : '', facts: ev.curated ? ev.curated.facts || [] : [], factSource: ev.curated ? ev.curated.factSource || null : null,
      reported: ev.curated ? ev.curated.reported : [],
      detectedDaily: ev.detected.map((c) => ({ site: c.site, date: c.date, level: c.level })),
      peaks, flowPeaks, rain: rainSummary, intensity: detail.hourlyRain || {}, travel, budget, backwaterMin, before
    });
  }
  writeJson(path.join(DATA, 'events', 'index.json'), { generated: new Date().toISOString(), example: MOCK, events: index });
  console.log(`events: ${index.length}`);
  saveState();
}
