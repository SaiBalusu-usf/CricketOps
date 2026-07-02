/**
 * Disk store — one directory per match:
 *   data/matches/<id>/meta.json          match id, name, PINs, timestamps
 *   data/matches/<id>/events.ndjson      the event log, one JSON event per line
 *   data/matches/<id>/presentation.json  director state (overlay toggles, ticker…)
 *
 * Every append is flushed to disk immediately; undo/edit rewrite the log
 * atomically (temp file + rename), so a crash can never corrupt a match.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const MATCHES_DIR = path.join(DATA_DIR, 'matches');

export function ensureDirs() {
  fs.mkdirSync(MATCHES_DIR, { recursive: true });
}

export function makeMatchId() {
  return `m-${crypto.randomBytes(3).toString('hex')}`;
}

export function makePin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

const dirOf = (id) => path.join(MATCHES_DIR, id);
const eventsFile = (id) => path.join(dirOf(id), 'events.ndjson');
const metaFile = (id) => path.join(dirOf(id), 'meta.json');
const presFile = (id) => path.join(dirOf(id), 'presentation.json');

function writeAtomic(file, contents) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

export const DEFAULT_PRESENTATION = {
  theme: 'broadcast',           // 'broadcast' | 'chroma' (green background fallback)
  ticker: '',
  auto: true,                   // auto stingers + auto cards when no director is driving
  show: {
    scorebug: true,
    batting: false,
    bowling: false,
    summary: false,
    lineups: false,
    target: false,
  },
};

export function createMatch(id, meta, firstEvent) {
  fs.mkdirSync(dirOf(id), { recursive: true });
  writeAtomic(metaFile(id), JSON.stringify(meta, null, 2));
  writeAtomic(presFile(id), JSON.stringify(DEFAULT_PRESENTATION, null, 2));
  writeAtomic(eventsFile(id), `${JSON.stringify(firstEvent)}\n`);
}

export function matchExists(id) {
  return typeof id === 'string' && /^[\w-]+$/.test(id) && fs.existsSync(metaFile(id));
}

export function readMeta(id) {
  return JSON.parse(fs.readFileSync(metaFile(id), 'utf8'));
}

export function writeMeta(id, meta) {
  writeAtomic(metaFile(id), JSON.stringify(meta, null, 2));
}

export function readEvents(id) {
  const raw = fs.readFileSync(eventsFile(id), 'utf8');
  const events = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      events.push(JSON.parse(s));
    } catch {
      // a torn final line from a crash mid-write: drop it, the event was never acked
    }
  }
  return events;
}

export function appendEvent(id, event) {
  fs.appendFileSync(eventsFile(id), `${JSON.stringify(event)}\n`);
}

export function rewriteEvents(id, events) {
  writeAtomic(eventsFile(id), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

export function readPresentation(id) {
  try {
    const p = JSON.parse(fs.readFileSync(presFile(id), 'utf8'));
    return { ...DEFAULT_PRESENTATION, ...p, show: { ...DEFAULT_PRESENTATION.show, ...(p.show || {}) } };
  } catch {
    return { ...DEFAULT_PRESENTATION, show: { ...DEFAULT_PRESENTATION.show } };
  }
}

export function writePresentation(id, pres) {
  writeAtomic(presFile(id), JSON.stringify(pres, null, 2));
}

export function listMatchIds() {
  if (!fs.existsSync(MATCHES_DIR)) return [];
  return fs.readdirSync(MATCHES_DIR).filter((d) => matchExists(d));
}

export function deleteMatch(id) {
  fs.rmSync(dirOf(id), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

const BRANDING_FILE = process.env.BRANDING_FILE || path.join(process.cwd(), 'config', 'branding.json');

export const DEFAULT_BRANDING = {
  orgName: 'ICAT',
  footer: 'ICAT — Tampa, FL',
  logo: null,        // data: URL (small PNG/SVG pasted in settings) or null
  sponsors: [],      // up to 3 { name, logo (data URL) }
  accent: '#f5b301',
};

export function readBranding() {
  try {
    return { ...DEFAULT_BRANDING, ...JSON.parse(fs.readFileSync(BRANDING_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_BRANDING };
  }
}

export function writeBranding(branding) {
  fs.mkdirSync(path.dirname(BRANDING_FILE), { recursive: true });
  const clean = { ...DEFAULT_BRANDING, ...branding };
  if (Array.isArray(clean.sponsors)) clean.sponsors = clean.sponsors.slice(0, 3);
  writeAtomic(BRANDING_FILE, JSON.stringify(clean, null, 2));
  return clean;
}
