/* Vic 2026 One Nation tracker: renders data/site.json. No build step, no dependencies. */
const COLORS = {ON:'var(--on)',LIB:'var(--lib)',NAT:'var(--nat)',ALP:'var(--alp)',GRN:'var(--grn)',IND:'var(--ind)',OTH:'var(--oth)'};
const NAMES = {ON:'One Nation',LIB:'Liberal',NAT:'Nationals',ALP:'Labor',GRN:'Greens',IND:'Independent',OTH:'Other'};
const STATUS = {
  won:'Won', lost:'Lost', leading:'Leading', 'ahead-close':'Narrowly ahead', 'trailing-close':'Narrowly behind',
  trailing:'Behind', contender:'In contention', kingmaker:'Third: kingmaker', outside:'Out of contention',
  'no-candidate':'No candidate', 'no-data':'No count yet'
};
const STATUS_ORDER = ['won','leading','ahead-close','trailing-close','contender','kingmaker','trailing','outside','lost','no-candidate','no-data'];
let D = null, seatCache = {}, ui = {filter:'contending', q:'', sort:'status'};

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct = v => v == null ? '–' : `${Number(v).toFixed(1)}%`;
const n = v => v == null ? '–' : Number(v).toLocaleString('en-AU');
const pill = c => `<span class="pill" style="background:${COLORS[c]||COLORS.OTH}">${esc(c)}</span>`;
const badge = s => `<span class="badge b-${esc(s)}">${esc(STATUS[s]||s)}</span>`;
const nm = c => NAMES[c] || c;
const title = c => (c||'').split(',').map(x=>x.trim()).reverse().join(' ').toLowerCase().replace(/\b\w/g,m=>m.toUpperCase());
const explain = (head, items, cls='') => `<div class="card explain ${cls}"><h3>${head}</h3>${
  Array.isArray(items) ? `<ul>${items.map(i=>`<li>${i}</li>`).join('')}</ul>` : `<p style="margin:0">${items}</p>`}</div>`;
const under = items => explain('Understanding this', items, 'under');
const means = items => explain('What this means', items);

async function load(){
  try{
    const r = await fetch(`data/site.json?t=${Date.now()}`, {cache:'no-store'});
    if(!r.ok) throw new Error(r.status);
    D = await r.json();
    seatCache = {};
    const t = D.scraped_at ? new Date(D.scraped_at) : null;
    const live = $('#live');
    live.className = 'live ' + (D.source_status==='ok' ? 'ok' : '');
    live.textContent = D.source_status==='ok'
      ? `Updated ${t.toLocaleTimeString('en-AU',{hour:'numeric',minute:'2-digit'})}`
      : 'Waiting for VEC results';
    render();
  }catch(e){
    $('#live').textContent = 'Data not available yet';
    if(!D) $('#app').innerHTML = `<div class="banner">No data has been published yet. The first update runs a few minutes after the site goes live.</div>`;
  }
}

