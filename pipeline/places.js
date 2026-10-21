// Builds ../data/places.json: every restaurant, pub, bar and café inside the M25,
// from the latest Overture Maps release (Meta, Microsoft, Foursquare and other sources).
// Usage: node places.js            (no API keys needed; downloads ~80 MB, takes ~1 min)
import fs from 'fs';
import { DuckDBInstance } from '@duckdb/node-api';

const OUTPUT         = '../data/places.json';
const MIN_CONFIDENCE = 0.5; // Overture's confidence that the place exists; below this is mostly stale listings

// Same outline as CONFIG.m25Polygon in ../app.js
const M25 = [
  [51.716, -0.198], [51.726, -0.100], [51.710,  0.020], [51.670,  0.095], [51.535,  0.215],
  [51.450,  0.290], [51.390,  0.270], [51.330,  0.200], [51.285,  0.100], [51.255,  0.005],
  [51.240, -0.130], [51.270, -0.320], [51.325, -0.430], [51.375, -0.515], [51.435, -0.555],
  [51.495, -0.570], [51.560, -0.535], [51.615, -0.498], [51.680, -0.430],
];
const BOUNDS = { south: 51.22, north: 51.74, west: -0.62, east: 0.32 };

// Overture basic_category → SCRAN place kind
const KINDS = {
  restaurant: 'eat', casual_eatery: 'eat', fast_food_restaurant: 'eat', food_truck_stand: 'eat', food_court: 'eat',
  bar: 'pub', lounge: 'pub', brewery: 'pub', alcoholic_beverage_venue: 'pub',
  cafe: 'cafe', coffee_shop: 'cafe',
};

// Taxonomy entries renamed to match the app's cuisine filter chips
const LABEL_OVERRIDES = {
  north_american_restaurant: ['American'],
  vegan_restaurant: ['Vegan', 'Vegetarian'],
};

function insideM25(lat, lon) {
  let inside = false;
  for (let i = 0, j = M25.length - 1; i < M25.length; j = i++) {
    const [yi, xi] = M25[i], [yj, xj] = M25[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ['food_and_drink', 'restaurant', 'european_restaurant', 'italian_restaurant', 'pizza_restaurant']
//   → ['European', 'Italian', 'Pizza']
function cuisineLabels(hierarchy) {
  return [...new Set((hierarchy || []).slice(2).flatMap(entry =>
    LABEL_OVERRIDES[entry] ?? [entry
      .replace(/_restaurant$/, '')
      .split('_')
      .map(w => w[0].toUpperCase() + w.slice(1))
      .join(' ')]
  ))];
}

async function latestRelease() {
  const catalog = await (await fetch('https://stac.overturemaps.org/catalog.json')).json();
  if (!catalog.latest) throw new Error('Could not find the latest Overture release');
  return catalog.latest;
}

async function main() {
  const release = await latestRelease();
  console.log(`Overture release ${release} — querying places inside the M25...`);

  const db  = await (await DuckDBInstance.create()).connect();
  await db.run(`INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';`);
  const categories = Object.keys(KINDS).map(c => `'${c}'`).join(',');
  const reader = await db.runAndReadAll(`
    SELECT id, names.primary AS name, basic_category, taxonomy.hierarchy AS hierarchy,
           addresses[1].freeform AS street, addresses[1].postcode AS postcode,
           ST_Y(geometry) AS lat, ST_X(geometry) AS lon
    FROM read_parquet('s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*.parquet')
    WHERE bbox.xmin BETWEEN ${BOUNDS.west} AND ${BOUNDS.east}
      AND bbox.ymin BETWEEN ${BOUNDS.south} AND ${BOUNDS.north}
      AND basic_category IN (${categories})
      AND confidence >= ${MIN_CONFIDENCE}
      AND names.primary IS NOT NULL
  `);

  const rows = reader.getRowObjectsJS().filter(r => insideM25(r.lat, r.lon));

  // Cuisine labels repeat thousands of times, so store each once and refer to it by index
  const cuisines = [];
  const cuisineIndex = label => {
    let i = cuisines.indexOf(label);
    if (i === -1) i = cuisines.push(label) - 1;
    return i;
  };

  // Overture IDs are stable across releases; the first 12 hex digits are plenty to tell
  // 50k places apart and save ~1 MB of download
  const shortId = id => id.replace(/-/g, '').slice(0, 12);
  if (new Set(rows.map(r => shortId(r.id))).size !== rows.length) throw new Error('Short place IDs collide — use a longer prefix');

  const places = rows.map(r => [
    shortId(r.id),
    r.name,
    Math.round(r.lat * 1e5) / 1e5,
    Math.round(r.lon * 1e5) / 1e5,
    KINDS[r.basic_category],
    cuisineLabels(r.hierarchy).map(cuisineIndex),
    [r.street, r.postcode].filter(Boolean).join(', '),
  ]);

  const output = {
    source: `Overture Maps Foundation, release ${release}`,
    attribution: 'Places © Overture Maps Foundation, incl. data from Meta, Microsoft, Foursquare and AllThePlaces',
    fields: ['id', 'name', 'lat', 'lon', 'kind', 'cuisine', 'address'], // cuisine = indexes into `cuisines`
    cuisines,
    places,
  };
  fs.writeFileSync(OUTPUT, JSON.stringify(output));

  const byKind = places.reduce((n, p) => ({ ...n, [p[4]]: (n[p[4]] || 0) + 1 }), {});
  console.log(`Wrote ${places.length} places to ${OUTPUT} (${(fs.statSync(OUTPUT).size / 1e6).toFixed(1)} MB)`, byKind);
}

main().catch(err => { console.error(err); process.exit(1); });
