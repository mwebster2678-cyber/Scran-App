// Groups mentions into one entry per restaurant and finds each one's location.
// Uses <creator>-verified.json (from verify.js, plus your verify-decisions.json) when it
// exists; otherwise the raw scraped picks, located with Google.
// Usage: node geocode.js <creator>
import fs from 'fs';
import { creatorFromArgs, nameKey, geocodeLondon } from './shared.js';
import { PLACES_FILE } from './link.js';
import { loadKnown, findKnown } from './known.js';

const creator   = creatorFromArgs();
const INPUT     = creator.files.scraped;
const OUTPUT    = creator.files.geocoded;
const VERIFIED  = `${creator.key}-verified.json`;
const DECISIONS = 'verify-decisions.json';
const UNVERIFIED = `${creator.key}-geocoded-unverified.json`;

async function geocode(name, location) {
  // Try progressively looser queries until we get a specific establishment hit
  const queries = [
    `${name} restaurant ${location || ''} London`,
    `${name} ${location || ''} London`,
    `${name} London`,
  ];
  for (const q of queries) {
    const [best] = await geocodeLondon(q);
    if (best) return { lat: best.lat, lon: best.lon };
  }
  return { lat: null, lon: null };
}

// ─── From verified picks ────────────────────────────────────────────────────

async function fromVerified() {
  const videos = JSON.parse(fs.readFileSync(VERIFIED, 'utf8'));
  const { places } = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8'));
  const placeById = new Map(places.map(([id, name, lat, lon]) => [id, { name, lat, lon }]));

  // Your decisions from the review page override Claude's
  const decisions = new Map((fs.existsSync(DECISIONS) ? JSON.parse(fs.readFileSync(DECISIONS, 'utf8')) : [])
    .filter(d => d.creator === creator.key)
    .map(d => [`${d.videoId}:${d.originalName}`, d]));

  // Where each pick was placed before verify.js, for picks with no matching place
  // (a copy of the old output is kept, because this step overwrites it)
  if (!fs.existsSync(UNVERIFIED) && fs.existsSync(OUTPUT)) fs.copyFileSync(OUTPUT, UNVERIFIED);
  const previous = new Map();
  if (fs.existsSync(UNVERIFIED)) {
    for (const r of JSON.parse(fs.readFileSync(UNVERIFIED, 'utf8'))) {
      if (r.lat) previous.set(nameKey(r.name), { lat: r.lat, lon: r.lon });
    }
  }

  const known = loadKnown();
  const byPlace = new Map();
  const unplaced = [];
  let dropped = 0, decided = 0, fromKnown = 0;
  for (const video of videos) {
    for (const pick of video.restaurants) {
      const decision = decisions.get(`${video.videoId}:${pick.originalName}`);
      if (decision) decided++;
      const keep = decision ? decision.keep : pick.keep;
      if (!keep) { dropped++; continue; }

      // A place you confirmed for this restaurant in another video, when Claude wasn't sure here
      const confirmed = !decision && (!pick.confident || !pick.placeId) ? findKnown(known, pick) : null;
      if (confirmed) fromKnown++;
      const answer  = decision || confirmed;
      const name    = answer?.name || pick.name;
      const placeId = answer ? answer.placeId : pick.placeId;
      let at = placeById.get(placeId)
        ?? (answer?.lat ? { lat: answer.lat, lon: answer.lon } : null)
        ?? previous.get(nameKey(name)) ?? previous.get(nameKey(pick.originalName));
      if (!at && decision?.manual) {
        const [best] = await geocodeLondon(`${decision.manual} London`).catch(() => []);
        if (best) at = best;
      }
      if (!at) { unplaced.push(name); continue; }

      // Same place → one entry; otherwise same name close together (so branches stay separate)
      const key = placeId || `${nameKey(name)}@${at.lat.toFixed(3)},${at.lon.toFixed(3)}`;
      if (!byPlace.has(key)) {
        byPlace.set(key, { name, location: pick.area || pick.location || null, lat: at.lat, lon: at.lon, placeId: placeId || null, mentions: [] });
      }
      const m = String(pick.moment || '').match(/^(\d+):(\d{2})$/);
      byPlace.get(key).mentions.push({
        videoId:       video.videoId,
        videoTitle:    video.title,
        rating:        pick.rating ?? null,
        rating_out_of: pick.rating_out_of ?? null,
        sentiment:     pick.sentiment,
        notes:         pick.notes,
        verdict:       pick.verdict || null,
        dishes:        pick.dishes || [],
        sponsored:     !!video.sponsored,
        at:            m ? +m[1] * 60 + +m[2] : null,
      });
    }
  }

  const results = [...byPlace.values()].map(r => {
    const ratings = r.mentions.map(m => m.rating).filter(v => v != null);
    const bestRating = ratings.length ? Math.max(...ratings) : null;
    const best = r.mentions.find(m => m.rating === bestRating) || r.mentions[0];
    return { ...r, bestRating, bestRatingOutOf: best?.rating_out_of ?? null };
  });

  fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2));
  console.log(`${creator.name}: ${results.length} restaurants from verified picks (${dropped} picks dropped, ${decided} decided by you, ${fromKnown} placed from your earlier answers) → ${OUTPUT}`);
  if (unplaced.length) console.log(`No location for ${unplaced.length} kept picks (not on the map):\n${unplaced.map(n => `  ${n}`).join('\n')}`);
}

// ─── From raw scraped picks ─────────────────────────────────────────────────

async function main() {
  if (fs.existsSync(VERIFIED)) return fromVerified();
  const raw = JSON.parse(fs.readFileSync(INPUT, 'utf8'));

  // Flatten all restaurant mentions across all videos
  const mentions = raw.flatMap(video =>
    (video.restaurants || [])
      .filter(r => r.name && r.name !== 'null')
      .map(r => ({ ...r, videoId: video.videoId, videoTitle: video.title }))
  );

  // Deduplicate by lowercase name — aggregate multiple video mentions
  const byName = new Map();
  for (const r of mentions) {
    const key = nameKey(r.name);
    if (!byName.has(key)) {
      byName.set(key, { name: r.name, location: r.location, mentions: [] });
    }
    byName.get(key).mentions.push({
      videoId:       r.videoId,
      videoTitle:    r.videoTitle,
      rating:        r.rating ?? null,
      rating_out_of: r.rating_out_of ?? null,
      sentiment:     r.sentiment,
      notes:         r.notes,
    });
  }

  const unique = [...byName.values()];
  console.log(`${unique.length} unique restaurants to geocode\n`);

  const results = [];
  for (let i = 0; i < unique.length; i++) {
    const r = unique[i];
    process.stdout.write(`[${i + 1}/${unique.length}] ${r.name}... `);
    const { lat, lon } = await geocode(r.name, r.location);

    // Best rating across all mentions
    const ratings = r.mentions.map(m => m.rating).filter(v => v != null);
    const bestRating    = ratings.length ? Math.max(...ratings) : null;
    const bestMention   = r.mentions.find(m => m.rating === bestRating) || r.mentions[0];

    results.push({
      name:          r.name,
      location:      r.location,
      lat,
      lon,
      bestRating,
      bestRatingOutOf: bestMention?.rating_out_of ?? null,
      mentions:      r.mentions,
    });

    console.log(lat ? `${lat.toFixed(4)}, ${lon.toFixed(4)}` : 'not found');
  }

  const found    = results.filter(r => r.lat).length;
  const notFound = results.length - found;
  console.log(`\nGeocoded: ${found}  Not found: ${notFound}`);

  fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2));
  console.log(`Saved to ${OUTPUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
