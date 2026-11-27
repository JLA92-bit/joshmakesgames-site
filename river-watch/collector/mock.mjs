// River Watch - EXAMPLE data generator (RW_MOCK=1).
// Produces made-up but realistically shaped data so the whole site can be tested without network access.
// Everything it makes is flagged as example data. It is never used in normal runs.
// Created by Josh Avard

const HOUR = 3600e3, DAY = 24 * HOUR;
const rnd = (n) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
const iso = (t) => new Date(t).toISOString().slice(0, 10);

// Made-up floods: peak time at Rochester Town, size relative to each gauge's major level, and which systems flooded.
export const EXAMPLE_FLOODS = [
  { peak: Date.UTC(1993, 9, 4, 6), f: 0.7, sys: { campaspe: 0.6, goulburn: 0.9, murray: 1.0 } },
  { peak: Date.UTC(2005, 8, 10, 6), f: 0.82, sys: { campaspe: 1, goulburn: 0.5, murray: 0.4 } },
  { peak: Date.UTC(2013, 7, 20, 18), f: 0.55, sys: { campaspe: 1, goulburn: 0.7, murray: 0.6 } },
  { peak: Date.UTC(2019, 6, 2, 12), f: 1.12, sys: { campaspe: 1, goulburn: 0.8, murray: 0.7 } }
];
const SYS = (s) => (s.group === 'goulburn' ? 'goulburn' : s.group === 'upper-murray' || s.group === 'echuca-down' ? 'murray' : 'campaspe');

const BASE = {
  '406213': 1.4, '406219': 193.45, '406207': 156.3, '406201': 1.1, '406218': 120.8, '406283': 107.7, '406202': 1.7, '406265': 90.85,
  '406990': 0.9, '406991': 0.6, '406262': 0.5, '406214': 0.8, '406224': 0.7,
  '405203': 1.6, '405202': 1.5, '405200': 4.2, '405237': 0.9, '405269': 1.6, '404222': 3.1, '405204': 4.6, '405232': 4.4,
  '401204': 1.9, '409017': 2.2, '402205': 1.1, '409001': 1.9, '409002': 2.3, '403200': 8.9, '403241': 3.2, '409025': 2.9, '409202': 2.4, '409215': 3.6,
  '409200': 90.6, '409207': 6.1, '409003': 2.1, '409005': 4.7, '407242': 74.9, '409204': 4.0
};
// hours relative to the Rochester Town peak
const LAG = {
  '406990': -70, '406991': -66, '406213': -62, '406219': -50, '406207': -46, '406262': -42, '406214': -38, '406201': -34, '406224': -20, '406218': -12,
  '406283': 0, '406202': 1, '406265': 9, '409200': 48,
  '405203': -150, '405202': -110, '405237': -100, '405269': -60, '404222': -50, '405200': -70, '405204': -40, '405232': -4,
  '401204': -260, '409017': -230, '402205': -215, '409001': -200, '409002': -170, '403200': -150, '403241': -125, '409025': -110, '409202': -40, '409215': 10,
  '409207': 72, '409003': 60, '409005': 150, '407242': 90, '409204': 230
};
const NO_FLOW = ['406219', '406218', '409025'];

