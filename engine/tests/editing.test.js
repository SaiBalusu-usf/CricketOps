import test from 'node:test';
import assert from 'node:assert/strict';
import { openMatch } from './helpers.js';
import { reduce, undoLast, replaceEvent } from '../index.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

test('undo of a wicket restores the dismissed batter mid-over (§5.6)', () => {
  const m = openMatch();
  m.runs(4).runs(1);
  const before = clone(m.state);
  m.out('bowled');
  m.newBatter('A3', 'striker');
  // two undos: the incoming batter, then the wicket ball
  let r = undoLast(m.events);
  assert.equal(r.undone.type, 'NEW_BATTER');
  r = undoLast(r.events);
  assert.equal(r.undone.type, 'BALL');
  const after = clone(reduce(r.events));
  assert.deepEqual(after, before);
  assert.equal(after.innings[0].wickets, 0);
  assert.equal(after.innings[0].batters.find((b) => b.id === 'A2').out, null);
});

test('single undo of a NEW_BATTER reopens the vacancy', () => {
  const m = openMatch();
  m.out('bowled');
  m.newBatter('A3', 'striker');
  assert.equal(m.state.needs.newBatter, false);
  const r = undoLast(m.events);
  assert.equal(reduce(r.events).needs.newBatter, true);
});

test('undo never removes match creation', () => {
  const m = openMatch();
  let ev = m.events.slice(0, 1);
  const r = undoLast(ev);
  assert.equal(r.undone, null);
  assert.equal(r.events.length, 1);
});

test('editing an earlier ball re-derives everything after it (§5.6)', () => {
  const m = openMatch();
  m.runs(1);  // ball 1 — will become a 4
  m.dot();    // ball 2
  m.runs(2);  // ball 3
  m.runs(1);  // ball 4
  m.runs(4);  // ball 5
  m.dot();    // ball 6 — over ends
  const orig = m.state;
  assert.equal(orig.innings[0].runs, 8);
  assert.equal(orig.innings[0].batters.find((b) => b.id === 'A1').runs, 5);
  assert.equal(orig.innings[0].batters.find((b) => b.id === 'A2').runs, 3);
  assert.equal(orig.innings[0].striker, 'A2'); // over-end swap

  // events: [MATCH_CREATED, INNINGS_START, BOWLER_CHANGE, BALL×6]
  const edited = replaceEvent(m.events, 3, { type: 'BALL', legality: 'legal', batRuns: 4, extraRuns: 0 });
  const st = reduce(edited);
  const inn = st.innings[0];
  // the single became a four, so A1 keeps strike for balls 2–4 and A2 faces 5–6
  assert.equal(inn.runs, 11);
  assert.equal(inn.batters.find((b) => b.id === 'A1').runs, 7);
  assert.equal(inn.batters.find((b) => b.id === 'A1').balls, 4);
  assert.equal(inn.batters.find((b) => b.id === 'A1').fours, 1);
  assert.equal(inn.batters.find((b) => b.id === 'A2').runs, 4);
  assert.equal(inn.batters.find((b) => b.id === 'A2').balls, 2);
  assert.equal(inn.batters.find((b) => b.id === 'A2').fours, 1);
  assert.equal(inn.bowlers.find((b) => b.id === 'B1').runs, 11);
  assert.equal(inn.striker, 'A1'); // downstream strike re-derived
  assert.equal(st.anomalies.length, 0);
});

test('editing a wicket away leaves the orphan NEW_BATTER as an anomaly, not a crash', () => {
  const m = openMatch();
  m.out('bowled');           // event 3
  m.newBatter('A3', 'striker'); // event 4
  m.runs(2);                 // event 5
  const edited = replaceEvent(m.events, 3, { type: 'BALL', legality: 'legal', batRuns: 1, extraRuns: 0 });
  const st = reduce(edited);
  assert.ok(st.anomalies.length > 0);
  const inn = st.innings[0];
  assert.equal(inn.wickets, 0);
  assert.equal(inn.runs, 3);
  assert.ok(!inn.batters.some((b) => b.id === 'A3'), 'orphan batter is ignored');
});

test('event log JSON round-trip reduces to identical state (export/import)', () => {
  const m = openMatch();
  m.runs(4).wide(2).nb(6).bye(1).out('caught', { fielders: ['B3'] });
  m.newBatter('A3', 'nonstriker');
  m.runs(3);
  const direct = clone(reduce(m.events));
  const roundTripped = clone(reduce(JSON.parse(JSON.stringify(m.events))));
  assert.deepEqual(roundTripped, direct);
});

test('garbage events never throw — they become anomalies', () => {
  // reduce with a completely empty log is fine
  assert.equal(reduce([]).phase, 'setup');
  const m = openMatch();
  m.events.push({ type: 'BALL', legality: 'legal', batRuns: 1, extraRuns: 0, wicket: { kind: 'nonsense', out: 'striker' } });
  m.events.push({ type: 'TOTALLY_UNKNOWN' });
  m.events.push({ type: 'NEW_BATTER', batter: 'A9', end: 'striker' });
  const st = reduce(m.events);
  assert.ok(st.anomalies.length >= 1);
  assert.equal(st.phase, 'live');
});
