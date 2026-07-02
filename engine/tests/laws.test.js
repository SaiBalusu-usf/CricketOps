import test from 'node:test';
import assert from 'node:assert/strict';
import { openMatch, Match } from './helpers.js';

test('wide: penalty run, no ball faced, does not count, charged to bowler', () => {
  const m = openMatch();
  m.wide();
  const inn = m.inn();
  assert.equal(inn.runs, 1);
  assert.equal(inn.extras.wides, 1);
  assert.equal(inn.legalBalls, 0);
  assert.equal(m.batter('A1').balls, 0);
  const bw = m.bowlerRow('B1');
  assert.equal(bw.runs, 1);
  assert.equal(bw.balls, 0);
  assert.equal(bw.wides, 1);
});

test('wide with 2 completed runs plus run out (§5.6)', () => {
  const m = openMatch();
  m.wide(2, { kind: 'runout', out: 'striker', fielders: ['B3'] });
  const inn = m.inn();
  assert.equal(inn.runs, 3);              // 1 wide penalty + 2 run
  assert.equal(inn.extras.wides, 3);      // all scored as wides
  assert.equal(inn.wickets, 1);
  assert.equal(inn.legalBalls, 0);        // wide never counts
  assert.equal(m.batter('A1').balls, 0);  // not a ball faced
  assert.equal(m.batter('A1').out.kind, 'runout');
  assert.equal(m.bowlerRow('B1').runs, 3);
  assert.equal(m.bowlerRow('B1').wickets, 0); // run out is never the bowler's
  assert.deepEqual(inn.fow[0].runs, 3);
  assert.equal(m.state.needs.newBatter, true);
});

test('configurable wide value of 2', () => {
  const m = new Match({ rules: { wideRuns: 2 } }).startInnings('A', 'A1', 'A2').bowler('B1');
  m.wide();
  assert.equal(m.inn().runs, 2);
  assert.equal(m.inn().extras.wides, 2);
});

test('no-ball hit for six (§5.6)', () => {
  const m = openMatch();
  m.nb(6);
  const inn = m.inn();
  assert.equal(inn.runs, 7);
  assert.equal(inn.extras.noballs, 1);
  assert.equal(inn.legalBalls, 0);
  const a1 = m.batter('A1');
  assert.equal(a1.runs, 6);
  assert.equal(a1.balls, 1);              // a no-ball counts as a ball faced
  assert.equal(a1.sixes, 1);
  const bw = m.bowlerRow('B1');
  assert.equal(bw.runs, 7);
  assert.equal(bw.balls, 0);
  assert.equal(bw.noballs, 1);
  assert.equal(m.state.freeHitPending, true);
});

test('free hit: stumping rejected, run out allowed (§5.6)', () => {
  const m = openMatch();
  m.nb(0);
  assert.equal(m.state.freeHitPending, true);
  const stump = m.check({
    type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0,
    wicket: { kind: 'stumped', out: 'striker', fielders: ['B7'] },
  });
  assert.ok(stump.errors.length > 0, 'stumping on a free hit must be rejected');

  m.ball({ batRuns: 1, wicket: { kind: 'runout', out: 'striker', fielders: ['B5'] } });
  const inn = m.inn();
  assert.equal(inn.wickets, 1);
  assert.equal(inn.runs, 2);              // nb penalty + 1 completed run
  assert.equal(m.state.freeHitPending, false); // consumed by the legal delivery
});

test('free hit carries over another no-ball and a wide (§5.6)', () => {
  const m = openMatch();
  m.nb(0);
  m.nb(1); // still not legal — free hit carries, and this no-ball renews it
  assert.equal(m.state.freeHitPending, true);
  m.wide(); // wide leaves the free hit in force (ICC 21.19.2)
  assert.equal(m.state.freeHitPending, true);
  // even on the wide, only run out etc. — a stumping attempt is not out
  const stump = m.check({
    type: 'BALL', legality: 'wide', batRuns: 0, extraRuns: 0,
    wicket: { kind: 'stumped', out: 'striker', fielders: ['B7'] },
  });
  assert.ok(stump.errors.length > 0, 'stumping on a free-hit wide must be rejected');
  m.dot(); // legal ball consumes the free hit
  assert.equal(m.state.freeHitPending, false);
  const stumpNow = m.check({
    type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0,
    wicket: { kind: 'stumped', out: 'striker', fielders: ['B7'] },
  });
  assert.equal(stumpNow.errors.length, 0, 'stumping is fine once the free hit is gone');
});