function topOf(site, base) {
  if (site.storageHead) return site.storageHead.fsl + 3;
  return site.major ?? site.moderate ?? site.minor ?? base + 2.5;
}
function level(site, t) {
  const base = BASE[site.id] ?? (site.minor != null ? site.minor - 3 : 1);
  const amp = topOf(site, base) - base;
  const sys = SYS(site);
  const slow = sys !== 'campaspe' || site.storageHead;
  // seasonal wobble (higher in late winter / spring) and small ripples
  const doy = (t / DAY) % 365.25;
  let v = base + amp * 0.05 * Math.sin(((doy - 150) / 365.25) * 2 * Math.PI) + amp * 0.012 * Math.sin(t / (DAY * 6.3) + site.id.length);
  // current small rise in the last few days (Goulburn and creeks), so the preview shows trends
  const ago = (Date.now() - t) / HOUR;
  if (ago >= 0 && ago < 120 && (sys === 'goulburn' || site.group === 'creeks')) v += amp * (site.group === 'creeks' ? 0.03 : 0.09) * Math.exp(-((ago - 30) ** 2) / 900);
  for (const fl of EXAMPLE_FLOODS) {
    const x = (t - fl.peak - (LAG[site.id] || 0) * HOUR) / HOUR;
    const w = x < 0 ? (slow ? 90 : 28) : (slow ? 220 : 64);
    const f = fl.f * (fl.sys[sys] ?? 1) * (sys === 'campaspe' ? 1 : 0.85);
    v += amp * f * Math.exp(-(x * x) / (w * w));
  }
  // at Echuca the Campaspe cannot sit below the Murray: a high Murray backs it up
  if (site.id === '406265') v = Math.max(v, level({ id: '409200', group: 'echuca-down', minor: 93.5, moderate: 93.9, major: 94.4 }, t) + 0.12);
  return v;
}
const PEAK_FLOW = { '406213': 25000, '406990': 30000, '406991': 12000, '406207': 70000, '406262': 5000, '406214': 12000, '406224': 9000, '406201': 82000, '406202': 98000, '406265': 98000 };
const BASE_FLOW = { '406213': 40, '406990': 18, '406991': 9, '406207': 60, '406262': 4, '406214': 8, '406224': 6, '406201': 75, '406202': 95, '406265': 100 };

export async function traces(site, kind, start, end, interval) {
  if (kind === 'flow' && (site.noFlow || NO_FLOW.includes(site.id))) throw new Error('no data returned');
  const from = Math.max(start.getTime(), Date.UTC(1975, 0, 1));
  const to = end.getTime();
  if (to <= from) throw new Error('no data returned');
  const step = interval === 'day' ? DAY : HOUR;
  const points = [];
  const base = BASE[site.id] ?? (site.minor != null ? site.minor - 3 : 1);
  const top = topOf(site, base);
  const bigRiver = SYS(site) === 'murray' || site.group === 'goulburn';
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    let v;
    if (interval === 'day') { v = -Infinity; for (let h = 0; h < 24; h += 3) v = Math.max(v, level(site, t + h * HOUR)); }
    else v = level(site, t);
    if (kind === 'flow') {
      const rel = Math.max(0, (v - base) / (top - base));
      const baseFlow = BASE_FLOW[site.id] ?? (site.group === 'creeks' ? 8 : bigRiver ? 4500 : 60);
      const peakFlow = PEAK_FLOW[site.id] ?? (site.group === 'creeks' ? 9000 : bigRiver ? 60000 : 45000);
      v = Math.round(baseFlow + peakFlow * Math.pow(rel, 1.7));
    } else v = Math.round(v * 1000) / 1000;
    points.push({ t, v, q: 150 });
  }
  return { points, name: site.autoName ? 'AXE CREEK @ LONGLEA (EXAMPLE)' : '', portal: 'example' };
}

export function kiwisStations(search) {
  if (/coliban/i.test(search)) return [{ station_no: '406990', station_name: 'COLIBAN RIVER @ LYAL (EXAMPLE GAUGE)' }];
  if (/mcivor/i.test(search)) return [{ station_no: '406991', station_name: 'MCIVOR CREEK @ HEATHCOTE (EXAMPLE GAUGE)' }];
  return [];
}

