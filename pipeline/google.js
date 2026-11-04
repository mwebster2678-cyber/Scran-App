// Google Places Text Search (New) for a pick's name and area, with the pipeline's own key
// (GOOGLE_MAPS_API_KEY in .env: Places API (New) only, no website restriction).
// Each search is saved in cache/, so re-runs cost nothing; the daily cap in Google Cloud
// stops a bug overspending.
import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import { NAME_STOPWORDS, soundsLike } from './link.js';

const CACHE = 'cache';
const LONDON = { low: { latitude: 51.2, longitude: -0.55 }, high: { latitude: 51.75, longitude: 0.35 } };
const FIELDS = 'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus,places.primaryType';

// Google limits searches per minute as well as per day: on a 429, wait a minute and retry
// a few times before giving up
async function search(query, near, tries = 3) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': FIELDS },
    body: JSON.stringify({ textQuery: query, pageSize: 3, regionCode: 'gb', ...(near
      ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lon }, radius: 2000 } } }
      : { locationRestriction: { rectangle: LONDON } }) }),
  });
  if (res.status !== 429 || tries <= 1) return res;
  await new Promise(done => setTimeout(done, 61_000));
  return search(query, near, tries - 1);
}

// `near` ({lat, lon}) prefers results around a point, e.g. the branch closest to a pin,
// instead of restricting to London
export async function googleSearch(query, near = null) {
  const key = near ? `${query}@${near.lat.toFixed(4)},${near.lon.toFixed(4)}` : query;
  const file = `${CACHE}/google-${crypto.createHash('md5').update(key).digest('hex').slice(0, 16)}.json`;
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await search(query, near);
  if (res.status === 429) throw new Error("Google's search limit is used up; run again later (searches so far are saved).");
  if (!res.ok) throw new Error(`Google search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const found = ((await res.json()).places || []).map(p => ({
    googleId: p.id, name: p.displayName?.text,
    address: (p.formattedAddress || '').replace(/, (London, )?UK$|, United Kingdom$/, ''),
    lat: p.location.latitude, lon: p.location.longitude,
    status: p.businessStatus || null, type: p.primaryType || null,
  }));
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ query, found }, null, 1));
  return { query, found };
}

// Where to search: a street address narrows it most; otherwise the area, unless it's just "London"
export const searchArea = pick =>
  pick.address || (pick.area && !/^(central |north |south |east |west )?london$/i.test(pick.area) ? pick.area : '');

export const searchQuery = (name, pick) => {
  const where = searchArea(pick);
  return name + (where ? ' ' + where : '') + ', London';
};

// How well a place's name fits a pick's names: share of distinctive words in common
// ("The George" fits "The George Tavern" better than "George & Dragon" does)
const STOPWORDS = new Set(NAME_STOPWORDS);
const distinct = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '')
  .split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOPWORDS.has(w));
export function nameFit(names, placeName) {
  const b = distinct(placeName);
  return Math.max(0, ...names.filter(Boolean).map(n => {
    const a = distinct(n);
    const shared = a.filter(w => b.includes(w)).length;
    return shared / new Set([...a, ...b]).size || 0;
  }));
}

// Google's best place for a pick: its top results for the name (and the on-screen name when it
// differs), the one whose name fits best. `strong` when the name clearly fits and the video
// narrowed the search to an area or address.
export async function googleMatch(pick) {
  const names = [pick.name, pick.originalName, pick.onScreen];
  const queries = [searchQuery(pick.name, pick)];
  if (pick.onScreen && nameFit([pick.name, pick.originalName], pick.onScreen) < 1) queries.push(searchQuery(pick.onScreen, pick));
  const found = [];
  for (const q of queries) for (const g of (await googleSearch(q)).found) {
    if (!found.some(f => f.googleId === g.googleId)) found.push(g);
  }
  const scored = found.map((g, rank) => ({ ...g, rank,
    fit: Math.max(nameFit(names, g.name), ...names.filter(Boolean).map(n => soundsLike(n, g.name) >= 0.85 ? 0.5 : 0)) }));
  const best = scored.filter(g => g.fit > 0).sort((a, b) => b.fit - a.fit || a.rank - b.rank)[0] || null;
  return { queries, found, best, strong: !!best && best.fit >= 0.5 && !!searchArea(pick) };
}
