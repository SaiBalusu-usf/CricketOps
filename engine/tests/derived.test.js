import test from 'node:test';
import assert from 'node:assert/strict';
import { openMatch, firstInnings, Match } from './helpers.js';
import { computeFx, dismissalText, oversText } from '../index.js';

test('maiden over detection: leg-byes do not break it, a wide does (§5.6)', () => {
  const m = openMatch();
  m.dot().dot().legbye(2).dot().dot().legbye(2);
  assert.equal(m.bowlerRow('B1').maidens, 1);
  assert.equal(m.bowlerRow('B1').dots, 6);
  m.bowler('B2');
  m.wide();
  for (let i = 0; i < 6; i++) m.dot();
  assert.equal(m.bowlerRow('B2').maidens, 0, 'a wide concedes a run — no maiden');
});

test('batting card: runs, balls, boundaries, strike rate, dismissal text', () => {
  const m = openMatch();
  m.runs(4).runs(6).runs(2).out('caught', { fielders: ['B3'] });
  const a1 = m.batter('A1');
  assert.equal(a1.runs, 12);
  assert.equal(a1.balls, 4);
  assert.equal(a1.fours, 1);
  assert.equal(a1.sixes, 1);
  assert.equal(a1.sr, 300);
  assert.equal(a1.howOut, 'c Pranav b Naveen');
  assert.equal(m.batter('A2').howOut, 'not out');
});

test('caught & bowled reads c & b', () => {
  const m = openMatch();
  m.out('caught', { fielders: ['B1'] });
  assert.equal(m.batter('A1').howOut, 'c & b Naveen');
});

test('bowling card: figures, economy, overs text', () => {
  const m = openMatch();
  m.runs(4).dot().dot().runs(1).nb(1).dot().dot(); // over: 4 . . 1 nb+1 . . => 6 legal
  const bw = m.bowlerRow('B1');
  assert.equal(bw.balls, 6);
  assert.equal(bw.oversText, '1.0');
  assert.equal(bw.runs, 7); // 4 + 1 + (no-ball penalty 1 + 1 off the bat)
  assert.equal(bw.noballs, 1);
  assert.equal(bw.econ, 7);
  assert.equal(oversText(9), '1.3');
});

test('fall of wickets and partnerships', () => {
  const m = openMatch();
  m.runs(4).runs(1).out('bowled');
  const inn = m.inn();
  assert.deepEqual(inn.fow[0], {
    wicket: 1, runs: 5, overs: '0.3', batterId: 'A2', batterName: 'Bala',
  });
  assert.equal(inn.partnerships.length, 1);
  assert.equal(inn.partnerships[0].runs, 5);
  assert.equal(inn.partnerships[0].balls, 3);
  assert.equal(inn.partnerships[0].unbroken, false);
  m.newBatter('A3', 'striker');
  m.runs(2);
  assert.equal(m.inn().currentPartnership.runs, 2);
  assert.equal(m.inn().currentPartnership.unbroken, true);
});

test('extras breakdown and total', () => {
  const m = openMatch();
  m.wide().nb(0).bye(2).legbye(3);
  m.push({ type: 'PENALTY', teamId: 'A', runs: 5 });
  const ex = m.inn().extras;
  assert.deepEqual(ex, { wides: 1, noballs: 1, byes: 2, legbyes: 3, penalties: 5, total: 12 });
  assert.equal(m.inn().runs, 12);
});

test('current run rate and over-by-over series', () => {
  const m = openMatch();
  m.runs(4).runs(2).dot().runs(1).dot().dot(); // 7 off over 1
  assert.equal(m.inn().crr, 7);
  m.bowler('B2');
  m.runs(6).dot();
  assert.equal(m.inn().overByOver.length, 1);
  assert.deepEqual(m.inn().overByOver[0], { over: 1, runs: 7, wickets: 0, bowlerId: 'B1', maiden: false });
  assert.equal(m.inn().thisOver.length, 2);
});

test('this-over strip tokens', () => {
  const m = openMatch();
  m.dot().runs(4).wide(2).nb(6).bye(1).out('bowled');
  assert.deepEqual(m.inn().thisOver, ['•', '4', 'wd+2', 'nb+6', 'b1', 'W']);
});

test('chase panel numbers', () => {
  const m = firstInnings(new Match(), 30);
  m.startInnings('B', 'B1', 'B2').bowler('A1');
  m.runs(4).runs(2);
  const c = m.state.chase;
  assert.equal(c.target, 31);
  assert.equal(c.need, 25);
  assert.equal(c.ballsLeft, 28);
  assert.equal(c.rrr, 5.36);
});

