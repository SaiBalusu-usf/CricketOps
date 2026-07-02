/**
 * Stinger banners for the broadcast overlays.
 * mountStingers(container) → { play(fxItem) } — queued, one at a time,
 * ~4.5s each. Markup/animation lives here + stingers.css (contract §6/§10).
 */
import { h } from '/client/shared/app.js';

const OUT_MS = 380;
const HOLD = { over: 3900, result: 5800 };
const DEFAULT_HOLD = 4100;

function tokClass(t) {
  if (t.indexOf('W') !== -1) return 's-tok w';
  if (t === '4' || t === '6') return 's-tok bd';
  if (/^(wd|nb|b\d|lb)/.test(t)) return 's-tok ex';
  return 's-tok';
}

/** [main?, sub?] info slab; skipped entirely when both are empty. */
function info(main, sub, extra) {
  if (!main && !sub && !extra) return null;
  return h('div', { class: 's-info' },
    h('div', { class: 's-k' },
      main && h('div', { class: 's-main' }, main),
      sub && h('div', { class: 's-sub' }, sub),
      extra));
}

function slabs(fx) {
  switch (fx.type) {
    case 'four':
    case 'six':
      return [word(fx.type === 'four' ? 'FOUR' : 'SIX'), info(fx.batter)];
    case 'wicket': {
      const sub = [fx.score, fx.how].filter(Boolean).join(' · ');
      return [
        word('WICKET'),
        info(fx.batter, sub),
        fx.teamScore && h('div', { class: 's-score' }, h('span', { class: 's-k' }, fx.teamScore)),
      ];
    }
    case 'duck':
      return [word('DUCK'), info(fx.batter, 'OUT FOR 0')];
    case 'fifty':
    case 'hundred':
      return [word(fx.type === 'fifty' ? 'FIFTY!' : 'HUNDRED!'), info(fx.batter, fx.score)];
    case 'hattrick':
      return [word('HAT-TRICK'), info(fx.bowler, 'THREE IN THREE')];
    case 'over': {
      const runsBit = fx.runs !== undefined
        ? `${fx.runs} RUN${fx.runs === 1 ? '' : 'S'}${fx.wickets ? ` · ${fx.wickets} WKT` : ''}`
        : null;
      const toks = Array.isArray(fx.tokens) && fx.tokens.length
        ? h('div', { class: 's-toks' }, fx.tokens.slice(-10).map((t) => h('span', { class: tokClass(t) }, t)))
        : null;
      return [
        word(fx.over !== undefined ? `END OF OVER ${fx.over}` : 'END OF OVER'),
        info(runsBit, fx.bowler, toks),
        fx.score && h('div', { class: 's-score' }, h('span', { class: 's-k' }, fx.score)),
      ];
    }
    case 'innings-end':
      return [word('INNINGS'), info(fx.team, fx.score)];
    case 'result':
      return [h('div', { class: 's-word' }, h('span', { class: 's-k' },
        h('span', { class: 's-tag' }, 'Result'),
        fx.text || 'Match complete'))];
    default:
      // unknown manual fire — show whatever we have
      return [word(String(fx.type).toUpperCase()), info(fx.batter || fx.bowler || fx.text)];
  }
}

function word(text) {
  return h('div', { class: 's-word' }, h('span', { class: 's-k' }, text));
}

export function mountStingers(container) {
  container.classList.add('fx-layer');
  const queue = [];
  let busy = false;

  function next() {
    const fx = queue.shift();
    if (!fx) { busy = false; return; }
    busy = true;
    const el = h('div', { class: `stinger t-${fx.type}` },
      h('div', { class: 's-sweep s-sweep-a' }),
      h('div', { class: 's-sweep s-sweep-b' }),
      h('div', { class: 's-inner' }, slabs(fx)));
    container.appendChild(el);
    void el.offsetWidth; // commit initial styles so .in animates
    el.classList.add('in');
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => { el.remove(); next(); }, OUT_MS);
    }, HOLD[fx.type] || DEFAULT_HOLD);
  }

  return {
    play(fx) {
      if (!fx || !fx.type) return;
      queue.push(fx);
      if (!busy) next();
    },
  };
}
