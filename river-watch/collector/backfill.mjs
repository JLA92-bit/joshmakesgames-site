// River Watch - history back-fill and past-flood builder
//   node collector/backfill.mjs                 everything (daily history, rain history, events)
//   node collector/backfill.mjs --only daily    just daily levels and flows
//   node collector/backfill.mjs --only rain     just rain history (ERA5)
//   node collector/backfill.mjs --only events   just detect floods and build event files
//   node collector/backfill.mjs --only storage  just storage history (Lake Eppalock)
//   node collector/backfill.mjs --only soil     just soil moisture history (ERA5)
//   add --from 2000 to start later, --force to rebuild event files, --sites 406201,406283 for some gauges only
// Created by Josh Avard
import path from 'node:path';
import fs from 'node:fs';
import {
  CFG, DATA, MOCK, HOUR, DAY, traces, saveState, rainArchive, sleep, writeJson, readJson, localDate, floodClass, round,
  varTrace, soilArchive
} from './lib.mjs';
import { readDaily, upsertDaily, readRainDaily, upsertRainDaily, upsertStorage, upsertSoil } from './store.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i > -1 ? args[i + 1] : dflt; };
const only = opt('only', 'all');
const force = args.includes('--force');
const fromYear = Number(opt('from', CFG.historyStartYear));
const thisYear = new Date().getFullYear();
const polite = MOCK ? 0 : 300; // ms between requests