function render(){
  const h = location.hash.replace(/^#\/?/, '');
  const [page, arg] = h.split('/');
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#/' + (page==='seat'?'seats':page)));
  if(!D) return;
  const v = {'':overview, seats, seat:seatPage, preferences, council, guide}[page] || overview;
  $('#app').innerHTML = waitingBanner() + v(arg);
  if(page==='seats') bindSeats();
  if(page==='seat') loadSeatDetail(arg);
  window.scrollTo({top:0});
}
window.addEventListener('hashchange', render);

function waitingBanner(){
  if(D.source_status === 'ok') return '';
  return `<div class="banner"><b>Waiting for the VEC.</b> ${esc(D.source_message || 'Results pages have not been found yet.')} The site checks again every few minutes.</div>`;
}

/* ---------------- overview ---------------- */
function overview(){
  const p = D.paths, sw = D.statewide, c = D.on_status_counts || {};
  const onPct = sw.pct?.ON;
  const inTcp = D.seats.filter(s=>s.on?.in_tcp).length;
  const close = (c['ahead-close']||0) + (c['trailing-close']||0) + (c.contender||0);
  const order = ['ON','LIB','NAT','ALP','GRN','IND','OTH'];
  const bar = order.map(k => p.tally[k] ? `<div title="${nm(k)} ${p.tally[k]}" style="width:${p.tally[k]/88*100}%;background:${COLORS[k]}"></div>` : '').join('');
  const lg = order.filter(k=>p.tally[k]).map(k=>`<span><i class="sw" style="background:${COLORS[k]}"></i>${nm(k)} ${p.tally[k]}</span>`).join('')
    + `<span><i class="sw" style="background:var(--panel2)"></i>No count ${p.pending}</span>`;
  const meaning = [esc(p.summary)];
  if(onPct != null) meaning.push(`Across all counted votes One Nation has ${pct(onPct)} of first preferences statewide${onPct>=20?', in line with its pre-election polling above 20%':''}.`);
  if(inTcp) meaning.push(`One Nation is in the final two in ${inTcp} seat${inTcp>1?'s':''}. Those are the only seats it can realistically win.`);
  if(close) meaning.push(`${close} seat${close>1?'s are':' is'} close enough that late counting or preferences could swing them.`);
  return `
  <h1>Can One Nation take power in Victoria?</h1>
  <p class="sub">Live count of the 2026 Victorian state election, seat by seat, through One Nation's eyes.</p>
  <div class="grid g4">
    ${stat('One Nation primary vote', pct(onPct), `${n(sw.formal)} formal votes counted`, true)}
    ${stat('Seats One Nation leads', p.on, `of ${p.reported} with a count`, true)}
    ${stat('In the final two', inTcp, 'seats where it can still win')}
    ${stat('Coalition leads', p.coalition, `${p.majority} needed for majority`)}
  </div>
  <h2>Paths to power</h2>
  <div class="card">
    <div class="small muted">Who is ahead in each of the 88 seats. The white line is the 45 seats needed to govern.</div>
    <div class="seatbar">${bar}<span class="maj"></span></div>
    <div class="legend">${lg}</div>
    <div style="margin-top:12px">${p.scenarios.map(s=>`<div class="scen"><span class="tick ${s.met?'yes':''}">${s.met?'✓':'·'}</span><div><b>${esc(s.title)}</b><small>${esc(s.detail)}</small></div></div>`).join('')}</div>
  </div>
  <div class="grid g2" style="margin-top:12px">
    ${means(meaning)}
    ${under([
      'Government is formed by whoever can win confidence votes in the 88-seat lower house. That takes 45 votes.',
      'One Nation can govern alone with 45 seats, or share power if the Coalition falls short of 45 and needs One Nation\'s seats to get there (a "kingmaker" deal).',
      '"Leads" means ahead on the current count. Seats are only won when the VEC declares them, often days later.',
      'Early counts come from small booths first. Pre-poll and postal votes are counted later and can change results.'
    ])}
  </div>
  ${historyChart()}
  <h2>One Nation's closest races</h2>
  ${p.close_races.length ? `<div class="card tablewrap"><table><tr><th>Seat</th><th>Status</th><th class="num">1st pref</th><th class="num">After prefs</th><th class="num hide-sm">Needs</th></tr>
    ${p.close_races.map(r=>`<tr class="click" onclick="location.hash='#/seat/${r.slug}'"><td>${esc(r.name)}</td><td>${badge(r.status)}</td><td class="num">${pct(r.on_pct)}</td><td class="num">${pct(r.on_tcp)}</td><td class="num hide-sm">${pct(r.needs)}</td></tr>`).join('')}
  </table></div>
  <p class="small muted">"Needs" is the share of other candidates' votes that must flow to One Nation for it to win.</p>` : '<p class="muted">No close One Nation races yet.</p>'}
  <h2>Statewide first preferences</h2>
  <div class="card bars">${Object.entries(sw.pct||{}).map(([k,v])=>barRow(nm(k),'',v,k)).join('') || '<span class="muted">No votes counted yet.</span>'}</div>`;
}
const stat = (k,v,nn,on) => `<div class="card stat"><div class="k">${k}</div><div class="v ${on?'on':''}">${v}</div><div class="n">${nn}</div></div>`;
function barRow(name, sub, v, code, max=100){
  return `<div class="row"><div class="name">${esc(name)} ${sub?`<small>${esc(sub)}</small>`:''}</div><div class="track"><div class="fill" style="width:${Math.min(100,(v||0)/max*100)}%;background:${COLORS[code]||COLORS.OTH}"></div></div><div class="val">${pct(v)}</div></div>`;
}

function historyChart(){
  const H = D.history || [];
  if(H.length < 3) return '';
  const xs = H.map((_,i)=>i), ys = H.map(h=>h.on_pct||0);
  const mn = Math.max(0, Math.min(...ys)-2), mx = Math.max(...ys)+2;
  const pts = ys.map((y,i)=>`${(i/(ys.length-1)*100).toFixed(2)},${(90-(y-mn)/(mx-mn)*80-5).toFixed(2)}`).join(' ');
  return `<h2>One Nation's vote through the night</h2><div class="card"><svg class="spark" viewBox="0 0 100 90" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(--on)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>
  <div class="small muted">Statewide One Nation first-preference share at each update, from ${pct(ys[0])} to ${pct(ys[ys.length-1])}.</div></div>`;
}

/* ---------------- seats ---------------- */
const FILTERS = {
  contending:['One Nation can win', s=>['won','leading','ahead-close','trailing-close','contender'].includes(s.on_status)],
  watch:['Target seats', s=>!!s.watch],
  tcp:['In final two', s=>s.on?.in_tcp],
  kingmaker:['Kingmaker', s=>s.on_status==='kingmaker'],
  all:['All 88', s=>true],
};
function seats(){
  return `<h1>Every seat</h1><p class="sub">Tap a seat for the full breakdown. Sorted by how well One Nation is placed.</p>
  <div class="chips">${Object.entries(FILTERS).map(([k,[l]])=>`<button class="chip ${ui.filter===k?'on':''}" data-f="${k}">${l}</button>`).join('')}</div>
  <input class="search" placeholder="Search seats" value="${esc(ui.q)}">
  <div class="card tablewrap" style="margin-top:12px"><table id="seattable"></table></div>
  <div class="grid g2" style="margin-top:12px">
  ${under(['<b>1st pref</b>: the share of voters who put One Nation number 1.',
           '<b>Rank</b>: where One Nation sits on first preferences. It usually needs to finish first or second to win.',
           '<b>After prefs</b>: One Nation\'s share once everyone else\'s preferences are counted, if the VEC picked it for the final two.',
           '<b>Counted</b>: rough share of enrolled voters counted so far.'])}
  ${means(['Seats marked "In contention" or better are where One Nation can still win.',
           '"Third: kingmaker" seats are ones One Nation can\'t win, but its voters\' preferences decide whether Labor or the Coalition does.'])}
  </div>`;
}
function bindSeats(){
  document.querySelectorAll('.chip').forEach(b=>b.onclick=()=>{ui.filter=b.dataset.f;render();});
  const s = $('input.search'); s.oninput = ()=>{ui.q=s.value;drawSeatTable();};
  drawSeatTable();
}
function drawSeatTable(){
  const q = ui.q.toLowerCase();
  let rows = D.seats.filter(FILTERS[ui.filter][1]).filter(s=>!q || s.name.toLowerCase().includes(q));
  rows.sort((a,b)=> STATUS_ORDER.indexOf(a.on_status||a.status)-STATUS_ORDER.indexOf(b.on_status||b.status) || (b.on?.pct||0)-(a.on?.pct||0));
  $('#seattable').innerHTML = `<tr><th>Seat</th><th>One Nation</th><th class="num">1st pref</th><th class="num hide-sm">Rank</th><th class="num">After prefs</th><th class="hide-sm">Leader</th><th class="num hide-sm">Counted</th></tr>` +
    (rows.map(s=>`<tr class="click" onclick="location.hash='#/seat/${s.slug}'"><td>${esc(s.name)}${s.watch?' <span title="Pre-election target">★</span>':''}</td><td>${badge(s.on_status||s.status)}</td><td class="num">${pct(s.on?.pct)}</td><td class="num hide-sm">${s.on?.rank??'–'}</td><td class="num">${pct(s.on?.tcp_pct)}</td><td class="hide-sm">${s.leader?pill(s.leader):''}</td><td class="num hide-sm">${pct(s.counted_pct)}</td></tr>`).join('')
     || `<tr><td colspan="7" class="muted">No seats match yet.</td></tr>`);
}

/* ---------------- seat ---------------- */
function seatPage(slug){
  const s = D.seats.find(x=>x.slug===slug);
  if(!s) return `<p>Seat not found. <a href="#/seats">Back to seats</a></p>`;
  const on = s.on || {};
  let h = `<a class="back" href="#/seats">← All seats</a><h1>${esc(s.name)}</h1>
    <p class="sub">${badge(s.on_status||s.status)} ${esc(s.headline||'')}${s.watch?` · <span class="muted">${esc(s.watch)}</span>`:''}</p>`;
  if(s.status!=='ok') return h + means(s.meaning.map(esc));
  h += `<div class="grid g4">
    ${stat('One Nation 1st pref', pct(on.pct), on.candidate?title(on.candidate):'', true)}
    ${stat('After preferences', on.in_tcp?pct(on.tcp_pct):'Not in final two', s.tcp_share_counted!=null?`${pct(s.tcp_share_counted)} of votes have a preference count`:'', on.in_tcp)}
    ${stat('Votes counted', n(s.formal), s.counted_pct!=null?`about ${pct(s.counted_pct)} of enrolled voters`:'')}
    ${stat('Currently ahead', nm(s.leader), s.confidence==='called'?'Declared':s.confidence)}
  </div>
  <div class="grid g2" style="margin-top:12px">${means(s.meaning.map(esc))}${needsCard(s)}</div>
  <h2>First preferences</h2><div class="card bars">${s.primary.map(r=>barRow(title(r.candidate), nm(r.code), r.pct, r.code, Math.max(...s.primary.map(x=>x.pct)))).join('')}</div>`;
  if(s.tcp?.length===2){
    h += `<h2>Two-candidate preferred</h2><div class="card bars">${s.tcp.map(r=>`<div class="row"><div class="name">${esc(title(r.candidate))} <small>${nm(r.code)}</small></div><div class="track"><div class="fill" style="width:${r.pct}%;background:${COLORS[r.code]}"></div><span class="half"></span></div><div class="val">${pct(r.pct)}</div></div>`).join('')}
      <div class="small muted">${n(s.tcp_total)} votes in the preference count so far. 50% wins.</div></div>`;
  }
  h += `<div id="booths"></div>
  <div class="grid g2" style="margin-top:12px">${under([
    '<b>First preferences</b> are the number 1 votes. Nobody usually gets 50%, so the lowest candidates are knocked out and their votes move to the next number on each ballot.',
    '<b>Two-candidate preferred (2CP)</b> is the VEC\'s early count of those preferences between the two candidates it expects to finish top. It is indicative only; the official result comes from the full distribution of preferences.',
    '<b>What One Nation needs</b> assumes every ballot ends with one of the final two, which is how Victorian lower-house voting works.',
    s.url?`Source: <a href="${esc(s.url)}" rel="noopener">VEC results page for ${esc(s.name)}</a>.`:''
  ])}</div>`;
  return h;
}
function needsCard(s){
  const nd = s.on?.needs; if(!nd) return '';
  const flow = s.on.flow;
  return `<div class="card"><h3>What One Nation needs to win</h3>
    <div class="small muted">Share of the ${pct(nd.others_pct)} of votes held by other candidates that must flow to One Nation over ${esc(nm(nd.rival))}.</div>
    <div class="gauge"><div class="have" style="width:${flow??0}%"></div><span class="need" style="left:${Math.min(100,nd.share_needed)}%"></span></div>
    <div class="small">Needs <b>${pct(nd.share_needed)}</b>${flow!=null?` · currently getting <b style="color:var(--on)">${pct(flow)}</b>`:' · no preference flow measured yet'}</div>
    ${s.on.projected_2cp!=null?`<div class="small muted" style="margin-top:6px">Projected after preferences: <b>${pct(s.on.projected_2cp)}</b> (${esc(s.on.projection_basis)})</div>`:''}
    ${nd.share_needed>100?'<div class="small" style="color:var(--bad)">Mathematically out of reach on current numbers.</div>':''}
  </div>`;
}
async function loadSeatDetail(slug){
  try{
    const s = seatCache[slug] || (seatCache[slug] = await (await fetch(`data/seat/${slug}.json?t=${Date.now()}`)).json());
    const bp = s.booths_primary; if(!bp?.rows?.length) return;
    const onCol = bp.columns.find(c => s.on?.candidate && c.toLowerCase().includes(s.on.candidate.split(',')[0].toLowerCase()));
    const candCols = bp.columns.filter(c => s.primary.some(p=>c.toLowerCase().includes(p.candidate.split(',')[0].toLowerCase())));
    const rows = bp.rows.filter(r=>!/total/i.test(r.booth)).map(r=>{
      const formal = candCols.reduce((a,c)=>a+(r.values[c]||0),0);
      return {booth:r.booth, formal, on: onCol&&formal ? 100*(r.values[onCol]||0)/formal : null};
    }).filter(r=>r.formal>0).sort((a,b)=>(b.on??0)-(a.on??0));
    if(!rows.length) return;
    const el = document.getElementById('booths'); if(!el) return;
    el.innerHTML = `<h2>Booth by booth</h2><div class="card tablewrap"><table><tr><th>Voting centre</th><th class="num">Formal votes</th><th class="num">One Nation</th></tr>
      ${rows.map(r=>`<tr><td>${esc(r.booth)}</td><td class="num">${n(r.formal)}</td><td class="num">${pct(r.on)}</td></tr>`).join('')}</table></div>
      <p class="small muted">One Nation's strongest booths first. Big differences between booths show where its support is concentrated.</p>`;
  }catch(e){}
}

