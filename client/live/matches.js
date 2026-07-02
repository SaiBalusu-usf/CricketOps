/* /matches — every match on this server, linking to /live/:id. */

import { $, h } from '/client/shared/app.js';

function toast(msg) {
  const el = h('div', { class: 'toast' }, msg);
  $('#toasts').append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2600);
}

function ago(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60e3) return 'just now';
  if (d < 3600e3) return `${Math.floor(d / 60e3)}m ago`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function statusPill(m) {
  if (m.phase === 'live') return h('span', { class: 'pill live' }, 'LIVE');
  if (m.phase === 'break') return h('span', { class: 'pill' }, 'BREAK');
  if (m.phase === 'complete') return h('span', { class: 'pill final' }, 'FINAL');
  return h('span', { class: 'pill' }, 'SETUP');
}

function card(m) {
  const rows = m.teams.map((t) => {
    const reg = m.innings.find((i) => !i.superOver && i.battingTeamId === t.id);
    const so = m.innings.find((i) => i.superOver && i.battingTeamId === t.id);
    return h('div', { class: 'mrow' },
      h('span', { class: 'tchip', style: { background: t.color } }),
      h('span', { class: 'tn' }, t.name),
      reg
        ? h('span', { class: 'ts' }, `${reg.runs}/${reg.wickets}`,
            h('small', {}, ` (${String(reg.overs).replace(/\.0$/, '')})`),
            so ? h('small', {}, ` · SO ${so.runs}/${so.wickets}`) : null)
        : h('span', { class: 'ts' }, h('small', {}, 'yet to bat')));
  });
  return h('a', { class: 'mcard card', href: `/live/${m.id}` },
    rows,
    h('div', { class: 'mfoot' },
      statusPill(m),
      h('span', { class: 'res' }, m.result ? m.result.text : (m.phase === 'live' ? 'In progress' : '')),
      h('span', { class: 'when' }, ago(m.updatedAt))));
}

async function load() {
  const list = $('#list');
  let matches;
  try {
    matches = await (await fetch('/api/matches')).json();
  } catch {
    if (!list.children.length) list.append(h('p', { class: 'empty' }, 'Could not reach the server.'));
    return;
  }
  matches.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  list.textContent = '';
  if (!matches.length) {
    list.append(h('p', { class: 'empty' }, 'No matches yet. Start one from the ', h('a', { href: '/console?new=1' }, 'console'), '.'));
    return;
  }
  for (const m of matches) list.append(card(m));
}

$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let body;
  try { body = JSON.parse(await file.text()); } catch { toast('Not a valid match file'); return; }
  try {
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const out = await res.json();
    if (!res.ok || !out.id) throw new Error(out.error || 'import failed');
    await load();
    toast(`Imported — opening ${out.id}`);
    setTimeout(() => { location.href = `/live/${out.id}`; }, 900);
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
});

load();
setInterval(load, 10000); // keep scores fresh
