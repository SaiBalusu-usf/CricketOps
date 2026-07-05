/**
 * Public live scorecard — CricHeroes-style layout wired to the state bus.
 * Everything renders from `state` via the shared runtime; the only fetches
 * are the one-time match meta (dates) and the event log for the
 * end-of-over commentary blocks (re-derived with the engine in-browser).
 */
import { connect, h, $, $$, fmt, teamOf } from '/client/shared/app.js';
import { reduce } from '/engine/index.js';

const matchId = location.pathname.split('/').filter(Boolean)[1] || null;

let app = null;
let state = null;
let pres = null;
let meta = { createdAt: null };
let lastUpdated = null;
let viewers = 0;
let activeTab = 'live';
let showAllOvers = false;
const evCache = { version: -1, snaps: null };

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------

function toast(msg) {
  const el = h('div', { class: 'toast' }, msg);
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2200);
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
  document.body.append(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* best effort */ }
  ta.remove();
}

const scoreText = (inn) => `${inn.runs}/${inn.wickets}`;
const dateText = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const timeText = (ts) => (ts ? new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');

function youTubeEmbed(url) {
  const m = String(url || '').match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/live\/)([\w-]{6,})/);
  return m ? `https://www.youtube.com/embed/${m[1]}` : null;
}

/** token → recent-ball bubble */
function bubble(tok) {
  if (tok.indexOf('W') >= 0) return h('span', { class: 'bub bw' }, 'W');
  if (tok === '4') return h('span', { class: 'bub b4' }, '4');
  if (tok === '6') return h('span', { class: 'bub b6' }, '6');
  if (tok === '•') return h('span', { class: 'bub' }, '0');
  if (/^\d+$/.test(tok)) return h('span', { class: 'bub' }, tok);
  return h('span', { class: 'bub bx' }, tok);
}

function feedBubble(it) {
  if (it.kind === 'four') return bubble('4');
  if (it.kind === 'six') return bubble('6');
  if (it.kind === 'wicket') return bubble('W');
  const t = it.text || '';
  if (/wide/i.test(t)) return bubble('wd');
  if (/NO BALL/i.test(t)) return bubble('nb');
  if (/leg bye/i.test(t)) { const m = t.match(/(\d) leg bye/); return bubble(`${m ? m[1] : ''}lb`); }
  if (/bye/i.test(t)) { const m = t.match(/(\d) bye/); return bubble(`${m ? m[1] : ''}b`); }
  if (/no run|dot ball|defended/i.test(t)) return bubble('0');
  if (/single/i.test(t)) return bubble('1');
  const m = t.match(/(\d) runs/);
  return bubble(m ? m[1] : '0');
}

function overNoOf(it) {
  if (!it.ov) return null;
  const [o, b] = String(it.ov).split('.').map(Number);
  return b === 0 ? o : o + 1;
}

const focus = () => (state && state.innings.length ? state.innings[state.innings.length - 1] : null);

// ---------------------------------------------------------------------------
// match card
// ---------------------------------------------------------------------------

function renderMatchCard() {
  const cfg = state.config;
  $('#matchLabel').textContent = cfg.name || `${cfg.teams[0].name} v ${cfg.teams[1].name}`;
  $('#livePill').hidden = !(state.phase === 'live' || state.phase === 'break');

  $('#mcMeta').textContent = '';
  $('#mcMeta').append(
    cfg.venue ? h('span', {}, `${cfg.venue}, `) : '',
    h('b', {}, 'Limited Overs, '), h('b', {}, `${cfg.oversPerInnings} Ov.`),
    meta.createdAt ? `, ${dateText(meta.createdAt)} ${timeText(meta.createdAt)}` : '');

  const toss = cfg.toss;
  $('#mcToss').textContent = toss
    ? `Toss: ${teamOf(state, toss.winner).name} opt to ${toss.decision === 'bat' ? 'bat' : 'field'}`
    : '';

  const rows = $('#teamRows');
  rows.textContent = '';
  const order = state.innings.length
    ? [state.innings[0].battingTeamId, state.innings[0].bowlingTeamId]
    : [cfg.teams[0].id, cfg.teams[1].id];
  for (const tid of order) {
    const team = teamOf(state, tid);
    const inns = state.innings.filter((i) => i.battingTeamId === tid && !i.superOver);
    const right = inns.length
      ? h('span', { class: 'tscore' }, inns.map((i) => scoreText(i)).join(' & '), ' ',
        h('small', {}, `(${inns[inns.length - 1].oversText} Ov)`))
      : h('span', { class: 'tstatus' }, state.phase === 'setup' ? '—' : 'Yet to Bat');
    rows.append(h('div', { class: 'trow' },
      h('span', { class: 'tname' }, h('span', { class: 'tchip', style: { background: team.color } }), team.name.toUpperCase()),
      right));
  }
  if (state.result) rows.append(h('div', { class: 'result-line' }, state.result.text));
  $('#mWatch').hidden = !(pres && youTubeEmbed(pres.videoUrl));
}

