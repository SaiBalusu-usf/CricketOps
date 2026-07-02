/**
 * Test harness for the scoring engine. Builds an event log through the same
 * validateAppend gate the server uses, so tests fail loudly if the engine
 * would reject input the console is expected to produce.
 */
import { matchCreatedEvent, reduce, validateAppend } from '../index.js';

export function makeConfig(overrides = {}) {
  return {
    teams: [
      {
        name: 'ICAT Blue', short: 'BLU', color: '#1d4ed8',
        players: ['Arun', 'Bala', 'Chetan', 'Dinesh', 'Emil', 'Farhan', 'Ganesh', 'Hari', 'Ishan', 'Jai', 'Kiran'],
      },
      {
        name: 'ICAT Gold', short: 'GLD', color: '#b45309',
        players: ['Naveen', 'Omar', 'Pranav', 'Qadir', 'Rohit', 'Sanjay', 'Tarun', 'Uday', 'Vikram', 'Wasim', 'Yash'],
      },
    ],
    oversPerInnings: 5,
    ...overrides,
  };
}

let seq = 0;

export class Match {
  constructor(cfgOverrides = {}) {
    this.events = [matchCreatedEvent(makeConfig(cfgOverrides), `t${++seq}`, 0)];
  }

  get state() { return reduce(this.events); }

  /** Validate + append. Throws on validation errors unless expectErrors. */
  push(ev, { force = false } = {}) {
    const v = validateAppend(this.state, ev);
    if (!force && v.errors.length) {
      throw new Error(`validation rejected ${ev.type}: ${v.errors.join('; ')}`);
    }
    this.events.push({ id: `t${++seq}`, ts: 0, ...ev });
    return this;
  }

  /** Validation result without appending. */
  check(ev) { return validateAppend(this.state, ev); }

  startInnings(battingTeamId, striker, nonStriker = null) {
    return this.push({ type: 'INNINGS_START', battingTeamId, striker, nonStriker });
  }

  bowler(id) { return this.push({ type: 'BOWLER_CHANGE', bowler: id }); }

  ball(over = {}) {
    return this.push({ type: 'BALL', legality: 'legal', batRuns: 0, extraRuns: 0, ...over });
  }

  runs(n) { return this.ball({ batRuns: n }); }
  dot() { return this.ball({}); }
  wide(extraRuns = 0, wicket = null) { return this.ball({ legality: 'wide', extraRuns, wicket }); }
  nb(batRuns = 0, rest = {}) { return this.ball({ legality: 'noball', batRuns, ...rest }); }
  bye(n) { return this.ball({ extraType: 'bye', extraRuns: n }); }
  legbye(n) { return this.ball({ extraType: 'legbye', extraRuns: n }); }

  out(kind, { out = 'striker', fielders = [], crossed = false, ball = {} } = {}) {
    return this.ball({ wicket: { kind, out, fielders, crossed }, ...ball });
  }

  newBatter(batter, end = 'striker') { return this.push({ type: 'NEW_BATTER', batter, end }); }
  retire(who = 'striker', kind = 'hurt') { return this.push({ type: 'RETIREMENT', who, kind }); }
  declare() { return this.push({ type: 'INNINGS_DECLARED' }); }

  /** Innings view: index or latest. */
  inn(i = null) {
    const s = this.state;
    return s.innings[i === null ? s.innings.length - 1 : i];
  }

  batter(pid, i = null) { return this.inn(i).batters.find((b) => b.id === pid); }
  bowlerRow(pid, i = null) { return this.inn(i).bowlers.find((b) => b.id === pid); }
}

/** A team-A innings, ready to bowl: A1 on strike, A2 non-striker, B1 bowling. */
export function openMatch(cfgOverrides = {}) {
  return new Match(cfgOverrides).startInnings('A', 'A1', 'A2').bowler('B1');
}

/**
 * Fast-forward a short first innings so a chase can be tested:
 * team A scores `runs` (as one boundary-ish lump of singles) then declares.
 */
export function firstInnings(m, runsWanted) {
  m.startInnings('A', 'A1', 'A2').bowler('B1');
  let scored = 0;
  let ballCount = 0;
  while (scored < runsWanted) {
    if (ballCount > 0 && ballCount % 6 === 0) m.bowler((ballCount / 6) % 2 === 1 ? 'B2' : 'B1');
    const chunk = Math.min(4, runsWanted - scored);
    m.runs(chunk);
    scored += chunk;
    ballCount += 1;
  }
  m.declare();
  return m;
}
