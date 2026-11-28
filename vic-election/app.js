/* Vic 2026 tracker: renders data/site.json. No build step, no dependencies. */
const C = {ON:'#e8590c',LIB:'#1d5fbf',NAT:'#147a4e',ALP:'#d22630',GRN:'#2f9e44',IND:'#8a93a3',OTH:'#9b7fc9'};
const NAME = {ON:'One Nation',LIB:'Liberal',NAT:'Nationals',ALP:'Labor',GRN:'Greens',IND:'Independent',OTH:'Other'};
const ORDER = ['GRN','ALP','IND','OTH','LIB','NAT','ON'];   // seating, left to right
let D = null, ui = {f:'chance', q:''}, seatCache = {};

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct = (v,d=1) => v == null ? '–' : `${Number(v).toFixed(d)}%`;
const chanceTxt = p => p == null ? '–' : p >= .995 ? '>99%' : p > 0 && p < .01 ? '<1%' : `${Math.round(p*100)}%`;
const fmt = v => v == null ? '–' : Number(v).toLocaleString('en-AU');
const nm = c => NAME[c] || c;
const person = c => { if(!c) return ''; if(NAME[c] || /^(One Nation|Liberal|Labor|Greens|Nationals|Independent|Other)$/.test(c)) return c;
  const [l,f] = c.split(','); return `${(f||'').trim()} ${l.charAt(0)}${l.slice(1).toLowerCase()}`.trim(); };
const chip = c => `<span class="chip" style="background:${C[c]||C.OTH}">${esc(nm(c))}</span>`;
const mpName = s => s.mp?.name ? person(s.mp.name) : null;
const heldBy = s => s.mp?.name ? `Held by ${esc(mpName(s))}, ${nm(s.mp.code)}` : (s.held_by ? `Held by ${nm(s.held_by)}` : '');
const onCand = s => s.on?.candidate ? `One Nation: ${esc(person(s.on.candidate))}` : '';
const means = ps => `<div class="means">${ps.filter(Boolean).map(p=>`<p>${p}</p>`).join('')}</div>`;
const under = ps => `<details class="under"><summary>Understanding this</summary><div>${ps.map(p=>`<p>${p}</p>`).join('')}</div></details>`;
const chanceCell = p => `<div class="chance"><b>${chanceTxt(p)}</b><span><i style="width:${Math.round((p||0)*100)}%"></i></span></div>`;

async function load(){
  try{
    const r = await fetch(`data/site.json?t=${Date.now()}`, {cache:'no-store'});
    if(!r.ok) throw new Error(r.status);
    const first = !D; D = await r.json(); seatCache = {};
    const t = D.scraped_at ? new Date(D.scraped_at) : null;
    $('#live').innerHTML = t ? `Updated <b>${t.toLocaleTimeString('en-AU',{hour:'numeric',minute:'2-digit'})}</b>` : '';
    render(first);
  }catch(e){
    if(!D) $('#app').innerHTML = `<p class="notice">Results haven't been published yet. This page checks again every minute.</p>`;
  }
}

