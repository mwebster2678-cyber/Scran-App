// Checks every pin on the map against Google: searches each place's name near its pin and
// lists the ones where Google's place with that name is more than FAR metres away. Those
// are usually a wrong pin in places.json (e.g. the right address but coordinates elsewhere)
// or a place that has moved. Searches are cached; if Google's daily cap stops it, run it
// again tomorrow and it carries on. Writes pin-check.json.
// Usage: node check-pins.js
import fs from 'fs';
import { googleSearch, nameFit } from './google.js';
import { metres } from './link.js';

const FAR = 300;

const pins = ['tod', 'topjaw'].flatMap(c => {
  const data = JSON.parse(fs.readFileSync(`../data/${c}.json`, 'utf8'));
  return (Array.isArray(data) ? data : Object.values(data)[0]).filter(r => r.lat).map(r => ({ ...r, creator: c }));
});
// The same place on both creators' maps only needs one search
const unique = [...new Map(pins.map(p => [p.placeId || `${p.name}@${p.lat},${p.lon}`, p])).values()];

const far = [], missing = [];
let checked = 0, stopped = null;
for (const pin of unique) {
  let found;
  try { found = (await googleSearch(`${pin.name}, London`, pin)).found; }
  catch (e) { stopped = e.message; break; }
  checked++;
  const named = found.filter(g => nameFit([pin.name], g.name) >= 0.5);
  if (!named.length) { missing.push(pin); continue; }
  const nearest = named.reduce((a, b) => metres(a, pin) <= metres(b, pin) ? a : b);
  const away = Math.round(metres(nearest, pin));
  if (away > FAR) far.push({ name: pin.name, creator: pin.creator, placeId: pin.placeId || null,
    pin: { lat: pin.lat, lon: pin.lon }, google: nearest, away });
}

far.sort((a, b) => b.away - a.away);
fs.writeFileSync('pin-check.json', JSON.stringify({ checked, far, missing: missing.map(p => p.name) }, null, 1) + '\n');
console.log(`Checked ${checked} of ${unique.length} pins${stopped ? ` (stopped: ${stopped})` : ''}\n`);
console.log(`${far.length} pins more than ${FAR} m from Google's place with that name:`);
for (const f of far) console.log(`  ${f.name} [${f.creator}] ${f.away} m → Google: ${f.google.name}, ${f.google.address}`);
console.log(`\n${missing.length} Google couldn't find by name (may have closed): ${missing.map(p => p.name).join(', ')}`);
