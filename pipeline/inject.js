// Writes a creator's geocoded restaurants to SCRAN's data folder.
// Usage: node inject.js tod | node inject.js topjaw
import fs from 'fs';

const SOURCES = {
  tod:    'tod-restaurants.json',
  topjaw: 'topjaw-geocoded.json',
};

const creator = process.argv[2];
if (!SOURCES[creator]) {
  console.error(`Usage: node inject.js <${Object.keys(SOURCES).join('|')}>`);
  process.exit(1);
}

const restaurants  = JSON.parse(fs.readFileSync(SOURCES[creator], 'utf8'));
const onlyGeocoded = restaurants.filter(r => r.lat && r.lon);
const outFile      = `../data/${creator}.json`;

fs.writeFileSync(outFile, JSON.stringify(onlyGeocoded, null, 1) + '\n');
console.log(`Wrote ${onlyGeocoded.length} geocoded ${creator} restaurants to ${outFile}`);