function render(animate){
  const [page, arg] = location.hash.replace(/^#\/?/, '').split('/');
  document.querySelectorAll('.nav a').forEach(a => a.toggleAttribute('aria-current', a.getAttribute('href') === '#/' + (page === 'seat' ? 'seats' : (page||''))));
  document.querySelectorAll('.nav a[aria-current]').forEach(a=>a.setAttribute('aria-current','page'));
  if(!D) return;
  const view = {'':overview, seats, seat:seatPage, council, method}[page||''] || overview;
  const keep = page === 'seats' ? document.activeElement?.className : null;
  $('#app').innerHTML = waiting() + view(arg, animate);
  if(page === 'seats') bindSeats(keep);
  if(page === 'seat') loadBooths(arg);
  document.querySelectorAll('tr[data-href]').forEach(tr => tr.onclick = () => location.hash = tr.dataset.href);
}
window.addEventListener('hashchange', () => { render(false); window.scrollTo(0,0); });

function waiting(){
  if(D.source_status === 'ok') return '';
  return `<p class="notice">Waiting for the VEC to publish counts. Until then, projections use the pre-election baseline.</p>`;
}

/* ---------------- chamber (88-seat hemicycle) ---------------- */
function chamber(seats, animate){
  const rows = 7, R0 = 120, R1 = 250, total = 88, pts = [];
  const radii = [...Array(rows)].map((_,i)=>R0 + (R1-R0)*i/(rows-1));
  const sumR = radii.reduce((a,b)=>a+b,0);
  let left = total;
  radii.forEach((r,i)=>{
    const n = i === rows-1 ? left : Math.round(total*r/sumR); left -= n;
    for(let k=0;k<n;k++){ const a = Math.PI - Math.PI*(k/(n-1)); pts.push({x:270+r*Math.cos(a), y:270-r*Math.sin(a), a}); }
  });
  pts.sort((p,q)=>q.a-p.a);
  const list = seats.slice().sort((a,b)=>{
    const pa=a.projection, pb=b.projection;
    const oa = pa?ORDER.indexOf(pa.winner):99, ob = pb?ORDER.indexOf(pb.winner):99;
    if(oa!==ob) return oa-ob;
    const sa=pa?.win_prob??0, sb=pb?.win_prob??0;
    return ORDER.indexOf(pa?.winner) < 4 ? sb-sa : sa-sb;  // firmest seats on the outer edges
  });
  const dots = list.map((s,i)=>{
    const p = s.projection, c = p ? (C[p.winner]||C.OTH) : '#c9ced6', o = !p ? 1 : p.win_prob >= .8 ? 1 : p.win_prob >= .6 ? .62 : .35;
    const t = `${s.name}: ${p ? `${nm(p.winner)} ${chanceTxt(p.win_prob)}` : 'no projection'}`;
    return `<a href="#/seat/${s.slug}"><circle cx="${pts[i].x.toFixed(1)}" cy="${pts[i].y.toFixed(1)}" r="9.6" fill="${c}" style="--o:${o};opacity:${o};animation-delay:${i*9}ms"><title>${esc(t)}</title></circle></a>`;
  }).join('');
  return `<svg class="chamber ${animate?'anim':''}" viewBox="0 0 540 285" role="img" aria-label="Projected seats in the 88-seat lower house">
    ${dots}<line x1="270" y1="6" x2="270" y2="150" stroke="#10182b" stroke-width="2" stroke-dasharray="3 4"/>
    <text x="270" y="200" text-anchor="middle" font-size="40" font-weight="800" font-stretch="120%" fill="#10182b">45</text>
    <text x="270" y="224" text-anchor="middle" font-size="14" fill="#6b7487">seats to govern</text></svg>`;
}

/* ---------------- overview ---------------- */
function overview(_, animate){
  const P = D.projection, pr = P.probs, sd = P.seats, sw = D.statewide.pct || {}, pa = D.poll_average || {};
  const onS = sd.ON || {p50:0,p10:0,p90:0};
  const coal = (sd.LIB?.p50||0) + (sd.NAT?.p50||0);
  const king = pr.on_kingmaker + pr.on_majority;
  const tallyKeys = ['ON','LIB','NAT','ALP','GRN'].filter(k=>sd[k]);
  const odds = [
    ['on', 'One Nation decides who governs', king, `Coalition short of 45 on its own but One Nation's seats get it there${pr.on_majority?', or One Nation wins outright':''}.`],
    ['', 'Coalition governs alone', pr.coalition_majority, 'Liberal and Nationals reach 45 without One Nation.'],
    ['', 'Labor holds on', pr.labor_majority + pr.labor_with_greens, 'Labor reaches 45 alone or with the Greens.'],
    ['', 'Other hung parliament', pr.hung, 'No combination above reaches 45.'],
  ];
  const close = D.seats.filter(s=>s.projection && s.projection.on_win_prob >= .05).sort((a,b)=>b.projection.on_win_prob-a.projection.on_win_prob);
  const expected = close.reduce((a,s)=>a+s.projection.on_win_prob,0);
  const prog = Math.round((P.progress||0)*100);
  const hist = P.on_hist || [], hmax = Math.max(...hist.map(h=>h.p), .01);
  const onLive = sw.ON, onPoll = pa.ON;
  const wrong = D.seats.filter(s=>s.on?.in_tcp && s.projection && !s.projection.final.some(f=>f.code==='ON'));

  return `
  <section class="block">
    <h1 class="hero__title">${esc(P.headline.title)}</h1>
    <p class="hero__sub">${esc(P.headline.sub)}</p>
  </section>

  <section class="block split">
    <div>
      ${chamber(D.seats, animate)}
      <div class="tally">${tallyKeys.map(k=>`<div style="--c:${C[k]}"><div class="n">${sd[k].p50}</div><div class="l">${nm(k)}</div><div class="r">${sd[k].p10}–${sd[k].p90} likely</div></div>`).join('')}</div>
    </div>
    <div>
      <h2>Paths to power</h2>
      <p class="lede small">Chance of each outcome across ${fmt(P.runs)} simulations of the remaining count.</p>
      <div class="odds">${odds.map(([cls,t,p,d])=>`<div class="odd ${cls?'is-on':''}"><div class="odd__t">${t}</div><div class="odd__p">${chanceTxt(p)}</div><div class="odd__bar"><i style="width:${Math.round(p*100)}%"></i></div><div class="odd__d">${d}</div></div>`).join('')}</div>
      ${means([
        king >= .5 ? `<strong>One Nation is more likely than not to hold the balance of power.</strong> The Coalition's projected ${coal} seats fall short of 45, and One Nation's seats would get it there.`
        : pr.coalition_majority >= .5 ? `<strong>The Coalition is projected to win ${coal} seats, enough to govern without One Nation.</strong> For One Nation to become kingmaker, the Coalition has to fall below 45 while One Nation picks up its marginal seats.`
        : `<strong>No side is clearly ahead.</strong> One Nation's leverage depends on the Coalition finishing just short of 45.`,
        `Faded dots are seats where the projected winner has less than an 80% chance. Tap a dot to open the seat.`
      ])}
      ${under([
        'Government goes to whoever can win confidence votes in the 88-seat lower house, which takes 45 seats.',
        'Each simulation redraws every undecided seat using its projected margin and uncertainty. Seats move together, as they do on a real night: if One Nation is doing better than projected in one seat, it is probably doing better in others too.',
        'Early in the count, projections lean on the pre-election baseline (2022 results and final polls). As more votes are counted, the live count takes over.'
      ])}
    </div>
  </section>

  <section class="block split">
    <div>
      <h2>Seats One Nation could win</h2>
      <p class="lede small">Expected total: ${expected.toFixed(1)} seats. Ranked by chance of winning.</p>
      <table class="list"><thead><tr><th>Seat</th><th class="hide-s">Projected final two</th><th class="r">Chance</th></tr></thead><tbody>
      ${close.slice(0,14).map(s=>{const p=s.projection;return `<tr data-href="#/seat/${s.slug}"><td class="seat">${esc(s.name)}<small>${onCand(s)}</small><small>${heldBy(s)}${s.counted_pct!=null?`, ${pct(s.counted_pct,0)} counted`:''}</small></td>
        <td class="hide-s small">${p.final.map(f=>`<span class="dot" style="background:${C[f.code]}"></span>${nm(f.code)} ${pct(f.pct)}`).join('<br>')}</td><td class="r">${chanceCell(p.on_win_prob)}</td></tr>`}).join('') || '<tr><td colspan="3" class="muted">No seats with a realistic One Nation chance yet.</td></tr>'}
      </tbody></table>
      <p class="small" style="margin-top:12px"><a href="#/seats">All 88 seats</a></p>
    </div>
    <div>
      <h2>How many seats for One Nation</h2>
      <div class="hist">${hist.map(h=>`<div class="${h.seats===onS.p50?'mid':''}" style="height:${Math.max(2,h.p/hmax*100)}%" title="${h.seats} seats: ${chanceTxt(h.p)}"></div>`).join('')}</div>
      <div class="hist__ax"><span>${hist[0]?.seats??0}</span><span>seats</span><span>${hist[hist.length-1]?.seats??0}</span></div>
      ${means([`Most likely ${onS.p50} seats. In 8 of 10 simulations One Nation wins between ${onS.p10} and ${onS.p90}.`,
        wrong.length ? `<strong>Watch ${wrong.slice(0,4).map(s=>esc(s.name)).join(', ')}.</strong> The VEC's preference count there is One Nation against Labor, but Labor has dropped to third. The real contest is likely One Nation against the Coalition, which is much harder for One Nation, because Labor and Greens preferences favour the Liberal or National.` : ''])}

      <h2 style="margin-top:40px">The vote so far</h2>
      <div class="bars">${['ON','LIB','NAT','ALP','GRN'].filter(k=>sw[k]!=null).map(k=>barRow(nm(k), sw[k], k, 45, k==='ON'?onPoll:k==='ALP'?pa.ALP:k==='GRN'?pa.GRN:null)).join('')}</div>
      <p class="small muted">Statewide first preferences counted so far. Tick marks show the final poll average${pa.COAL?` (Coalition ${pa.COAL}%)`:''}.</p>
      ${onLive!=null && onPoll!=null ? means([`One Nation is on <strong>${pct(onLive)}</strong> of counted votes, ${onLive>=onPoll?`${(onLive-onPoll).toFixed(1)} points above`:`${(onPoll-onLive).toFixed(1)} points below`} its final poll average of ${onPoll}%.`]) : ''}
      <div style="margin-top:22px" class="small"><span class="muted">Roll counted</span> <b>${prog}%</b>, ${fmt(P.counted_votes)} votes</div>
      <div class="progress"><i style="width:${prog}%"></i></div>
    </div>
  </section>
  ${closestSeats()}`;
}
function closestSeats(){
  const list = D.seats.filter(s=>s.projection && s.projection.win_prob < .72 && s.projection.basis !== 'pre-count estimate')
    .sort((a,b)=>a.projection.win_prob-b.projection.win_prob).slice(0,16);
  if(!list.length) return '';
  return `<section class="block"><h2>Closest seats</h2>
  <p class="lede small">Seats where the projected winner has less than a 72% chance, closest first. The candidates named are the projected final two.</p>
  <table class="list"><thead><tr><th>Seat</th><th>Projected final two</th><th class="r hide-s">Sitting MP</th><th class="r">Leader's chance</th></tr></thead><tbody>
  ${list.map(s=>{const p=s.projection;return `<tr data-href="#/seat/${s.slug}"><td class="seat">${esc(s.name)}<small>${onCand(s)}</small></td>
    <td class="small">${p.final.map(f=>`<span class="dot" style="background:${C[f.code]}"></span><b>${esc(person(f.candidate))}</b> ${nm(f.code)}, ${pct(f.pct)}`).join('<br>')}</td>
    <td class="r small hide-s">${s.mp?.name?`${esc(mpName(s))}<br><span class="muted">${nm(s.mp.code)}${s.mp.running===false?', not running':''}</span>`:'–'}</td>
    <td class="r">${chanceTxt(p.win_prob)}</td></tr>`}).join('')}</tbody></table>
  ${means(['A seat that changes hands is one where the projected winner is from a different party to the sitting MP. Where the sitting MP isn\'t running again, the seat is open and usually easier to win.'])}
  </section>`;
}
function barRow(name, v, code, max, tick, swing){
  return `<div class="brow"><div class="brow__n">${esc(name)}</div><div class="brow__t"><i style="width:${Math.min(100,(v||0)/max*100)}%;background:${C[code]||C.OTH}"></i>${tick!=null?`<u style="left:${Math.min(100,tick/max*100)}%"></u>`:''}</div><div class="brow__v">${pct(v)}</div><div class="brow__s ${swing>0?'up':swing<0?'down':''}">${swing!=null?(swing>0?'+':'')+swing.toFixed(1):''}</div></div>`;
}

/* ---------------- seats ---------------- */
const FILTERS = {
  chance:['One Nation chance', s=>s.projection && s.projection.on_win_prob >= .02],
  close:['Close seats', s=>s.projection && s.projection.win_prob < .75],
  gains:['Changing hands', s=>s.projection && s.held_by && s.projection.winner !== s.held_by],
  all:['All 88', ()=>true],
};
function seats(){
  return `<section class="block"><h1 class="hero__title" style="font-size:clamp(28px,4vw,40px)">Every seat</h1>
  <p class="lede">Projected winner and One Nation's chance in all 88 lower house seats.</p>
  <div class="filters"><div class="seg" role="group" aria-label="Filter seats">${Object.entries(FILTERS).map(([k,[l]])=>`<button data-f="${k}" aria-pressed="${ui.f===k}">${l}</button>`).join('')}</div>
  <input class="search" type="search" placeholder="Find a seat" aria-label="Find a seat" value="${esc(ui.q)}"></div>
  <table class="list"><thead><tr><th>Seat</th><th>Projected</th><th class="r hide-s">One Nation 1st pref</th><th class="r">One Nation chance</th></tr></thead><tbody id="rows"></tbody></table>
  ${means(['<strong>"Changing hands"</strong> lists seats projected to go to a different party from the one holding them now.', 'Percentages under each projected winner are their chance of winning the seat.'])}
  ${under(['First preferences are each voter\'s number 1. Most seats are decided on preferences, so a candidate can top the first count and still lose.', 'A seat\'s chance blends the live count with the pre-election baseline. It firms up as more of the roll is counted.'])}
  </section>`;
}
function bindSeats(){
  document.querySelectorAll('.seg button').forEach(b=>b.onclick=()=>{ui.f=b.dataset.f;render(false);});
  const s = $('.search'); s.oninput = ()=>{ui.q=s.value;rows();};
  rows();
}
function rows(){
  const q = ui.q.toLowerCase();
  const list = D.seats.filter(FILTERS[ui.f][1]).filter(s=>!q||s.name.toLowerCase().includes(q))
    .sort((a,b)=>(b.projection?.on_win_prob||0)-(a.projection?.on_win_prob||0) || (b.on?.pct||0)-(a.on?.pct||0) || a.name.localeCompare(b.name));
  $('#rows').innerHTML = list.map(s=>{const p=s.projection;return `<tr data-href="#/seat/${s.slug}"><td class="seat">${esc(s.name)}<small>${onCand(s)||'&nbsp;'}</small><small>${heldBy(s)}</small></td>
    <td>${p?`${chip(p.winner)} <span class="small muted">${chanceTxt(p.win_prob)}</span>`:'<span class="muted">–</span>'}</td>
    <td class="r hide-s">${pct(s.on?.pct)}</td><td class="r">${chanceCell(p?.on_win_prob)}</td></tr>`}).join('') || `<tr><td colspan="4" class="muted">No seats match.</td></tr>`;
  document.querySelectorAll('tr[data-href]').forEach(tr => tr.onclick = () => location.hash = tr.dataset.href);
}

/* ---------------- seat ---------------- */
function seatPage(slug){
  const s = D.seats.find(x=>x.slug===slug);
  if(!s) return `<p><a href="#/seats">Seat not found. Back to all seats.</a></p>`;
  const p = s.projection, on = s.on || {}, b = s.baseline;
  const fin = p?.final || [];
  let h = `<a class="crumb" href="#/seats">All seats</a>
  <div class="seat-h"><h1>${esc(s.name)}</h1>${s.held_by?`<span class="muted">${heldBy(s)}${b?.margin!=null?`, won by ${b.margin.toFixed(1)} points in 2022`:''}</span>`:''}</div>
  <dl class="facts">
    <div><dt>Projected winner</dt><dd>${p?`${nm(p.winner)} <small>${chanceTxt(p.win_prob)} chance</small>`:'–'}</dd></div>
    <div><dt>One Nation chance</dt><dd style="color:var(--on)">${chanceTxt(p?.on_win_prob)}<small>${on.pct!=null?`${pct(on.pct)} first preferences`:'no live count yet'}</small></dd></div>
    <div><dt>One Nation candidate</dt><dd>${on.candidate?esc(person(on.candidate)):'–'}<small>${on.rank?`${['','First','Second','Third','Fourth','Fifth'][on.rank]||on.rank+'th'} on first preferences`:''}</small></dd></div>
    <div><dt>Sitting MP</dt><dd>${s.mp?.name?esc(mpName(s)):'–'}<small>${s.mp?.name?`${nm(s.mp.code)}${s.mp.running===true?`, running again${s.mp.pct!=null?` on ${pct(s.mp.pct)}`:''}`:s.mp.running===false?', not running again':''}`:''}</small></dd></div>
    <div><dt>Counted</dt><dd>${pct(s.counted_pct,0)}<small>${s.formal?`${fmt(s.formal)} formal votes`:'of enrolled voters'}</small></dd></div>
  </dl>${s.mp?.note && !/2022 election/.test(s.mp.note)?`<p class="small muted" style="margin:10px 0 0">${esc(mpName(s))}: ${esc(s.mp.note.charAt(0).toLowerCase()+s.mp.note.slice(1))}.</p>`:''}`;
  if(fin.length===2){
    h += `<section class="block" style="margin-top:36px"><h2>Projected result after preferences</h2>
    <div class="duel"><div class="duel__bar"><div style="width:${fin[0].pct}%;background:${C[fin[0].code]}">${pct(fin[0].pct)}</div><div style="width:${fin[1].pct}%;background:${C[fin[1].code]}">${pct(fin[1].pct)}</div></div>
    <div class="duel__names"><span>${esc(person(fin[0].candidate))}, ${nm(fin[0].code)}</span><span>${esc(person(fin[1].candidate))}, ${nm(fin[1].code)}</span></div></div>
    <p class="small muted" style="margin-top:8px">Based on: ${esc(p.basis)}.</p>
    ${means((s.meaning||[]).map(esc))}
    ${needBlock(s)}
    </section>`;
  } else if(s.meaning) h += means(s.meaning.map(esc));
  if(s.primary?.length){
    const max = Math.max(...s.primary.map(r=>r.pct), 10);
    h += `<section class="block"><h2>First preferences</h2><p class="lede small">Change since 2022 on the right.</p>
    <div class="bars">${(()=>{const seen=new Set();return s.primary.map(r=>{const sw=seen.has(r.code)?null:s.swing?.[r.code];seen.add(r.code);return barRow(`${person(r.candidate)}, ${nm(r.code)}`, r.pct, r.code, max, null, sw);}).join('')})()}</div></section>`;
  } else if(s.prior?.primary){
    const pp = Object.entries(s.prior.primary).sort((a,b)=>b[1]-a[1]);
    h += `<section class="block"><h2>Pre-count estimate</h2><p class="lede small">No votes counted yet. Estimated first preferences from 2022 results and the final polls.</p>
    <div class="bars">${pp.map(([k,v])=>barRow(nm(k), v, k, Math.max(...pp.map(x=>x[1])))).join('')}</div></section>`;
  }
  if(s.tcp?.length===2){
    h += `<section class="block"><h2>VEC preference count</h2><p class="lede small">${fmt(s.tcp_total)} votes so far between the two candidates the VEC expects to finish top.</p>
    <div class="bars">${s.tcp.map(r=>barRow(`${person(r.candidate)}, ${nm(r.code)}`, r.pct, r.code, 100, 50)).join('')}</div></section>`;
  }
  h += `<div id="booths"></div>${under([
    '<strong>Projected result</strong> simulates the full preference count: the lowest candidate is excluded and their votes passed on, until two remain. Where the VEC has counted preferences, that real data is blended in.',
    '<strong>VEC preference count</strong> is an early sort of ballots between the two candidates the VEC expects to finish top. If it picked the wrong two, it recounts later.',
    s.url ? `Source: <a href="${esc(s.url)}" rel="noopener">VEC results for ${esc(s.name)}</a>.` : ''])}`;
  return h;
}
function needBlock(s){
  const n = s.on?.needs; if(!n || s.on.rank > 3) return '';
  const f = s.on.flow;
  return `<div class="need" style="margin-top:24px"><h3>What One Nation needs</h3>
    <p class="small muted" style="margin:4px 0 10px">Share of other candidates' votes (${pct(n.others_pct)} of the total) that must flow to One Nation ahead of ${nm(n.rival)}.</p>
    <div class="need__t"><i style="width:${Math.min(100,f??0)}%"></i><u style="left:${Math.min(100,n.share_needed)}%"></u></div>
    <p class="small" style="margin:8px 0 0">Needs <b>${pct(n.share_needed)}</b>${f!=null?`, getting <b style="color:var(--on)">${pct(f)}</b> where it can be measured`:''}.</p></div>`;
}
async function loadBooths(slug){
  try{
    const s = seatCache[slug] || (seatCache[slug] = await (await fetch(`data/seat/${slug}.json?t=${Date.now()}`)).json());
    const bp = s.booths_primary; if(!bp?.rows?.length || !s.on?.candidate) return;
    const key = s.on.candidate.split(',')[0].toLowerCase();
    const onCol = bp.columns.find(c=>c.toLowerCase().includes(key));
    const cand = bp.columns.filter(c=>s.primary.some(p=>c.toLowerCase().includes(p.candidate.split(',')[0].toLowerCase())));
    const rows = bp.rows.filter(r=>!/total|percentage|formal vote/i.test(r.booth)).map(r=>{const f=cand.reduce((a,c)=>a+(r.values[c]||0),0);return {b:r.booth,f,on:onCol&&f?100*(r.values[onCol]||0)/f:null};})
      .filter(r=>r.f>0).sort((a,b)=>(b.on??0)-(a.on??0));
    const el = $('#booths'); if(!el || !rows.length) return;
    el.innerHTML = `<section class="block"><h2>Booth by booth</h2><p class="lede small">One Nation's first-preference share at each voting centre counted so far.</p>
      <table class="list"><thead><tr><th>Voting centre</th><th class="r">Votes</th><th class="r">One Nation</th></tr></thead><tbody>
      ${rows.map(r=>`<tr><td>${esc(r.b)}</td><td class="r">${fmt(r.f)}</td><td class="r"><b>${pct(r.on)}</b></td></tr>`).join('')}</tbody></table></section>`;
  }catch(e){}
}

/* ---------------- council ---------------- */
function council(){
  const c = D.council, rs = D.regions.filter(r=>r.status==='ok');
  return `<section class="block"><h1 class="hero__title" style="font-size:clamp(28px,4vw,40px)">Upper house</h1>
  <p class="lede">40 members, five from each of eight regions. 21 votes pass a law.</p>
  ${rs.length ? `<dl class="facts"><div><dt>One Nation</dt><dd style="color:var(--on)">${c.on}<small>estimated seats</small></dd></div><div><dt>Coalition</dt><dd>${c.coalition}</dd></div><div><dt>Labor and Greens</dt><dd>${c.left}</dd></div><div><dt>Regions reporting</dt><dd>${rs.length} of 8</dd></div></dl>${means([esc(c.summary)])}` :
  `${means(['<strong>No upper house figures yet.</strong> These are usually published later on election night.', 'Before the count, the final DemosAU poll projected One Nation to win 7 to 10 of the 40 upper house seats, with the Coalition on 15 to 17. Either way, the Coalition would likely need One Nation, or Labor and the Greens, to pass laws.'])}`}
  ${under(['Each region elects five members. A quota is one-sixth of the vote (16.7%). Reaching it guarantees a seat.', 'Group voting tickets were abolished for 2026, so above-the-line voters now number parties themselves instead of following party deals. That favours parties with a big first-preference vote, like One Nation.', 'Seat estimates here use full quotas and then the largest leftovers, which ignores preferences, so treat them as a guide. Final results take one to two weeks.'])}
  ${rs.map(r=>`<section class="block"><h2>${esc(r.name)}</h2><div class="bars">${r.groups.slice(0,8).map(g=>barRow(`${g.name} (${g.quotas} quotas)`, g.pct, g.code, 50, 16.67)).join('')}</div>${r.meaning?means([esc(r.meaning)]):''}</section>`).join('')}
  </section>`;
}

/* ---------------- method ---------------- */
function method(){
  const polls = D.polls || [];
  return `<section class="block"><h1 class="hero__title" style="font-size:clamp(28px,4vw,40px)">How this works</h1>
  <dl class="gloss">
  <dt>Where the numbers come from</dt><dd>Live counts are read from the Victorian Electoral Commission's results pages about every five minutes. The pre-election baseline uses the 2022 results for each seat (boundaries are unchanged), holders after by-elections, and the average of the final polls.</dd>
  <dt>Pre-count estimate</dt><dd>One Nation barely ran in 2022, so its vote is estimated by drawing from each party's 2022 voters at different rates (most from Nationals, Liberal and minor-right voters, least from Greens voters), scaled to its poll average${D.poll_average?` of ${D.poll_average.ON}%`:''}. Other parties are then scaled to their poll averages.</dd>
  <dt>Preference model</dt><dd>Each seat is counted out the way the VEC does it: the lowest candidate is excluded and their votes passed on, until two remain. Votes move according to typical patterns: Greens and Labor voters put One Nation near last, while Coalition and minor-right voters prefer One Nation to Labor.</dd>
  <dt>Live count</dt><dd>As votes come in, the model runs on real first preferences. Where the VEC has a preference count, it's blended in, and where booth data lets us measure the actual flow of preferences to One Nation, that measured flow is used. The baseline fades out as about a quarter of the roll is counted.</dd>
  <dt>Chances and paths to power</dt><dd>Each seat gets a margin and an uncertainty that shrinks as counting goes on. The whole parliament is then simulated ${fmt(D.projection?.runs)} times, with shared statewide errors so seats move together as they do on a real night.</dd>
  <dt>Balance of power</dt><dd>If the largest group is short of 45 seats, a smaller party can decide who governs, usually through a confidence-and-supply agreement or a formal coalition.</dd>
  <dt>Limits</dt><dd>Early booths are small and unrepresentative, and pre-poll and postal votes come later. Independents and local factors aren't captured well. Treat chances as estimates, not results.</dd>
  </dl>
  ${polls.length?`<section class="block"><h2>Final polls used</h2><table class="list"><thead><tr><th>Poll</th><th class="r">Coalition</th><th class="r">Labor</th><th class="r">One Nation</th><th class="r">Greens</th></tr></thead><tbody>
  ${polls.map(p=>`<tr><td>${esc(p.name)}</td><td class="r">${p.COAL??'–'}</td><td class="r">${p.ALP??'–'}</td><td class="r"><b>${p.ON??'–'}</b></td><td class="r">${p.GRN??'–'}</td></tr>`).join('')}
  <tr><td><b>Average</b></td><td class="r"><b>${D.poll_average.COAL}</b></td><td class="r"><b>${D.poll_average.ALP}</b></td><td class="r"><b>${D.poll_average.ON}</b></td><td class="r"><b>${D.poll_average.GRN}</b></td></tr></tbody></table></section>`:''}
  </section>`;
}

load();
setInterval(load, 60000);
