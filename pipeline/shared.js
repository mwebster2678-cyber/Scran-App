// Shared config and helpers for every pipeline step.
// Each step takes the creator key as its first argument, e.g. `node geocode.js tod`.
import 'dotenv/config';

// To add a creator: add an entry here and a matching one in ../app.js CREATORS.
// `source` is how the scraper reads a video: 'transcript' (spoken reviews)
// or 'description' (reviews written in the video description).
export const CREATORS = {
  tod: {
    name: 'Tod',
    channel: 'eatingwithtod',
    source: 'transcript',
    emoji: '⭐',
    colour: '#D4AC0D',
    textColour: '#A07D00',
  },
  topjaw: {
    name: 'Topjaw',
    channel: 'topjaw',
    source: 'description',
    emoji: '🔵',
    colour: '#0e7490',
    textColour: '#0e7490',
  },
};

// Reads the creator key from the command line, or exits with usage help.
export function creatorFromArgs() {
  const key = process.argv[2];
  if (!CREATORS[key]) {
    const script = process.argv[1].split('/').pop();
    console.error(`Usage: node ${script} <${Object.keys(CREATORS).join('|')}>`);
    process.exit(1);
  }
  return {
    key,
    ...CREATORS[key],
    files: {
      scraped:     `${key}-scraped.json`,      // scrape.js output: restaurants per video
      geocoded:    `${key}-geocoded.json`,     // geocode.js output: one entry per restaurant
      review:      `review-${key}.html`,       // build-review.js output
      corrections: `${key}-corrections.json`,  // exported from the review page
      app:         `../data/${key}.json`,      // what SCRAN loads
    },
  };
}

// Key used to match the same restaurant across videos and corrections
export function nameKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─── Google geocoding ───────────────────────────────────────────────────────

// Rough M25 bounding box — discard results clearly outside London
const LONDON = { minLat: 51.2, maxLat: 51.75, minLon: -0.55, maxLon: 0.35 };

// Result types that indicate Google fell back to a generic city/region result
const GENERIC_TYPES = new Set([
  'locality', 'administrative_area_level_1', 'administrative_area_level_2',
  'administrative_area_level_3', 'country', 'postal_code', 'political',
]);

// Google results for `query` that are specific places inside London
export async function geocodeLondon(query) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is missing from .env');
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query.trim())}&region=gb&key=${apiKey}`;
  const data = await (await fetch(url)).json();
  return (data.results || [])
    .filter(r => !(r.types || []).every(t => GENERIC_TYPES.has(t)))
    .map(r => ({
      name:    r.address_components?.[0]?.long_name,
      address: r.formatted_address,
      lat:     r.geometry.location.lat,
      lon:     r.geometry.location.lng,
    }))
    .filter(({ lat, lon }) =>
      lat >= LONDON.minLat && lat <= LONDON.maxLat && lon >= LONDON.minLon && lon <= LONDON.maxLon);
}