test('fx: boundaries, wicket, duck', () => {
  const m = openMatch();
  let before = m.state;
  const six = { type: 'BALL', legality: 'legal', batRuns: 6, extraRuns: 0 };
  m.push(six);
  assert.deepEqual(computeFx(before, m.state, six).map((f) => f.type), ['six']);

  before = m.state;
  const w = {
    type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0,
    wicket: { kind: 'bowled', out: 'striker' },
  };
  m.push(w);
  const fx = computeFx(before, m.state, w);
  assert.deepEqual(fx.map((f) => f.type), ['wicket'], 'A1 made 6 — not a duck');
  assert.equal(fx[0].batter, 'Arun'); // the six kept A1 on strike
  assert.match(fx[0].how, /b Naveen/);

  // a first-ball nought IS a duck
  m.newBatter('A3', 'striker');
  before = m.state;
  m.push(w);
  const fx2 = computeFx(before, m.state, w);
  assert.deepEqual(fx2.map((f) => f.type), ['wicket', 'duck']);
  assert.equal(fx2[1].batter, 'Chetan');
});

test('fx: hat-trick on three credited wickets in consecutive balls', () => {
  const m = openMatch();
  m.out('bowled'); m.newBatter('A3');
  m.out('bowled'); m.newBatter('A4');
  const before = m.state;
  const ev = {
    type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0,
    wicket: { kind: 'bowled', out: 'striker' },
  };
  m.push(ev);
  const types = computeFx(before, m.state, ev).map((f) => f.type);
  assert.ok(types.includes('hattrick'), `expected hattrick in ${types}`);
});

test('fx: run out does not extend a hat-trick chain', () => {
  const m = openMatch();
  m.out('bowled'); m.newBatter('A3');
  m.ball({ batRuns: 0, wicket: { kind: 'runout', out: 'striker', fielders: ['B2'] } });
  m.newBatter('A4');
  const before = m.state;
  const ev = {
    type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0,
    wicket: { kind: 'bowled', out: 'striker' },
  };
  m.push(ev);
  const types = computeFx(before, m.state, ev).map((f) => f.type);
  assert.ok(!types.includes('hattrick'));
});

test('fx: fifty milestone and end of over', () => {
  const m = openMatch();
  // A1 farms the strike: five fours + a single off the last ball, twice = 46
  for (let over = 0; over < 2; over++) {
    if (over > 0) m.bowler(`B${over + 1}`);
    for (let i = 0; i < 5; i++) m.runs(4);
    m.runs(1);
  }
  m.bowler('B3');
  m.runs(4); // 21 + 21 + 4 = 46
  assert.equal(m.batter('A1').runs, 46);
  const before = m.state;
  const four = { type: 'BALL', legality: 'legal', batRuns: 4, extraRuns: 0 };
  m.push(four);
  const fx = computeFx(before, m.state, four);
  assert.ok(fx.some((f) => f.type === 'fifty' && f.batter === 'Arun'), `expected fifty in ${JSON.stringify(fx)}`);

  // end of over fx: over 3 has 2 balls so far — bowl 4 more
  const dots = { type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0 };
  m.push(dots); m.push(dots); m.push(dots);
  const beforeLast = m.state;
  m.push(dots);
  const overFx = computeFx(beforeLast, m.state, dots);
  assert.ok(overFx.some((f) => f.type === 'over' && f.over === 3), `expected over fx in ${JSON.stringify(overFx)}`);
});

test('fx: innings end and result', () => {
  const m = firstInnings(new Match(), 8);
  m.startInnings('B', 'B1', 'B2').bowler('A1');
  m.runs(4).runs(4);
  const before = m.state;
  const winner = { type: 'BALL', legality: 'legal', batRuns: 1, extraRuns: 0 };
  m.push(winner);
  const fx = computeFx(before, m.state, winner);
  assert.ok(fx.some((f) => f.type === 'innings-end'));
  assert.ok(fx.some((f) => f.type === 'result' && /ICAT Gold won/.test(f.text)));
});

test('commentary feed lines', () => {
  const m = openMatch();
  m.runs(4);
  m.wide();
  m.out('caught', { fielders: ['B3'] });
  const texts = m.state.feed.map((f) => f.text);
  assert.ok(texts.some((t) => /Naveen to Arun, FOUR/.test(t)));
  assert.ok(texts.some((t) => /wide/.test(t)));
  assert.ok(texts.some((t) => /OUT! .* c Pranav b Naveen/.test(t)));
  const wk = m.state.feed.find((f) => f.kind === 'wicket');
  assert.ok(wk);
});

test('dismissal text helper covers the odd ones', () => {
  const names = { B7: 'Tarun', B1: 'Naveen' };
  const nameOf = (id) => names[id];
  assert.equal(dismissalText({ kind: 'stumped', fielders: ['B7'], bowlerId: 'B1' }, nameOf), 'st Tarun b Naveen');
  assert.equal(dismissalText({ kind: 'obstructing' }, nameOf), 'obstructing the field');
  assert.equal(dismissalText({ kind: 'hittwice' }, nameOf), 'hit the ball twice');
  assert.equal(dismissalText({ kind: 'timedout' }, nameOf), 'timed out');
});