// ---------------- rain
function rainOn(dateStr, point) {
  const t = Date.parse(dateStr + 'T00:00:00Z');
  const c = point.catchment || '';
  const wet = c === 'upper-campaspe' ? 1.4 : c === 'upper-murray' ? 1.5 : c === 'goulburn' ? 1.1 : c === 'eppalock' ? 1.0 : 0.75;
  let mm = rnd(t / DAY + point.lat) < 0.28 ? rnd(t / DAY * 3.1 + point.lon) * 9 * wet : 0;
  for (const fl of EXAMPLE_FLOODS) {
    const d = (fl.peak - t) / DAY;
    if (d > 1 && d < 6) mm += fl.f * 13 * wet * (0.6 + rnd(t / DAY + 7));
    if (d >= 6 && d < 28) mm += rnd(t / DAY + 3) < 0.4 ? 3 * wet : 0;
  }
  return Math.round(mm * 10) / 10;
}
export async function rainArchive(point, startDate, endDate) {
  const out = [];
  for (let t = Date.parse(startDate + 'T00:00:00Z'); t <= Date.parse(endDate + 'T00:00:00Z'); t += DAY) { const d = iso(t); out.push([d, rainOn(d, point)]); }
  return out;
}
function spreadHours(dayMm, seed) {
  // put most of a day's rain into a short burst
  const hrs = Array(24).fill(0);
  if (!dayMm) return hrs;
  const start = Math.floor(rnd(seed) * 18), len = 3 + Math.floor(rnd(seed + 1) * 6);
  for (let h = 0; h < len; h++) hrs[start + h] = dayMm / len * (h === Math.floor(len / 2) ? 1.8 : 0.85);
  const s = hrs.reduce((a, b) => a + b, 0);
  return hrs.map((x) => Math.round((x * dayMm) / s * 10) / 10);
}
export async function rainArchiveHourly(points, startDate, endDate) {
  const out = {};
  for (const p of points) {
    const rows = [];
    for (let t = Date.parse(startDate + 'T00:00:00Z'); t <= Date.parse(endDate + 'T00:00:00Z'); t += DAY) {
      const d = iso(t);
      spreadHours(rainOn(d, p), t / DAY + p.lat).forEach((mm, h) => rows.push([d + 'T' + String(h).padStart(2, '0') + ':00', mm]));
    }
    out[p.id] = rows;
  }
  return out;
}
export async function rainForecast(points) {
  const today = new Date();
  const fc = [0, 2.1, 0.4, 0, 0, 5.8, 1.2, 0.2];
  return points.map((p, pi) => {
    const time = [], precipitation_sum = [], precipitation_probability_max = [], htime = [], hprec = [];
    for (let i = -30; i < 8; i++) {
      const d = iso(today.getTime() + i * DAY);
      const wet = p.catchment === 'upper-campaspe' || p.catchment === 'upper-murray' ? 1.4 : 0.9;
      const mm = i < 0 ? rainOn(d, p) : Math.round(fc[i] * wet * 10) / 10 + (i === 5 && p.catchment === 'upper-murray' ? 9 : 0);
      time.push(d); precipitation_sum.push(mm);
      precipitation_probability_max.push(i < 0 ? null : Math.min(95, Math.round(fc[i] * 8 + 10 + pi)));
      spreadHours(mm, i + p.lon).forEach((h, k) => { htime.push(d + 'T' + String(k).padStart(2, '0') + ':00'); hprec.push(h); });
    }
    return { ...p, daily: { time, precipitation_sum, precipitation_probability_max }, hourly: { time: htime, precipitation: hprec } };
  });
}

// ---------------- soil moisture (mm of water in the top metre)
export async function soilArchive(catchment, startDate, endDate) {
  const out = [];
  const base = { 'upper-campaspe': 300, eppalock: 250, 'below-eppalock': 235, 'lower-campaspe': 215, goulburn: 290, 'upper-murray': 330 }[catchment.id] || 260;
  let store = base;
  for (let t = Date.parse(startDate + 'T00:00:00Z') - 60 * DAY; t <= Date.parse(endDate + 'T00:00:00Z'); t += DAY) {
    const d = iso(t);
    const doy = (t / DAY) % 365.25;
    const season = 45 * Math.sin(((doy - 100) / 365.25) * 2 * Math.PI); // wetter in winter
    const rain = rainOn(d, { lat: catchment.lat, lon: catchment.lon, catchment: catchment.id });
    store = store + rain * 0.6 - (store - (base + season)) * 0.05;
    if (d >= startDate) out.push([d, Math.round(Math.max(120, Math.min(420, store)) * 10) / 10]);
  }
  return out;
}

