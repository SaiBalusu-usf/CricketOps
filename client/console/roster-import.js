/**
 * Roster import for the match wizard: teams + players from a shared
 * spreadsheet. Accepts .xlsx, .csv, .tsv and .txt with zero dependencies —
 * the .xlsx path reads the ZIP container by hand and inflates entries with
 * the browser's native DecompressionStream.
 *
 * Accepted layouts (auto-detected):
 *   A) columns are teams: header row = team names, each row below = players
 *   B) two columns of (team, player) pairs, one player per row
 *      (an optional "Team,Player"-style header row is skipped)
 *
 * parseRosterFile(file) → [{ name, players: [string, …] }, …]
 */

// ---------------------------------------------------------------------------
// delimited text (.csv / .tsv / pasted Excel range)
// ---------------------------------------------------------------------------

export function parseDelimited(text) {
  const delim = text.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------
// minimal .xlsx reader (ZIP central directory + deflate-raw + sheet XML)
// ---------------------------------------------------------------------------

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Unzip → Map<path, Uint8Array>. Enough of the ZIP spec for xlsx files. */
async function unzip(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  // find End Of Central Directory (PK\x05\x06) in the trailing 64 KB
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip/xlsx file');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break; // central dir entry
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(b.subarray(off + 46, off + 46 + nameLen));
    // local header tells us where the data really starts
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = b.subarray(dataStart, dataStart + compSize);
    files.set(name, { method, raw });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const out = new Map();
  for (const [name, { method, raw }] of files) {
    if (!/\.xml$/i.test(name)) continue; // we only need the XML parts
    out.set(name, method === 0 ? raw : await inflateRaw(raw));
  }
  return out;
}

const decodeEntities = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, '&');

function parseSharedStrings(xmlBytes) {
  if (!xmlBytes) return [];
  const xml = new TextDecoder().decode(xmlBytes);
  const out = [];
  for (const si of xml.match(/<si[\s>][\s\S]*?<\/si>/g) || []) {
    const parts = [];
    for (const t of si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []) {
      parts.push(decodeEntities(t.replace(/<t[^>]*>|<\/t>/g, '')));
    }
    out.push(parts.join(''));
  }
  return out;
}

const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref) {
    if (ch >= 'A' && ch <= 'Z') n = n * 26 + (ch.charCodeAt(0) - 64);
    else break;
  }
  return n - 1;
};

function parseSheet(xmlBytes, shared) {
  const xml = new TextDecoder().decode(xmlBytes);
  const rows = [];
  for (const rowXml of xml.match(/<row[\s>][\s\S]*?<\/row>/g) || []) {
    const row = [];
    for (const cXml of rowXml.match(/<c[\s>][\s\S]*?(<\/c>|\/>)/g) || []) {
      const ref = (cXml.match(/r="([A-Z]+)\d+"/) || [])[1];
      const type = (cXml.match(/t="(\w+)"/) || [])[1];
      let val = '';
      if (type === 'inlineStr') {
        val = decodeEntities((cXml.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [, ''])[1]);
      } else {
        const v = (cXml.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (v !== undefined) val = type === 's' ? (shared[+v] ?? '') : decodeEntities(v);
      }
      const idx = ref ? colIndex(ref) : row.length;
      row[idx] = val;
    }
    rows.push(Array.from(row, (c) => c ?? ''));
  }
  return rows;
}

async function readXlsx(buf) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser cannot read .xlsx — save the sheet as CSV instead');
  }
  const files = await unzip(buf);
  const shared = parseSharedStrings(files.get('xl/sharedStrings.xml'));
  const sheetPath = files.has('xl/worksheets/sheet1.xml')
    ? 'xl/worksheets/sheet1.xml'
    : [...files.keys()].find((p) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(p));
  if (!sheetPath) throw new Error('no worksheet found in this file');
  return parseSheet(files.get(sheetPath), shared);
}

// ---------------------------------------------------------------------------
// layout detection: rows matrix → teams
// ---------------------------------------------------------------------------

export function rowsToTeams(rowsIn) {
  const rows = rowsIn
    .map((r) => r.map((c) => String(c ?? '').trim()))
    .filter((r) => r.some((c) => c !== ''));
  if (!rows.length) throw new Error('the sheet is empty');

  const width = Math.max(...rows.map((r) => r.length));

  // Layout B: exactly two used columns of (team, player) pairs
  if (width === 2 && rows.length >= 3) {
    let body = rows;
    const head = rows[0].map((c) => c.toLowerCase());
    if (head[0].includes('team') || head[1].includes('player') || head[1].includes('name')) {
      body = rows.slice(1);
    }
    const teamNames = body.map((r) => r[0]).filter(Boolean);
    const distinct = [...new Set(teamNames)];
    // repeated team values ⇒ definitely pairs, not two team columns
    if (distinct.length < teamNames.length && distinct.length >= 1) {
      const byTeam = new Map();
      for (const r of body) {
        const team = r[0] || [...byTeam.keys()].pop(); // blank = same team as above
        const player = r[1];
        if (!team || !player) continue;
        if (!byTeam.has(team)) byTeam.set(team, []);
        byTeam.get(team).push(player);
      }
      return [...byTeam.entries()].map(([name, players]) => ({ name, players }));
    }
  }

  // Layout A: header row = team names, columns of players below
  const header = rows[0];
  const teams = [];
  for (let c = 0; c < width; c++) {
    const name = (header[c] || '').trim();
    if (!name) continue;
    const players = rows.slice(1).map((r) => (r[c] || '').trim()).filter(Boolean);
    if (players.length) teams.push({ name, players });
  }
  if (!teams.length) throw new Error('could not find teams — put team names in the first row, players below them (or use Team,Player columns)');
  return teams;
}

/** Main entry: File → [{ name, players }] */
export async function parseRosterFile(file) {
  const isXlsx = /\.xlsx$/i.test(file.name)
    || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (/\.xls$/i.test(file.name) && !isXlsx) {
    throw new Error('old .xls files are not supported — save as .xlsx or .csv');
  }
  const rows = isXlsx
    ? await readXlsx(await file.arrayBuffer())
    : parseDelimited(await file.text());
  return rowsToTeams(rows);
}
