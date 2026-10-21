// Groups scraped mentions into one entry per restaurant and finds each one's location.
// Usage: node geocode.js <creator>
import fs from 'fs';
import { creatorFromArgs, nameKey, geocodeLondon } from './shared.js';

const creator = creatorFromArgs();
const INPUT   = creator.files.scraped;
const OUTPUT  = creator.files.geocoded;

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
