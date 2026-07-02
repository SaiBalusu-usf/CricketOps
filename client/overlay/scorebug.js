/**
 * Broadcast scorebug — persistent lower third for OBS.
 * scorebug.html boots it directly; full.js calls bootScorebug({ onFx }) to add
 * stingers on top. Styles are injected here so both pages share one source.
 */
import { connect, fitStage, fmt, h, focusInnings, teamOf, applyBranding } from '/client/shared/app.js';

const CSS = `
.sb-root { position: absolute; left: var(--safe); right: var(--safe); bottom: var(--safe); z-index: 10; }

/* row above the bar: free-hit flag + ticker (space always reserved — no jank) */
.sb-top { display: flex; align-items: flex-end; gap: 12px; height: 48px; margin-bottom: 10px; position: relative; z-index: 1; }
.sb-flag, .sb-ticker {
  opacity: 0; transform: translateY(18px);
  transition: opacity 0.24s var(--ease), transform 0.24s var(--ease);
}
.sb-flag.on, .sb-ticker.on { opacity: 1; transform: translateY(0); }
.sb-flag {
  position: absolute; left: 0; bottom: 0;
  background: var(--accent); color: #171204; border-radius: 7px; padding: 9px 24px;
  font-size: 21px; font-weight: 900; letter-spacing: 0.16em; white-space: nowrap;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.35);
}
/* keep the ticker clear of the flag only while the flag is up */
.sb-flag.on + .sb-ticker { margin-left: 184px; }
.sb-ticker {
  flex: 1; min-width: 0; display: flex; align-items: center;
  background: linear-gradient(180deg, var(--panel-hi), var(--panel-lo));
  border: 1px solid var(--panel-line); border-radius: 7px; padding: 9px 18px; font-size: 20px;
}
.sb-ticker::before {
  content: ''; width: 8px; height: 8px; border-radius: 50%;
  background: var(--accent); margin-right: 14px; flex: none;
}
.sb-ticker-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* the bar */
.sb-bar { position: relative; z-index: 2; display: flex; align-items: stretch; height: 106px; overflow: hidden; }
.sb-seg {
  display: none; flex: none; flex-direction: column; justify-content: center;
  padding: 0 18px; min-width: 0; border-left: 1px solid var(--panel-line);
}
.sb-bar.m-live .sb-seg.live,
.sb-bar.m-setup .sb-seg.setup,
.sb-bar.m-break .sb-seg.break,
.sb-bar.m-complete .sb-seg.complete,
.sb-bar .sb-seg.always { display: flex; }
/* hard kill switch — must beat the mode rules above */
.sb-bar .sb-seg.off { display: none !important; }

.sb-lab {
  font-size: 13px; font-weight: 800; color: var(--ink-dim);
  text-transform: uppercase; letter-spacing: 0.14em; margin-bottom: 6px; white-space: nowrap;
}

/* brand block */
.sb-brand { flex-direction: row; align-items: center; background: var(--accent); color: #171204; border-left: none; padding: 0 24px; }
.sb-brand-name { font-size: 34px; font-weight: 900; letter-spacing: 0.05em; white-space: nowrap; }
.sb-brand-logo { display: none; max-height: 74px; max-width: 140px; }
.sb-brand.has-logo .sb-brand-logo { display: block; }
.sb-brand.has-logo .sb-brand-name { display: none; }

/* team + score */
.sb-scorewrap { flex-direction: row; align-items: center; }
.sb-chip { width: 8px; border-radius: 4px; align-self: center; height: 68px; }
.sb-scorecol { margin-left: 18px; }
.sb-scoreline { display: flex; align-items: baseline; gap: 14px; white-space: nowrap; }
.sb-team { font-size: 29px; font-weight: 800; letter-spacing: 0.04em; }
.sb-score { font-size: 47px; font-weight: 900; line-height: 1; display: inline-block; transform-origin: left center; }
.sb-overs { font-size: 18px; font-weight: 600; color: var(--ink-dim); letter-spacing: 0.08em; margin-top: 5px; }

/* batters — grows into slack, shrinks last when the bar is tight */
.sb-bats { flex: 1 1 340px; min-width: 190px; max-width: 440px; overflow: hidden; }
.sb-bat { display: flex; align-items: center; gap: 10px; font-size: 24px; line-height: 1.35; white-space: nowrap; }
.sb-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); flex: none; }
.sb-bat.ns { color: var(--ink-dim); }
.sb-bat.ns .sb-dot { visibility: hidden; }
.sb-bat.off { display: none; }
.sb-bat-name { overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; }
.sb-bat.st .sb-bat-name { font-weight: 700; }
.sb-bat-fig { font-weight: 700; margin-left: auto; padding-left: 14px; display: inline-block; transform-origin: right center; }

/* bowler + this-over shrink (with clipping) before anything else breaks */
.sb-bowl { flex: 0 3 auto; min-width: 225px; overflow: hidden; }
.sb-over { flex: 0 3 auto; min-width: 170px; overflow: hidden; }
.sb-bowl-line { display: flex; align-items: baseline; gap: 12px; white-space: nowrap; }
.sb-bowl-name { font-size: 24px; font-weight: 700; max-width: 170px; overflow: hidden; text-overflow: ellipsis; }
.sb-bowl-fig { font-size: 25px; font-weight: 800; display: inline-block; transform-origin: left center; }

/* this-over token pills */
.sb-pills { display: flex; gap: 6px; align-items: center; min-height: 30px; }
.sb-pill {
  min-width: 30px; height: 30px; padding: 0 7px; border-radius: 7px;
  background: rgba(255, 255, 255, 0.13);
  display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 800;
}
.sb-pill.w { background: #e01e37; color: #fff; }
.sb-pill.bd { background: var(--accent); color: #171204; }
.sb-pill.ex { background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.28); color: var(--ink-dim); font-size: 15px; }
.sb-ell { font-size: 19px; color: var(--ink-dim); }

/* run rates + chase */
.sb-crr-val { font-size: 33px; font-weight: 800; display: inline-block; transform-origin: left center; }
.sb-chase { background: rgba(255, 255, 255, 0.05); margin-left: auto; }
.sb-chase-main { font-size: 25px; font-weight: 800; color: var(--accent); white-space: nowrap; display: inline-block; transform-origin: left center; }

/* sponsors */
.sb-sponsors { flex-direction: row; align-items: center; gap: 10px; margin-left: auto; padding: 0 16px; }
.sb-sponsor { background: rgba(255, 255, 255, 0.92); border-radius: 8px; padding: 5px 10px; display: flex; align-items: center; }
.sb-sponsor img { max-height: 40px; max-width: 84px; display: block; }

/* setup / break / complete */
.sb-status { font-size: 25px; color: var(--ink-dim); }
.sb-breakwrap { flex-direction: row; align-items: center; }
.sb-break-score { font-size: 30px; font-weight: 800; white-space: nowrap; }
.sb-break-need { font-size: 27px; font-weight: 800; color: var(--accent); text-transform: uppercase; letter-spacing: 0.03em; white-space: nowrap; }
.sb-result-text { font-size: 30px; font-weight: 800; color: #ffd75e; white-space: nowrap; }

@keyframes sb-pop { 0% { transform: scale(1); } 40% { transform: scale(1.06); } 100% { transform: scale(1); } }
.sb-pop { animation: sb-pop 0.28s var(--ease); }
`;

