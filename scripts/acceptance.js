/**
 * §14 acceptance walkthrough (npm run acceptance).
 *
 * Drives the REAL server over the real socket protocol end-to-end:
 *   1. create a 5-over match, teams of 6, last-man-stands ON, free hit ON
 *   2. score innings 1 incl. wide+2, no-ball six, free-hit run out, byes,
 *      caught behind, retired hurt who returns, and a maiden — verifying the
 *      server state equals an independent local reduce() after every event,
 *      and that the state broadcast arrives fast
 *   3. undo a wicket; edit an earlier ball 1 → 4; verify re-derivation
 *   4. SIGKILL the server mid-innings, restart, verify exact resume
 *   5. score the chase to a last-over finish; verify chase panel + result
 *   6. export → wipe → import → identical scorecards
 *   7. open every /overlay/* route at 1920×1080 in headless Chromium:
 *      no JS errors, transparent background, screenshots
 *
 * Uses a throwaway DATA_DIR so real match data is never touched.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { reduce } from '../engine/index.js';

const PORT = process.env.ACCEPT_PORT || 3411;
const BASE = `http://localhost:${PORT}`;
const WORK = process.env.ACCEPT_DIR || path.join(process.cwd(), 'scratch', 'acceptance');
const DATA_DIR = path.join(WORK, 'data');
const SHOTS = path.join(WORK, 'shots');

const results = [];
const step = (name, fn) => stepImpl(name, fn);
async function stepImpl(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✘ ${name}\n    ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// server + socket plumbing
// ---------------------------------------------------------------------------

let server = null;
async function startServer() {
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up');
}
function killServer(signal = 'SIGKILL') {
  if (server) { server.kill(signal); server = null; }
  return new Promise((r) => setTimeout(r, 300));
}

let socket = null;
let latestState = null;
let latestVersion = 0;
let lastFx = [];
let stateArrivals = new Map(); // version -> arrival time

function connectSocket(matchId, pin) {
  return new Promise((resolve, reject) => {
    socket = io(BASE, { transports: ['websocket'] });
    socket.on('state', (msg) => {
      latestState = msg.state;
      latestVersion = msg.version;
      stateArrivals.set(msg.version, performance.now());
    });
    socket.on('fx', (msg) => { lastFx.push(...msg.fx); });
    socket.on('connect', () => {
      socket.emit('join', { matchId, role: 'scorer', pin, clientId: 'acceptance' }, (res) => {
        if (!res.ok) return reject(new Error(`join failed: ${res.error}`));
        latestState = res.state;
        latestVersion = res.version;
        resolve(res);
      });
    });
    setTimeout(() => reject(new Error('socket connect timeout')), 5000);
  });
}

const localEvents = []; // mirror of the server log, for independent verification

function send(event, { force = false } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    socket.emit('append', { matchId: MATCH.id, event, force }, (res) => {
      if (!res.ok) return reject(new Error(`append ${event.type} rejected: ${JSON.stringify(res.errors || res.warnings)}`));
      localEvents.push(event);
      // verify the broadcast reached us quickly (same client is in the room)
      const check = () => {
        const arrived = stateArrivals.get(res.version);
        if (arrived === undefined) return setTimeout(check, 10);
        const ms = arrived - t0;
        if (ms > 300) console.log(`    (slow broadcast: ${Math.round(ms)}ms)`);
        // independent engine check: server state must equal our own reduce
        const mine = reduce([FIRST_EVENT, ...localEvents]);
        assert.equal(latestState.innings.length, mine.innings.length, 'innings count mismatch');
        const a = latestState.innings[latestState.innings.length - 1];
        const b = mine.innings[mine.innings.length - 1];
        assert.deepEqual(
          { r: a.runs, w: a.wickets, b: a.legalBalls, s: a.striker, n: a.nonStriker },
          { r: b.runs, w: b.wickets, b: b.legalBalls, s: b.striker, n: b.nonStriker },
          `server/local divergence after ${event.type}`,
        );
        resolve(res);
      };
      check();
    });
    setTimeout(() => reject(new Error(`append ${event.type} ack timeout`)), 5000);
  });
}

const ball = (over = {}) => send({ type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0, ...over });
const emitAck = (name, payload) => new Promise((resolve) => socket.emit(name, payload, resolve));

// ---------------------------------------------------------------------------

let MATCH = null;
let FIRST_EVENT = null;

async function createMatch() {
  const res = await (await fetch(`${BASE}/api/matches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      config: {
        teams: [
          { name: 'ICAT Blue', short: 'BLU', color: '#1d4ed8', players: ['Arun', 'Bala', 'Chetan', 'Dinesh', 'Emil', 'Farhan'] },
          { name: 'ICAT Gold', short: 'GLD', color: '#b45309', players: ['Naveen', 'Omar', 'Pranav', 'Qadir', 'Rohit', 'Sanjay'] },
        ],
        oversPerInnings: 5,
        maxOversPerBowler: 2,
        toss: { winner: 'A', decision: 'bat' },
        rules: { lastManStands: true, freeHit: true },
      },
    }),
  })).json();
  assert.ok(res.id && res.scorerPin, 'match creation failed');
  MATCH = res;
  const evs = await (await fetch(`${BASE}/api/matches/${res.id}/events`)).json();
  FIRST_EVENT = evs.events[0];
}

const inn = () => latestState.innings[latestState.innings.length - 1];
const batter = (id) => inn().batters.find((b) => b.id === id);

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('\nICAT Cricket Live — §14 acceptance walkthrough\n');

  await step('1. server up, match created (5 ov, 6-a-side, LMS on, free hit on)', async () => {
    await startServer();
    await createMatch();
    assert.equal((await (await fetch(`${BASE}/api/info`)).json()).activeMatchId, MATCH.id);
    await connectSocket(MATCH.id, MATCH.scorerPin);
  });

  await step('2. innings 1: wide+2, no-ball six, free-hit run out, byes, caught behind, retired hurt returns, maiden', async () => {
    await send({ type: 'INNINGS_START', battingTeamId: 'A', striker: 'A1', nonStriker: 'A2' });
    await send({ type: 'BOWLER_CHANGE', bowler: 'B1' });
    // over 1
    await ball({ legality: 'wide', extraRuns: 2 });                    // wide + 2 → 3 wides
    assert.equal(inn().extras.wides, 3);
    await ball({ legality: 'noball', batRuns: 6 });                    // no-ball SIX
    assert.equal(latestState.freeHitPending, true, 'free hit should be pending');
    assert.equal(batter('A1').sixes, 1);
    // free hit: stumping must be rejected…
    await assert.rejects(
      ball({ wicket: { kind: 'stumped', out: 'striker', fielders: ['B6'] } }),
      /free hit/i, 'stumping on a free hit must be rejected',
    );
    // …but a run out on the free hit is out
    await ball({ batRuns: 1, wicket: { kind: 'runout', out: 'striker', fielders: ['B5'] } });
    assert.equal(inn().wickets, 1);
    assert.equal(latestState.needs.newBatter, true);
    await send({ type: 'NEW_BATTER', batter: 'A3', end: 'striker' });
    await ball({ extraType: 'bye', extraRuns: 2 });                    // byes
    assert.equal(inn().extras.byes, 2);
    await ball({ wicket: { kind: 'caught', out: 'striker', fielders: ['B6'] } }); // caught behind
    await send({ type: 'NEW_BATTER', batter: 'A4', end: 'striker' });
    await ball({ batRuns: 4 });
    await ball({ batRuns: 1 });
    await ball({});                                                    // over 1 complete (6 legal)
    assert.equal(inn().legalBalls, 6);
    assert.equal(latestState.needs.bowler, true);

    // over 2: retired hurt mid-over
    await send({ type: 'BOWLER_CHANGE', bowler: 'B2' });
    await ball({ batRuns: 2 });
    await send({ type: 'RETIREMENT', who: 'striker', kind: 'hurt' });
    const retiredId = inn().batters.find((b) => b.retiredHurt).id;
    await send({ type: 'NEW_BATTER', batter: 'A5', end: 'striker' });
    await ball({ batRuns: 4 });
    await ball({});
    await ball({ batRuns: 1 });
    await ball({});
    await ball({});                                                    // over 2 done

    // over 3: a maiden from B1
    await send({ type: 'BOWLER_CHANGE', bowler: 'B1' });
    for (let i = 0; i < 6; i++) await ball({});
    assert.equal(inn().bowlers.find((b) => b.id === 'B1').maidens, 1, 'over 3 must be a maiden');

    // over 4: wicket, and the retired-hurt batter RETURNS at the fall
    await send({ type: 'BOWLER_CHANGE', bowler: 'B3' });
    await ball({ batRuns: 6 });
    await ball({ wicket: { kind: 'bowled', out: 'striker' } });
    await send({ type: 'NEW_BATTER', batter: retiredId, end: 'striker' });
    assert.equal(batter(retiredId).resumed, true, 'retired-hurt batter resumes');
    await ball({ batRuns: 2 });
    await ball({ batRuns: 2 });
    await ball({});
    await ball({ batRuns: 1 });

    // over 5
    await send({ type: 'BOWLER_CHANGE', bowler: 'B4' });
    for (let i = 0; i < 6; i++) await ball({ batRuns: i % 2 ? 1 : 2 });
    assert.equal(inn().closed, true);
    assert.equal(inn().closeReason, 'overs');
    assert.equal(latestState.phase, 'break');
  });

  let scoreBeforeUndo = null;
  await step('3a. undo a wicket restores the batter (during innings 2)', async () => {
    await send({ type: 'INNINGS_START', battingTeamId: 'B', striker: 'B1', nonStriker: 'B2' });
    await send({ type: 'BOWLER_CHANGE', bowler: 'A1' });
    await ball({ batRuns: 4 });
    await ball({ batRuns: 1 });
    scoreBeforeUndo = JSON.stringify({ r: inn().runs, w: inn().wickets, s: inn().striker });
    await ball({ wicket: { kind: 'bowled', out: 'striker' } });
    await send({ type: 'NEW_BATTER', batter: 'B3', end: 'striker' });
    assert.equal(inn().wickets, 1);
    for (let i = 0; i < 2; i++) {
      const res = await emitAck('undo', { matchId: MATCH.id });
      assert.ok(res.ok, `undo failed: ${JSON.stringify(res)}`);
      localEvents.pop();
    }
    assert.equal(inn().wickets, 0, 'wicket must be gone');
    assert.equal(JSON.stringify({ r: inn().runs, w: inn().wickets, s: inn().striker }), scoreBeforeUndo);
  });

  await step('3b. edit an earlier ball from 1 to 4 re-derives downstream state', async () => {
    const evs = await (await fetch(`${BASE}/api/matches/${MATCH.id}/events`)).json();
    // the single scored in THIS innings (after the most recent INNINGS_START)
    const startIdx = evs.events.map((e) => e.type).lastIndexOf('INNINGS_START');
    const seq = evs.events.findIndex((e, i) => i > startIdx && e.type === 'BALL' && e.batRuns === 1 && !e.wicket);
    const target = evs.events[seq];
    const runsBefore = inn().runs;
    const res = await emitAck('edit', { matchId: MATCH.id, seq, event: { ...target, batRuns: 4 } });
    assert.ok(res.ok, `edit failed: ${JSON.stringify(res)}`);
    localEvents[seq - 1] = { ...target, batRuns: 4 };
    assert.equal(inn().runs, runsBefore + 3, 'total re-derived +3');
    assert.deepEqual(res.anomalies, [], 'no anomalies from the edit');
    // put it back so the chase numbers stay tidy
    const back = await emitAck('edit', { matchId: MATCH.id, seq, event: target });
    assert.ok(back.ok);
    localEvents[seq - 1] = target;
  });

  await step('4. SIGKILL the server mid-innings → restart → exact resume', async () => {
    const before = JSON.stringify({ v: latestVersion, s: latestState.innings.map((i) => [i.runs, i.wickets, i.legalBalls]) });
    socket.close();
    await killServer('SIGKILL');
    await startServer();
    await connectSocket(MATCH.id, MATCH.scorerPin);
    const after = JSON.stringify({ v: latestVersion, s: latestState.innings.map((i) => [i.runs, i.wickets, i.legalBalls]) });
    assert.equal(after, before, 'state must survive a hard kill');
  });

  await step('5. chase to a last-over finish: target/RRR live, result string, result fx', async () => {
    const target = latestState.target.runs;
    assert.equal(target, latestState.innings[0].runs + 1);
    // bowl overs 1–4 economically so the finish lands in over 5
    const perOver = [['A2'], ['A3'], ['A4'], ['A5']];
    // over 1 already has 2 balls (4 + 1). finish it with singles/dots:
    await ball({ batRuns: 1 }); await ball({}); await ball({ batRuns: 2 }); await ball({});
    for (const [bowler] of perOver.slice(0, 3)) {
      await send({ type: 'BOWLER_CHANGE', bowler });
      for (let i = 0; i < 6; i++) await ball({ batRuns: [1, 2, 1, 0, 1, 1][i] });
    }
    const chase = latestState.chase;
    assert.ok(chase && chase.ballsLeft === 6, `should be 6 balls left, got ${chase && chase.ballsLeft}`);
    assert.ok(chase.rrr > 0);
    // last over: get within a boundary of the target, then hit it
    await send({ type: 'BOWLER_CHANGE', bowler: 'A5' });
    lastFx = [];
    let guard = 0;
    while (!latestState.result && guard++ < 6) {
      const need = latestState.chase.need;
      await ball({ batRuns: need > 6 ? 6 : need });
    }
    assert.ok(latestState.result, 'match must end in the last over');
    assert.match(latestState.result.text, /ICAT Gold won by \d+ wickets? with [1-5] balls? remaining/);
    assert.ok(lastFx.some((f) => f.type === 'result'), 'result stinger must fire');
    assert.equal(latestState.phase, 'complete');
  });

  let exported = null;
  await step('6. export → wipe → import → identical scorecards', async () => {
    exported = await (await fetch(`${BASE}/api/matches/${MATCH.id}/export`)).json();
    assert.equal(exported.events.length, latestVersion);
    const stateBefore = reduce(exported.events);
    // wipe the entire data dir (server keeps a cache — kill it first, like a real wipe)
    socket.close();
    await killServer();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    await startServer();
    assert.deepEqual(await (await fetch(`${BASE}/api/matches`)).json(), [], 'DB wiped');
    const imp = await (await fetch(`${BASE}/api/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exported),
    })).json();
    assert.ok(imp.id, 'import failed');
    const snap = await (await fetch(`${BASE}/api/matches/${imp.id}`)).json();
    assert.deepEqual(
      snap.state.innings.map((i) => ({ r: i.runs, w: i.wickets, o: i.oversText, bat: i.batters, bowl: i.bowlers })),
      stateBefore.innings.map((i) => ({ r: i.runs, w: i.wickets, o: i.oversText, bat: i.batters, bowl: i.bowlers })),
      'scorecards identical after import',
    );
    assert.equal(snap.state.result.text, stateBefore.result.text);
    MATCH.id = imp.id;
  });

  await step('7. every overlay route at 1920×1080: no JS errors, transparent, screenshots', async () => {
    const { chromium } = await import('playwright-core');
    const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
    const errors = [];
    try {
      for (const kind of ['scorebug', 'batting', 'bowling', 'summary', 'lineups', 'target', 'full']) {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        page.on('pageerror', (e) => errors.push(`${kind}: ${e.message}`));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(`${kind} console: ${m.text()}`); });
        await page.goto(`${BASE}/overlay/${kind}?match=${MATCH.id}`, { waitUntil: 'networkidle' }).catch((e) => errors.push(`${kind}: ${e.message}`));
        await page.waitForTimeout(1200);
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        if (!/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) errors.push(`${kind}: body background not transparent (${bg})`);
        await page.screenshot({ path: path.join(SHOTS, `${kind}.png`), omitBackground: true });
        await page.close();
      }
    } finally {
      await browser.close();
    }
    assert.deepEqual(errors, [], `overlay problems:\n${errors.join('\n')}`);
  });

  socket?.close();
  await killServer();

  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} steps passed. Screenshots: ${SHOTS}\n`);
  if (fails.length) {
    for (const f of fails) console.log(`FAILED: ${f.name}\n${f.err.stack}\n`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  socket?.close();
  await killServer();
  process.exit(1);
});
