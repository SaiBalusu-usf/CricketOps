/**
 * Canvas scorebug for the Tier-2 phone broadcast composite (Part D2).
 * A compact 2D renderer fed by the same onState/onPresentation callbacks as
 * the DOM scorebug — the DOM one stays untouched. The chroma theme is
 * meaningless on a composited frame and is deliberately ignored here.
 */
import { fmt, teamOf, focusInnings } from '/client/shared/app.js';

const FONT = '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export function createCanvasScorebug() {
  let state = null;
  let presentation = null;
  let branding = null;
  let flashUntil = 0;
  let flashText = '';
  let flashColor = '#f5b301';

  function setState(s) { state = s; }
  function setPresentation(p) { presentation = p; }
  function setBranding(b) { branding = b; }

  /** 2 s moment banner for wicket/four/six on phone-only broadcasts (D3). */
  function flash(fx) {
    const map = {
      four: ['FOUR', '#f5b301'],
      six: ['SIX', '#f5b301'],
      wicket: ['WICKET', '#e03131'],
    };
    const hit = map[fx.type];
    if (!hit) return;
    flashText = fx.type === 'wicket' && fx.batter ? `WICKET — ${fx.batter} ${fx.score || ''}` : `${hit[0]}${fx.batter ? ' — ' + fx.batter : ''}`;
    flashColor = hit[1];
    flashUntil = performance.now() + 2000;
  }

  function draw(ctx, w, h) {
    if (!state || !state.config) return;
    const inn = focusInnings(state);
    if (!inn) return;
    const accent = (branding && branding.accent) || '#f5b301';
    const team = teamOf(state, inn.battingTeamId) || {};
    const barH = Math.round(h * 0.105);
    const y = h - barH - Math.round(h * 0.03);
    const pad = Math.round(w * 0.015);

    ctx.save();
    ctx.textBaseline = 'middle';

    // ticker above the bar
    const ticker = presentation && presentation.ticker;
    if (ticker) {
      ctx.font = `600 ${Math.round(barH * 0.34)}px ${FONT}`;
      const tw = ctx.measureText(ticker).width + pad * 2;
      rr(ctx, pad, y - barH * 0.52, Math.min(tw, w * 0.7), barH * 0.44, 6, 'rgba(8,12,20,0.9)');
      ctx.fillStyle = '#fff';
      ctx.fillText(ticker, pad * 1.5, y - barH * 0.3, w * 0.66);
    }

    // free hit flag
    if (state.freeHitPending) {
      ctx.font = `800 ${Math.round(barH * 0.36)}px ${FONT}`;
      const fw = ctx.measureText('FREE HIT').width + pad * 2;
      rr(ctx, w - fw - pad, y - barH * 0.52, fw, barH * 0.44, 6, accent);
      ctx.fillStyle = '#10151d';
      ctx.fillText('FREE HIT', w - fw, y - barH * 0.3);
    }

    // main bar
    rr(ctx, pad, y, w - pad * 2, barH, 8, 'rgba(10,14,22,0.92)');

    // brand block
    const brand = (branding && branding.orgName) || 'ICAT';
    ctx.font = `900 ${Math.round(barH * 0.42)}px ${FONT}`;
    const bw = Math.max(ctx.measureText(brand).width + pad * 1.2, barH * 1.1);
    rr(ctx, pad, y, bw, barH, 8, accent);
    ctx.fillStyle = '#10151d';
    ctx.fillText(brand, pad + (bw - ctx.measureText(brand).width) / 2, y + barH / 2);

    // score block
    let x = pad + bw + pad;
    ctx.fillStyle = team.color || '#888';
    ctx.fillRect(x, y + barH * 0.18, 6, barH * 0.64);
    x += 14;
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${Math.round(barH * 0.52)}px ${FONT}`;
    const score = `${team.short || ''} ${inn.runs}/${inn.wickets}`;
    ctx.fillText(score, x, y + barH * 0.38);
    ctx.font = `600 ${Math.round(barH * 0.3)}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fillText(`${inn.oversText} ov · CRR ${fmt.num1(inn.crr)}`, x, y + barH * 0.76);
    x += Math.max(ctx.measureText(score).width, barH * 2.4) + pad;

    // batters / phase line
    ctx.font = `600 ${Math.round(barH * 0.32)}px ${FONT}`;
    ctx.fillStyle = '#fff';
    let line1 = '';
    let line2 = '';
    if (state.phase === 'complete' && state.result) {
      line1 = state.result.text;
    } else if (state.phase === 'break') {
      line1 = state.target ? `Target ${state.target.runs}` : 'Innings break';
    } else {
      const bat = (pid, star) => {
        const b = inn.batters.find((q) => q.id === pid);
        return b ? `${star ? '● ' : ''}${b.name} ${b.runs}(${b.balls})` : '';
      };
      line1 = bat(inn.striker, true);
      line2 = bat(inn.nonStriker, false);
      const bowler = inn.bowlers.find((q) => q.id === inn.currentBowlerId);
      if (bowler) line2 += `${line2 ? '   ' : ''}⊙ ${bowler.name} ${fmt.figures(bowler)}`;
    }
    ctx.fillText(line1, x, y + barH * (line2 ? 0.32 : 0.5), w * 0.42);
    if (line2) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(line2, x, y + barH * 0.72, w * 0.42);
    }

    // chase segment, right-aligned
    if (state.chase) {
      const c = state.chase;
      ctx.textAlign = 'right';
      ctx.fillStyle = accent;
      ctx.font = `800 ${Math.round(barH * 0.36)}px ${FONT}`;
      ctx.fillText(`NEED ${c.need} OFF ${c.ballsLeft}`, w - pad * 2, y + barH * 0.38);
      ctx.font = `600 ${Math.round(barH * 0.28)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillText(`TARGET ${c.target} · RRR ${fmt.num1(c.rrr)}`, w - pad * 2, y + barH * 0.74);
      ctx.textAlign = 'left';
    } else {
      // this-over tokens
      const tokens = (inn.thisOver.length ? inn.thisOver : inn.lastOver).slice(-8);
      if (tokens.length) {
        ctx.textAlign = 'right';
        ctx.font = `700 ${Math.round(barH * 0.3)}px ${FONT}`;
        let tx = w - pad * 2;
        for (let i = tokens.length - 1; i >= 0; i--) {
          const t = tokens[i];
          const tw2 = Math.max(ctx.measureText(t).width + 12, barH * 0.42);
          const isW = t.indexOf('W') >= 0;
          const isB = t === '4' || t === '6';
          rr(ctx, tx - tw2, y + barH * 0.28, tw2, barH * 0.44, 5, isW ? '#e03131' : isB ? accent : 'rgba(255,255,255,0.14)');
          ctx.fillStyle = isB ? '#10151d' : '#fff';
          ctx.fillText(t, tx - 6, y + barH * 0.5);
          tx -= tw2 + 6;
          if (tx < x + w * 0.42) break;
        }
        ctx.textAlign = 'left';
      }
    }

    // fx flash banner
    if (performance.now() < flashUntil && flashText) {
      ctx.font = `900 ${Math.round(h * 0.07)}px ${FONT}`;
      const fw = ctx.measureText(flashText).width + pad * 3;
      const fy = h * 0.62;
      rr(ctx, (w - fw) / 2, fy, fw, h * 0.09, 10, flashColor);
      ctx.fillStyle = flashColor === '#e03131' ? '#fff' : '#10151d';
      ctx.textAlign = 'center';
      ctx.fillText(flashText, w / 2, fy + h * 0.047);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  return { setState, setPresentation, setBranding, flash, draw };
}

function rr(ctx, x, y, w, h, r, fill) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}
