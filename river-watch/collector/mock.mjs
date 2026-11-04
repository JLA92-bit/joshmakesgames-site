// River Watch - EXAMPLE data generator (RW_MOCK=1).
// Produces made-up but realistic-shaped data so the site can be tested without network access.
// Everything it makes is flagged as example data. Never used in normal runs.
// Created by Josh Avard

const HOUR = 3600e3, DAY = 24 * HOUR;
const rnd = (n) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

// Made-up floods (peak time at Rochester Town) and how high they reach relative to that gauge's major level.
export const EXAMPLE_FLOODS = [
  { peak: Date.UTC(2005, 8, 10, 6), f: 0.82 },
  { peak: Date.UTC(2013, 7, 20, 18), f: 0.55 },
  { peak: Date.UTC(2019, 6, 2, 12), f: 1.12 }
];

const BASE = { '406213': 1.4, '406207': 156.3, '406201': 1.1, '406218': 120.8, '406283': 107.7, '406202': 1.7, '406265': 90.4,
  '406214': 0.8, '409025': 2.9, '409202': 2.4, '409200': 90.6, '409207': 6.1, '409005': 4.7, '409204': 4.0 };
const LAG = { '406213': -60, '406207': -46, '406201': -34, '406218': -18, '406283': 0, '406202': 1, '406265': 30, '406214': -40,
  '409025': -90, '409202': -60, '409200': 44, '409207': 76, '409005': 120, '409204': 180 };
const NO_FLOW = ['406207', '406218', '406214'];

function level(site, t) {
  const base = BASE[site.id] ?? 1;
  const top = site.major ?? site.minor ?? base + 2;
  const amp = top - base;
  const murray = site.river === 'Murray';
  let v = base + 0.06 * Math.sin(t / (DAY * 58)) + 0.04 * Math.sin(t / (DAY * 6.3) + site.id.length);
  for (const fl of EXAMPLE_FLOODS) {
    const x = (t - fl.peak - (LAG[site.id] || 0) * HOUR) / HOUR;
    const w = x < 0 ? (murray ? 90 : 28) : (murray ? 220 : 64);
    const f = murray ? fl.f * 0.85 : fl.f;
    v += amp * f * Math.exp(-(x * x) / (w * w));
  }
  return v;
}

export async function traces(site, kind, start, end, interval) {
  // RW_MOCK_SLOW=1 pretends the server times out on flow requests longer than about 2 years (for testing)
  if (process.env.RW_MOCK_SLOW === '1' && kind === 'flow' && end - start > 800 * DAY) throw new Error('The operation was aborted due to timeout');
  if (kind === 'flow' && NO_FLOW.includes(site.id)) throw new Error('no data returned');
  const from = Math.max(start.getTime(), Date.UTC(1990, 0, 1));
  const to = end.getTime();
  if (to <= from) throw new Error('no data returned');
  const step = interval === 'day' ? DAY : HOUR;
  const points = [];
  const base = BASE[site.id] ?? 1;
  const top = site.major ?? site.minor ?? base + 2;
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    let v;
    if (interval === 'day') { v = -Infinity; for (let h = 0; h < 24; h += 3) v = Math.max(v, level(site, t + h * HOUR)); }
    else v = level(site, t);
    if (kind === 'flow') {
      const rel = Math.max(0, (v - base) / (top - base));
      v = (site.river === 'Murray' ? 4500 : 60) + (site.river === 'Murray' ? 60000 : 45000) * Math.pow(rel, 1.7);
      v = Math.round(v);
    } else v = Math.round(v * 1000) / 1000;
    points.push({ t, v, q: 150 });
  }
  return { points, name: site.autoName ? 'Example creek gauge' : '', portal: 'example' };
}

function rainOn(dateStr, point) {
  const t = Date.parse(dateStr + 'T00:00:00Z');
  const wet = point.catchment.startsWith('Upper') ? 1.4 : point.catchment.startsWith('Lake') ? 1.0 : 0.75;
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
  for (let t = Date.parse(startDate + 'T00:00:00Z'); t <= Date.parse(endDate + 'T00:00:00Z'); t += DAY) {
    const d = new Date(t).toISOString().slice(0, 10);
    out.push([d, rainOn(d, point)]);
  }
  return out;
}

export async function rainForecast(points) {
  const today = new Date();
  const fc = [0, 2.1, 0.4, 0, 0, 5.8, 1.2, 0.2];
  return points.map((p, pi) => {
    const time = [], precipitation_sum = [], precipitation_probability_max = [];
    for (let i = -30; i < 8; i++) {
      const d = new Date(today.getTime() + i * DAY).toISOString().slice(0, 10);
      time.push(d);
      const wet = p.catchment.startsWith('Upper') ? 1.4 : 0.9;
      precipitation_sum.push(i < 0 ? rainOn(d, p) : Math.round(fc[i] * wet * 10) / 10);
      precipitation_probability_max.push(i < 0 ? null : Math.min(95, Math.round(fc[i] * 8 + 10 + pi)));
    }
    return { id: p.id, name: p.name, catchment: p.catchment, daily: { time, precipitation_sum, precipitation_probability_max } };
  });
}

// Example storage: fills in winter-spring, draws down in summer, tops out before each example flood.
export async function storageTrace(siteId, varto, start, end, interval) {
  const from = Math.max(start.getTime(), Date.UTC(1990, 0, 1)), to = end.getTime();
  if (to <= from) throw new Error('no data returned');
  const step = interval === 'day' ? DAY : HOUR, out = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    const season = Math.sin(((t / DAY) % 365.25) / 365.25 * 2 * Math.PI - 1.2);
    let pct = 62 + 26 * season + 6 * Math.sin(t / (DAY * 900));
    for (const fl of EXAMPLE_FLOODS) { const d = (fl.peak - t) / DAY; if (d > -20 && d < 60) pct = Math.max(pct, 100 - Math.abs(d) * 0.2); }
    pct = Math.min(101, Math.max(15, pct));
    const vol = 304651 * pct / 100;
    out.push({ t, v: Math.round((varto === '130.00' ? 193.0 - (100 - pct) * 0.09 : vol) * 1000) / 1000 });
  }
  return out;
}

// Example soil moisture (m3/m3): wetter in winter, wetter still before example floods.
export async function soilArchive(point, startDate, endDate) {
  const out = [];
  for (let t = Date.parse(startDate + 'T00:00:00Z'); t <= Date.parse(endDate + 'T00:00:00Z'); t += DAY) {
    const season = Math.sin(((t / DAY) % 365.25) / 365.25 * 2 * Math.PI - 1.4);
    let v = 0.26 + 0.07 * season + 0.02 * (rnd(t / DAY / 9 + point.lat) - 0.5);
    for (const fl of EXAMPLE_FLOODS) { const d = (fl.peak - t) / DAY; if (d > -15 && d < 40) v += 0.06 * Math.exp(-((d - 5) ** 2) / 300); }
    out.push([new Date(t).toISOString().slice(0, 10), Math.round(v * 1000) / 1000]);
  }
  return out;
}