// ---------------- storages
const STORE_BASE = { eppalock: 0.82, 'upper-coliban': 0.7, lauriston: 0.85, malmsbury: 0.8, eildon: 0.72, waranga: 0.7, dartmouth: 0.78, hume: 0.75 };
const STORE_CAP = { 'upper-coliban': 37770, lauriston: 19790, malmsbury: 12034 };
function storagePct(id, t) {
  const doy = (t / DAY) % 365.25;
  let p = (STORE_BASE[id] ?? 0.75) + 0.13 * Math.sin(((doy - 170) / 365.25) * 2 * Math.PI) + 0.06 * Math.sin(t / (DAY * 900));
  for (const fl of EXAMPLE_FLOODS) {
    const d = (fl.peak - t) / DAY;
    if (d > -20 && d < 60) p = Math.max(p, d > 0 ? 1.0 - d * 0.0012 : 1.0 + (id === 'eppalock' ? 0.25 * fl.f * Math.exp(-((d + 1) ** 2) / 8) : 0));
  }
  return Math.max(0.2, Math.min(id === 'eppalock' ? 1.4 : 1.02, p));
}
export async function storageHistory(storage, fromDate, toDate) {
  const cap = storage.capacity || STORE_CAP[storage.id] || 20000;
  const out = [];
  for (let t = Date.parse(fromDate + 'T00:00:00Z'); t <= Date.parse(toDate + 'T00:00:00Z'); t += DAY) out.push([iso(t), Math.round(storagePct(storage.id, t) * cap)]);
  return out;
}
export async function gmwStorages() {
  const now = Date.now();
  const names = { eppalock: 'Lake Eppalock', eildon: 'Lake Eildon', 'goulburn-weir': 'Goulburn Weir', waranga: 'Waranga Basin', nillahcootie: 'Lake Nillahcootie',
    dartmouth: 'Dartmouth Dam', hume: 'Hume Dam', buffalo: 'Lake Buffalo', 'william-hovell': 'Lake William Hovell', yarrawonga: 'Yarrawonga Weir',
    torrumbarry: 'Torrumbarry Weir', 'cairn-curran': 'Cairn Curran Reservoir', tullaroop: 'Tullaroop Reservoir' };
  const caps = { eppalock: 304651, eildon: 3334158, 'goulburn-weir': 25500, waranga: 432360, nillahcootie: 40400, dartmouth: 3856232, hume: 3005157,
    buffalo: 23504, 'william-hovell': 13690, yarrawonga: 117500, torrumbarry: 36810, 'cairn-curran': 147130, tullaroop: 72950 };
  const out = {};
  for (const [id, name] of Object.entries(names)) {
    const pct = id === 'eppalock' ? 0.957 : ['goulburn-weir', 'yarrawonga', 'torrumbarry', 'william-hovell'].includes(id) ? 0.97 : storagePct(id, now);
    out[name] = { pct: Math.round(pct * 10000) / 100, volume: Math.round(pct * caps[id]), level: id === 'eppalock' ? 193.45 : null, published: 'example' };
  }
  return out;
}

// ---------------- climate drivers
export async function climateIndex(key) {
  const out = {};
  const now = new Date();
  for (let y = 1970; y <= now.getUTCFullYear(); y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === now.getUTCFullYear() && m > now.getUTCMonth() + 1) break;
      const t = Date.UTC(y, m - 1, 15);
      let v = key === 'oni' ? 0.9 * Math.sin(t / (DAY * 365.25 * 3.7)) + 0.4 * Math.sin(t / (DAY * 365.25 * 1.3))
        : key === 'dmi' ? 0.35 * Math.sin(t / (DAY * 365.25 * 2.1) + 1) + 0.15 * Math.sin(t / (DAY * 97))
          : 0.8 * Math.sin(t / (DAY * 365.25 * 0.9) + 2);
      for (const fl of EXAMPLE_FLOODS) {
        const d = (fl.peak - t) / (DAY * 30);
        if (d > -3 && d < 8) v += (key === 'oni' ? -1.1 : key === 'dmi' ? -0.6 : 0.9) * Math.exp(-((d - 2) ** 2) / 10);
      }
      out[`${y}-${String(m).padStart(2, '0')}`] = Math.round(v * 100) / 100;
    }
  }
  return out;
}
