// Builds a review page for the picks verify.js wasn't sure about, for every creator:
// Claude's decision and best-guess place, other candidates, and a link to the moment
// in the video. Decide each one, Export, and save the file in this folder.
// Usage: node build-verify-review.js   → review-verify.html (open via the local server)
import fs from 'fs';
import crypto from 'crypto';
import { CREATORS, nameKey } from './shared.js';
import { PLACES_FILE, sameName, NAME_STOPWORDS } from './link.js';
import { loadKnown, findKnown } from './known.js';
import { saysWhere } from './comments.js';

const OUTPUT        = 'review-verify.html';
const DECISIONS     = 'verify-decisions.json';
const SPOT_KEPT     = 50; // picks Claude was sure about, to spot-check: kept ones…
const SPOT_DROPPED  = 20; // …and dropped ones

const REASON_LABELS = {
  own_review:           'Reviewed it themself',
  guest_recommendation: 'A guest recommended it',
  guest_own_place:      "The guest's own restaurant",
  event_stall:          'Stall at their own event',
  not_london:           'Not in London',
  not_a_place_to_eat:   'Not a place to eat',
  only_mentioned:       'Only mentioned in passing',
};

// The app's browser key: Google accepts it from pages on http://localhost:8000
const APP_JS = fs.readFileSync('../app.js', 'utf8');
const GOOGLE_KEY = APP_JS.match(/googleMapsKey:\s*'([^']+)'/)?.[1] || '';
// Same Supabase project and publishable key as the app: on localhost:8000 the page shares the
// app's sign-in, so the Suggestions tab can read creator suggestions when you're an admin
const SUPABASE_URL = APP_JS.match(/SUPABASE_URL = '([^']+)'/)?.[1] || '';
const SUPABASE_KEY = APP_JS.match(/SUPABASE_KEY = '([^']+)'/)?.[1] || '';

const { places } = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8'));
const placeById = new Map(places.map(([id, name, lat, lon, , , address]) => [id, { id, name, lat, lon, address }]));

function seconds(moment) {
  const m = moment?.match(/^(\d+):(\d{2})$/);
  return m ? +m[1] * 60 + +m[2] : null;
}

// Comments on the video that say what or where a place is (fetched by verify.js)
function commentsFor(videoId) {
  const file = `cache/${videoId}.comments.json`;
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).filter(c => saysWhere(c.text)).map(c => c.text) : [];
}

function item(key, creator, video, pick, why) {
  // Only candidates whose name looks like the pick's (not every place near an old, possibly wrong pin)
  const candidates = (pick.candidates || []).map(c => placeById.get(c.id))
    .filter(c => c && (sameName(c.name, pick.name) || sameName(c.name, pick.originalName)));
  const guess = placeById.get(pick.placeId);
  const options = guess ? [guess, ...candidates.filter(c => c.id !== guess.id)] : candidates;
  return {
    id: `${key}:${video.videoId}:${pick.originalName}`,
    creator: key, creatorName: creator.name, colour: creator.colour,
    videoId: video.videoId, title: video.title, sponsored: video.sponsored,
    at: seconds(pick.moment), moment: pick.moment,
    originalName: pick.originalName, name: pick.name, area: pick.area || pick.location || null,
    keep: pick.keep, reasonKey: pick.reason, reason: REASON_LABELS[pick.reason] || pick.reason, why,
    verdict: pick.verdict, notes: pick.notes, comments: commentsFor(video.videoId),
    address: pick.address || null, writtenAs: pick.writtenAs || null, onScreen: pick.onScreen || null, onScreenAt: pick.onScreenAt || null,
    options, guessed: !!guess, specificArea: !!(pick.address || (pick.area && !/^(central |north |south |east |west )?london$/i.test(pick.area))),
  };
}