/* ---------------- preferences ---------------- */
function preferences(){
  const tcp = D.seats.filter(s=>s.on?.in_tcp).sort((a,b)=>(b.on.tcp_pct||0)-(a.on.tcp_pct||0));
  const third = D.seats.filter(s=>s.status==='ok' && s.on?.rank && s.on.rank>=3 && s.on.pct>=10).sort((a,b)=>b.on.pct-a.on.pct);
  const wrong = D.seats.filter(s=>s.status==='ok' && s.on?.rank<=2 && s.tcp?.length===2 && !s.on.in_tcp);
  const flows = tcp.filter(s=>s.on.flow!=null).map(s=>s.on.flow);
  const avg = flows.length ? flows.reduce((a,b)=>a+b,0)/flows.length : null;
  const m = [];
  if(avg!=null) m.push(`Across ${flows.length} seat${flows.length>1?'s':''} where it can be measured, about ${pct(avg)} of other candidates' votes are flowing to One Nation.`);
  if(avg!=null) m.push(avg<45 ? 'That\'s a below-even flow, so One Nation needs a big first-preference lead to win.' : 'That\'s a strong flow. One Nation can win from second place in some seats.');
  if(wrong.length) m.push(`In ${wrong.length} seat${wrong.length>1?'s':''} One Nation is top two on first preferences but the VEC is counting preferences between two other candidates. Watch for the VEC to switch those counts.`);
  if(!m.length) m.push('Not enough preference counts with One Nation in them yet.');
  return `<h1>Preferences</h1><p class="sub">Where One Nation gains or loses once everyone else's votes are passed on.</p>
  <div class="grid g2">${means(m)}${under([
    'Victoria uses full preferential voting in the lower house: you must number every box. When your candidate is knocked out your vote moves to your next choice.',
    'Who finishes <b>third</b> matters most. Liberal and Nationals voters tend to preference One Nation above Labor and the Greens. Labor and Greens voters tend to put One Nation last.',
    'So One Nation does best when it faces Labor in the final two and the Liberals finish third. It struggles when it faces the Liberals or Nationals.',
    '"Flow" is the share of other candidates\' votes that ended up with One Nation, measured at booths where both counts exist.'])}</div>
  <h2>One Nation in the final two</h2>
  ${tcp.length?`<div class="card tablewrap"><table><tr><th>Seat</th><th>Against</th><th class="num">1st pref</th><th class="num">Flow to ON</th><th class="num">Needs</th><th class="num">After prefs</th></tr>
  ${tcp.map(s=>{const opp=s.tcp.find(r=>r.code!=='ON');return `<tr class="click" onclick="location.hash='#/seat/${s.slug}'"><td>${esc(s.name)}</td><td>${opp?pill(opp.code):''}</td><td class="num">${pct(s.on.pct)}</td><td class="num">${pct(s.on.flow)}</td><td class="num">${pct(s.on.needs?.share_needed)}</td><td class="num"><b style="color:${s.on.tcp_pct>50?'var(--good)':'var(--bad)'}">${pct(s.on.tcp_pct)}</b></td></tr>`}).join('')}</table></div>`:'<p class="muted">No preference counts include One Nation yet.</p>'}
  ${wrong.length?`<h2>Preference count may be between the wrong two</h2><div class="card">${wrong.map(s=>`<div><a href="#/seat/${s.slug}">${esc(s.name)}</a>: One Nation ${pct(s.on.pct)} (rank ${s.on.rank}); VEC counting ${s.tcp.map(r=>pill(r.code)).join(' v ')}</div>`).join('')}</div>`:''}
  <h2>Where One Nation's preferences decide the winner</h2>
  ${third.length?`<div class="card tablewrap"><table><tr><th>Seat</th><th class="num">One Nation</th><th>Leading</th><th class="num">Margin</th></tr>${third.slice(0,30).map(s=>`<tr class="click" onclick="location.hash='#/seat/${s.slug}'"><td>${esc(s.name)}</td><td class="num">${pct(s.on.pct)}</td><td>${pill(s.leader)}</td><td class="num">${s.margin!=null?'+'+s.margin.toFixed(1):'–'}</td></tr>`).join('')}</table></div>
  <p class="small muted">One Nation can't win these, but with 10%+ of the vote its how-to-vote card can tip close Labor v Coalition contests.</p>`:'<p class="muted">None yet.</p>'}`;
}

