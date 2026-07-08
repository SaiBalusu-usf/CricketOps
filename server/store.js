/**
 * Postgres store.
 *
 * The cricket engine still treats a match as an append-only event log. This
 * module owns the durable side: matches, event rows, presentation state,
 * branding, and write-only stream keys.
 */
import crypto from 'node:crypto';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://icat:icat_local@postgres:5432/icat_cricket';
const pool = new Pool({ connectionString: DATABASE_URL });

export function makeMatchId() {
  return `m-${crypto.randomBytes(3).toString('hex')}`;
}

export function makePin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

export const DEFAULT_PRESENTATION = {
  theme: 'broadcast',
  ticker: '',
  auto: true,
  // card carousel at over/innings breaks: batting → bowling → summary (…)
  // take turns on screen until the next ball is bowled
  rotate: { enabled: true, seconds: 8 },
  show: {
    scorebug: true,
    batting: false,
    bowling: false,
    summary: false,
    lineups: false,
    target: false,
  },
};

export const DEFAULT_BRANDING = {
  orgName: 'ICAT',
  footer: 'ICAT — Tampa, FL',
  logo: null,
  sponsors: [],
  accent: '#f5b301',
};

async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function withTx(fn) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

function extraMeta(meta) {
  const {
    id, createdAt, updatedAt, scorerPin, directorPin, rev,
    ...rest
  } = meta || {};
  return rest;
}

function rowToMeta(row) {
  if (!row) return null;
  return {
    ...(row.meta || {}),
    id: row.id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    scorerPin: row.scorer_pin,
    directorPin: row.director_pin,
    rev: Number(row.rev || 0),
  };
}

function normalizePresentation(p) {
  return {
    ...DEFAULT_PRESENTATION,
    ...(p || {}),
    show: { ...DEFAULT_PRESENTATION.show, ...((p && p.show) || {}) },
    rotate: { ...DEFAULT_PRESENTATION.rotate, ...((p && p.rotate) || {}) },
  };
}

function normalizeBranding(branding) {
  const clean = { ...DEFAULT_BRANDING, ...(branding || {}) };
  if (Array.isArray(clean.sponsors)) clean.sponsors = clean.sponsors.slice(0, 3);
  else clean.sponsors = [];
  return clean;
}

export async function ensureDirs() {
  const attempts = Number(process.env.DB_CONNECT_ATTEMPTS || 60);
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await migrate();
      if (process.env.RESET_STORE_ON_START === '1') await clearAll();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastErr;
}

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id text PRIMARY KEY,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      scorer_pin text NOT NULL,
      director_pin text NOT NULL,
      rev integer NOT NULL DEFAULT 0,
      meta jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS match_events (
      match_id text NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      seq integer NOT NULL,
      event_id text NOT NULL,
      event jsonb NOT NULL,
      PRIMARY KEY (match_id, seq),
      UNIQUE (match_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS match_presentation (
      match_id text PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
      presentation jsonb NOT NULL
    );

    CREATE TABLE IF NOT EXISTS match_stream_keys (
      match_id text PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
      stream_key text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL
    );

    CREATE INDEX IF NOT EXISTS match_events_match_seq_idx
      ON match_events(match_id, seq);
    CREATE INDEX IF NOT EXISTS matches_updated_idx
      ON matches(updated_at DESC);
  `);
}

export async function clearAll() {
  await pool.query('TRUNCATE app_settings, matches RESTART IDENTITY CASCADE');
}

export async function createMatch(id, meta, firstEvent) {
  await withTx(async (client) => {
    await client.query(
      `INSERT INTO matches
        (id, created_at, updated_at, scorer_pin, director_pin, rev, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        id,
        meta.createdAt,
        meta.updatedAt || meta.createdAt,
        meta.scorerPin,
        meta.directorPin,
        meta.rev || 0,
        JSON.stringify(extraMeta(meta)),
      ],
    );
    await client.query(
      `INSERT INTO match_presentation (match_id, presentation)
       VALUES ($1, $2::jsonb)`,
      [id, JSON.stringify(DEFAULT_PRESENTATION)],
    );
    await client.query(
      `INSERT INTO match_events (match_id, seq, event_id, event)
       VALUES ($1, 0, $2, $3::jsonb)`,
      [id, firstEvent.id || `created-${id}`, JSON.stringify(firstEvent)],
    );
  });
}

