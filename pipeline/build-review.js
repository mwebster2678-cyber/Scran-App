import 'dotenv/config';
import fs from 'fs';

const INPUT  = 'tod-restaurants.json';
const OUTPUT = 'review.html';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const LONDON = { minLat: 51.2, maxLat: 51.75, minLon: -0.55, maxLon: 0.35 };
const GENERIC_TYPES = new Set([
  'locality', 'administrative_area_level_1', 'administrative_area_level_2',
  'administrative_area_level_3', 'country', 'postal_code', 'political',
]);

async function getCandidates(name, location) {
  const seen = new Map();
  const queries = [
    `${name}${location ? ' ' + location : ''} restaurant London`,
    `${name} London`,
    `${name.split(' ').slice(0, 2).join(' ')} London restaurant`,
  ];
  for (const q of queries) {
    if (seen.size >= 3) break;
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q.trim())}&region=gb&key=${GOOGLE_MAPS_API_KEY}`;
      const res  = await fetch(url);
      const data = await res.json();
      for (const result of (data.results || [])) {
        if (seen.size >= 3) break;
        const types = result.types || [];
        if (types.every(t => GENERIC_TYPES.has(t))) continue;
        const { lat, lng } = result.geometry.location;
        if (lat < LONDON.minLat || lat > LONDON.maxLat || lng < LONDON.minLon || lng > LONDON.maxLon) continue;
        const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
        if (!seen.has(key)) {
          seen.set(key, {
            name:    result.address_components?.[0]?.long_name || name,
            address: result.formatted_address,
            lat,
            lon: lng,
          });
        }
      }
    } catch { /* skip failed queries */ }
  }
  return [...seen.values()];
}

async function main() {
  const all         = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const ungeocoded  = all.filter(r => !r.lat);
  console.log(`Building review page for ${ungeocoded.length} ungeocoded restaurants...\n`);

  const reviewData = [];
  for (let i = 0; i < ungeocoded.length; i++) {
    const r = ungeocoded[i];
    const key = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    process.stdout.write(`[${i + 1}/${ungeocoded.length}] "${r.name}"... `);
    const candidates = await getCandidates(r.name, r.location);
    console.log(`${candidates.length} candidates`);
    reviewData.push({ key, name: r.name, location: r.location, mentions: r.mentions, candidates });
  }

  const html = buildHtml(reviewData);
  fs.writeFileSync(OUTPUT, html);
  console.log(`\nSaved to ${OUTPUT} — open it in your browser.`);
}

function buildHtml(data) {
  const dataJson = JSON.stringify(data);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Tod Mode — Restaurant Approval</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0ede8; color: #1a1a1a; min-height: 100vh; }

  /* Header */
  .site-header { position: sticky; top: 0; z-index: 100; background: rgba(244,241,237,0.95); backdrop-filter: blur(10px); border-bottom: 1px solid rgba(0,0,0,0.08); padding: 14px 24px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .site-header h1 { font-size: 1.1rem; font-weight: 800; color: #A07D00; flex: 1; }
  .progress-text { font-size: 0.8rem; color: #666; }
  .progress-text b { color: #1a1a1a; }
  .tabs { display: flex; gap: 6px; }
  .tab { padding: 6px 12px; border-radius: 20px; border: 1.5px solid rgba(0,0,0,0.12); background: none; cursor: pointer; font-size: 0.78rem; font-weight: 600; color: #666; }
  .tab.active { background: #D4AC0D; border-color: #D4AC0D; color: #fff; }
  #export-btn { padding: 8px 16px; background: #6C3483; color: #fff; border: none; border-radius: 20px; font-size: 0.8rem; font-weight: 600; cursor: pointer; }
  #export-btn:hover { background: #5a2a6e; }

  /* Grid */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 16px; padding: 20px 24px; max-width: 1400px; margin: 0 auto; }

  /* Card */
  .card { background: #fff; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); overflow: hidden; display: flex; flex-direction: column; transition: opacity 0.2s; }
  .card.hidden { display: none; }
  .card.approved { border: 2px solid #27AE60; }
  .card.removed  { border: 2px solid #ccc; opacity: 0.55; }

  /* Card header */
  .card-top { padding: 14px 16px 10px; border-bottom: 1px solid #f0ede8; }
  .mishear-label { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #A07D00; margin-bottom: 3px; }
  .mishear-name  { font-size: 1.05rem; font-weight: 800; color: #1a1a1a; }
  .mishear-loc   { font-size: 0.78rem; color: #888; margin-top: 2px; }

  /* Video context */
  .context { padding: 10px 16px; background: #faf9f7; border-bottom: 1px solid #f0ede8; }
  .context-mentions { display: flex; flex-direction: column; gap: 8px; }
  .mention-block { font-size: 0.78rem; }
  .mention-video { font-weight: 600; color: #6C3483; text-decoration: none; display: block; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mention-video:hover { text-decoration: underline; }
  .mention-rating { display: inline-block; background: #D4AC0D; color: #fff; border-radius: 10px; padding: 1px 8px; font-size: 0.72rem; font-weight: 700; margin-bottom: 3px; }
  .mention-notes { color: #444; line-height: 1.4; }
  .show-more { font-size: 0.72rem; color: #A07D00; cursor: pointer; border: none; background: none; padding: 0; margin-top: 4px; }

  /* Candidates */
  .candidates { padding: 12px 16px; border-bottom: 1px solid #f0ede8; }
  .candidates-label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-bottom: 8px; }
  .candidate-option { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 10px; cursor: pointer; border: 1.5px solid transparent; margin-bottom: 5px; transition: border-color 0.1s, background 0.1s; }
  .candidate-option:hover { background: #faf9f7; }
  .candidate-option input[type=radio] { margin-top: 3px; accent-color: #D4AC0D; flex-shrink: 0; }
  .candidate-option.selected { border-color: #D4AC0D; background: rgba(212,172,13,0.06); }
  .candidate-name    { font-size: 0.85rem; font-weight: 600; display: block; }
  .candidate-address { font-size: 0.75rem; color: #666; display: block; margin-top: 1px; }
  .candidate-map { font-size: 0.7rem; color: #A07D00; text-decoration: none; display: inline-block; margin-top: 3px; }
  .no-candidates { font-size: 0.78rem; color: #888; font-style: italic; }

  /* Manual */
  .manual { padding: 10px 16px; border-bottom: 1px solid #f0ede8; }
  .manual label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #888; display: block; margin-bottom: 6px; }
  .manual input { width: 100%; padding: 8px 10px; border: 1.5px solid rgba(0,0,0,0.1); border-radius: 8px; font-size: 0.82rem; font-family: inherit; outline: none; }
  .manual input:focus { border-color: #D4AC0D; }

  /* Actions */
  .actions { padding: 12px 16px; display: flex; gap: 8px; }
  .btn-approve { flex: 1; padding: 9px; border: none; border-radius: 10px; background: #27AE60; color: #fff; font-weight: 700; font-size: 0.82rem; cursor: pointer; }
  .btn-approve:hover { background: #219653; }
  .btn-remove  { padding: 9px 14px; border: 1.5px solid rgba(0,0,0,0.12); border-radius: 10px; background: none; color: #888; font-weight: 600; font-size: 0.82rem; cursor: pointer; }
  .btn-remove:hover { background: #f5f5f5; }
  .status-pill { align-self: center; font-size: 0.72rem; font-weight: 700; padding: 3px 10px; border-radius: 20px; }
  .status-pill.approved { background: rgba(39,174,96,0.12); color: #27AE60; }
  .status-pill.removed  { background: rgba(0,0,0,0.06); color: #999; }
</style>
</head>
<body>

<header class="site-header">
  <h1>⭐ Tod Mode — Restaurant Approvals</h1>
  <div class="progress-text">
    <b id="count-approved">0</b> approved &nbsp;·&nbsp;
    <b id="count-removed">0</b> removed &nbsp;·&nbsp;
    <b id="count-pending">0</b> pending
  </div>
  <div class="tabs">
    <button class="tab active" data-filter="all">All</button>
    <button class="tab" data-filter="pending">Pending</button>
    <button class="tab" data-filter="approved">Approved</button>
    <button class="tab" data-filter="removed">Removed</button>
  </div>
  <button id="export-btn">📥 Export Corrections</button>
</header>

<div class="grid" id="grid"></div>

<script>
const DATA = ${dataJson};
const state = JSON.parse(localStorage.getItem('scran-review-state') || '{}');

function save() { localStorage.setItem('scran-review-state', JSON.stringify(state)); }

function buildCard(r) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.key = r.key;

  // Mentions — show first one expanded, rest collapsed
  const mentionHtml = r.mentions.map((m, i) => {
    const ratingHtml = m.rating != null ? \`<span class="mention-rating">⭐ \${m.rating}/\${m.rating_out_of ?? 10}</span>\` : '';
    return \`<div class="mention-block" \${i > 0 ? 'style="display:none"' : ''} data-mention="\${i}">
      <a class="mention-video" href="https://youtube.com/watch?v=\${m.videoId}" target="_blank">▶ \${m.videoTitle}</a>
      \${ratingHtml}
      <div class="mention-notes">\${m.notes || ''}</div>
    </div>\`;
  }).join('');
  const moreBtn = r.mentions.length > 1
    ? \`<button class="show-more" data-showing="false">+ \${r.mentions.length - 1} more video\${r.mentions.length > 2 ? 's' : ''}</button>\`
    : '';

  // Candidates
  const candidatesHtml = r.candidates.length
    ? r.candidates.map((c, i) => \`
      <label class="candidate-option" data-ci="\${i}">
        <input type="radio" name="cand-\${r.key}" value="\${i}">
        <div>
          <span class="candidate-name">\${c.name}</span>
          <span class="candidate-address">\${c.address}</span>
          <a class="candidate-map" href="https://www.openstreetmap.org/?mlat=\${c.lat}&mlon=\${c.lon}&zoom=17" target="_blank">View on map ↗</a>
        </div>
      </label>\`).join('')
    : '<div class="no-candidates">No candidates found — use the field below</div>';

  card.innerHTML = \`
    <div class="card-top">
      <div class="mishear-label">🎤 Heard as</div>
      <div class="mishear-name">"\${r.name}"</div>
      \${r.location ? \`<div class="mishear-loc">📍 \${r.location}</div>\` : ''}
    </div>
    <div class="context">
      <div class="context-mentions">\${mentionHtml}</div>
      \${moreBtn}
    </div>
    <div class="candidates">
      <div class="candidates-label">Possible matches</div>
      \${candidatesHtml}
    </div>
    <div class="manual">
      <label>Or type the correct name</label>
      <input type="text" placeholder="e.g. Jamavar, 8 Mount Street, Mayfair" data-manual>
    </div>
    <div class="actions">
      <button class="btn-approve">✓ Correct</button>
      <button class="btn-remove">✗ Not a restaurant</button>
      <span class="status-pill" style="display:none"></span>
    </div>
  \`;

  // Show more mentions
  const showMoreBtn = card.querySelector('.show-more');
  if (showMoreBtn) {
    showMoreBtn.addEventListener('click', () => {
      const showing = showMoreBtn.dataset.showing === 'true';
      card.querySelectorAll('[data-mention]').forEach((el, i) => {
        if (i > 0) el.style.display = showing ? 'none' : '';
      });
      showMoreBtn.dataset.showing = !showing;
      showMoreBtn.textContent = showing
        ? \`+ \${r.mentions.length - 1} more video\${r.mentions.length > 2 ? 's' : ''}\`
        : '− Show less';
    });
  }

  // Highlight selected candidate
  card.querySelectorAll('.candidate-option').forEach(opt => {
    opt.querySelector('input').addEventListener('change', () => {
      card.querySelectorAll('.candidate-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    });
  });

  // Approve
  card.querySelector('.btn-approve').addEventListener('click', () => {
    const manualInput = card.querySelector('[data-manual]').value.trim();
    const selectedRadio = card.querySelector('input[type=radio]:checked');
    const ci = selectedRadio ? parseInt(selectedRadio.value) : -1;
    const candidate = ci >= 0 ? r.candidates[ci] : null;

    state[r.key] = {
      action: 'approve',
      originalName: r.name,
      correctedName: manualInput || (candidate?.name ?? r.name),
      lat: candidate?.lat ?? null,
      lon: candidate?.lon ?? null,
      manualInput: manualInput || null,
    };
    save();
    applyCardState(card, r.key);
    updateCounts();
  });

  // Remove
  card.querySelector('.btn-remove').addEventListener('click', () => {
    state[r.key] = { action: 'remove', originalName: r.name };
    save();
    applyCardState(card, r.key);
    updateCounts();
  });

  return card;
}

function applyCardState(card, key) {
  const s = state[key];
  const pill = card.querySelector('.status-pill');
  card.classList.remove('approved', 'removed');
  if (!s) { pill.style.display = 'none'; return; }
  if (s.action === 'approve') {
    card.classList.add('approved');
    pill.className = 'status-pill approved';
    pill.textContent = s.correctedName ? \`✓ \${s.correctedName}\` : '✓ Approved';
    pill.style.display = '';
  } else {
    card.classList.add('removed');
    pill.className = 'status-pill removed';
    pill.textContent = '✗ Removed';
    pill.style.display = '';
  }
}

function updateCounts() {
  const approved = Object.values(state).filter(s => s.action === 'approve').length;
  const removed  = Object.values(state).filter(s => s.action === 'remove').length;
  const pending  = DATA.length - approved - removed;
  document.getElementById('count-approved').textContent = approved;
  document.getElementById('count-removed').textContent  = removed;
  document.getElementById('count-pending').textContent  = pending;
}

function applyFilter(filter) {
  document.querySelectorAll('.card').forEach(card => {
    const key = card.dataset.key;
    const s   = state[key];
    const status = s?.action === 'approve' ? 'approved' : s?.action === 'remove' ? 'removed' : 'pending';
    card.classList.toggle('hidden', filter !== 'all' && status !== filter);
  });
}

// Build grid
const grid = document.getElementById('grid');
DATA.forEach(r => {
  const card = buildCard(r);
  applyCardState(card, r.key);
  grid.appendChild(card);
});
updateCounts();

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    applyFilter(tab.dataset.filter);
  });
});

// Export
document.getElementById('export-btn').addEventListener('click', () => {
  const corrections = Object.values(state);
  if (!corrections.length) { alert('Nothing to export yet — approve or remove some restaurants first.'); return; }
  const blob = new Blob([JSON.stringify(corrections, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'corrections.json';
  a.click();
});
</script>
</body>
</html>`;
}

main().catch(err => { console.error(err); process.exit(1); });
