// Places you've confirmed on the review page (written by learn.js), so the same restaurant
// in another video is placed without asking Claude, Google or you again.
import fs from 'fs';
import { nameKey } from './shared.js';

export const KNOWN_FILE = 'known-places.json';

export function loadKnown() {
  return fs.existsSync(KNOWN_FILE) ? JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8')) : [];
}

const sameArea = (a, b) => {
  const ka = nameKey(a || ''), kb = nameKey(b || '');
  return ka && kb && (ka.includes(kb) || kb.includes(ka));
};

// The confirmed place for a pick, matched on any of its names. Chains have several
// confirmed branches, so a name that matches more than one place needs a matching area.
export function findKnown(known, { name, originalName, area }) {
  const keys = new Set([name, originalName].filter(Boolean).map(nameKey));
  const matches = known.filter(k => k.names.some(n => keys.has(nameKey(n))));
  const places = new Map(matches.map(k => [k.placeId || `${k.lat},${k.lon}`, k]));
  if (places.size === 1) return matches[0];
  return matches.find(k => sameArea(k.area, area)) || null;
}