/* ---------------- council ---------------- */
function council(){
  const c = D.council, rs = D.regions.filter(r=>r.status==='ok');
  return `<h1>Upper house</h1><p class="sub">The Legislative Council: 40 members, 5 from each of 8 regions. 21 needed to pass laws.</p>
  <div class="grid g4">${stat('One Nation est. seats', c.on, 'from first preferences', true)}${stat('Coalition est.', c.coalition, 'Liberal + Nationals')}${stat('Labor + Greens est.', c.left, '')}${stat('Regions reporting', rs.length, 'of 8')}</div>
  <div class="grid g2" style="margin-top:12px">${means([esc(c.summary), c.on_pivotal?'<b>One Nation would hold the balance of power</b>: the Coalition could not pass legislation without it.':'On these estimates One Nation does not hold the balance of power on its own, but every seat matters in a close chamber.'])}
  ${under(['Each region elects 5 members. A <b>quota</b> is one-sixth of the vote (16.7%) plus one vote: reaching it guarantees a seat.',
           '1 quota = 1 seat. Parties with part-quotas compete for the last seats using preferences from knocked-out parties.',
           '<b>New for 2026:</b> group voting tickets have been abolished. Voters now number parties above the line themselves (like the Senate), so preferences follow voters, not backroom deals. That favours parties with a big primary vote, like One Nation.',
           'These seat estimates use first preferences only (full quotas, then largest leftovers), so treat them as a guide.',
           'Final upper house results usually take one to two weeks.'])}</div>
  ${rs.map(r=>`<h2>${esc(r.name)}</h2><div class="card bars">${r.groups.slice(0,8).map(g=>`<div class="row"><div class="name">${esc(g.name)} <small>${g.quotas} quotas</small></div><div class="track"><div class="fill" style="width:${Math.min(100,g.pct/50*100)}%;background:${COLORS[g.code]||COLORS.OTH}"></div><span class="half" style="left:${16.67/50*100}%" title="1 quota"></span></div><div class="val">${pct(g.pct)}</div></div>`).join('')}
    <div class="small muted">White line = 1 quota (16.7%). ${r.meaning?esc(r.meaning):''}</div></div>`).join('') || '<p class="muted">No upper house figures yet. These usually come in later on election night.</p>'}`;
}