test('byes on a no-ball are scored as no-ball extras (§5.6)', () => {
  const m = openMatch();
  m.nb(0, { extraType: 'bye', extraRuns: 2 });
  const inn = m.inn();
  assert.equal(inn.runs, 3);
  assert.equal(inn.extras.noballs, 3);
  assert.equal(inn.extras.byes, 0);
  assert.equal(m.bowlerRow('B1').runs, 3); // no-ball runs are the bowler's
  assert.equal(m.batter('A1').balls, 1);
  assert.equal(m.batter('A1').runs, 0);
});

test('byes and leg-byes: ball counts, striker faces it, bowler not charged', () => {
  const m = openMatch();
  m.bye(2);
  let inn = m.inn();
  assert.equal(inn.extras.byes, 2);
  assert.equal(inn.legalBalls, 1);
  assert.equal(m.batter('A1').balls, 1);
  assert.equal(m.batter('A1').runs, 0);
  assert.equal(m.bowlerRow('B1').runs, 0);
  // 2 byes are even — striker keeps the strike
  assert.equal(inn.striker, 'A1');
  m.legbye(3);
  inn = m.inn();
  assert.equal(inn.extras.legbyes, 3);
  assert.equal(inn.striker, 'A2'); // 3 leg-byes rotate the strike
});

test('strike rotation on 3 leg-byes (§5.6)', () => {
  const m = openMatch();
  m.legbye(3);
  assert.equal(m.inn().striker, 'A2');
  assert.equal(m.inn().nonStriker, 'A1');
});

test('declared short run: score reduced, crossings still count (Law 18)', () => {
  const m = openMatch();
  m.ball({ batRuns: 2, short: true });
  assert.equal(m.inn().runs, 1);
  assert.equal(m.batter('A1').runs, 1);
  assert.equal(m.inn().striker, 'A1'); // ran 2, back where they started
  m.ball({ batRuns: 1, short: true });
  assert.equal(m.inn().runs, 1);       // the single was short — no run scored
  assert.equal(m.inn().striker, 'A2'); // but they did cross
});

test('penalty runs to the batting side and to a side yet to bat', () => {
  const m = openMatch();
  m.push({ type: 'PENALTY', teamId: 'A', runs: 5, note: 'ball tampering' });
  assert.equal(m.inn().runs, 5);
  assert.equal(m.inn().extras.penalties, 5);
  // to team B (has not batted yet) — held, then applied at their innings start
  m.push({ type: 'PENALTY', teamId: 'B', runs: 5 });
  assert.equal(m.inn(0).runs, 5);
  m.declare();
  m.startInnings('B', 'B1', 'B2');
  assert.equal(m.inn(1).runs, 5);
  assert.equal(m.inn(1).extras.penalties, 5);
});

test('dismissal legality per delivery type', () => {
  const m = openMatch();
  const w = (kind, legality = 'legal') => m.check({
    type: 'BALL', legality, batRuns: 0, extraRuns: 0,
    wicket: { kind, out: 'striker', fielders: ['B2'] },
  });
  assert.ok(w('bowled', 'wide').errors.length, 'bowled off a wide is impossible');
  assert.ok(w('caught', 'wide').errors.length, 'caught off a wide is impossible');
  assert.equal(w('stumped', 'wide').errors.length, 0, 'stumped off a wide is fine');
  assert.equal(w('hitwicket', 'wide').errors.length, 0);
  assert.ok(w('caught', 'noball').errors.length, 'caught off a no-ball is impossible');
  assert.ok(w('bowled', 'noball').errors.length);
  assert.ok(w('stumped', 'noball').errors.length, 'stumped off a no-ball is impossible');
  assert.equal(w('runout', 'noball').errors.length, 0);
  assert.equal(w('lbw').errors.length, 0, 'lbw is fine by default');
  assert.ok(w('caught').errors.length === 0);
});

test('no-LBW toggle rejects lbw', () => {
  const m = new Match({ rules: { noLbw: true } }).startInnings('A', 'A1', 'A2').bowler('B1');
  const v = m.check({
    type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0,
    wicket: { kind: 'lbw', out: 'striker' },
  });
  assert.ok(v.errors.some((e) => /LBW is disabled/.test(e)));
});

test('caught/bowled/lbw/stumped cannot carry runs; wide cannot carry bat runs', () => {
  const m = openMatch();
  assert.ok(m.check({
    type: 'BALL', legality: 'legal', batRuns: 1, extraRuns: 0,
    wicket: { kind: 'caught', out: 'striker', fielders: ['B2'] },
  }).errors.length);
  assert.ok(m.check({ type: 'BALL', legality: 'wide', batRuns: 2, extraRuns: 0 }).errors.length);
  assert.ok(m.check({ type: 'BALL', legality: 'wide', batRuns: 0, extraRuns: 1, extraType: 'bye' }).errors.length);
});
