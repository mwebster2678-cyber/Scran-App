// Writes a creator's geocoded restaurants to SCRAN's data folder, linked to places.json.
// Usage: node inject.js <creator>
import fs from 'fs';
import { creatorFromArgs } from './shared.js';
import { linkToPlaces } from './link.js';

const creator = creatorFromArgs();

const restaurants  = JSON.parse(fs.readFileSync(creator.files.geocoded, 'utf8'));
const onlyGeocoded = restaurants.filter(r => r.lat && r.lon);
const unlinked     = linkToPlaces(onlyGeocoded);

fs.writeFileSync(creator.files.app, JSON.stringify(onlyGeocoded, null, 1) + '\n');
console.log(`Wrote ${onlyGeocoded.length} geocoded ${creator.name} restaurants to ${creator.files.app}`);
console.log(`Linked ${onlyGeocoded.length - unlinked.length} to places.json; not found (shown as their own pins):`);
console.log(unlinked.map(name => `  ${name}`).join('\n'));
