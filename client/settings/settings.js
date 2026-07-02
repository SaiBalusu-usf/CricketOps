/* Branding editor — GET/PUT /api/branding; the server broadcasts changes to overlays. */

import { $, h } from '/client/shared/app.js';

const DEFAULTS = { orgName: 'ICAT', footer: 'ICAT — Tampa, FL', logo: null, sponsors: [], accent: '#f5b301' };
let model = { ...DEFAULTS };

function toast(msg) {
  const el = h('div', { class: 'toast' }, msg);
  $('#toasts').append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2200);
}

/** File → PNG data URL, longest side ≤ max px (keeps overlay payloads tiny). */
function downscale(file, max = 128) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const sc = Math.min(1, max / Math.max(img.width, img.height, 1));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * sc));
      c.height = Math.max(1, Math.round(img.height * sc));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read image')); };
    img.src = url;
  });
}

function thumb(el, dataUrl) {
  el.textContent = '';
  if (dataUrl) el.append(h('img', { src: dataUrl, alt: '' }));
  else el.textContent = 'none';
}

// ---------------------------------------------------------------------------
// Sponsors — three fixed slots
// ---------------------------------------------------------------------------

const slots = [0, 1, 2].map((i) => {
  const nameIn = h('input', { type: 'text', maxlength: 40, placeholder: `Sponsor ${i + 1} name`, oninput: sync });
  const th = h('span', { class: 'thumb' }, 'none');
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      slot.logo = await downscale(f);
      thumb(th, slot.logo);
      clear.hidden = false;
      sync();
    } catch { toast('Could not read that image'); }
  } });
  const clear = h('button', { class: 'btn ghost', type: 'button', hidden: true, onclick: () => {
    slot.logo = null;
    thumb(th, null);
    clear.hidden = true;
    sync();
  } }, '×');
  const pick = h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, 'Logo');
  const slot = { logo: null, nameIn, th, clear };
  $('#sponsors').append(h('div', { class: 'sponsor' }, th, nameIn, pick, clear, file));
  return slot;
});

// ---------------------------------------------------------------------------
// Form ⇄ model ⇄ preview
// ---------------------------------------------------------------------------

function fill() {
  $('#orgName').value = model.orgName || '';
  $('#footer').value = model.footer || '';
  $('#accent').value = /^#[0-9a-fA-F]{6}$/.test(model.accent || '') ? model.accent : DEFAULTS.accent;
  thumb($('#logoThumb'), model.logo);
  $('#logoClear').hidden = !model.logo;
  slots.forEach((slot, i) => {
    const sp = (model.sponsors || [])[i] || {};
    slot.nameIn.value = sp.name || '';
    slot.logo = sp.logo || null;
    thumb(slot.th, slot.logo);
    slot.clear.hidden = !slot.logo;
  });
  sync();
}

function sync() {
  model.orgName = $('#orgName').value.trim() || DEFAULTS.orgName;
  model.footer = $('#footer').value.trim();
  model.accent = $('#accent').value;
  model.sponsors = slots
    .map((slot) => ({ name: slot.nameIn.value.trim(), logo: slot.logo }))
    .filter((sp) => sp.name || sp.logo);

  // preview
  document.documentElement.style.setProperty('--accent', model.accent);
  $('#accentHex').textContent = model.accent;
  $('#pvOrg').textContent = model.orgName;
  $('#pvFooter').textContent = model.footer || ' ';
  const pvLogo = $('#pvLogo');
  pvLogo.hidden = !model.logo;
  if (model.logo) pvLogo.src = model.logo;
  const pvS = $('#pvSponsors');
  pvS.textContent = '';
  for (const sp of model.sponsors) {
    pvS.append(sp.logo ? h('img', { src: sp.logo, alt: sp.name || '' }) : h('span', { class: 'sname' }, sp.name));
  }
}

$('#orgName').addEventListener('input', sync);
$('#footer').addEventListener('input', sync);
$('#accent').addEventListener('input', sync);

$('#logoPick').addEventListener('click', () => $('#logoFile').click());
$('#logoFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    model.logo = await downscale(f);
    thumb($('#logoThumb'), model.logo);
    $('#logoClear').hidden = false;
    sync();
  } catch { toast('Could not read that image'); }
});
$('#logoClear').addEventListener('click', () => {
  model.logo = null;
  thumb($('#logoThumb'), null);
  $('#logoClear').hidden = true;
  sync();
});

// ---------------------------------------------------------------------------
// Save / reset
// ---------------------------------------------------------------------------

async function put(body) {
  // saving from another device needs a scorer/director PIN (B2);
  // localhost saves stay frictionless — the server only 401s remote callers
  const headers = { 'Content-Type': 'application/json' };
  const saved = sessionStorage.getItem('icat-settings-pin');
  if (saved) headers['x-icat-pin'] = saved;
  let res = await fetch('/api/branding', { method: 'PUT', headers, body: JSON.stringify(body) });
  if (res.status === 401 || res.status === 429) {
    const ask = res.status === 429
      ? 'Too many wrong PINs — wait a bit, then enter a scorer or director PIN:'
      : 'Enter a scorer or director PIN to change branding from this device:';
    const pin = window.prompt(ask);
    if (!pin || !pin.trim()) throw new Error('a PIN is needed to save from this device');
    headers['x-icat-pin'] = pin.trim();
    res = await fetch('/api/branding', { method: 'PUT', headers, body: JSON.stringify(body) });
    if (res.ok) sessionStorage.setItem('icat-settings-pin', pin.trim());
    else if (res.status === 401) sessionStorage.removeItem('icat-settings-pin');
  }
  if (!res.ok) throw new Error(`save failed (${res.status})`);
  return res.json();
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  sync();
  try {
    model = await put(model);
    fill();
    toast('Saved — overlays updated live');
  } catch (err) {
    toast(err.message);
  }
});

$('#resetBtn').addEventListener('click', async () => {
  if (!confirm('Reset branding to defaults?')) return;
  try {
    model = await put({ ...DEFAULTS });
    fill();
    toast('Branding reset');
  } catch (err) {
    toast(err.message);
  }
});

// boot
(async () => {
  try { model = { ...DEFAULTS, ...(await (await fetch('/api/branding')).json()) }; } catch { /* defaults */ }
  fill();
})();
