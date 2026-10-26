// Links creator picks to places in ../data/places.json, so the app can show one card per
// restaurant with every creator's verdict, Google's info and the user's own rating.
// Used by inject.js; re-run `node inject.js <creator>` for each creator after `node places.js`.
import fs from 'fs';

export const PLACES_FILE = '../data/places.json';

// Words that say what a place is rather than which one it is
const GENERIC = new Set((
  'the and of at by on in de la le el il co ltd london restaurant restaurants cafe caffe coffee bar bars pub ' +
  'tavern inn house kitchen kitchens grill dining pizza pizzeria burger burgers chicken fried deep noodle noodles ' +
  'shop bakery bake club tap taproom brew brewing thai indian chinese italian japanese korean mexican kebab kebabs ' +
  'tacos taco poke oriental collective market hall food foods eatery street bridge tower soho cross square road ' +
  'lane wine deli joint express'
).split(' '));

const normalise   = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/&/g, ' and ').replace(/['’]/g, '');
const words       = s => normalise(s).split(/[^a-z0-9]+/).filter(Boolean);
export const squash = s => words(s).filter(w => w !== 'the' && w !== 'and').join('');
const distinctive = s => words(s).filter(w => w.length >= 3 && !GENERIC.has(w));

// Share of letter pairs two strings have in common (0–1); tolerates misheard spellings
export function similarity(a, b) {
  const pairs = s => Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2));
  const pa = pairs(a), pb = pairs(b);
  if (!pa.length || !pb.length) return 0;
  const unused = new Map(); // pair → how many of b's are still unmatched
  pb.forEach(p => unused.set(p, (unused.get(p) || 0) + 1));
  let hits = 0;
  for (const p of pa) {
    if (unused.get(p) > 0) { hits++; unused.set(p, unused.get(p) - 1); }
  }
  return 2 * hits / (pa.length + pb.length);
}

// How sure we are two names are the same place, and how far apart they can be (metres)
function nameMatch(a, b) {
  const sa = squash(a), sb = squash(b);
  if (!sa || !sb) return null;
  if (sa === sb) return { score: 1, maxDistance: 200 };
  // One name inside the other ("Smacks" / "Smacks Hamburgers"), if the shorter one is distinctive
  const shorter = sa.length < sb.length ? a : b;
  if (Math.min(sa.length, sb.length) >= 4 && (sa.includes(sb) || sb.includes(sa)) && distinctive(shorter).length) {
    return { score: 0.9, maxDistance: 150 };
  }
  // Misheard or misspelt ("Schnitle Forever" / "Schnitzel Forever")
  if (similarity(sa, sb) >= 0.75) return { score: 0.8, maxDistance: 100 };
  // Same leading name ("The George Public House" / "The George Tavern"), right next door
  const [fa] = distinctive(a), [fb] = distinctive(b);
  if (fa && fa === fb) return { score: 0.6, maxDistance: 60 };
  return null;
}

export function metres(a, b) {
  const dy = (a.lat - b.lat) * 111320;
  const dx = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dx, dy);
}

// Adds `placeId` (or null) to each restaurant that doesn't have one yet. Returns the names that couldn't be linked.
export function linkToPlaces(restaurants) {
  const { places } = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8'));
  const unlinked = [];
  for (const r of restaurants) {
    if (r.placeId) continue; // already confirmed by verify.js
    let best = null;
    for (const [id, name, lat, lon] of places) {
      if (Math.abs(lat - r.lat) > 0.003 || Math.abs(lon - r.lon) > 0.005) continue; // ~300 m box
      const match = nameMatch(r.name, name);
      if (!match) continue;
      const distance = metres(r, { lat, lon });
      if (distance > match.maxDistance) continue;
      const score = match.score - distance / 1000; // prefer better names, then nearer places
      if (!best || score > best.score) best = { score, id };
    }
    r.placeId = best ? best.id : null;
    if (!best) unlinked.push(r.name);
  }
  return unlinked;
}
