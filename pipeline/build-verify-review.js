// Builds a review page for the picks verify.js wasn't sure about, for every creator:
// Claude's decision and best-guess place, other candidates, and a link to the moment
// in the video. Decide each one, Export, and save the file in this folder.
// Usage: node build-verify-review.js   → review-verify.html (open via the local server)
import fs from 'fs';
import { CREATORS, nameKey } from './shared.js';
import { PLACES_FILE } from './link.js';

const OUTPUT        = 'review-verify.html';
const DECISIONS     = 'verify-decisions.json';

const REASON_LABELS = {
  own_review:           'Reviewed it themself',
  guest_recommendation: 'A guest recommended it',
  guest_own_place:      "The guest's own restaurant",
  event_stall:          'Stall at their own event',
  not_london:           'Not in London',
  not_a_place_to_eat:   'Not a place to eat',
  only_mentioned:       'Only mentioned in passing',
};

const { places } = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8'));
const placeById = new Map(places.map(([id, name, lat, lon, , , address]) => [id, { id, name, lat, lon, address }]));

function seconds(moment) {
  const m = moment?.match(/^(\d+):(\d{2})$/);
  return m ? +m[1] * 60 + +m[2] : null;
}

function main() {
  const items = [];
  for (const [key, creator] of Object.entries(CREATORS)) {
    const file = `${key}-verified.json`;
    if (!fs.existsSync(file)) continue;
    // Kept picks with no place and no earlier pin would be missing from the map, so they're reviewed too
    const unverified = `${key}-geocoded-unverified.json`;
    const pinned = new Set(fs.existsSync(unverified)
      ? JSON.parse(fs.readFileSync(unverified, 'utf8')).filter(r => r.lat).map(r => nameKey(r.name)) : []);
    const unplaced = r => r.keep && !placeById.has(r.placeId) && !pinned.has(nameKey(r.name)) && !pinned.has(nameKey(r.originalName));
    for (const video of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      for (const pick of video.restaurants.filter(r => !r.confident || unplaced(r))) {
        const candidates = (pick.candidates || []).map(c => placeById.get(c.id)).filter(Boolean);
        const guess = placeById.get(pick.placeId);
        const options = guess ? [guess, ...candidates.filter(c => c.id !== guess.id)] : candidates;
        items.push({
          id: `${key}:${video.videoId}:${pick.originalName}`,
          creator: key, creatorName: creator.name, colour: creator.colour,
          videoId: video.videoId, title: video.title, sponsored: video.sponsored,
          at: seconds(pick.moment), moment: pick.moment,
          originalName: pick.originalName, name: pick.name, area: pick.area || pick.location || null,
          keep: pick.keep, reason: REASON_LABELS[pick.reason] || pick.reason,
          why: pick.confident ? `No location found, so it isn't on the map yet. ${pick.why}` : pick.why,
          verdict: pick.verdict, notes: pick.notes,
          options, guessed: !!guess,
        });
      }
    }
  }
  fs.writeFileSync(OUTPUT, buildHtml(items));
  const counts = Object.keys(CREATORS).map(k => `${items.filter(i => i.creator === k).length} ${CREATORS[k].name}`).join(', ');
  console.log(`${items.length} picks to review (${counts}) → ${OUTPUT}`);
}