/* ---------------- guide ---------------- */
function guide(){
  return `<h1>Guide</h1><p class="sub">How Victorian elections work, and how to read this site.</p>
  <div class="card"><dl class="gloss">
  <dt>How a party takes power</dt><dd>The party or group that can win votes of confidence in the 88-seat Legislative Assembly forms government. That needs 45 seats. If no one has 45, it's a hung parliament and parties negotiate.</dd>
  <dt>Kingmaker / balance of power</dt><dd>When the biggest group is just short of 45, a smaller party can decide who governs, usually through a confidence-and-supply agreement (backing the budget and opposing no-confidence motions) in exchange for policy wins, or a formal coalition with ministries.</dd>
  <dt>First preferences (primary vote)</dt><dd>The candidate each voter numbered 1.</dd>
  <dt>Preferences</dt><dd>Victoria uses full preferential voting in the lower house. If no one has over 50%, the last-placed candidate is excluded and their ballots move to each voter's next choice, until someone passes 50%.</dd>
  <dt>Two-candidate preferred (2CP)</dt><dd>On election night the VEC sorts every ballot into a pile for one of the two candidates it expects to finish top. It's a fast estimate. The official result is the full distribution of preferences, done days later. If the VEC picks the wrong two, it redoes the count.</dd>
  <dt>Why the leader on first preferences can lose</dt><dd>A candidate on 36% loses to one on 30% if most of the remaining 34% preference the second candidate. That's One Nation's biggest risk against Liberal or Nationals opponents.</dd>
  <dt>Booths, pre-poll and postal votes</dt><dd>Election-day booths are counted first, smallest first. Early votes (pre-poll) and postal votes are counted later and can lean differently. Postal votes keep arriving for about two weeks.</dd>
  <dt>Upper house quotas</dt><dd>Each of 8 regions elects 5 members. A quota is 16.7% of the vote. Group voting tickets were abolished for 2026, so above-the-line voters now choose their own preferences instead of following party deals.</dd>
  <dt>Where this data comes from</dt><dd>The site reads the Victorian Electoral Commission's published results every ~5 minutes and recalculates everything. "Needs", "flow" and "projected" figures are this site's own estimates.</dd>
  </dl></div>`;
}

load();
setInterval(load, 60000);
