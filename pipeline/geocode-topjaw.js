import 'dotenv/config';
import fs from 'fs';

const INPUT  = 'topjaw-restaurants.json';
const OUTPUT = 'topjaw-geocoded.json';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Result types that indicate Google fell back to a generic city/region result
const GENERIC_TYPES = new Set([
  'locality', 'administrative_area_level_1', 'administrative_area_level_2',
  'administrative_area_level_3', 'country', 'postal_code', 'political',
]);

// Rough M25 bounding box — discard results clearly outside London
const LONDON = { minLat: 51.2, maxLat: 51.75, minLon: -0.55, maxLon: 0.35 };

async function geocode(name, location) {
  // Try progressively looser queries until we get a specific establishment hit
  const queries = [
    `${name} restaurant ${location || ''} London`,
    `${name} ${location || ''} London`,
    `${name} London`,
  ];
  for (const q of queries) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q.trim())}&region=gb&key=${GOOGLE_MAPS_API_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.results?.length) {
      const result = data.results[0];
      const types  = result.types || [];
      // Skip if Google returned a generic city/region rather than a specific place
      if (types.every(t => GENERIC_TYPES.has(t))) continue;
      const { lat, lng } = result.geometry.location;
      // Skip if result is outside the M25
      if (lat < LONDON.minLat || lat > LONDON.maxLat || lng < LONDON.minLon || lng > LONDON.maxLon) continue;
      return { lat, lon: lng };
    }
  }
  return { lat: null, lon: null };
}

async function main() {
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
    const key = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
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

  if (!GOOGLE_MAPS_API_KEY) throw new Error('GOOGLE_MAPS_API_KEY is missing from .env');

  const unique = [...byName.values()];
  console.log(`${unique.length} unique restaurants to geocode\n`);

  const results = [];
  for (let i = 0; i < unique.length; i++) {
    const r = unique[i];
    process.stdout.write(`[${i + 1}/${unique.length}] ${r.name}... `);
    const { lat, lon } = await geocode(r.name, r.location);

    // Best rating across all mentions (Topjaw rarely gives scores, but capture if present)
    const ratings    = r.mentions.map(m => m.rating).filter(v => v != null);
    const bestRating = ratings.length ? Math.max(...ratings) : null;
    const bestMention = r.mentions.find(m => m.rating === bestRating) || r.mentions[0];

    results.push({
      name:            r.name,
      location:        r.location,
      lat,
      lon,
      bestRating,
      bestRatingOutOf: bestMention?.rating_out_of ?? null,
      mentions:        r.mentions,
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