function buildHtml(items) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>SCRAN — Verify Picks</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0ede8; color: #1a1a1a; min-height: 100vh; }

  /* Header */
  .site-header { position: sticky; top: 0; z-index: 100; background: rgba(244,241,237,0.95); backdrop-filter: blur(10px); border-bottom: 1px solid rgba(0,0,0,0.08); padding: 14px 24px; display: flex; align-items: center; gap: 12px 16px; flex-wrap: wrap; }
  .site-header h1 { font-size: 1.1rem; font-weight: 800; flex: 1; min-width: 200px; }
  .progress-text { font-size: 0.8rem; color: #666; }
  .progress-text b { color: #1a1a1a; }
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; }
  .tab { padding: 6px 12px; border-radius: 20px; border: 1.5px solid rgba(0,0,0,0.12); background: none; cursor: pointer; font-size: 0.78rem; font-weight: 600; color: #666; }
  .tab.active { background: #1a1a1a; border-color: #1a1a1a; color: #fff; }
  #export-btn { padding: 8px 16px; background: #6C3483; color: #fff; border: none; border-radius: 20px; font-size: 0.8rem; font-weight: 600; cursor: pointer; }
  #export-btn:hover { background: #5a2a6e; }
  .help { font-size: 0.78rem; color: #666; padding: 12px 24px 0; max-width: 1400px; margin: 0 auto; line-height: 1.5; }

  /* Grid */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(380px, 100%), 1fr)); gap: 16px; padding: 16px 24px 40px; max-width: 1400px; margin: 0 auto; }

  /* Card */
  .card { background: #fff; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); overflow: hidden; display: flex; flex-direction: column; border: 2px solid transparent; }
  .card.hidden { display: none; }
  .card.kept    { border-color: #27AE60; }
  .card.dropped { border-color: #ccc; opacity: 0.55; }

  .card-top { padding: 14px 16px 10px; border-bottom: 1px solid #f0ede8; }
  .creator { display: inline-block; font-size: 0.68rem; font-weight: 700; color: #fff; border-radius: 10px; padding: 1px 8px; margin-bottom: 6px; }
  .ad { display: inline-block; font-size: 0.68rem; font-weight: 700; color: #b45309; border: 1px solid #b45309; border-radius: 10px; padding: 0 7px; margin-left: 4px; }
  .name { font-size: 1.05rem; font-weight: 800; }
  .heard { font-size: 0.78rem; color: #888; margin-top: 2px; }
  .video { display: block; margin-top: 8px; font-size: 0.8rem; font-weight: 600; color: #6C3483; text-decoration: none; }
  .video:hover { text-decoration: underline; }

  .claude { padding: 10px 16px; background: #faf9f7; border-bottom: 1px solid #f0ede8; font-size: 0.8rem; line-height: 1.45; }
  .claude-label { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-bottom: 3px; }
  .decision { font-weight: 700; }
  .decision.keep { color: #27AE60; }
  .decision.drop { color: #c0392b; }
  .why { color: #444; }
  .verdict { color: #444; margin-top: 4px; font-style: italic; }

  .options { padding: 12px 16px; border-bottom: 1px solid #f0ede8; }
  .options-label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-bottom: 8px; }
  .option { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 10px; cursor: pointer; border: 1.5px solid transparent; margin-bottom: 4px; }
  .option:hover { background: #faf9f7; }
  .option.selected { border-color: #27AE60; background: rgba(39,174,96,0.05); }
  .option input { margin-top: 3px; accent-color: #27AE60; flex-shrink: 0; }
  .option-name { font-size: 0.85rem; font-weight: 600; display: block; }
  .best { font-size: 0.66rem; font-weight: 700; color: #27AE60; text-transform: uppercase; margin-left: 4px; }
  .option-address { font-size: 0.75rem; color: #666; display: block; margin-top: 1px; }
  .option-map { font-size: 0.72rem; color: #6C3483; text-decoration: none; display: inline-block; margin-top: 3px; }
  .manual input { width: 100%; margin-top: 6px; padding: 8px 10px; border: 1.5px solid rgba(0,0,0,0.1); border-radius: 8px; font-size: 0.82rem; font-family: inherit; }

  .actions { padding: 12px 16px; display: flex; gap: 8px; align-items: center; margin-top: auto; }
  .btn-keep { flex: 1; padding: 9px; border: none; border-radius: 10px; background: #27AE60; color: #fff; font-weight: 700; font-size: 0.82rem; cursor: pointer; }
  .btn-keep:hover { background: #219653; }
  .btn-drop { padding: 9px 14px; border: 1.5px solid rgba(0,0,0,0.12); border-radius: 10px; background: none; color: #666; font-weight: 600; font-size: 0.82rem; cursor: pointer; }
  .btn-drop:hover { background: #f5f5f5; }
  .status { font-size: 0.72rem; font-weight: 700; color: #888; }
</style>
</head>
<body>

<header class="site-header">
  <h1>Verify picks</h1>
  <div class="progress-text"><b id="count-kept">0</b> kept · <b id="count-dropped">0</b> dropped · <b id="count-pending">0</b> to do</div>
  <div class="tabs" id="creator-tabs"></div>
  <div class="tabs" id="status-tabs">
    <button class="tab active" data-status="pending">To do</button>
    <button class="tab" data-status="all">All</button>
    <button class="tab" data-status="kept">Kept</button>
    <button class="tab" data-status="dropped">Dropped</button>
  </div>
  <button id="export-btn">Export decisions</button>
</header>
<p class="help">Claude wasn't sure about these. Watch the moment in the video, choose the right place (the top one is Claude's best guess), then <b>Keep</b> or <b>Drop</b>. Your choices are saved in this browser. When you're done, Export and save <code>${DECISIONS}</code> in the pipeline folder.</p>

<div class="grid" id="grid"></div>

<script>
const DATA = ${JSON.stringify(items).replace(/</g, '\\u003c')};
const STORE = 'scran-verify-review';
let state = {};
try { state = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch {}
function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {} }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mapLink = o => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(o.name + ', ' + (o.address || 'London'));
let creatorFilter = 'all', statusFilter = 'pending';

function buildCard(r, n) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = r.id;
  card.dataset.creator = r.creator;
  const videoUrl = 'https://www.youtube.com/watch?v=' + r.videoId + (r.at ? '&t=' + r.at + 's' : '');
  const options = r.options.map((o, i) => \`
    <label class="option">
      <input type="radio" name="opt-\${n}" value="\${i}">
      <div>
        <span class="option-name">\${esc(o.name)}\${i === 0 && r.guessed ? '<span class="best">Best guess</span>' : ''}</span>
        <span class="option-address">\${esc(o.address || 'No address')}</span>
        <a class="option-map" href="\${mapLink(o)}" target="_blank" rel="noopener">Open in Google Maps ↗</a>
      </div>
    </label>\`).join('');

  card.innerHTML = \`
    <div class="card-top">
      <span class="creator" style="background:\${r.colour}">\${esc(r.creatorName)}</span>\${r.sponsored ? '<span class="ad">Ad</span>' : ''}
      <div class="name">\${esc(r.name)}</div>
      \${r.originalName !== r.name || r.area ? \`<div class="heard">\${r.originalName !== r.name ? 'Picked up as “' + esc(r.originalName) + '”' : ''}\${r.originalName !== r.name && r.area ? ' · ' : ''}\${r.area ? esc(r.area) : ''}</div>\` : ''}
      <a class="video" href="\${mapLink({ name: r.name, address: (r.area ? r.area + ', ' : '') + 'London' })}" target="_blank" rel="noopener">⌕ Search Google Maps for “\${esc(r.name)}”</a>
      <a class="video" href="\${videoUrl}" target="_blank" rel="noopener">▶ \${r.moment ? 'At ' + esc(r.moment) + ' — ' : ''}\${esc(r.title)}</a>
    </div>
    <div class="claude">
      <div class="claude-label">Claude's call</div>
      <span class="decision \${r.keep ? 'keep' : 'drop'}">\${r.keep ? 'Keep' : 'Drop'}</span> — \${esc(r.reason)}
      <div class="why">\${esc(r.why)}</div>
      \${r.verdict ? '<div class="verdict">“' + esc(r.verdict) + '”</div>' : ''}
    </div>
    <div class="options">
      <div class="options-label">Which place is it?</div>
      \${options || '<div class="option-address">No matches found. Type it below.</div>'}
      <label class="option manual">
        <input type="radio" name="opt-\${n}" value="manual">
        <div style="flex:1">
          <span class="option-name">None of these</span>
          <input type="text" placeholder="Correct name and address, e.g. Cèl, 26 Old Compton St" data-manual>
        </div>
      </label>
    </div>
    <div class="actions">
      <button class="btn-keep">✓ Keep</button>
      <button class="btn-drop">✗ Drop</button>
      <span class="status"></span>
    </div>\`;

  const radios = [...card.querySelectorAll('input[type=radio]')];
  const manual = card.querySelector('[data-manual]');
  const select = value => {
    radios.forEach(x => { x.checked = x.value === String(value); x.closest('.option').classList.toggle('selected', x.checked); });
  };
  radios.forEach(x => x.addEventListener('change', () => select(x.value)));
  manual.addEventListener('focus', () => select('manual'));

  const s = state[r.id];
  if (s?.manual) { manual.value = s.manual; select('manual'); }
  else if (s && s.optionIndex != null) select(s.optionIndex);
  else if (r.options.length && r.guessed) select(0);

  card.querySelector('.btn-keep').addEventListener('click', () => {
    const chosen = radios.find(x => x.checked)?.value;
    const text = manual.value.trim();
    if (chosen === 'manual' && !text) { manual.focus(); return; }
    if (chosen == null) { alert('Choose the place first, or type it under "None of these".'); return; }
    const o = chosen === 'manual' ? null : r.options[+chosen];
    state[r.id] = {
      creator: r.creator, videoId: r.videoId, originalName: r.originalName, keep: true,
      name: o ? o.name : text.split(',')[0].trim(),
      placeId: o?.id ?? null, lat: o?.lat ?? null, lon: o?.lon ?? null, address: o?.address ?? null,
      manual: chosen === 'manual' ? text : null, optionIndex: o ? +chosen : null,
    };
    save(); refresh();
  });
  card.querySelector('.btn-drop').addEventListener('click', () => {
    state[r.id] = { creator: r.creator, videoId: r.videoId, originalName: r.originalName, keep: false };
    save(); refresh();
  });
  return card;
}

function statusOf(id) { const s = state[id]; return !s ? 'pending' : s.keep ? 'kept' : 'dropped'; }

function refresh() {
  const visible = DATA.filter(r => creatorFilter === 'all' || r.creator === creatorFilter);
  document.querySelectorAll('.card').forEach(card => {
    const status = statusOf(card.dataset.id);
    const s = state[card.dataset.id];
    card.classList.toggle('kept', status === 'kept');
    card.classList.toggle('dropped', status === 'dropped');
    card.querySelector('.status').textContent = status === 'kept' ? 'Kept: ' + s.name : status === 'dropped' ? 'Dropped' : '';
    card.classList.toggle('hidden',
      (creatorFilter !== 'all' && card.dataset.creator !== creatorFilter) ||
      (statusFilter !== 'all' && status !== statusFilter));
  });
  const count = st => visible.filter(r => statusOf(r.id) === st).length;
  document.getElementById('count-kept').textContent = count('kept');
  document.getElementById('count-dropped').textContent = count('dropped');
  document.getElementById('count-pending').textContent = count('pending');
}

const grid = document.getElementById('grid');
DATA.forEach((r, n) => grid.appendChild(buildCard(r, n)));

const creatorTabs = document.getElementById('creator-tabs');
const creators = [['all', 'Everyone'], ...[...new Map(DATA.map(r => [r.creator, r.creatorName]))]];
creators.forEach(([key, label], i) => {
  const b = document.createElement('button');
  b.className = 'tab' + (i === 0 ? ' active' : '');
  b.textContent = label;
  b.addEventListener('click', () => {
    creatorTabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    b.classList.add('active'); creatorFilter = key; refresh();
  });
  creatorTabs.appendChild(b);
});
document.querySelectorAll('#status-tabs .tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#status-tabs .tab').forEach(t => t.classList.remove('active'));
  b.classList.add('active'); statusFilter = b.dataset.status; refresh();
}));
refresh();

document.getElementById('export-btn').addEventListener('click', () => {
  const decisions = Object.values(state).map(({ optionIndex, ...d }) => d);
  if (!decisions.length) { alert('Nothing to export yet. Keep or drop some picks first.'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(decisions, null, 2)], { type: 'application/json' }));
  a.download = '${DECISIONS}';
  a.click();
});
</script>
</body>
</html>`;
}

main();