function injectCss() {
  if (document.getElementById('sb-css')) return;
  const st = document.createElement('style');
  st.id = 'sb-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}

function pillClass(t) {
  if (t.indexOf('W') !== -1) return 'sb-pill w';
  if (t === '4' || t === '6') return 'sb-pill bd';
  if (/^(wd|nb|b\d|lb)/.test(t)) return 'sb-pill ex';
  return 'sb-pill';
}

export function mountScorebug(stage) {
  injectCss();
  const r = {}; // live element refs
  let ready = false; // suppress pop animation on the very first render
  let tokKey = null;
  let spKey = null;

  const setNum = (el, text) => {
    if (el.textContent === text) return;
    el.textContent = text;
    if (!ready) return;
    el.classList.remove('sb-pop');
    void el.offsetWidth;
    el.classList.add('sb-pop');
  };

  // --- skeleton -------------------------------------------------------------
  r.flag = h('div', { class: 'sb-flag' }, 'FREE HIT');
  r.tickerText = h('span', { class: 'sb-ticker-text' });
  r.ticker = h('div', { class: 'sb-ticker' }, r.tickerText);

  r.brandLogo = h('img', { class: 'sb-brand-logo', alt: '' });
  r.brandName = h('span', { class: 'sb-brand-name' }, 'ICAT');
  r.brand = h('div', { class: 'sb-seg always sb-brand' }, r.brandLogo, r.brandName);

  r.chip = h('span', { class: 'chip sb-chip' });
  r.team = h('span', { class: 'sb-team up' });
  r.score = h('span', { class: 'sb-score num' });
  r.overs = h('div', { class: 'sb-overs num' });
  const scoreSeg = h('div', { class: 'sb-seg live sb-scorewrap' }, r.chip,
    h('div', { class: 'sb-scorecol' },
      h('div', { class: 'sb-scoreline' }, r.team, r.score),
      r.overs));

  const batRow = (cls) => {
    const name = h('span', { class: 'sb-bat-name' });
    const fig = h('span', { class: 'sb-bat-fig num' });
    const row = h('div', { class: `sb-bat ${cls}` }, h('span', { class: 'sb-dot' }), name, fig);
    return { row, name, fig };
  };
  const st = batRow('st');
  const ns = batRow('ns');
  r.stName = st.name; r.stFig = st.fig;
  r.nsRow = ns.row; r.nsName = ns.name; r.nsFig = ns.fig;
  const batsSeg = h('div', { class: 'sb-seg live sb-bats' }, st.row, ns.row);

  r.bowlName = h('span', { class: 'sb-bowl-name' });
  r.bowlFig = h('span', { class: 'sb-bowl-fig num' });
  const bowlSeg = h('div', { class: 'sb-seg live sb-bowl' },
    h('div', { class: 'sb-lab' }, 'Bowling'),
    h('div', { class: 'sb-bowl-line' }, r.bowlName, r.bowlFig));

  r.overLab = h('div', { class: 'sb-lab' }, 'This over');
  r.pills = h('div', { class: 'sb-pills num' });
  const overSeg = h('div', { class: 'sb-seg live sb-over' }, r.overLab, r.pills);

  r.crr = h('div', { class: 'sb-crr-val num' });
  r.crrSeg = h('div', { class: 'sb-seg live' }, h('div', { class: 'sb-lab' }, 'CRR'), r.crr);

  r.chaseLab = h('div', { class: 'sb-lab' });
  r.chaseMain = h('div', { class: 'sb-chase-main num' });
  r.chase = h('div', { class: 'sb-seg live sb-chase off' }, r.chaseLab, r.chaseMain);

  r.sponsors = h('div', { class: 'sb-seg always sb-sponsors off' });

  const setupSeg = h('div', { class: 'sb-seg setup sb-status' }, 'Waiting for the match…');

  r.bkChip = h('span', { class: 'chip sb-chip' });
  r.bkScore = h('div', { class: 'sb-break-score num' });
  const bkSeg = h('div', { class: 'sb-seg break sb-breakwrap' }, r.bkChip,
    h('div', { class: 'sb-scorecol' }, h('div', { class: 'sb-lab' }, 'Innings break'), r.bkScore));
  r.bkNeed = h('div', { class: 'sb-break-need num' });
  r.bkNeedSeg = h('div', { class: 'sb-seg break' }, r.bkNeed);

  r.resSummary = h('div', { class: 'sb-lab num' });
  r.resText = h('div', { class: 'sb-result-text' });
  const resSeg = h('div', { class: 'sb-seg complete' }, r.resSummary, r.resText);

  const bar = h('div', { class: 'sb-bar panel m-setup' },
    r.brand, scoreSeg, batsSeg, bowlSeg, overSeg, r.crrSeg, r.chase,
    setupSeg, bkSeg, r.bkNeedSeg, resSeg, r.sponsors);

  const root = h('div', { class: 'sb-root fade' },
    h('div', { class: 'sb-top' }, r.flag, r.ticker), bar);
  stage.appendChild(root);

  // --- renderers ------------------------------------------------------------
  function renderLive(state, inn) {
    const team = teamOf(state, inn.battingTeamId) || {};
    r.chip.style.setProperty('--team', team.color || '#8a93a3');
    r.team.textContent = team.short || '';
    setNum(r.score, `${inn.runs}/${inn.wickets}`);
    r.overs.textContent = `${inn.oversText} OV`;

    const bat = (id) => (id ? inn.batters.find((b) => b.id === id) : null);
    const s = bat(inn.striker);
    const n = bat(inn.nonStriker);
    r.stName.textContent = s ? s.name : '—';
    setNum(r.stFig, s ? fmt.batLine(s) : '');
    r.nsRow.classList.toggle('off', !!inn.solo && !n);
    r.nsName.textContent = n ? n.name : '—';
    setNum(r.nsFig, n ? fmt.batLine(n) : '');

    const bw = inn.bowlers.find((b) => b.id === inn.currentBowlerId);
    r.bowlName.textContent = bw ? bw.name : '—';
    setNum(r.bowlFig, bw ? fmt.figures(bw) : '');

    const useThis = inn.thisOver.length > 0;
    const toks = useThis ? inn.thisOver : (inn.lastOver || []);
    r.overLab.textContent = useThis ? 'This over' : 'Last over';
    const key = `${useThis}|${toks.join(',')}`;
    if (key !== tokKey) {
      tokKey = key;
      r.pills.textContent = '';
      const shown = toks.slice(-6);
      if (toks.length > shown.length) r.pills.appendChild(h('span', { class: 'sb-ell' }, '…'));
      for (const t of shown) r.pills.appendChild(h('span', { class: pillClass(t) }, t));
      if (!toks.length) r.pills.appendChild(h('span', { class: 'sb-ell' }, '—'));
    }

    setNum(r.crr, fmt.num1(inn.crr));

    // during a chase RRR carries the story — drop CRR to keep the bar tight
    const ch = state.chase;
    r.crrSeg.classList.toggle('off', !!ch);
    r.chase.classList.toggle('off', !ch);
    if (ch) {
      r.chaseLab.textContent = `Target ${ch.target} · RRR ${fmt.num1(ch.rrr)}`;
      setNum(r.chaseMain, `NEED ${ch.need} OFF ${ch.ballsLeft}`);
    }
  }

  function renderBreak(state, inn) {
    const team = teamOf(state, inn.battingTeamId) || {};
    r.bkChip.style.setProperty('--team', team.color || '#8a93a3');
    r.bkScore.textContent = `${team.short || ''} ${inn.runs}/${inn.wickets} (${inn.oversText} ov)`;
    let need = '';
    if (state.target) {
      const nxt = teamOf(state, inn.bowlingTeamId) || {};
      const limit = state.innings.length >= 2 ? 1 : (state.config.oversPerInnings || inn.oversLimit);
      need = `${nxt.short || nxt.name || ''} need ${state.target.runs} from ${limit} over${limit === 1 ? '' : 's'}`;
    }
    r.bkNeed.textContent = need;
    r.bkNeedSeg.classList.toggle('off', !need);
  }

  function renderComplete(state) {
    r.resSummary.textContent = state.innings.map((i) => {
      const t = teamOf(state, i.battingTeamId) || {};
      return `${t.short || ''} ${i.runs}/${i.wickets}${i.superOver ? ' (SO)' : ''}`;
    }).join(' · ');
    r.resText.textContent = state.result ? state.result.text : 'Match complete';
  }

  // --- public API -----------------------------------------------------------
  function setState(state) {
    if (!state) return;
    const phase = state.phase || 'setup';
    bar.classList.remove('m-setup', 'm-live', 'm-break', 'm-complete');
    bar.classList.add(`m-${phase}`);
    r.flag.classList.toggle('on', !!state.freeHitPending);
    const inn = focusInnings(state);
    if (phase === 'live' && inn) renderLive(state, inn);
    else if (phase === 'break' && inn) renderBreak(state, inn);
    else if (phase === 'complete') renderComplete(state);
    ready = true;
  }

  function setPresentation(p) {
    if (!p) return;
    const show = p.show ? p.show.scorebug !== false : true;
    root.classList.toggle('hidden', !show);
    document.body.classList.toggle('chroma', p.theme === 'chroma');
    const t = (p.ticker || '').trim();
    r.tickerText.textContent = t;
    r.ticker.classList.toggle('on', !!t);
  }

  function setBranding(b) {
    if (!b) return;
    applyBranding(b);
    if (b.logo) {
      r.brandLogo.src = b.logo;
      r.brand.classList.add('has-logo');
    } else {
      r.brand.classList.remove('has-logo');
      r.brandName.textContent = b.orgName || 'ICAT';
    }
    const sp = (b.sponsors || []).filter((x) => x && x.logo).slice(0, 3);
    const key = sp.map((x) => `${x.name || ''}:${x.logo.length}`).join('|');
    if (key !== spKey) {
      spKey = key;
      r.sponsors.textContent = '';
      for (const x of sp) {
        r.sponsors.appendChild(h('span', { class: 'sb-sponsor' }, h('img', { src: x.logo, alt: x.name || '' })));
      }
    }
    r.sponsors.classList.toggle('off', !sp.length);
  }

  return { setState, setPresentation, setBranding };
}

/** Page boot shared by scorebug.html and full.js (which adds onFx → stingers). */
export async function bootScorebug(opts = {}) {
  fitStage();
  const bug = mountScorebug(document.getElementById('stage'));
  let presentation = null;
  return connect({
    matchId: new URLSearchParams(location.search).get('match'),
    role: 'view',
    onState(state) { bug.setState(state); },
    onPresentation(p) { presentation = p; bug.setPresentation(p); },
    onBranding(b) { bug.setBranding(b); },
    onFx(fx, manual) { if (opts.onFx) opts.onFx(fx, manual, presentation); },
  });
}