// ------------------------------------------------------------ 1. daily levels and flows
if (only === 'all' || only === 'daily') {
  const siteList = opt('sites', '') ? CFG.sites.filter((s) => opt('sites', '').split(',').includes(s.id)) : CFG.sites;
  // Flows are converted from levels on the server, which can be slow over long periods.
  // Each period starts at 5 years; if the server takes too long, the period is split in half and
  // tried again (down to about 3 months). Progress is printed after every piece.
  const WAIT = 75000, MIN_DAYS = 100;
  const fmtD = (d) => new Date(d.getTime() + CFG.hydstraOffsetHours * HOUR).toISOString().slice(0, 10);
  for (const site of siteList) {
    for (const kind of ['level', 'flow']) {
      let n = 0, stuck = 0, worked = false;
      const t0 = Date.now();
      const piece = async (start, end) => {
        if (stuck >= 3) return;
        const c0 = Date.now();
        try {
          const res = await traces(site, kind, start, end, 'day', kind === 'level' ? 'max' : 'mean', { tries: 1, timeoutMs: WAIT, onlyRemembered: worked });
          upsertDaily(site.id, kind, res.points);
          n += res.points.length; worked = true; stuck = 0;
          console.log(`  ${site.id} ${kind} ${fmtD(start)} to ${fmtD(end)}: ${res.points.length} days (${((Date.now() - c0) / 1000).toFixed(0)}s)`);
        } catch (err) {
          const msg = String(err.message || err);
          const slow = /abort|timeout|timed out/i.test(msg) || Date.now() - c0 >= WAIT - 1000;
          if (slow && (end - start) / DAY > MIN_DAYS * 2) {
            console.log(`  ${site.id} ${kind} ${fmtD(start)} to ${fmtD(end)}: slow, splitting in half`);
            const mid = new Date(start.getTime() + Math.round((end - start) / 2 / DAY) * DAY);
            await piece(start, mid); await sleep(polite); await piece(mid, end);
            return;
          }
          if (slow) stuck++;
          console.log(`  ${site.id} ${kind} ${fmtD(start)} to ${fmtD(end)}: none (${msg.slice(0, 70)}, ${((Date.now() - c0) / 1000).toFixed(0)}s)`);
        }
      };
      for (let y = fromYear; y <= thisYear && stuck < 3; y += 5) {
        const start = new Date(Date.UTC(y, 0, 1) - CFG.hydstraOffsetHours * HOUR);
        const end = new Date(Math.min(Date.UTC(y + 5, 0, 1) - CFG.hydstraOffsetHours * HOUR, Date.now()));
        await piece(start, end);
        saveState();
        await sleep(polite);
      }
      if (stuck >= 3) console.log(`  ${site.id} ${kind}: the server kept timing out, skipped the rest for now`);
      console.log(`daily ${site.id} ${site.name} ${kind}: ${n} days in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    }
  }
  saveState();
}

// ------------------------------------------------------------ 2. rain history (Open-Meteo archive, ERA5)
if (only === 'all' || only === 'rain') {
  const endDate = localDate(Date.now() - 6 * DAY); // reanalysis runs about 5 days behind
  for (const p of CFG.rainPoints) {
    let n = 0;
    for (let y = Math.max(fromYear, 1950); y <= thisYear; y += 10) {
      const s = `${y}-01-01`;
      const e = y + 9 >= thisYear ? endDate : `${y + 9}-12-31`;
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

// ------------------------------------------------------------ 2b. storage history (Lake Eppalock and others)
if (only === 'all' || only === 'storage') {
  for (const st of CFG.storages || []) {
    let n = 0;
    for (let y = fromYear; y <= thisYear; y += 5) {
      const start = new Date(Date.UTC(y, 0, 1) - CFG.hydstraOffsetHours * HOUR);
      const end = new Date(Math.min(Date.UTC(y + 5, 0, 1) - CFG.hydstraOffsetHours * HOUR, Date.now()));
      const rows = {};
      for (const [k, v] of [['volume', st.volumeVar], ['level', st.levelVar]]) {
        if (!v) continue;
        try { for (const p of await varTrace(st.portal, st.ds, st.id, v.from, v.to, start, end, 'day', 'mean')) (rows[localDate(p.t + 12 * HOUR)] ||= { date: localDate(p.t + 12 * HOUR) })[k] = p.v; } catch { /* no record */ }
        await sleep(polite);
      }
      upsertStorage(st, Object.values(rows));
      n += Object.keys(rows).length;
    }
    console.log(`storage ${st.name}: ${n} days`);
  }
}

// ------------------------------------------------------------ 2c. soil moisture history (ERA5, catchment means)
if ((only === 'all' || only === 'soil') && CFG.soil) {
  const endDate = localDate(Date.now() - 6 * DAY);
  const byC = {};
  for (const p of CFG.rainPoints) {
    for (let y = Math.max(fromYear, 1950); y <= thisYear; y += 10) {
      const s = `${y}-01-01`, e = y + 9 >= thisYear ? endDate : `${y + 9}-12-31`;
      if (s > endDate) break;
      try { for (const [d, v] of await soilArchive(p, s, e)) if (v != null) ((byC[p.catchment] ||= {})[d] ||= []).push(v); }
      catch (err) { console.log(`soil ${p.id} ${s}: ${err.message}`); }
      await sleep(MOCK ? 0 : 1200);
    }
    console.log(`soil ${p.name} done`);
  }
  const rows = [];
  for (const [c, days] of Object.entries(byC)) for (const [d, vs] of Object.entries(days)) rows.push([d, c, round(vs.reduce((a, b) => a + b, 0) / vs.length, 4)]);
  upsertSoil(rows);
  console.log(`soil: ${rows.length} catchment-days`);
}

// ------------------------------------------------------------ 3. past floods
if (only === 'all' || only === 'events') {
  const siteById = Object.fromEntries(CFG.sites.map((s) => [s.id, s]));

  // 3a. find peaks above the minor flood level at the event gauges
  const candidates = [];
  for (const gid of CFG.eventGauges) {
    const site = siteById[gid];
    const days = readDaily(gid).filter((d) => d.level != null);
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

  // 3b. group peaks within 21 days into one event; anchor on the first gauge in eventGauges order
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

  // 3c. attach curated (reported) events; add any that the data did not find
  for (const ce of CFG.curatedEvents) {
    const match = events.find((e) => Math.abs(Date.parse(e.anchor) - Date.parse(ce.date)) <= 20 * DAY);
    if (match) Object.assign(match, { curated: ce });
    else events.push({ anchor: ce.date, anchorSite: ce.reported[0] && ce.reported[0].site, detected: [], curated: ce });
  }
  events.sort((a, b) => (a.anchor < b.anchor ? 1 : -1));

  const monthName = (d) => new Date(d + 'T12:00:00Z').toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  let exampleNo = 0;
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const exampleNames = {};
  if (MOCK) [...events].filter((e) => !e.curated).sort((a, b) => (a.anchor < b.anchor ? -1 : 1)).forEach((e) => { exampleNames[e.anchor] = 'Example flood ' + letters[exampleNo++]; });

  const rainAll = readRainDaily();
  const rainByPoint = {};
  for (const r of rainAll) (rainByPoint[r.point] ||= {})[r.date] = r.mm;
  const catchments = [...new Set(CFG.rainPoints.map((p) => p.catchment))];

  const index = [];
  for (const ev of events) {
    const id = ev.anchor;
    const name = ev.curated ? ev.curated.name : MOCK ? exampleNames[ev.anchor] : monthName(ev.anchor) + ' flood';
    // In example mode, real (curated) floods are listed with their reported peaks only.
    const measured = !(MOCK && ev.curated);
    const anchorT = Date.parse(ev.anchor + 'T02:00:00Z'); // midday AEST
    const start = new Date(anchorT - CFG.eventWindowDays.before * DAY);
    const end = new Date(anchorT + CFG.eventWindowDays.after * DAY);
    const file = path.join(DATA, 'events', id + '.json');
    let detail = !force && fs.existsSync(file) ? readJson(file, null) : null;

    if (!detail) {
      detail = { id, name, anchor: ev.anchor, anchorT, example: MOCK, sites: {}, rain: {} };
      if (measured) {
        for (const site of CFG.sites) {
          const entry = {};
          for (const kind of ['level', 'flow']) {
            try {
              const res = await traces(site, kind, start, end, 'hour', kind === 'level' ? 'max' : 'mean');
              // hours relative to the anchor day, every 2nd hour
              entry[kind] = res.points.filter((p, i) => i % 2 === 0).map((p) => [Math.round((p.t - anchorT) / HOUR), kind === 'level' ? round(p.v) : Math.round(p.v)]);
            } catch { /* no data */ }
            await sleep(polite);
          }
          if (entry.level || entry.flow) detail.sites[site.id] = entry;
        }
      }
      console.log(`event ${id} ${name}: ${Object.keys(detail.sites).length} gauges`);
    }
    detail.name = name;

    // rain for the 30 days before to 3 days after, averaged across each catchment's points
    detail.rain = {};
    const rainSummary = {};
    for (const c of (measured ? catchments : [])) {
      const ids = CFG.rainPoints.filter((p) => p.catchment === c).map((p) => p.id);
      const series = [];
      for (let d = -30; d <= 3; d++) {
        const date = localDate(anchorT + d * DAY);
        const vals = ids.map((pid) => rainByPoint[pid] && rainByPoint[pid][date]).filter((v) => v != null);
        series.push([d, vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length, 1) : null]);
      }
      detail.rain[c] = series;
      const sum = (from, to) => { const v = series.filter(([d, mm]) => d >= from && d <= to && mm != null); return v.length ? round(v.reduce((a, [, mm]) => a + mm, 0), 1) : null; };
      rainSummary[c] = { pre7: sum(-6, 0), pre30: sum(-29, 0) };
    }

    // peaks and travel times
    const peaks = {}, flowPeaks = {};
    for (const [sid, e] of Object.entries(detail.sites)) {
      if (e.level && e.level.length) {
        const pk = e.level.reduce((a, b) => (b[1] > a[1] ? b : a));
        peaks[sid] = { v: pk[1], h: pk[0], cls: floodClass(siteById[sid], pk[1]) };
      }
      if (e.flow && e.flow.length) flowPeaks[sid] = e.flow.reduce((a, b) => (b[1] > a[1] ? b : a))[1];
    }
    const travel = {};
    const hop = (a, b) => { if (peaks[a] && peaks[b]) travel[a + '>' + b] = peaks[b].h - peaks[a].h; };
    hop('406201', '406283'); hop('406283', '406265'); hop('406207', '406283'); hop('406265', '409200');

    writeJson(file, detail);
    index.push({
      id, name, anchor: ev.anchor, anchorSite: ev.anchorSite, measured,
      curated: !!ev.curated, notes: ev.curated ? ev.curated.notes : '', reported: ev.curated ? ev.curated.reported : [],
      detectedDaily: ev.detected.map((c) => ({ site: c.site, date: c.date, level: c.level })),
      peaks, flowPeaks, rain: rainSummary, travel
    });
  }
  writeJson(path.join(DATA, 'events', 'index.json'), { generated: new Date().toISOString(), example: MOCK, events: index });
  console.log(`events: ${index.length}`);
  saveState();
}
