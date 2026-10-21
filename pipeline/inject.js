// Writes a creator's geocoded restaurants to SCRAN's data folder.
// Usage: node inject.js <creator>
import fs from 'fs';
import { creatorFromArgs } from './shared.js';

const creator = creatorFromArgs();

const restaurants  = JSON.parse(fs.readFileSync(creator.files.geocoded, 'utf8'));
const onlyGeocoded = restaurants.filter(r => r.lat && r.lon);

fs.writeFileSync(creator.files.app, JSON.stringify(onlyGeocoded, null, 1) + '\n');
console.log(`Wrote ${onlyGeocoded.length} geocoded ${creator.name} restaurants to ${creator.files.app}`);
