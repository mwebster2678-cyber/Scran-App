// Applies corrections exported from the review page, then re-exports to SCRAN.
// Usage: node apply-corrections.js <creator>
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { creatorFromArgs, nameKey, geocodeLondon } from './shared.js';
const execFileAsync = promisify(execFile);

const creator          = creatorFromArgs();
const CORRECTIONS_FILE = creator.files.corrections;
const GEOCODED_FILE    = creator.files.geocoded;

if (!fs.existsSync(CORRECTIONS_FILE)) {
  console.error(`No ${CORRECTIONS_FILE} found — export from ${creator.files.review} first.`);
  process.exit(1);
}

const corrections = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf8'));
const restaurants  = JSON.parse(fs.readFileSync(GEOCODED_FILE, 'utf8'));

let approved = 0, removed = 0;

for (const c of corrections) {
  const key = nameKey(c.originalName);
  const idx = restaurants.findIndex(r => nameKey(r.name) === key);
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
    const [best] = await geocodeLondon(r.name + ' London');
    if (best) {
      r.lat = best.lat;
      r.lon = best.lon;
      console.log(`  ✓ Geocoded: ${r.name} → ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}`);
    } else {
      console.log(`  ✗ Still not found: ${r.name}`);
    }
    delete r.needsGeocode;
  }
}

fs.writeFileSync(GEOCODED_FILE, JSON.stringify(restaurants, null, 2));
console.log(`\nSaved ${GEOCODED_FILE} (${approved} updated, ${removed} removed)`);

console.log('Exporting to SCRAN...');
const { stdout } = await execFileAsync('node', ['inject.js', creator.key]);
process.stdout.write(stdout);
console.log(`Done. Refresh SCRAN to see the updated ${creator.name} pins.`);
