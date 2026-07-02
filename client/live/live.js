/* Public live scorecard — /live/:matchId. View role, real-time via shared runtime. */

import { connect, fmt, $, $$, h, teamOf } from '/client/shared/app.js';

const matchId = decodeURIComponent(location.pathname.split('/')[2] || '') || null;

const SVG = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

// "20.0" → "20" for compact score lines
const ovShort = (t) => String(t || '0.0').replace(/\.0$/, '');
const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][n % 10 > 3 || (n % 100 >= 11 && n % 100 <= 13) ? 0 : n % 10]}`;

function toast(msg) {
  const el = h('div', { class: 'toast' }, msg);
  $('#toasts').append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2200);
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
  document.body.append(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* best effort */ }
  ta.remove();
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function setTab(name, push) {
  for (const b of $$('.tab')) b.classList.toggle('active', b.dataset.tab === name);
  for (const sec of $$('main section')) sec.hidden = sec.dataset.sec !== name;
  if (push) {
    history.replaceState(null, '', `#${name}`);
    window.scrollTo(0, 0);
  }
}
for (const b of $$('.tab')) b.addEventListener('click', () => setTab(b.dataset.tab, true));
setTab(['scorecard', 'commentary', 'overs', 'info'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'scorecard');

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader(st) {
  const [A, B] = st.config.teams;
  $('#matchTitle').textContent = st.config.name || `${A.name} vs ${B.name}`;

  const pill = $('#statusPill');
  pill.className = 'pill';
  if (st.phase === 'live') { pill.classList.add('live'); pill.textContent = 'LIVE'; }
  else if (st.phase === 'break') pill.textContent = 'INNINGS BREAK';
  else if (st.phase === 'complete') { pill.classList.add('final'); pill.textContent = 'FINAL'; }
  else pill.textContent = 'STARTING SOON';

  const teamsEl = $('#teams');
  teamsEl.textContent = '';
  for (const t of st.config.teams) {
    const reg = st.innings.find((i) => !i.superOver && i.battingTeamId === t.id);
    const so = st.innings.find((i) => i.superOver && i.battingTeamId === t.id);
    const score = reg
      ? h('span', { class: 'tscore' }, `${reg.runs}/${reg.wickets}`,
          h('small', {}, ` (${ovShort(reg.oversText)})`),
          so && h('span', { class: 'so' }, `SO ${so.runs}/${so.wickets}`))
      : h('span', { class: 'tscore' }, h('small', {}, 'yet to bat'));
    const live = st.phase === 'live' && st.battingTeamId === t.id;
    teamsEl.append(h('div', { class: `team-line${live ? ' batting' : ''}${reg && !live ? ' quiet' : ''}` },
      h('span', { class: 'tchip', style: { background: t.color } }),
      h('span', { class: 'tshort' }, t.short),
      h('span', { class: 'tname' }, t.name),
      score));
  }

  const chase = $('#chase');
  chase.classList.remove('result');
  if (st.result) {
    chase.hidden = false;
    chase.classList.add('result');
    chase.textContent = st.result.text;
  } else if (st.chase) {
    const rrr = typeof st.chase.rrr === 'number' ? ` · RRR ${st.chase.rrr.toFixed(2)}` : '';
    chase.hidden = false;
    chase.textContent = `Need ${st.chase.need} off ${st.chase.ballsLeft}${rrr}`;
  } else if (st.target && st.phase !== 'complete') {
    chase.hidden = false;
    chase.textContent = `Target ${st.target.runs}${st.target.revised ? ' (revised)' : ''}`;
  } else {
    chase.hidden = true;
  }

  const bits = st.config.teams.map((t) => {
    const reg = st.innings.find((i) => !i.superOver && i.battingTeamId === t.id);
    return reg ? `${t.short} ${reg.runs}/${reg.wickets}` : t.short;
  });
  document.title = `${bits.join(' v ')} — ICAT Cricket Live`;
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

const openState = {}; // innings index → user's open/closed choice

function extrasText(x) {
  const parts = [];
  if (x.byes) parts.push(`b ${x.byes}`);
  if (x.legbyes) parts.push(`lb ${x.legbyes}`);
  if (x.wides) parts.push(`w ${x.wides}`);
  if (x.noballs) parts.push(`nb ${x.noballs}`);
  if (x.penalties) parts.push(`pen ${x.penalties}`);
  return `${x.total}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

function battingTable(st, inn) {
  const rows = inn.batters.map((b) => h('tr', { class: b.atCrease ? 'crease' : '' },
    h('td', {},
      h('span', { class: 'bname' }, b.name, b.id === inn.striker ? h('span', { class: 'star' }, ' *') : null),
      h('span', { class: 'howout' }, b.howOut || (b.atCrease ? 'not out' : ''))),
    h('td', { class: 'r-runs' }, b.runs),
    h('td', {}, b.balls),
    h('td', {}, b.fours),
    h('td', {}, b.sixes),
    h('td', {}, fmt.num1(b.sr))));
  return h('table', { class: 'sc' },
    h('colgroup', {}, h('col', { class: 'c-name' }), h('col'), h('col'), h('col'), h('col'), h('col')),
    h('thead', {}, h('tr', {}, h('th', {}, 'Batter'), h('th', {}, 'R'), h('th', {}, 'B'), h('th', {}, '4s'), h('th', {}, '6s'), h('th', {}, 'SR'))),
    h('tbody', {}, rows));
}

function bowlingTable(inn) {
  const rows = inn.bowlers.map((b) => h('tr', { class: b.id === inn.currentBowlerId && !inn.closed ? 'crease' : '' },
    h('td', {}, h('span', { class: 'bname' }, b.name)),
    h('td', {}, b.oversText),
    h('td', {}, b.maidens),
    h('td', {}, b.runs),
    h('td', { class: 'r-runs' }, b.wickets),
    h('td', {}, fmt.num1(b.econ))));
  return h('table', { class: 'sc' },
    h('colgroup', {}, h('col', { class: 'c-name' }), h('col'), h('col'), h('col'), h('col'), h('col')),
    h('thead', {}, h('tr', {}, h('th', {}, 'Bowler'), h('th', {}, 'O'), h('th', {}, 'M'), h('th', {}, 'R'), h('th', {}, 'W'), h('th', {}, 'Econ'))),
    h('tbody', {}, rows));
}

function renderScorecard(st) {
  const sec = $('#sec-scorecard');
  sec.textContent = '';
  if (!st.innings.length) {
    sec.append(h('p', { class: 'empty' }, 'The match has not started yet.'));
    return;
  }
  const list = [...st.innings].reverse(); // latest innings first
  for (const inn of list) {
    const team = teamOf(st, inn.battingTeamId);
    const batted = new Set(inn.batters.map((b) => b.id));
    const dnb = (st.squads[inn.battingTeamId] || []).filter((p) => !batted.has(p.id));
    const open = openState[inn.index] !== undefined ? openState[inn.index] : inn.index === st.innings.length - 1;

    const det = h('details', { class: 'inn card', open },
      h('summary', {},
        h('span', { class: 'tchip', style: { background: team.color } }),
        h('span', { class: 'iname' }, team.name,
          h('span', { class: 'sub' }, inn.superOver ? 'Super over' : `${ordinal(inn.index + 1)} innings`)),
        h('span', { class: 'iscore' }, `${inn.runs}/${inn.wickets} `, h('small', {}, `(${inn.oversText})`)),
        h('span', { class: 'caret' }, '▾')),
      h('div', { class: 'inn-body' },
        battingTable(st, inn),
        h('div', { class: 'sc-line' }, h('span', { class: 'lbl' }, 'Extras'), h('span', { class: 'val' }, extrasText(inn.extras))),
        h('div', { class: 'sc-line total' }, h('span', { class: 'lbl' }, 'Total'),
          h('span', { class: 'val' }, `${inn.runs}/${inn.wickets} (${inn.oversText} ov${inn.crr !== null && inn.crr !== undefined ? `, CRR ${fmt.num1(inn.crr)}` : ''})`)),
        dnb.length ? h('div', { class: 'sc-line dnb' },
          h('span', { class: 'lbl' }, inn.closed ? 'Did not bat' : 'Yet to bat'),
          h('span', { class: 'val' }, dnb.map((p) => p.name).join(', '))) : null,
        inn.fow.length ? h('div', { class: 'sc-line fow' },
          h('span', { class: 'lbl' }, 'FOW'),
          h('span', { class: 'val' }, inn.fow.map((f) => `${f.wicket}-${f.runs} ${f.batterName} (${f.overs})`).join('  ·  '))) : null,
        h('div', { class: 'sc-sub' }, 'Bowling'),
        bowlingTable(inn)));
    det.addEventListener('toggle', () => { openState[inn.index] = det.open; });
    sec.append(det);
  }
}

// ---------------------------------------------------------------------------
// Commentary (newest first, incremental prepend)
// ---------------------------------------------------------------------------

let feedCount = 0;      // rendered entries (the feed array is append-only across pure appends)
let feedVersion = null; // state version those entries came from
let feedOverKey = null;

function overNoOf(it) {
  if (!it.ov) return null;
  const [o, b] = String(it.ov).split('.').map(Number);
  return b === 0 ? o : o + 1; // "7.1" is the 8th over
}

function feedItem(it) {
  return h('div', { class: `fi kind-${it.kind}` },
    h('div', { class: 'fi-ov' }, it.ov || ''),
    h('div', { class: 'fi-text' }, it.text));
}

function renderFeed(st, version) {
  const box = $('#feed');
  const items = st.feed || [];
  // Pure append → render just the new tail. Anything else (first paint,
  // undo, edit-in-place, reconnect) → full rebuild. Entries can carry
  // seq:null (innings/result lines), so the cursor is an index, not a seq.
  const incremental = feedVersion !== null && version > feedVersion && items.length >= feedCount;
  if (!incremental) { box.textContent = ''; feedCount = 0; feedOverKey = null; }
  feedVersion = version;

  if (!items.length) {
    box.append(h('p', { class: 'empty' }, 'Ball-by-ball commentary will appear here.'));
    return;
  }
  if (feedCount === 0) box.textContent = ''; // drop any placeholder

  for (let i = feedCount; i < items.length; i++) {
    const it = items[i];
    const overNo = overNoOf(it);
    if (overNo !== null && ['ball', 'four', 'six', 'wicket', 'extra'].includes(it.kind)) {
      const key = `${it.inning}:${overNo}`;
      if (key !== feedOverKey) {
        if (feedOverKey !== null) box.insertBefore(h('div', { class: 'over-mark' }, `Over ${overNo}`), box.firstChild);
        feedOverKey = key;
      }
    }
    box.insertBefore(feedItem(it), box.firstChild);
  }
  feedCount = items.length;
}

// ---------------------------------------------------------------------------
// Overs chart (inline SVG, one per innings)
// ---------------------------------------------------------------------------

function oversChart(st, inn) {
  const data = inn.overByOver || [];
  const n = Math.max(data.length, Math.min(inn.oversLimit || data.length, 50), 1);
  const slot = 30, barW = 20;
  const padL = 30, padR = 6, padT = 30, padB = 20, plotH = 130;
  const W = padL + n * slot + padR;
  const H = padT + plotH + padB;
  const maxRuns = Math.max(6, ...data.map((o) => o.runs));
  const ymax = Math.ceil(maxRuns / 6) * 6;
  const yStep = ymax > 24 ? 12 : 6;
  const y = (v) => padT + plotH - (v / ymax) * plotH;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Runs per over' });

  for (let v = 0; v <= ymax; v += yStep) { // recessive hairline grid
    svg.append(s('line', { x1: padL, y1: y(v), x2: W - padR, y2: y(v), stroke: 'rgba(255,255,255,0.08)', 'stroke-width': 1 }));
    svg.append(s('text', { x: padL - 6, y: y(v) + 3, 'text-anchor': 'end', fill: '#9aa7b5', 'font-size': 10 }, v));
  }

  const maxOver = data.reduce((m, o) => (o.runs > (m ? m.runs : -1) ? o : m), null);
  data.forEach((o, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    const hgt = Math.max((o.runs / ymax) * plotH, 2);
    const top = padT + plotH - hgt;
    const r = Math.min(4, hgt);
    const g = s('g', {});
    g.append(s('title', {}, `Over ${o.over}: ${o.runs} run${o.runs === 1 ? '' : 's'}${o.wickets ? `, ${o.wickets} wkt` : ''}${o.maiden ? ' (maiden)' : ''}`));
    // rounded data-end, square baseline
    g.append(s('path', {
      d: `M${x},${padT + plotH} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + barW - r},${top} Q${x + barW},${top} ${x + barW},${top + r} L${x + barW},${padT + plotH} Z`,
      fill: teamOf(st, inn.battingTeamId).color,
    }));
    for (let k = 0; k < o.wickets; k++) {
      g.append(s('circle', { cx: x + barW / 2, cy: top - 9 - k * 11, r: 4, fill: '#ff5a52', stroke: '#161d27', 'stroke-width': 2 }));
    }
    if (o === maxOver && !o.wickets) { // selective label: the biggest over
      g.append(s('text', { x: x + barW / 2, y: top - 6, 'text-anchor': 'middle', fill: '#9aa7b5', 'font-size': 10, 'font-weight': 700 }, o.runs));
    }
    g.append(s('rect', { x: padL + i * slot, y: padT, width: slot, height: plotH, fill: 'transparent' })); // hover/tap target
    svg.append(g);
  });

  for (let ov = 5; ov <= n; ov += 5) {
    svg.append(s('text', { x: padL + (ov - 1) * slot + slot / 2, y: padT + plotH + 14, 'text-anchor': 'middle', fill: '#9aa7b5', 'font-size': 10 }, ov));
  }
  svg.append(s('line', { x1: padL, y1: padT + plotH, x2: W - padR, y2: padT + plotH, stroke: 'rgba(255,255,255,0.25)', 'stroke-width': 1 }));
  return svg;
}

function renderOvers(st) {
  const sec = $('#sec-overs');
  sec.textContent = '';
  const played = st.innings.filter((i) => (i.overByOver || []).length);
  if (!played.length) {
    sec.append(h('p', { class: 'empty' }, 'The over-by-over chart appears once play begins.'));
    return;
  }
  for (const inn of played) {
    const team = teamOf(st, inn.battingTeamId);
    sec.append(h('div', { class: 'ochart card' },
      h('h3', {},
        h('span', { class: 'tchip', style: { background: team.color } }),
        `${team.name}${inn.superOver ? ' — Super over' : ''}`,
        h('span', { class: 'osc num' }, `${inn.runs}/${inn.wickets}`)),
      oversChart(st, inn)));
  }
}

// ---------------------------------------------------------------------------
// Info
// ---------------------------------------------------------------------------

function renderInfo(st) {
  const sec = $('#sec-info');
  const c = st.config;
  const rules = [];
  if (c.rules.freeHit) rules.push('Free hit');
  if (c.rules.lastManStands) rules.push('Last man stands');
  if (c.rules.noLbw) rules.push('No LBW');
  if (c.rules.jokerAllowed) rules.push('Joker');
  if (c.superOver) rules.push('Super over on tie');
  rules.push(`Wide = ${c.rules.wideRuns}`, `No-ball = ${c.rules.noBallRuns}`);

  const toss = c.toss
    ? `${teamOf(st, c.toss.winner).name} won the toss and chose to ${c.toss.decision === 'bat' ? 'bat' : 'bowl'}`
    : 'No toss recorded';

  const row = (lbl, val, cls) => h('div', { class: 'info-row' },
    h('span', { class: 'lbl' }, lbl), h('span', { class: `val${cls ? ` ${cls}` : ''}` }, val));

  sec.textContent = '';
  sec.append(h('div', { class: 'info-list card' },
    c.name ? row('Match', c.name) : null,
    row('Venue', c.venue || '—'),
    row('Format', `${c.oversPerInnings} overs a side · max ${c.maxOversPerBowler} overs per bowler`),
    row('Toss', toss),
    row('Rules', h('span', { class: 'rule-chips' }, rules.map((r) => h('span', { class: 'pill' }, r)))),
    row('Match ID', st ? matchId || '—' : '—', 'mono')));
}

// ---------------------------------------------------------------------------
// Share + QR
// ---------------------------------------------------------------------------

$('#shareBtn').addEventListener('click', async () => {
  const data = { title: document.title, url: location.href };
  if (navigator.share) {
    try { await navigator.share(data); return; } catch { /* cancelled */ }
  } else {
    await copyText(location.href);
    toast('Link copied');
  }
});

$('#qrBtn').addEventListener('click', () => {
  const url = location.href;
  const back = h('div', { class: 'sheet-backdrop' },
    h('div', { class: 'sheet qr-box' },
      h('h3', {}, 'Scan to follow live'),
      h('img', { src: `/qr.svg?text=${encodeURIComponent(url)}`, alt: 'QR code for this page' }),
      h('div', { class: 'url' }, url),
      h('div', { class: 'row', style: { justifyContent: 'center' } },
        h('button', { class: 'btn', onclick: async () => { await copyText(url); toast('Link copied'); } }, 'Copy link'),
        h('button', { class: 'btn primary', onclick: () => back.remove() }, 'Close'))));
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  $('#modal').append(back);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

connect({
  matchId,
  role: 'view',
  onState(st, version) {
    renderHeader(st);
    renderScorecard(st);
    renderFeed(st, version);
    renderOvers(st);
    renderInfo(st);
  },
  onBranding(b) {
    if (b && b.accent) document.documentElement.style.setProperty('--accent', b.accent);
  },
  onStatus(sst) {
    $('#offline').hidden = sst !== 'offline';
    if (sst === 'no-match') {
      $('#matchTitle').textContent = 'Match not found';
      $('#sec-scorecard').textContent = '';
      $('#sec-scorecard').append(h('p', { class: 'empty' }, 'No match with this id on this server. ', h('a', { href: '/matches' }, 'All matches')));
    }
  },
});
