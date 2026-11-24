'use strict';

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const $ = id => document.getElementById(id);
const state = { cfg: LS.get('thali.cfg', null), data: LS.get('thali.data', null), busy: false };

// ---------- API ----------
async function api(action, params = {}) {
  if (!state.cfg) throw new Error('Not connected yet');
  const u = new URL(state.cfg.url);
  u.searchParams.set('action', action);
  u.searchParams.set('token', state.cfg.token);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  u.searchParams.set('_', Date.now()); // no caching
  const res = await fetch(u.toString(), { method: 'GET', redirect: 'follow' });
  if (!res.ok) throw new Error('The sheet answered ' + res.status);
  let body;
  try { body = await res.json(); } catch { throw new Error('Unexpected answer – check the web app URL and that it is deployed for "Anyone".'); }
  if (body.error === 'unauthorized') throw new Error('Wrong token – check Settings.');
  if (body.error) throw new Error(body.error);
  return body;
}

async function run(action, params, btn) {
  if (state.busy) return;
  state.busy = true;
  setBusy(true, btn);
  try {
    const data = await api(action, params);
    state.data = data;
    LS.set('thali.data', data);
    showStatus('');
    render();
  } catch (e) {
    const offline = !navigator.onLine;
    showStatus(offline ? 'You are offline – showing the last saved week.' : e.message, !offline);
  } finally {
    state.busy = false;
    setBusy(false, btn);
  }
}

function setBusy(on, btn) {
  $('refreshBtn').classList.toggle('spinning', on);
  document.querySelectorAll('.dish button').forEach(b => b.disabled = on);
  if (btn) btn.disabled = on;
}

function showStatus(msg, isErr) {
  const el = $('status');
  el.hidden = !msg;
  el.textContent = msg || '';
  el.classList.toggle('err', !!isErr);
}

// ---------- helpers ----------
const fmtDate = iso => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const days = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function splitItems(s) {
  // "Paneer, cream (optional), green & dry red chillies" → items; drop "Optional tempering:" prefixes
  return String(s || '')
    .replace(/^optional tempering:\s*/i, '')
    .split(/,(?![^()]*\))/)
    .map(x => x.trim()).filter(Boolean);
}
const keyOf = s => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim()
  .replace(/chillies$/, 'chili').replace(/chilies$/, 'chili').replace(/chilli$/, 'chili');

function shopping(picks) {
  const veg = new Map(), other = new Map(), spice = new Map();
  for (const d of picks) {
    for (const v of d.veggies || []) {
      if (!veg.has(v)) veg.set(v, []);
      veg.get(v).push(d.name);
    }
    for (const it of splitItems(d.other)) {
      const k = keyOf(it);
      if (!other.has(k)) other.set(k, { label: it.charAt(0).toUpperCase() + it.slice(1), dishes: [] });
      other.get(k).dishes.push(d.name);
    }
    for (const it of splitItems(d.spices)) {
      const k = keyOf(it);
      if (!spice.has(k)) spice.set(k, it);
    }
  }
  return { veg, other, spice };
}