function main() {
  const items = [];
  const sure = [];
  const known = loadKnown();
  let settled = 0;
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
        // Already answered for this restaurant in another video: geocode.js places it from that
        const confirmed = pick.keep && findKnown(known, pick);
        if (confirmed && confirmed.videoId !== video.videoId) { settled++; continue; }
        items.push(item(key, creator, video, pick,
          pick.confident ? `No location found, so it isn't on the map yet. ${pick.why}` : pick.why));
      }
      for (const pick of video.restaurants.filter(r => r.confident && !unplaced(r))) sure.push({ key, creator, video, pick });
    }
  }

  // A fixed random sample of the picks Claude was sure about (the same ones each rebuild)
  const hash = ({ key, video, pick }) => crypto.createHash('md5').update(`${key}:${video.videoId}:${pick.originalName}`).digest('hex');
  sure.sort((a, b) => hash(a).localeCompare(hash(b)));
  for (const s of [...sure.filter(s => s.pick.keep).slice(0, SPOT_KEPT), ...sure.filter(s => !s.pick.keep).slice(0, SPOT_DROPPED)]) {
    items.push({ ...item(s.key, s.creator, s.video, s.pick, s.pick.why), spot: true });
  }
  // Map pins check-pins.js found far from Google's place with the same name, picked out for you
  // in pins-to-review.json: move each to Google's location, leave it, or paste the right one
  if (fs.existsSync('pin-check.json') && fs.existsSync('pins-to-review.json')) {
    const review = new Set(JSON.parse(fs.readFileSync('pins-to-review.json', 'utf8')));
    for (const f of JSON.parse(fs.readFileSync('pin-check.json', 'utf8')).far.filter(f => review.has(f.name))) {
      const creator = CREATORS[f.creator];
      const onMap = JSON.parse(fs.readFileSync(`../data/${f.creator}.json`, 'utf8'));
      const entry = (Array.isArray(onMap) ? onMap : Object.values(onMap)[0])
        .find(r => (f.placeId && r.placeId === f.placeId) || r.name === f.name);
      items.push({
        kind: 'pin', id: `pin:${f.creator}:${f.name}`, creator: f.creator, creatorName: creator.name, colour: creator.colour,
        name: f.name, placeId: f.placeId, pin: f.pin, google: f.google, away: f.away,
        address: f.placeId ? placeById.get(f.placeId)?.address || null : null,
        videos: (entry?.mentions || []).map(m => ({ videoId: m.videoId, title: m.videoTitle, at: m.at })),
      });
    }
  }

  fs.writeFileSync(OUTPUT, buildHtml(items));
  const unsure = items.filter(i => !i.spot && i.kind !== 'pin');
  const counts = Object.keys(CREATORS).map(k => `${unsure.filter(i => i.creator === k).length} ${CREATORS[k].name}`).join(', ');
  console.log(`${unsure.length} picks to review (${counts}) + ${items.filter(i => i.spot).length} to spot-check + ${items.filter(i => i.kind === 'pin').length} pins → ${OUTPUT}` +
    (settled ? `; ${settled} more settled by your earlier answers` : ''));
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
  .manual input[type=text] { width: 100%; margin-top: 6px; padding: 8px 10px; border: 1.5px solid rgba(0,0,0,0.1); border-radius: 8px; font-size: 0.82rem; font-family: inherit; }

  .search { padding: 12px 16px; border-bottom: 1px solid #f0ede8; }
  .search input[type=search] { width: 100%; padding: 8px 10px; border: 1.5px solid rgba(0,0,0,0.1); border-radius: 8px; font-size: 0.85rem; font-family: inherit; }
  .results { display: flex; flex-direction: column; gap: 2px; margin: 6px 0; }
  .result { text-align: left; padding: 7px 10px; border: none; border-radius: 8px; background: #faf9f7; cursor: pointer; font-family: inherit; font-size: 0.8rem; }
  .result:hover { background: #f0ede8; }
  .result span { color: #666; font-size: 0.75rem; }
  .google-note { font-size: 0.72rem; color: #888; margin-top: 4px; }
  .moved { display: flex; gap: 6px; align-items: center; padding: 8px 16px 0; font-size: 0.75rem; color: #666; cursor: pointer; }
  .pin-where { font-size: 0.8rem; margin-top: 8px; }
  .pin-where b { display: block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: #888; }
  .google-flag { display: inline-block; margin-top: 6px; padding: 3px 9px; border-radius: 10px; font-size: 0.75rem; font-weight: 600; }
  .google-flag[hidden] { display: none; }
  .google-flag.agrees { background: #e6f6ec; color: #1e7a45; }
  .google-flag.missing { background: #fdf0e1; color: #a35a00; }
  .loc-status { display: block; font-size: 0.72rem; font-weight: 600; margin-top: 4px; }
  .option[hidden] { display: none; }

  .actions { padding: 12px 16px; display: flex; gap: 8px; align-items: center; margin-top: auto; }
  .btn-keep { flex: 1; padding: 9px; border: none; border-radius: 10px; background: #27AE60; color: #fff; font-weight: 700; font-size: 0.82rem; cursor: pointer; }
  .btn-keep:hover { background: #219653; }
  .btn-drop { padding: 9px 14px; border: 1.5px solid rgba(0,0,0,0.12); border-radius: 10px; background: none; color: #666; font-weight: 600; font-size: 0.82rem; cursor: pointer; }
  .btn-drop:hover { background: #f5f5f5; }
  .actions { flex-wrap: wrap; }
  .drop-reasons { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 0.75rem; color: #666; }
  .drop-reasons[hidden] { display: none; }
  .drop-reasons button { padding: 5px 10px; border: 1.5px solid rgba(0,0,0,0.12); border-radius: 14px; background: #fff; cursor: pointer; font-size: 0.75rem; font-family: inherit; }
  .drop-reasons button:hover { border-color: #c0392b; color: #c0392b; }
  .drop-reasons button.claudes { border-color: #c0392b; color: #c0392b; font-weight: 700; }
  .comments { padding: 10px 16px; border-bottom: 1px solid #f0ede8; }
  .comment { font-size: 0.78rem; color: #444; line-height: 1.4; margin-bottom: 4px; }
  .spot { display: inline-block; font-size: 0.68rem; font-weight: 700; color: #6C3483; border: 1px solid #6C3483; border-radius: 10px; padding: 0 7px; margin-left: 4px; }
  .status { font-size: 0.72rem; font-weight: 700; color: #888; }
  #suggestions { max-width: 720px; margin: 0 auto; padding: 0 16px 40px; }
  .suggestion { display: flex; gap: 12px; align-items: center; background: #fff; border-radius: 12px; padding: 12px 16px; margin-bottom: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  .suggestion-text { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 0.9rem; }
  .suggestion-meta { font-size: 0.72rem; color: #888; margin-top: 2px; }
  .suggestion button { padding: 6px 12px; border-radius: 16px; border: 1.5px solid rgba(0,0,0,0.15); background: none; cursor: pointer; font-weight: 600; font-size: 0.75rem; }
  body.suggestions-view #creator-tabs, body.suggestions-view #status-tabs, body.suggestions-view #export-btn,
  body.suggestions-view .progress-text, body.suggestions-view .help, body.suggestions-view #grid { display: none; }
</style>
</head>
<body>

<header class="site-header">
  <h1>Verify picks</h1>
  <div class="progress-text"><b id="count-kept">0</b> kept · <b id="count-dropped">0</b> dropped · <b id="count-pending">0</b> to do</div>
  <div class="tabs" id="kind-tabs">
    <button class="tab active" data-kind="unsure">Unsure</button>
    <button class="tab" data-kind="spot">Spot check</button>
    <button class="tab" data-kind="pins">Pin check</button>
    <button class="tab" data-kind="suggestions">Creator suggestions</button>
    <button class="tab" data-kind="added">Added places</button>
  </div>
  <div class="tabs" id="creator-tabs"></div>
  <div class="tabs" id="status-tabs">
    <button class="tab active" data-status="pending">To do</button>
    <button class="tab" data-status="all">All</button>
    <button class="tab" data-status="kept">Kept</button>
    <button class="tab" data-status="dropped">Dropped</button>
  </div>
  <button id="export-btn">Export decisions</button>
</header>
<p class="help"><b>Pin check:</b> map pins that are far from Google's place with the same name, usually a place that has moved. Move the pin to Google's location, leave it, paste the right Google Maps link, or remove it if the place has closed (Google often finds a different place then). <b>Spot check</b> has a random few of the picks Claude was sure about, to see how often it's wrong. <b>Unsure:</b> Claude wasn't sure about these. Watch the moment in the video, choose the right place (Claude's best guess or Google's top match is ticked) or type its name to search, then <b>Keep</b> or <b>Drop</b>. Your choices are saved in this browser. When you're done, Export and save <code>${DECISIONS}</code> in the pipeline folder.</p>

<div class="grid" id="grid"></div>
<div id="suggestions" hidden></div>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
<script>
const DATA = ${JSON.stringify(items).replace(/</g, '\\u003c')};
const STORE = 'scran-verify-review';
let state = {};
try { state = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch {}
function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {} }

const DROP_REASONS = {
  guest_recommendation: 'A guest’s pick', guest_own_place: 'Guest’s own place', only_mentioned: 'Only mentioned',
  event_stall: 'Their own event', closed: 'Closed now', temporary: 'Pop-up / temporary stall',
  not_london: 'Not London', not_a_place_to_eat: 'Not a place to eat', cant_find: 'Can’t find', own_place: 'Their own restaurant', other: 'Other',
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mapLink = o => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(o.name + ', ' + (o.address || 'London'));
let creatorFilter = 'all', statusFilter = 'pending', kindFilter = 'unsure';

// Name search over SCRAN's places list (loaded on first search)
let placesPromise;
const squash = s => s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
function similarity(a, b) {
  const pairs = s => Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2));
  const pa = pairs(a), pb = pairs(b);
  if (!pa.length || !pb.length) return 0;
  const unused = new Map();
  pb.forEach(p => unused.set(p, (unused.get(p) || 0) + 1));
  let hits = 0;
  for (const p of pa) if (unused.get(p) > 0) { hits++; unused.set(p, unused.get(p) - 1); }
  return 2 * hits / (pa.length + pb.length);
}
const loadPlaces = () => placesPromise ??= fetch('../data/places.json').then(r => r.json())
  .then(({ places }) => places.map(([id, name, lat, lon, , , address]) => ({ id, name, lat, lon, address, key: squash(name) })));
const km = (a, b) => Math.hypot(a.lat - b.lat, (a.lon - b.lon) * 0.62) * 111;

// Best matches for a typed name; equally good matches nearest \`near\` first (e.g. the 19 places called The George)
async function searchPlaces(query, near) {
  const q = squash(query);
  if (q.length < 2) return [];
  return (await loadPlaces())
    .map(p => ({ p, score: p.key === q ? 2 : p.key.startsWith(q) ? 1.5 : p.key.includes(q) ? 1 : similarity(q, p.key) }))
    .filter(x => x.score >= 0.6)
    .sort((a, b) => b.score - a.score || (near ? km(a.p, near) - km(b.p, near) : 0))
    .slice(0, 6)
    .map(x => x.p);
}

// How well a place's name fits a pick's names: share of distinctive words in common
// ("The George" fits "The George Tavern" better than "George & Dragon" does)
const STOPWORDS = new Set(${JSON.stringify(NAME_STOPWORDS)});
const distinct = s => s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/['’]/g, '')
  .split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOPWORDS.has(w));
function nameFit(names, placeName) {
  const b = distinct(placeName);
  return Math.max(0, ...names.map(n => {
    const a = distinct(n);
    const shared = a.filter(w => b.includes(w)).length;
    return shared / new Set([...a, ...b]).size || 0;
  }));
}

// Google's top places for a pick's name and area. Each search is saved in this browser, so
// reloading costs nothing; the Text Search daily cap set in Google Cloud stops it overspending.
const GOOGLE_KEY = '${GOOGLE_KEY}';
const GOOGLE_STORE = 'scran-verify-google';
let googleSaved = {};
try { googleSaved = JSON.parse(localStorage.getItem(GOOGLE_STORE) || '{}'); } catch {}
let googleStopped = null; // why searching stopped for this visit, e.g. the daily limit

async function googleSearch(query) {
  if (query in googleSaved) return googleSaved[query];
  if (googleStopped) throw new Error(googleStopped);
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location' },
    body: JSON.stringify({ textQuery: query, pageSize: 3, regionCode: 'gb',
      locationRestriction: { rectangle: { low: { latitude: 51.2, longitude: -0.55 }, high: { latitude: 51.75, longitude: 0.35 } } } }),
  });
  if (!res.ok) {
    googleStopped = res.status === 429 ? "Google's daily search limit is used up; the rest will search tomorrow." : 'Google search failed (' + res.status + ').';
    throw new Error(googleStopped);
  }
  const found = ((await res.json()).places || []).map(p => ({
    name: p.displayName?.text, address: (p.formattedAddress || '').replace(/, (London, )?UK$|, United Kingdom$/, ''),
    lat: p.location.latitude, lon: p.location.longitude,
  }));
  googleSaved[query] = found;
  try { localStorage.setItem(GOOGLE_STORE, JSON.stringify(googleSaved)); } catch {}
  return found;
}

// The SCRAN place a Google result is, if one with a similar name is within ~80 m (keeps one card per place)
async function scranPlaceFor(g) {
  const all = await loadPlaces(), key = squash(g.name);
  let best = null;
  for (const p of all) {
    if (Math.abs(p.lat - g.lat) > 0.001 || Math.abs(p.lon - g.lon) > 0.0015) continue;
    const score = p.key === key ? 2 : (p.key.includes(key) || key.includes(p.key)) && Math.min(p.key.length, key.length) >= 4 ? 1.5 : similarity(key, p.key);
    if (score >= 0.6 && (!best || score > best.score)) best = { p, score };
  }
  return best?.p || null;
}

// Coordinates from a pasted Google Maps address (the place's own pin if it has one).
// Links with only a place name are looked up on Google by name (see lookUpLink).
const linkFound = {};
function coordsFrom(raw) {
  if (raw in linkFound) return linkFound[raw];
  let text = raw;
  try { text = decodeURIComponent(raw); } catch {}
  const m = text.match(/!3d(-?\\d+\\.\\d+)!4d(-?\\d+\\.\\d+)/) || text.match(/@(-?\\d+\\.\\d+),(-?\\d+\\.\\d+)/)
    || text.match(/[?&](?:q|query|ll|center|destination)=(-?\\d+\\.\\d+),\\s*(-?\\d+\\.\\d+)/) || text.match(/^\\s*(-?\\d+\\.\\d+),\\s*(-?\\d+\\.\\d+)\\s*$/);
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  return inLondon(lat, lon) ? { lat, lon } : null;
}
const inLondon = (lat, lon) => lat > 51.2 && lat < 51.75 && lon > -0.55 && lon < 0.35;
// The place name in a link, e.g. /maps/place/Meat+Stop/… or ?q=Meat+Stop
function nameFrom(raw) {
  let text = raw;
  try { text = decodeURIComponent(raw.replace(/\\+/g, ' ')); } catch {}
  const m = text.match(/\\/maps\\/place\\/([^/@?]+)/) || text.match(/[?&](?:q|query)=([^&]+)/);
  const name = m && m[1].trim();
  return name && !/^-?\\d+\\.\\d+,\\s*-?\\d+\\.\\d+$/.test(name) ? name : null;
}
// Why a link has no location, for the status line
function linkProblem(raw) {
  if (/maps\\.app\\.goo\\.gl|goo\\.gl\\/maps/.test(raw)) return "That's a share link, which hides the location. Open it, then copy the address from the browser bar.";
  let text = raw; try { text = decodeURIComponent(raw); } catch {}
  const m = text.match(/!3d(-?\\d+\\.\\d+)!4d(-?\\d+\\.\\d+)/) || text.match(/@(-?\\d+\\.\\d+),(-?\\d+\\.\\d+)/);
  if (m && !inLondon(+m[1], +m[2])) return 'That link points outside London.';
  return 'No location or place name in that link.';
}
// Fills linkFound for a name-only link; calls done() when it's known either way
async function lookUpLink(raw, done) {
  const name = nameFrom(raw);
  if (!name || raw in linkFound) return done();
  done('Looking up “' + name + '” on Google…');
  try {
    const top = (await googleSearch(name.includes('London') ? name : name + ', London'))[0];
    linkFound[raw] = top ? { lat: top.lat, lon: top.lon, name: top.name, address: top.address } : null;
  } catch (e) { return done(e.message); }
  done();
}
function linkStatusText(raw, at, found) {
  if (!raw.trim()) return '';
  if (at) return '✓ Pin found' + (at.name ? ': ' + at.name + (at.address ? ', ' + at.address : '') : '') + found;
  return raw in linkFound ? "Google couldn't find that place." : linkProblem(raw);
}

const pinLink = at => 'https://www.google.com/maps/search/?api=1&query=' + at.lat + ',' + at.lon;
const distance = m => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m';

function buildPinCard(r) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = r.id;
  card.dataset.creator = r.creator;
  card.dataset.kind = 'pins';
  card.innerHTML = \`
    <div class="card-top">
      <span class="creator" style="background:\${r.colour}">\${esc(r.creatorName)}</span>
      <div class="name">\${esc(r.name)}</div>
      <div class="heard">Pin is \${distance(r.away)} from Google’s \${esc(r.google.name)}</div>
      \${r.videos.map(v => \`<a class="video" href="https://www.youtube.com/watch?v=\${v.videoId}\${v.at ? '&t=' + v.at + 's' : ''}" target="_blank" rel="noopener">▶ \${esc(v.title)}</a>\`).join('')}
    </div>
    <div class="claude">
      <div class="pin-where"><b>Pin on the map now</b>\${esc(r.address || 'No address')}
        <a class="option-map" href="\${pinLink(r.pin)}" target="_blank" rel="noopener">See it on Google Maps ↗</a></div>
      <div class="pin-where"><b>Google’s location</b>\${esc(r.google.name)}, \${esc(r.google.address)}
        <a class="option-map" href="\${pinLink(r.google)}" target="_blank" rel="noopener">See it on Google Maps ↗</a></div>
    </div>
    <div class="search">
      <div class="options-label">Somewhere else? Paste its Google Maps link</div>
      <input type="text" placeholder="https://www.google.com/maps/place/…" data-maplink>
      <span class="loc-status" data-loc-status></span>
    </div>
    <div class="actions">
      <button class="btn-keep" data-move>Move pin</button>
      <button class="btn-drop" data-leave>Pin is right</button>
      <button class="btn-drop" data-closed>Closed: remove</button>
      <span class="status"></span>
    </div>\`;

  const link = card.querySelector('[data-maplink]');
  const linkStatus = card.querySelector('[data-loc-status]');
  const base = { kind: 'pin', creator: r.creator, name: r.name, placeId: r.placeId, from: r.pin, keep: true };
  const decide = d => { state[r.id] = { ...base, ...d }; save(); refresh(); };
  const showLink = busy => {
    const at = coordsFrom(link.value);
    linkStatus.textContent = busy || linkStatusText(link.value, at, '. Press Move pin to use it');
    linkStatus.style.color = busy ? '#888' : at ? '#27AE60' : '#c0392b';
  };
  link.addEventListener('input', () => {
    showLink();
    if (link.value.trim() && !coordsFrom(link.value)) lookUpLink(link.value, showLink);
  });
  // Moves to your pasted link if there is one, otherwise to Google's location
  card.querySelector('[data-move]').addEventListener('click', () => {
    const at = link.value.trim() && coordsFrom(link.value);
    decide(at ? { move: true, lat: at.lat, lon: at.lon, source: 'maplink' }
              : { move: true, lat: r.google.lat, lon: r.google.lon, address: r.google.address, source: 'google' });
  });
  card.querySelector('[data-leave]').addEventListener('click', () => decide({ move: false }));
  // Google's place is often a different one when the reviewed place has shut
  card.querySelector('[data-closed]').addEventListener('click', () => decide({ move: false, remove: true, dropReason: 'closed' }));
  return card;
}

function buildCard(r, n) {
  if (r.kind === 'pin') return buildPinCard(r);
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = r.id;
  card.dataset.creator = r.creator;
  card.dataset.spot = !!r.spot;
  card.dataset.kind = r.spot ? 'spot' : 'unsure';
  const videoUrl = 'https://www.youtube.com/watch?v=' + r.videoId + (r.at ? '&t=' + r.at + 's' : '');
  const optionsHtml = r.options.map((o, i) => \`
    <label class="option">
      <input type="radio" name="opt-\${n}" value="\${i}">
      <div>
        <span class="option-name">\${esc(o.name)}\${i === 0 && r.guessed ? '<span class="best">Claude’s guess</span>' : ''}</span>
        <span class="option-address">\${esc(o.address || 'No address')}</span>
        <a class="option-map" href="\${mapLink(o)}" target="_blank" rel="noopener">Open in Google Maps ↗</a>
      </div>
    </label>\`).join('');

  card.innerHTML = \`
    <div class="card-top">
      <span class="creator" style="background:\${r.colour}">\${esc(r.creatorName)}</span>\${r.sponsored ? '<span class="ad">Ad</span>' : ''}\${r.spot ? '<span class="spot">Spot check: Claude was sure</span>' : ''}
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
      \${r.onScreen ? '<div class="why"><b>On screen:</b> ' + esc(r.onScreen) + (r.onScreenAt ? ' at ' + esc(r.onScreenAt) : '') + '</div>' : ''}
      \${r.address ? '<div class="why"><b>Address mentioned:</b> ' + esc(r.address) + '</div>' : ''}
    </div>
    \${r.comments.length ? \`<div class="comments">
      <div class="options-label">Viewers say</div>
      \${r.comments.map(c => \`<div class="comment">“\${esc(c)}”</div>\`).join('')}
    </div>\` : ''}
    <div class="options">
      <div class="options-label">Which place is it?</div>
      <div data-options>\${optionsHtml || '<div class="option-address" data-empty>No matches found. Type the name below.</div>'}</div>
      <div class="google-note" data-google-note></div>
      <div class="google-flag" data-google-flag hidden></div>
    </div>
    <div class="search">
      <div class="options-label">Not right? Type the name</div>
      <input type="search" placeholder="e.g. Sael" data-search autocomplete="off">
      <div class="results" data-results></div>
      <label class="option manual" data-manual hidden>
        <input type="radio" name="opt-\${n}" value="manual">
        <div style="flex:1">
          <span class="option-name">Not in our list: <span data-manual-name></span></span>
          <a class="option-map" data-manual-search target="_blank" rel="noopener">Find it on Google Maps ↗</a>
          <span class="option-address">then copy the page's address from your browser and paste it here, so it gets a pin:</span>
          <input type="text" placeholder="https://www.google.com/maps/place/…" data-maplink>
          <span class="loc-status" data-loc-status></span>
        </div>
      </label>
    </div>
    <label class="moved"><input type="checkbox" data-moved> Moved since the video: the place you choose is where it is now</label>
    <div class="actions">
      <button class="btn-keep">✓ Keep</button>
      <button class="btn-drop">✗ Drop</button>
      <span class="status"></span>
      <div class="drop-reasons" hidden>Why?
        \${Object.entries(DROP_REASONS).map(([k, label]) => \`<button data-reason="\${k}"\${!r.keep && k === r.reasonKey ? ' class="claudes" title="Claude’s reason"' : ''}>\${label}\${!r.keep && k === r.reasonKey ? ' (Claude)' : ''}</button>\`).join('')}
      </div>
    </div>\`;

  const options = r.options.slice(); // plus any places added from the search
  // Where each option came from, saved with your decision so learn.js can see which suggestions are right
  const sources = options.map((_, i) => i === 0 && r.guessed ? 'claude' : 'candidate');
  let suggested = r.guessed ? 'claude' : null; // the source of the option the page ticked for you
  const optionsBox = card.querySelector('[data-options]');
  const search = card.querySelector('[data-search]');
  const results = card.querySelector('[data-results]');
  const manual = card.querySelector('[data-manual]');
  const mapLinkInput = card.querySelector('[data-maplink]');
  const locStatus = card.querySelector('[data-loc-status]');
  const radios = () => [...card.querySelectorAll('input[type=radio]')];
  const select = value => radios().forEach(x => {
    x.checked = x.value === String(value);
    x.closest('.option').classList.toggle('selected', x.checked);
  });
  card.addEventListener('change', e => { if (e.target.type === 'radio') select(e.target.value); });

  // Adds a place from the search to the options, and selects it
  const same = (a, b) => a.id ? a.id === b.id : !b.id && Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5;
  const addOption = (place, tag = 'Your search', selectIt = true, atTop = false, source = 'search') => {
    let i = options.findIndex(o => same(o, place));
    if (i < 0) {
      options.push(place);
      sources.push(source);
      i = options.length - 1;
      optionsBox.querySelector('[data-empty]')?.remove();
      optionsBox.insertAdjacentHTML(atTop ? 'afterbegin' : 'beforeend', \`
        <label class="option">
          <input type="radio" name="opt-\${n}" value="\${i}">
          <div>
            <span class="option-name">\${esc(place.name)}<span class="best" style="color:#6C3483">\${tag}</span></span>
            <span class="option-address">\${esc(place.address || 'No address')}</span>
            <a class="option-map" href="\${mapLink(place)}" target="_blank" rel="noopener">Open in Google Maps ↗</a>
          </div>
        </label>\`);
    }
    if (selectIt) select(i);
    return i;
  };

  // Google's matches for the name and area, listed first. Its top match is ticked unless
  // Claude's guess is one of them, or the video gave no area and Claude had a guess.
  let googleTop = null;
  card.googleSearch = async () => {
    const note = card.querySelector('[data-google-note]');
    // A street address narrows the search most; otherwise the area, unless it's just "London"
    const where = r.address || (r.area && !/^(central |north |south |east |west )?london$/i.test(r.area) ? r.area : '');
    const queries = [r.name + (where ? ' ' + where : '') + ', London'];
    // The on-screen name too, when it differs from Claude's (it may fix a misheard name)
    // The title or description's spelling first, when it differs (e.g. heard "Roan 5", written "Row on 5")
    if (r.writtenAs) queries.unshift(r.writtenAs + (where ? ' ' + where : '') + ', London');
    if (r.onScreen && nameFit([r.name, r.originalName], r.onScreen) < 1) queries.push(r.onScreen + (where ? ' ' + where : '') + ', London');
    try {
      const found = [];
      for (const [qi, q] of queries.entries()) for (const g of await googleSearch(q)) {
        if (!found.some(f => Math.abs(f.lat - g.lat) < 1e-5 && Math.abs(f.lon - g.lon) < 1e-5)) found.push({ ...g, fromScreen: qi > 0 });
      }
      const query = queries.map(q => '“' + q + '”').join(' and ');
      note.textContent = found.length ? 'Searched Google for ' + query : 'Google found nothing for ' + query;
      const places = [];
      for (const g of found) {
        const p = await scranPlaceFor(g);
        places.push(p ? { id: p.id, name: p.name, address: p.address || g.address, lat: p.lat, lon: p.lon, fromScreen: g.fromScreen }
                      : { id: null, name: g.name, address: g.address, lat: g.lat, lon: g.lon, fromScreen: g.fromScreen });
      }
      googleTop = places[0] || null;
      const names = [r.name, r.originalName, r.onScreen].filter(Boolean);
      // Places in our list with the same name within ~1 km of Google's results (Google
      // finds the area well even when its top result is a different place)
      const nearby = places.length ? (await loadPlaces())
        .filter(p => !places.some(g => same(g, p)) && places.some(g => km(g, p) < 1.2))
        .map(p => ({ p, fit: nameFit(names, p.name), dist: Math.min(...places.map(g => km(g, p))) }))
        .filter(x => x.fit > 0)
        .sort((a, b) => b.fit - a.fit || a.dist - b.dist)
        .slice(0, 3)
        .map(({ p }) => ({ id: p.id, name: p.name, address: p.address, lat: p.lat, lon: p.lon })) : [];

      const guess = r.guessed ? r.options[0] : null;
      const agrees = guess && [...places, ...nearby].some(p => same(p, guess) || km(p, guess) < 0.3);
      const tick = places.length && !state[r.id] && !agrees && (r.specificArea || !guess);
      // Added in reverse so Google's top match ends up first, then the nearby ones
      const added = [];
      [...nearby].reverse().forEach(place => added.unshift(addOption(place, 'Same name nearby', false, true, 'nearby')));
      [...places.entries()].reverse().forEach(([k, place]) =>
        added.unshift(place.fromScreen ? addOption(place, 'Google, for the on-screen name', false, true, 'google-screen')
          : addOption(place, k === 0 ? "Google's top match" : 'Google', false, true, k === 0 ? 'google-top' : 'google')));
      if (tick) {
        // Tick the best name fit, Google's order breaking ties
        const all = [...places, ...nearby];
        const best = all.reduce((b, p, i) => nameFit(names, p.name) > nameFit(names, all[b].name) ? i : b, 0);
        select(added[best]);
        suggested = sources[added[best]];
      }
      // Google and Claude agreeing has always been the right place; Google finding nothing
      // with the name is a sign the place has closed or was only a temporary stall
      const flag = card.querySelector('[data-google-flag]');
      const named = places.some(p => nameFit(names, p.name) > 0);
      if (agrees) Object.assign(flag, { hidden: false, className: 'google-flag agrees', textContent: '✓ Google agrees with Claude’s place' });
      else if (!named) Object.assign(flag, { hidden: false, className: 'google-flag missing', textContent: 'Google can’t find this: may be closed or a temporary stall' });
    } catch (e) { note.textContent = e.message; }
  };

  const showManual = name => {
    manual.hidden = !name;
    card.querySelector('[data-manual-name]').textContent = '“' + name + '”';
    card.querySelector('[data-manual-search]').href = mapLink({ name, address: 'London' });
  };
  const showLocation = busy => {
    const at = coordsFrom(mapLinkInput.value);
    locStatus.textContent = busy || linkStatusText(mapLinkInput.value, at, '');
    locStatus.style.color = busy ? '#888' : at ? '#27AE60' : '#c0392b';
    return at;
  };
  mapLinkInput.addEventListener('focus', () => select('manual'));
  mapLinkInput.addEventListener('input', () => {
    select('manual');
    if (!showLocation() && mapLinkInput.value.trim()) lookUpLink(mapLinkInput.value, showLocation);
  });

  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const query = search.value.trim();
      showManual(query);
      if (!query) { results.innerHTML = ''; return; }
      const anchor = googleTop || options.find(o => o.lat) || null; // where the video is, roughly
      const found = await searchPlaces(query, anchor);
      if (search.value.trim() !== query) return;
      const show = (list, more) => {
        results.innerHTML = (list.length
          ? list.map((p, i) => \`<button class="result" data-i="\${i}"><b>\${esc(p.name)}</b> <span>\${esc(p.address || '')}\${p.google ? ' · Google' : ''}</span></button>\`).join('')
          : '') + (more ? '<div class="option-address">' + more + '</div>' : '');
        results.querySelectorAll('.result').forEach(b => b.addEventListener('click', () => {
          const p = list[+b.dataset.i];
          addOption(p, p.google ? 'Google, your search' : 'Your search', true, false, p.google ? 'google-search' : 'search');
          results.innerHTML = '';
        }));
      };
      show(found, GOOGLE_KEY && query.length >= 3 ? 'Searching Google too…' : found.length ? '' : 'Not in our places list.');
      if (!GOOGLE_KEY || query.length < 3) return;
      // Google as well, once typing pauses (each search is saved, so retyping costs nothing)
      await new Promise(res => setTimeout(res, 600));
      if (search.value.trim() !== query) return;
      let fromGoogle = [];
      try {
        for (const g of await googleSearch(/london/i.test(query) ? query : query + ', London')) {
          const p = await scranPlaceFor(g);
          fromGoogle.push(p ? { id: p.id, name: p.name, address: p.address || g.address, lat: p.lat, lon: p.lon, google: true }
                            : { id: null, name: g.name, address: g.address, lat: g.lat, lon: g.lon, google: true });
        }
      } catch (e) { if (search.value.trim() === query) show(found, e.message); return; }
      if (search.value.trim() !== query) return;
      fromGoogle = fromGoogle.filter(g => !found.some(f => same(f, g)));
      const all = [...found, ...fromGoogle];
      show(all, all.length ? '' : 'Not found in our places list or on Google.');
    }, 150);
  });

  const s = state[r.id];
  if (s?.keep && (s.placeId || (s.lat && !s.manual))) addOption({ id: s.placeId, name: s.name, address: s.address, lat: s.lat, lon: s.lon }, 'Your choice', true, false, s.source || 'unknown');
  else if (s?.keep && s.manual) {
    search.value = s.manual; showManual(s.manual);
    if (s.mapLink && s.lat != null && !coordsFrom(s.mapLink)) linkFound[s.mapLink] = { lat: s.lat, lon: s.lon, address: s.address };
    mapLinkInput.value = s.mapLink || ''; showLocation();
    select('manual');
  }
  else if (s && s.optionIndex != null) select(s.optionIndex); // saved by the page's first version
  else if (options.length && r.guessed) select(0);

  const movedBox = card.querySelector('[data-moved]');
  movedBox.checked = !!s?.moved;

  // Claude's call and what the page suggested, saved with every decision
  const context = () => ({
    creator: r.creator, videoId: r.videoId, originalName: r.originalName, area: r.area,
    claude: { keep: r.keep, reason: r.reasonKey, name: r.name, placeId: r.guessed ? r.options[0].id : null },
    suggested, spot: !!r.spot, moved: movedBox.checked,
  });
  // Ticking or unticking after deciding updates the saved decision
  movedBox.addEventListener('change', () => { if (state[r.id]) { state[r.id].moved = movedBox.checked; save(); } });

  card.querySelector('.btn-keep').addEventListener('click', () => {
    const chosen = radios().find(x => x.checked)?.value;
    if (chosen == null) { alert('Choose the place first, or type its name under "Not right?".'); return; }
    if (chosen === 'manual') {
      const name = search.value.trim();
      const at = showLocation();
      if (!at && !confirm(name + ' has no pin yet, so it won\\'t be on the map. Keep it anyway?')) { mapLinkInput.focus(); return; }
      state[r.id] = {
        ...context(), keep: true,
        name, placeId: null, lat: at?.lat ?? null, lon: at?.lon ?? null, address: at?.address ?? null,
        manual: name, mapLink: mapLinkInput.value.trim() || null, source: at ? 'maplink' : 'typed-no-pin',
      };
    } else {
      const o = options[+chosen];
      state[r.id] = {
        ...context(), keep: true,
        name: o.name, placeId: o.id, lat: o.lat, lon: o.lon, address: o.address ?? null, manual: null,
        source: sources[+chosen],
      };
    }
    shareWithTwins(r);
    save(); refresh();
  });
  // Dropping always asks why (Claude's reason highlighted), so learn.js can spot repeated mistakes
  const reasons = card.querySelector('.drop-reasons');
  const drop = reason => { state[r.id] = { ...context(), keep: false, dropReason: reason }; reasons.hidden = true; save(); refresh(); };
  card.querySelector('.btn-drop').addEventListener('click', () => { reasons.hidden = !reasons.hidden; });
  reasons.querySelectorAll('button').forEach(b => b.addEventListener('click', () => drop(b.dataset.reason)));
  return card;
}

// The same restaurant in another of the creator's videos (long videos are often cut into Shorts):
// keeping one fills in the other's place too, if it's still to do and Claude kept it there.
// It's marked source 'twin', so you can change it and learn.js can tell it apart.
const twinKey = n => (n || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
  .replace(/^the\\s+/, '').replace(/\\s(&|and)\\s/g, ' ').replace(/['’]s\\b/g, 's').replace(/[^a-z0-9]/g, '').replace(/s$/, '');
const twinKeys = r => [r.name, r.originalName].map(twinKey).filter(k => k.length >= 3 && k !== 'unknown');
function shareWithTwins(r) {
  const d = state[r.id];
  if (!d?.keep) return;
  const keys = twinKeys(r);
  for (const t of DATA) {
    if (t === r || t.kind === 'pin' || t.creator !== r.creator || t.videoId === r.videoId || !t.keep || state[t.id]) continue;
    if (!twinKeys(t).some(k => keys.includes(k))) continue;
    state[t.id] = { ...d, videoId: t.videoId, originalName: t.originalName, area: t.area,
      claude: { keep: t.keep, reason: t.reasonKey, name: t.name, placeId: t.guessed ? t.options[0].id : null },
      suggested: null, spot: !!t.spot, moved: false, source: 'twin', twinOf: r.id };
    const old = grid.querySelector('.card[data-id="' + CSS.escape(t.id) + '"]');
    if (old) old.replaceWith(buildCard(t, DATA.indexOf(t)));
  }
}

function statusOf(id) { const s = state[id]; return !s ? 'pending' : s.keep ? 'kept' : 'dropped'; }

function refresh() {
  const kindOf = r => r.kind === 'pin' ? 'pins' : r.spot ? 'spot' : 'unsure';
  const visible = DATA.filter(r => (creatorFilter === 'all' || r.creator === creatorFilter) && kindOf(r) === kindFilter);
  document.querySelectorAll('.card').forEach(card => {
    const status = statusOf(card.dataset.id);
    const s = state[card.dataset.id];
    card.classList.toggle('kept', status === 'kept');
    card.classList.toggle('dropped', status === 'dropped');
    card.querySelector('.status').textContent = s?.kind === 'pin' ? (s.remove ? 'Closed: removed from the map' : s.move ? (s.source === 'maplink' ? 'Moved to your link' : 'Moved to Google’s location') : 'Pin left as it is')
      : status === 'kept' ? 'Kept: ' + s.name + (s.twinOf ? ' (your answer from its other video)' : '')
      : status === 'dropped' ? 'Dropped' + (s.dropReason && DROP_REASONS[s.dropReason] ? ': ' + DROP_REASONS[s.dropReason] : '') : '';
    card.classList.toggle('hidden',
      card.dataset.kind !== kindFilter ||
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

// Search Google for the cards still to do, one at a time
(async () => {
  if (!GOOGLE_KEY) return;
  for (const card of document.querySelectorAll('.card')) {
    if (!state[card.dataset.id] && card.dataset.kind === 'unsure') await card.googleSearch();
  }
})();

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
document.querySelectorAll('#kind-tabs .tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#kind-tabs .tab').forEach(t => t.classList.remove('active'));
  b.classList.add('active');
  const other = b.dataset.kind === 'suggestions' || b.dataset.kind === 'added';
  document.body.classList.toggle('suggestions-view', other);
  document.getElementById('suggestions').hidden = !other;
  if (b.dataset.kind === 'suggestions') { loadSuggestions(); return; }
  if (b.dataset.kind === 'added') { loadAdded(); return; }
  kindFilter = b.dataset.kind; refresh();
}));

// "Suggest a creator" from the app's Explore sheet. Needs you signed in to SCRAN in this browser
// (the app at http://localhost:8000) with an account listed in the admins table.
const sb = window.supabase && '${SUPABASE_URL}' ? window.supabase.createClient('${SUPABASE_URL}', '${SUPABASE_KEY}') : null;
async function loadSuggestions() {
  const box = document.getElementById('suggestions');
  if (!sb) { box.innerHTML = '<p class="help">Supabase didn’t load.</p>'; return; }
  box.innerHTML = '<p class="help">Loading…</p>';
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    box.innerHTML = '<p class="help">Sign in to SCRAN at <a href="http://localhost:8000">http://localhost:8000</a> in this browser, then come back to this tab.</p>';
    return;
  }
  const { data, error } = await sb.from('creator_suggestions')
    .select('id, suggestion, created_at, profiles(name)').order('created_at', { ascending: false });
  if (error) { box.innerHTML = '<p class="help">Couldn’t load suggestions: ' + esc(error.message) + '</p>'; return; }
  if (!data.length) {
    box.innerHTML = '<p class="help">No suggestions yet. (If you know there are some, check your account is in the <code>admins</code> table: see supabase/creator-suggestions.sql.)</p>';
    return;
  }
  box.innerHTML = '<p class="help">' + data.length + ' suggestion' + (data.length === 1 ? '' : 's') + ', newest first. <b>Done</b> removes one.</p>' + data.map(s => {
    const text = /^https?:$/.test(s.suggestion.split('//')[0])
      ? '<a href="' + esc(s.suggestion) + '" target="_blank" rel="noopener">' + esc(s.suggestion) + '</a>' : esc(s.suggestion);
    return '<div class="suggestion"><div class="suggestion-text">' + text +
      '<div class="suggestion-meta">' + esc(s.profiles?.name || 'Someone') + ' · ' + new Date(s.created_at).toLocaleDateString('en-GB') + '</div></div>' +
      '<button data-done="' + s.id + '">Done</button></div>';
  }).join('');
}
document.getElementById('suggestions').addEventListener('click', async e => {
  const done = e.target.closest('[data-done]')?.dataset.done;
  const del = e.target.closest('[data-delete-place]')?.dataset.deletePlace;
  if (done) {
    const { error } = await sb.from('creator_suggestions').delete().eq('id', done);
    if (error) alert('Couldn’t remove it: ' + error.message);
    loadSuggestions();
  } else if (del) {
    const name = e.target.closest('.suggestion').querySelector('b').textContent;
    if (!confirm('Delete ' + name + ' from SCRAN for everyone? People’s ratings of it stay in their accounts but lose the pin.')) return;
    const { data, error } = await sb.from('added_places').delete().eq('id', del).select('id');
    if (error || !data.length) alert('Couldn’t delete it' + (error ? ': ' + error.message : '. Check your account is in the admins table.'));
    loadAdded();
  }
});

// Places people added in the app ("Can't find it? Add it"), newest first, so you can delete junk
const KINDS = { eat: 'Restaurant', pub: 'Pub or bar', cafe: 'Café' };
async function loadAdded() {
  const box = document.getElementById('suggestions');
  if (!sb) { box.innerHTML = '<p class="help">Supabase didn’t load.</p>'; return; }
  box.innerHTML = '<p class="help">Loading…</p>';
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    box.innerHTML = '<p class="help">Sign in to SCRAN at <a href="http://localhost:8000">http://localhost:8000</a> in this browser, then come back to this tab.</p>';
    return;
  }
  const { data, error } = await sb.from('added_places')
    .select('id, name, kind, lat, lon, address, created_at, profiles(name)').order('created_at', { ascending: false });
  if (error) { box.innerHTML = '<p class="help">Couldn’t load added places: ' + esc(error.message) + '</p>'; return; }
  if (!data.length) { box.innerHTML = '<p class="help">No one has added a place yet.</p>'; return; }
  box.innerHTML = '<p class="help">' + data.length + ' added place' + (data.length === 1 ? '' : 's') + ', newest first. Everyone sees these on the map. <b>Delete</b> removes one for everyone.</p>' + data.map(p => {
    const google = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(p.name + ', ' + (p.address || 'London'));
    const scran = 'http://localhost:8000/?lat=' + p.lat + '&lon=' + p.lon + '&type=place&id=a-' + p.id + '&name=' + encodeURIComponent(p.name);
    return '<div class="suggestion"><div class="suggestion-text"><b>' + esc(p.name) + '</b> · ' + esc(KINDS[p.kind] || p.kind) +
      (p.address ? '<div class="suggestion-meta">' + esc(p.address) + '</div>' : '') +
      '<div class="suggestion-meta">Added by ' + esc(p.profiles?.name || 'someone who has left') + ' · ' + new Date(p.created_at).toLocaleDateString('en-GB') +
      ' · <a href="' + scran + '" target="_blank" rel="noopener">On SCRAN</a> · <a href="' + google + '" target="_blank" rel="noopener">Google Maps</a></div></div>' +
      '<button data-delete-place="' + p.id + '">Delete</button></div>';
  }).join('');
}
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
