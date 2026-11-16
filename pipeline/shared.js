// Shared config and helpers for every pipeline step.
// Each step takes the creator key as its first argument, e.g. `node geocode.js tod`.
import 'dotenv/config';

// To add a creator: add an entry here and a matching one in ../app.js CREATORS.
// `source` is how the scraper reads a video: 'transcript' (spoken reviews)
// or 'description' (reviews written in the video description); `about` is optional
// context for Claude (e.g. who presents). New creators use scrape.js.
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
  },  bitetwice: {
    name: 'Bite Twice',
    channel: 'BiteTwice',
    source: 'transcript',
    about: 'Bite Twice is two presenters, Gerry and Paul, reviewing together; either of them giving their view counts as Bite Twice reviewing it.',
    emoji: '🟠',
    colour: '#D35400',
    textColour: '#B34700',
  },
  morefallow: {
    name: 'More Fallow',
    channel: 'MoreFallow',
    source: 'transcript',
    about: 'More Fallow is the YouTube channel of the chefs who run Fallow, a restaurant in St James\'s, London; they make long videos reviewing one or a few restaurants, sometimes outside London. Restaurants they run or work in themselves (e.g. Fallow, Roe) are never their reviews: drop them with reason "own_place".',
    maxText: 80_000, // long videos: the places can come late
    emoji: '🟢',
    colour: '#2E7D32',
    textColour: '#1B5E20',
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

// A restaurant name as it should appear on the map, without Google listing styling:
// "#AsadorCamden" → "Asador Camden", "Peckish Burgers | Camden" → "Peckish Burgers",
// "Roll Boys." → "Roll Boys" (abbreviations like "Co." keep their full stop)
export function tidyName(name) {
  let n = name.trim()
    .replace(/^#(\S+)$/, (_, tag) => tag.replace(/([a-z])([A-Z])/g, '$1 $2'))
    .replace(/\s+[|•·]\s+.*$/, '')
    .replace(/\s{2,}/g, ' ');
  if (/\.$/.test(n) && !/\b(Co|Ltd|St|Jr|Inc|Bros)\.$/i.test(n)) n = n.slice(0, -1);
  // Typed in lowercase: capitalise each word
  if (n === n.toLowerCase()) n = n.replace(/\b[a-z]/g, c => c.toUpperCase());
  return n;
}

// Whether a street address is actually given in the video's text (description, transcript,
// chapters, comments, on-screen graphics): its postcode, house number and street, or street name.
// Claude sometimes copies the address of the place it guessed, which isn't evidence of anything.
const STREET_WORDS = new Set(['road', 'rd', 'street', 'st', 'lane', 'ln', 'avenue', 'ave', 'high', 'place', 'pl',
  'square', 'sq', 'way', 'row', 'hill', 'terrace', 'parade', 'yard', 'market', 'london', 'unit', 'the', 'and']);
const plain = s => ' ' + String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
export function addressInText(address, text) {
  if (!address) return false;
  const t = plain(text), squashed = t.replace(/ /g, '');
  const postcode = address.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i)?.[0];
  if (postcode && squashed.includes(postcode.toLowerCase().replace(/\s/g, ''))) return true;
  const street = address.split(',').find(part => /[a-z]{3}/i.test(part) && !/^\s*unit\b/i.test(part)) || '';
  const numbered = street.match(/\b(\d+[a-z]?)\s+([a-z]+)/i);
  if (numbered && t.includes(` ${numbered[1].toLowerCase()} ${numbered[2].toLowerCase()} `)) return true;
  const name = plain(street).trim().split(' ').filter(w => !/^\d/.test(w) && !STREET_WORDS.has(w)).join(' ');
  return name.length >= 5 && t.includes(` ${name} `);
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