// ---------------------------------------------------------------------------
// LIVE tab — current batters, bowlers, partnership, recent strip
// ---------------------------------------------------------------------------

function renderLiveTab() {
  const box = $('#tab-live');
  box.textContent = '';
  const inn = focus();
  if (!inn) { box.append(h('p', { class: 'cm-info' }, 'The match has not started yet.')); return; }

  const batRows = inn.batters.filter((b) => b.atCrease);
  const bt = h('table', { class: 'ltable' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Batters'), h('th', {}, 'R'), h('th', {}, 'B'), h('th', {}, '4s'), h('th', {}, '6s'), h('th', {}, 'SR'))),
    h('tbody', {}, batRows.length ? batRows.map((b) => h('tr', {},
      h('td', { class: 'pl' }, `${b.name}${b.id === inn.striker ? '*' : ''}`),
      h('td', {}, h('b', {}, b.runs)), h('td', {}, b.balls), h('td', {}, b.fours), h('td', {}, b.sixes),
      h('td', {}, b.balls ? b.sr.toFixed(2) : '-'),
    )) : h('tr', { class: 'dim' }, h('td', { colspan: '6' }, inn.closed ? 'Innings over' : 'Waiting for the openers…'))));

  const bowlIds = [inn.currentBowlerId, inn.lastOverBowlerId].filter(Boolean);
  const bowlRows = inn.bowlers.filter((b) => bowlIds.includes(b.id));
  const wt = h('table', { class: 'ltable' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Bowlers'), h('th', {}, 'O'), h('th', {}, 'M'), h('th', {}, 'R'), h('th', {}, 'W'), h('th', {}, 'Eco'))),
    h('tbody', {}, bowlRows.length ? bowlRows.map((b) => h('tr', {},
      h('td', { class: 'pl' }, `${b.name}${b.id === inn.currentBowlerId ? '*' : ''}`),
      h('td', {}, b.oversText), h('td', {}, b.maidens), h('td', {}, b.runs), h('td', {}, h('b', {}, b.wickets)),
      h('td', {}, b.balls ? b.econ.toFixed(2) : '-'),
    )) : h('tr', { class: 'dim' }, h('td', { colspan: '6' }, 'Waiting for the bowler…'))));

  box.append(bt, wt);

  const p = inn.currentPartnership;
  if (p) {
    box.append(h('div', { class: 'strip-row' },
      h('span', { class: 'lab' }, 'Current Partnership:'), h('b', { class: 'num' }, `${p.runs}(${p.balls})`)));
  }

  const recent = h('div', { class: 'strip-row' }, h('span', { class: 'lab' }, 'RECENT :'));
  const last = inn.lastOver || [];
  const cur = inn.thisOver || [];
  if (last.length) { last.forEach((t) => recent.append(bubble(t))); if (cur.length) recent.append(h('span', { class: 'bub-sep' }, '|')); }
  cur.forEach((t) => recent.append(bubble(t)));
  if (last.length || cur.length) box.append(recent);

  if (state.chase) {
    box.append(h('div', { class: 'strip-row' },
      h('span', { class: 'lab' }, 'Chase:'),
      h('span', {}, `need ${state.chase.need} off ${state.chase.ballsLeft} balls (target ${state.chase.target}, RRR ${fmt.num1(state.chase.rrr)})`)));
  }
}

// ---------------------------------------------------------------------------
// SCORECARD tab — full cards for every innings
// ---------------------------------------------------------------------------

function renderScorecardTab() {
  const box = $('#tab-scorecard');
  box.textContent = '';
  if (!state.innings.length) { box.append(h('p', { class: 'cm-info' }, 'No innings yet.')); return; }
  for (const inn of [...state.innings].reverse()) {
    const team = teamOf(state, inn.battingTeamId);
    box.append(h('div', { class: 'sc-innings-head' },
      h('span', {}, h('span', { class: 'chip2', style: { background: team.color, display: 'inline-block' } }),
        `${team.name} ${inn.superOver ? '· Super Over' : `· ${['1st', '2nd'][inn.index] || ''} innings`}`),
      h('span', {}, `${scoreText(inn)} (${inn.oversText} Ov)`)));
    box.append(h('table', { class: 'ltable' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Batter'), h('th', {}, 'R'), h('th', {}, 'B'), h('th', {}, '4s'), h('th', {}, '6s'), h('th', {}, 'SR'))),
      h('tbody', {},
        inn.batters.map((b) => h('tr', {},
          h('td', { class: 'pl' }, `${b.name}${b.atCrease && !inn.closed ? '*' : ''}`, h('span', { class: 'out-how' }, b.howOut)),
          h('td', {}, h('b', {}, b.runs)), h('td', {}, b.balls), h('td', {}, b.fours), h('td', {}, b.sixes),
          h('td', {}, b.balls ? b.sr.toFixed(2) : '-'))))));
    const dnb = state.squads[inn.battingTeamId].filter((p) => !inn.batters.some((b) => b.id === p.id));
    box.append(h('div', { class: 'sc-sub' },
      h('span', {}, 'Extras ', h('b', {}, `${inn.extras.total}`),
        ` (wd ${inn.extras.wides}, nb ${inn.extras.noballs}, b ${inn.extras.byes}, lb ${inn.extras.legbyes}${inn.extras.penalties ? `, pen ${inn.extras.penalties}` : ''})`)));
    if (dnb.length && !inn.closed) box.append(h('div', { class: 'sc-sub' }, 'Yet to bat: ', dnb.map((p) => p.name).join(', ')));
    if (inn.fow.length) {
      box.append(h('div', { class: 'sc-sub' }, h('b', {}, 'Fall of wickets: '),
        inn.fow.map((f) => `${f.runs}-${f.wicket} (${f.batterName}, ${f.overs})`).join(' · ')));
    }
    box.append(h('table', { class: 'ltable' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Bowler'), h('th', {}, 'O'), h('th', {}, 'M'), h('th', {}, 'R'), h('th', {}, 'W'), h('th', {}, 'Eco'))),
      h('tbody', {}, inn.bowlers.map((b) => h('tr', {},
        h('td', { class: 'pl' }, b.name),
        h('td', {}, b.oversText), h('td', {}, b.maidens), h('td', {}, b.runs), h('td', {}, h('b', {}, b.wickets)),
        h('td', {}, b.balls ? b.econ.toFixed(2) : '-'))))));
  }
}

// ---------------------------------------------------------------------------
// COMMENTARY tab — end-of-over blocks + ball-by-ball, newest first
// ---------------------------------------------------------------------------

async function overSnapshots() {
  if (evCache.version === app.version && evCache.snaps) return evCache.snaps;
  try {
    const { events } = await app.fetchEvents();
    const marks = [];
    let innIdx = -1;
    let legal = 0;
    events.forEach((e, i) => {
      if (e.type === 'INNINGS_START') { innIdx += 1; legal = 0; }
      if (e.type === 'BALL' && (!e.legality || e.legality === 'legal')) {
        legal += 1;
        if (legal % 6 === 0) marks.push({ at: i, inning: innIdx, over: legal / 6 });
      }
    });
    const snaps = new Map(); // `${inning}:${over}` -> reduced state
    for (const mk of marks) snaps.set(`${mk.inning}:${mk.over}`, reduce(events.slice(0, mk.at + 1)));
    evCache.version = app.version;
    evCache.snaps = snaps;
  } catch { evCache.snaps = evCache.snaps || new Map(); }
  return evCache.snaps;
}

function overBlock(snap, over) {
  const inn = snap.innings[snap.innings.length - 1];
  const ob = inn.overByOver.find((o) => o.over === over);
  const batters = inn.batters.filter((b) => b.atCrease);
  const bowlIds = [inn.lastOverBowlerId, inn.currentBowlerId].filter(Boolean);
  const bowlers = inn.bowlers.filter((b) => bowlIds.includes(b.id));
  return h('div', { class: 'ov-block' },
    h('div', { class: 'ovb-top' }, h('span', {}, `END OF OVER ${over}`), h('span', {}, scoreText(inn))),
    ob ? h('div', { class: 'ovb-sub' }, `${ob.runs} Run${ob.runs === 1 ? '' : 's'} ${ob.wickets} Wkt${ob.wickets === 1 ? '' : 's'}${ob.maiden ? ' · Maiden' : ''}`) : null,
    h('div', { class: 'ovb-cols' },
      h('div', {}, batters.map((b) => h('div', { class: 'ovb-line' }, h('span', {}, `${b.name}${b.id === inn.striker ? '*' : ''}`), h('b', {}, `${b.runs} (${b.balls})`)))),
      h('div', {}, bowlers.map((b) => h('div', { class: 'ovb-line' }, h('span', {}, b.name), h('b', {}, fmt.figures(b)))))));
}

async function renderCommentaryTab() {
  const box = $('#tab-commentary');
  box.textContent = '';
  const items = (state.feed || []).filter((f) => f.ov || f.kind === 'result' || f.kind === 'innings' || f.kind === 'info');
  if (!items.length) { box.append(h('p', { class: 'cm-info' }, 'Ball-by-ball commentary will appear here.')); return; }
  const snaps = await overSnapshots();

  // group ball entries by (inning, over); non-ball entries ride along in order
  const groups = [];
  let cur = null;
  for (const it of items) {
    const ov = overNoOf(it);
    const key = ov === null ? (cur ? cur.key : 'pre') : `${it.inning}:${ov}`;
    if (!cur || cur.key !== key) { cur = { key, inning: it.inning, over: ov, items: [] }; groups.push(cur); }
    cur.items.push(it);
  }
  groups.reverse(); // newest over first
  const visible = showAllOvers ? groups : groups.slice(0, 8);

  for (const g of visible) {
    const snap = g.over !== null ? snaps.get(`${g.inning}:${g.over}`) : null;
    if (snap) box.append(overBlock(snap, g.over));
    for (const it of [...g.items].reverse()) {
      if (['ball', 'four', 'six', 'wicket', 'extra'].includes(it.kind)) {
        box.append(h('div', { class: `cm-row${['four', 'six', 'wicket'].includes(it.kind) ? ' hl' : ''}` },
          h('span', { class: 'ovno' }, it.ov), feedBubble(it), h('span', { class: 'cm-text' }, it.text)));
      } else {
        box.append(h('div', { class: 'cm-info' }, it.text));
      }
    }
  }
  if (!showAllOvers && groups.length > visible.length) {
    box.append(h('button', { class: 'cm-more', onclick: () => { showAllOvers = true; renderCommentaryTab(); } },
      `Show ${groups.length - visible.length} earlier over${groups.length - visible.length === 1 ? '' : 's'}`));
  }
}

// ---------------------------------------------------------------------------
// ANALYSIS (overs chart) + TEAMS tabs
// ---------------------------------------------------------------------------

function renderOversTab() {
  const box = $('#tab-overs');
  box.textContent = '';
  const wrap = h('div', { class: 'ovch' });
  let any = false;
  for (const inn of state.innings) {
    if (!inn.overByOver.length) continue;
    any = true;
    const team = teamOf(state, inn.battingTeamId);
    wrap.append(h('h4', {}, `${team.name} — runs per over`));
    const W = 640;
    const H = 150;
    const n = Math.max(inn.oversLimit, inn.overByOver.length);
    const bw = Math.min(28, (W - 20) / n - 6);
    const max = Math.max(12, ...inn.overByOver.map((o) => o.runs));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('style', 'width:100%;height:auto');
    inn.overByOver.forEach((o, i) => {
      const x = 10 + i * ((W - 20) / n);
      const bh = Math.max(3, (o.runs / max) * (H - 36));
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', x); r.setAttribute('y', H - 22 - bh);
      r.setAttribute('width', bw); r.setAttribute('height', bh);
      r.setAttribute('rx', 3); r.setAttribute('fill', o.maiden ? '#c9d1da' : team.color);
      svg.append(r);
      if (o.wickets) {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', x + bw / 2); c.setAttribute('cy', H - 30 - bh);
        c.setAttribute('r', 4); c.setAttribute('fill', '#d0342c');
        svg.append(c);
      }
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', x + bw / 2); t.setAttribute('y', H - 8);
      t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', '9'); t.setAttribute('fill', '#8a93a3');
      t.textContent = o.over;
      svg.append(t);
    });
    wrap.append(svg);
  }
  if (!any) wrap.append(h('p', { class: 'cm-info' }, 'The runs-per-over chart appears after the first over.'));
  box.append(wrap);
}

function renderTeamsTab() {
  const box = $('#tab-teams');
  box.textContent = '';
  const grid = h('div', { class: 'teams-grid' });
  for (const t of state.config.teams) {
    grid.append(h('div', { class: 'tcol' },
      h('h3', {}, h('span', { class: 'tchip', style: { background: t.color, width: '10px', height: '10px', borderRadius: '3px', display: 'inline-block' } }), `${t.name} (${t.short})`),
      h('ul', {}, state.squads[t.id].map((p) => h('li', {}, p.name)))));
  }
  box.append(grid);
}

// ---------------------------------------------------------------------------
// sidebar
// ---------------------------------------------------------------------------

function renderSidebar() {
  // video
  const v = $('#videoCard');
  v.textContent = '';
  const embed = pres ? youTubeEmbed(pres.videoUrl) : null;
  const wrapEl = h('div', { class: 'video-wrap' });
  if (embed) {
    wrapEl.append(h('iframe', {
      src: embed, allow: 'autoplay; encrypted-media; picture-in-picture', allowfullscreen: true,
      title: 'Live stream',
    }));
  } else {
    wrapEl.append(h('div', { class: 'video-empty' },
      h('span', { style: { fontSize: '26px' } }, '▶'),
      'No live video linked yet.',
      h('span', { class: 'small' }, 'The director can add the YouTube link from the director panel.')));
  }
  v.append(h('h3', {}, 'Live stream'), wrapEl,
    h('div', { class: 'video-meta' },
      h('span', {}, 'LIVE VIEWERS: ', h('b', {}, String(viewers))),
      embed ? h('a', { href: pres.videoUrl, target: '_blank', rel: 'noopener' }, 'Watch on YouTube') : ''));

  // run rate / projection
  const rr = $('#rrCard');
  rr.textContent = '';
  const inn = focus();
  if (inn && !inn.closed && !state.chase) {
    const projected = inn.legalBalls ? Math.round((inn.crr * inn.oversLimit)) : 0;
    rr.append(h('div', { class: 'rr-grid' },
      h('div', {}, h('div', { class: 'k' }, 'Current RR'), h('div', { class: 'v' }, fmt.num1(inn.crr) === '—' ? '0.0' : inn.crr.toFixed(2))),
      h('div', {}, h('div', { class: 'k' }, 'Projected Score'), h('div', { class: 'v' }, String(projected), ' ', h('small', {}, `(at ${inn.crr.toFixed(2)} RPO)`)))));
  } else if (state.chase) {
    rr.append(h('div', { class: 'rr-grid' },
      h('div', {}, h('div', { class: 'k' }, 'Current RR'), h('div', { class: 'v' }, inn.crr.toFixed(2))),
      h('div', {}, h('div', { class: 'k' }, `Need ${state.chase.need} off ${state.chase.ballsLeft}`), h('div', { class: 'v' }, fmt.num1(state.chase.rrr), ' ', h('small', {}, 'req. RR')))));
  } else if (state.result) {
    rr.append(h('div', {}, h('div', { class: 'k' }, 'Result'), h('div', { style: { fontWeight: '800', marginTop: '4px' } }, state.result.text)));
  } else {
    rr.append(h('div', { class: 'k' }, 'Run rates appear once the match starts.'));
  }

  // details
  const d = $('#detailsCard');
  d.textContent = '';
  d.append(h('h3', {}, 'Match details'), h('div', { class: 'dl' },
    h('div', {}, h('div', { class: 'k' }, 'Match Date'), dateText(meta.createdAt) || '—'),
    state.config.venue ? h('div', {}, h('div', { class: 'k' }, 'Location'), state.config.venue) : '',
    h('div', {}, h('div', { class: 'k' }, 'Format'), `Limited Overs — ${state.config.oversPerInnings} overs, max ${state.config.maxOversPerBowler}/bowler`),
    h('div', {}, h('div', { class: 'k' }, 'Match id'), matchId || app.matchId || ''),
    h('div', {}, h('div', { class: 'k' }, 'Last Updated'), lastUpdated ? timeText(lastUpdated) : '—')));
}

// ---------------------------------------------------------------------------
// tabs + boot
// ---------------------------------------------------------------------------

function showTab(name) {
  activeTab = name;
  for (const btn of $$('#tabs button')) btn.classList.toggle('on', btn.dataset.tab === name);
  for (const p of $$('.tabpanel')) p.hidden = p.id !== `tab-${name}`;
  renderActiveTab();
}

function renderActiveTab() {
  if (!state || !state.config) return;
  if (activeTab === 'live') renderLiveTab();
  else if (activeTab === 'scorecard') renderScorecardTab();
  else if (activeTab === 'commentary') renderCommentaryTab();
  else if (activeTab === 'overs') renderOversTab();
  else if (activeTab === 'teams') renderTeamsTab();
}

function renderAll() {
  if (!state || !state.config) return;
  renderMatchCard();
  renderActiveTab();
  renderSidebar();
}

$$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

$('#shareBtn').addEventListener('click', async () => {
  const data = { title: document.title, url: location.href };
  if (navigator.share) { try { await navigator.share(data); } catch { /* dismissed */ } }
  else { await copyText(location.href); toast('Link copied'); }
});
$('#qrBtn').addEventListener('click', () => {
  $('#qrImg').src = `/qr.svg?text=${encodeURIComponent(location.href)}`;
  $('#qrModal').hidden = false;
});
$('#qrClose').addEventListener('click', () => { $('#qrModal').hidden = true; });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

(async () => {
  try {
    const snap = await (await fetch(`/api/matches/${matchId}`)).json();
    meta.createdAt = snap.createdAt || null;
  } catch { /* fine — dates stay blank */ }

  app = await connect({
    matchId,
    role: 'view',
    onState(st) {
      state = st;
      lastUpdated = Date.now();
      renderAll();
    },
    onPresentation(p) { pres = p; renderSidebar(); renderMatchCard(); },
    onBranding(b) {
      if (!b) return;
      if (b.accent) document.documentElement.style.setProperty('--accent', b.accent);
      if (b.orgName) $('#bbName').textContent = b.orgName;
      if (b.logo) { $('#bbLogo').src = b.logo; $('#bbLogo').hidden = false; }
    },
    onViewers(n) { viewers = n; renderSidebar(); },
    onStatus(s) {
      $('#offline').hidden = s !== 'offline';
      if (s === 'no-match') {
        $('#matchLabel').textContent = 'Match not found';
        $('#tab-live').textContent = '';
        $('#tab-live').append(h('p', { class: 'cm-info' }, 'No match with this id on this server. ', h('a', { href: '/matches' }, 'All matches')));
      }
    },
  });
})();
