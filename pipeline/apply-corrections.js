// Reads corrections.json, updates tod-restaurants.json, then re-injects into SCRAN
import 'dotenv/config';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const CORRECTIONS_FILE = 'corrections.json';
const TOD_DATA_FILE    = 'tod-restaurants.json';

if (!fs.existsSync(CORRECTIONS_FILE)) {
  console.error(`No ${CORRECTIONS_FILE} found — export from review.html first.`);
  process.exit(1);
}

const corrections = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf8'));
const restaurants  = JSON.parse(fs.readFileSync(TOD_DATA_FILE, 'utf8'));

let approved = 0, removed = 0;

for (const c of corrections) {
  const key = c.originalName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const idx = restaurants.findIndex(r =>
    r.name.toLowerCase().replace(/[^a-z0-9]/g, '') === key
  );
  if (idx === -1) { console.log(`  Not found in data: "${c.originalName}"`); continue; }

  if (c.action === 'approve') {
    if (c.lat && c.lon) {
      restaurants[idx].name = c.correctedName || restaurants[idx].name;
      restaurants[idx].lat  = c.lat;
      restaurants[idx].lon  = c.lon;
      console.log(`  ✓ ${c.originalName} → ${restaurants[idx].name} (${c.lat.toFixed(4)}, ${c.lon.toFixed(4)})`);
      approved++;
    } else if (c.manualInput) {
      // User typed a correction but no lat/lon — flag it for re-geocoding
      restaurants[idx].name          = c.correctedName;
      restaurants[idx].needsGeocode  = true;
      console.log(`  ~ ${c.originalName} → "${c.correctedName}" (needs geocoding)`);
      approved++;
    }
  } else if (c.action === 'remove') {
    restaurants.splice(idx, 1);
    console.log(`  ✗ Removed: "${c.originalName}"`);
    removed++;
  }
}

// Re-geocode any items flagged as needing it
const toGeocode = restaurants.filter(r => r.needsGeocode);
if (toGeocode.length) {
  console.log(`\nGeocoding ${toGeocode.length} manually-corrected restaurants...`);
  for (const r of toGeocode) {
    const url  = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(r.name + ' London')}&region=gb&key=${GOOGLE_MAPS_API_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.results?.length) {
      const { lat, lng } = data.results[0].geometry.location;
      r.lat = lat;
      r.lon = lng;
      console.log(`  ✓ Geocoded: ${r.name} → ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}`);
    } else {
      console.log(`  ✗ Still not found: ${r.name}`);
    }
    delete r.needsGeocode;
  }
}

fs.writeFileSync(TOD_DATA_FILE, JSON.stringify(restaurants, null, 2));
console.log(`\nSaved ${TOD_DATA_FILE} (${approved} updated, ${removed} removed)`);

// Re-inject into SCRAN
console.log('Re-injecting into SCRAN...');
await execFileAsync('node', ['inject.js', 'tod']);
console.log('Done. Refresh SCRAN to see the updated Tod Mode pins.');