// ---------- render ----------
function render() {
  const d = state.data;
  const connected = !!state.cfg;
  $('setupView').hidden = connected && !state.editing;
  $('weekView').hidden = !connected || state.editing || !d;
  $('cancelSetup').hidden = !connected;
  $('setupExtra').hidden = !connected;
  if (!connected || !d) { $('weekLabel').textContent = connected ? 'Loading…' : 'Set up to start'; return; }

  $('weekLabel').textContent = 'Week of ' + fmtDate(d.week);
  const s = d.settings || {};
  $('nextNote').textContent = 'New picks every ' + (days[s.rollDay || 1]) + ' from ' +
    String(s.rollHour ?? 18).padStart(2, '0') + ':00. Swap anything you don’t fancy.';

  // dishes
  const list = $('dishList');
  list.replaceChildren();
  const tpl = $('dishTpl');
  d.picks.forEach((p, i) => {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.classList.toggle('done', !!p.cooked);
    li.querySelector('.num').textContent = i + 1;
    li.querySelector('.name').textContent = p.name;
    li.querySelector('.meta').textContent = [p.region, p.time ? p.time + ' min' : '', p.difficulty].filter(Boolean).join(' · ');
    li.querySelector('.cat').textContent = p.category;
    const chips = li.querySelector('.chips');
    (p.veggies || []).forEach(v => { const c = document.createElement('li'); c.textContent = v; chips.append(c); });
    if (!(p.veggies || []).length) chips.remove();
    li.querySelector('.other').textContent = p.other || '—';
    li.querySelector('.spice').textContent = p.spices || '—';
    li.querySelector('.last').textContent = p.cooked ? 'Cooked this week' :
      (p.lastCooked ? 'Last cooked ' + fmtDate(p.lastCooked) : 'Not cooked yet');
    const cook = li.querySelector('.cook');
    cook.setAttribute('aria-pressed', p.cooked ? 'true' : 'false');
    cook.textContent = p.cooked ? 'Cooked ✓' : 'Cooked';
    cook.addEventListener('click', () => {
      if (p.cooked) {
        const prev = LS.get('thali.prev', {})[p.name] || '';
        run('cooked', { dish: p.name, undo: '1', prev }, cook);
      } else {
        const prevMap = LS.get('thali.prev', {});
        prevMap[p.name] = p.lastCooked || '';
        LS.set('thali.prev', prevMap);
        run('cooked', { dish: p.name }, cook);
      }
    });
    const swap = li.querySelector('.swap');
    swap.hidden = !!p.cooked;
    swap.addEventListener('click', () => run('swap', { index: i }, swap));
    list.append(li);
  });

  // shopping list
  const ticks = LS.get('thali.ticks.' + d.week, {});
  const { veg, other, spice } = shopping(d.picks);
  const mk = (id, label, forList) => {
    const li = document.createElement('li');
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !!ticks[id];
    cb.addEventListener('change', () => { ticks[id] = cb.checked; LS.set('thali.ticks.' + d.week, ticks); });
    const span = document.createElement('span');
    span.textContent = label;
    const f = document.createElement('small');
    f.className = 'for'; f.textContent = 'for ' + forList.join(', ');
    span.append(f);
    lab.append(cb, span); li.append(lab);
    return li;
  };
  $('vegList').replaceChildren(...[...veg.entries()].sort((a, b) => b[1].length - a[1].length)
    .map(([v, ds]) => mk('v:' + v, v, ds)));
  if (!veg.size) $('vegList').innerHTML = '<li><label><span class="muted">No fresh vegetables needed.</span></label></li>';
  $('otherList').replaceChildren(...[...other.entries()].map(([k, o]) => mk('o:' + k, o.label, o.dishes)));
  $('spiceList').textContent = [...spice.values()].join(' · ') || '—';
}

function listAsText() {
  const d = state.data; if (!d) return '';
  const { veg, other, spice } = shopping(d.picks);
  return [
    'Weekly Thali – week of ' + fmtDate(d.week),
    '', 'Dishes:', ...d.picks.map((p, i) => `${i + 1}. ${p.name}`),
    '', 'Vegetables:', ...[...veg.keys()].map(v => '- ' + v),
    '', 'Other:', ...[...other.values()].map(o => '- ' + o.label),
    '', 'Spices: ' + [...spice.values()].join(', '),
  ].join('\n');
}

// ---------- events ----------
function selectTab(shop) {
  $('tabDishes').setAttribute('aria-selected', String(!shop));
  $('tabShop').setAttribute('aria-selected', String(shop));
  $('dishesPanel').hidden = shop;
  $('shopPanel').hidden = !shop;
}

function init() {
  $('tabDishes').addEventListener('click', () => selectTab(false));
  $('tabShop').addEventListener('click', () => selectTab(true));
  $('refreshBtn').addEventListener('click', () => state.cfg && run('week'));
  $('settingsBtn').addEventListener('click', () => {
    state.editing = true;
    $('urlInput').value = state.cfg?.url || '';
    $('tokenInput').value = state.cfg?.token || '';
    render();
  });
  $('cancelSetup').addEventListener('click', () => { state.editing = false; render(); });
  $('setupForm').addEventListener('submit', e => {
    e.preventDefault();
    state.cfg = { url: $('urlInput').value.trim(), token: $('tokenInput').value.trim() };
    LS.set('thali.cfg', state.cfg);
    state.editing = false;
    render();
    run('week');
  });
  $('regenBtn').addEventListener('click', () => {
    if (!confirmInline()) return;
    state.editing = false; render(); run('regen');
  });
  $('shareList').addEventListener('click', async () => {
    const text = listAsText();
    try {
      if (navigator.share) await navigator.share({ title: 'Shopping list', text });
      else { await navigator.clipboard.writeText(text); showStatus('Shopping list copied.'); }
    } catch { /* user cancelled */ }
  });
  $('clearTicks').addEventListener('click', () => {
    if (state.data) LS.set('thali.ticks.' + state.data.week, {});
    render();
  });

  render();
  if (state.cfg) run('week');
  else { $('weekView').hidden = true; }

  // refresh when the app comes back to the foreground (e.g. Monday evening)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.cfg && !state.editing) run('week');
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

// A second tap within 4 s confirms, instead of a blocking dialog.
let armedAt = 0;
function confirmInline() {
  const now = Date.now();
  if (now - armedAt < 4000) { armedAt = 0; $('regenBtn').textContent = 'Pick a new set for this week'; return true; }
  armedAt = now;
  $('regenBtn').textContent = 'Tap again to confirm';
  setTimeout(() => { if (armedAt === now) { armedAt = 0; $('regenBtn').textContent = 'Pick a new set for this week'; } }, 4000);
  return false;
}

init();