export async function matchExists(id) {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) return false;
  const res = await pool.query('SELECT 1 FROM matches WHERE id = $1', [id]);
  return res.rowCount > 0;
}

export async function readMeta(id) {
  const res = await pool.query('SELECT * FROM matches WHERE id = $1', [id]);
  if (!res.rowCount) throw new Error(`no such match: ${id}`);
  return rowToMeta(res.rows[0]);
}

export async function writeMeta(id, meta) {
  await pool.query(
    `UPDATE matches
     SET created_at = $2,
         updated_at = $3,
         scorer_pin = $4,
         director_pin = $5,
         rev = $6,
         meta = $7::jsonb
     WHERE id = $1`,
    [
      id,
      meta.createdAt,
      meta.updatedAt || meta.createdAt,
      meta.scorerPin,
      meta.directorPin,
      meta.rev || 0,
      JSON.stringify(extraMeta(meta)),
    ],
  );
}

export async function readEvents(id) {
  const res = await pool.query(
    'SELECT event FROM match_events WHERE match_id = $1 ORDER BY seq ASC',
    [id],
  );
  return res.rows.map((r) => r.event);
}

export async function appendEvent(id, event) {
  await withTx(async (client) => {
    await client.query('SELECT id FROM matches WHERE id = $1 FOR UPDATE', [id]);
    await client.query(
      `INSERT INTO match_events (match_id, seq, event_id, event)
       SELECT $1, COALESCE(MAX(seq) + 1, 0), $2, $3::jsonb
       FROM match_events
       WHERE match_id = $1`,
      [id, event.id || crypto.randomUUID(), JSON.stringify(event)],
    );
  });
}

export async function rewriteEvents(id, events) {
  await withTx(async (client) => {
    await client.query('SELECT id FROM matches WHERE id = $1 FOR UPDATE', [id]);
    await client.query('DELETE FROM match_events WHERE match_id = $1', [id]);
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      await client.query(
        `INSERT INTO match_events (match_id, seq, event_id, event)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [id, i, event.id || `${id}-${i}`, JSON.stringify(event)],
      );
    }
  });
}

export async function readPresentation(id) {
  const res = await pool.query(
    'SELECT presentation FROM match_presentation WHERE match_id = $1',
    [id],
  );
  return normalizePresentation(res.rows[0]?.presentation);
}

export async function writePresentation(id, pres) {
  const clean = normalizePresentation(pres);
  await pool.query(
    `INSERT INTO match_presentation (match_id, presentation)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (match_id) DO UPDATE SET presentation = EXCLUDED.presentation`,
    [id, JSON.stringify(clean)],
  );
  return clean;
}

export async function listMatchIds() {
  const res = await pool.query('SELECT id FROM matches ORDER BY updated_at DESC, created_at DESC');
  return res.rows.map((r) => r.id);
}

export async function deleteMatch(id) {
  await pool.query('DELETE FROM matches WHERE id = $1', [id]);
}

export async function writeStreamKey(id, key) {
  await pool.query(
    `INSERT INTO match_stream_keys (match_id, stream_key)
     VALUES ($1, $2)
     ON CONFLICT (match_id) DO UPDATE SET stream_key = EXCLUDED.stream_key`,
    [id, key],
  );
}

export async function readStreamKey(id) {
  const res = await pool.query(
    'SELECT stream_key FROM match_stream_keys WHERE match_id = $1',
    [id],
  );
  return res.rows[0]?.stream_key || null;
}

export async function clearStreamKey(id) {
  await pool.query('DELETE FROM match_stream_keys WHERE match_id = $1', [id]);
}

export async function readBranding() {
  const res = await pool.query("SELECT value FROM app_settings WHERE key = 'branding'");
  return normalizeBranding(res.rows[0]?.value);
}

export async function writeBranding(branding) {
  const clean = normalizeBranding(branding);
  await pool.query(
    `INSERT INTO app_settings (key, value)
     VALUES ('branding', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(clean)],
  );
  return clean;
}

export async function close() {
  await pool.end();
}
