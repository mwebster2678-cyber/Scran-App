// How much would searching Google during the check have helped? Replays google.js against
// your review-page decisions: did Google find the place you chose, and did it know which
// places had closed? Searches are cached, so re-running is free.
// Usage: node eval-google.js
import fs from 'fs';
import { googleMatch } from './google.js';
import { metres } from './link.js';

const NEAR = 150; // metres between Google's place and yours to count as the same place

const decisions = JSON.parse(fs.readFileSync('verify-decisions.json', 'utf8')).filter(d => d.claude);
const picks = new Map();
for (const creator of ['tod', 'topjaw']) {
  for (const v of JSON.parse(fs.readFileSync(`${creator}-verified.json`, 'utf8'))) {
    for (const r of v.restaurants) picks.set(`${v.videoId}:${r.originalName}`, r);
  }
}

const pct = (n, d) => d ? `${Math.round(100 * n / d)}% (${n}/${d})` : 'n/a';
const rows = [];
for (const d of decisions) {
  const pick = picks.get(`${d.videoId}:${d.originalName}`);
  if (!pick) continue;
  const g = await googleMatch(pick);
  const yours = d.keep && d.lat ? { lat: d.lat, lon: d.lon } : null;
  rows.push({ d, pick, g, right: !!(yours && g.best && metres(g.best, yours) <= NEAR) });
}

const kept = rows.filter(x => x.d.keep && x.d.lat);
const claudeRight = x => x.d.claude.placeId && x.d.placeId === x.d.claude.placeId;
console.log(`${rows.length} decisions replayed\n`);

console.log(`Kept places: Google's best match was yours`);
for (const [label, group] of [
  ['strong matches', kept.filter(x => x.g.strong)],
  ['weak matches', kept.filter(x => x.g.best && !x.g.strong)],
  ['no match', kept.filter(x => !x.g.best)],
]) console.log(`  ${label.padEnd(16)} ${pct(group.filter(x => x.right).length, group.length)}`);
const youFound = kept.filter(x => !claudeRight(x));
console.log(`\nOf the ${youFound.length} places you had to find yourself:`);
console.log(`  strong and right (would be placed automatically) ${youFound.filter(x => x.g.strong && x.right).length}`);
console.log(`  weak but right (would be the ticked suggestion)   ${youFound.filter(x => !x.g.strong && x.right).length}`);
console.log(`  strong but WRONG (would be placed wrongly)        ${youFound.filter(x => x.g.strong && !x.right).length}`);
console.log(`Strong and wrong where Claude was right:            ${kept.filter(x => claudeRight(x) && x.g.strong && !x.right).length}`);

console.log(`\nGoogle's status for its best match:`);
const status = x => x.g.best?.status || 'no match';
for (const [label, group] of [
  ['you dropped: closed', rows.filter(x => x.d.dropReason === 'closed')],
  ['you dropped: temporary', rows.filter(x => x.d.dropReason === 'temporary')],
  ['you kept', kept],
]) {
  const n = group.reduce((t, x) => ({ ...t, [status(x)]: (t[status(x)] || 0) + 1 }), {});
  console.log(`  ${label.padEnd(24)} ${Object.entries(n).map(([s, c]) => `${s} ${c}`).join(', ')}`);
}

console.log(`\nStrong but wrong:`);
kept.filter(x => x.g.strong && !x.right).forEach(x => console.log(`  "${x.pick.name}" (${x.g.queries[0]}) → Google: ${x.g.best.name}, ${x.g.best.address} | you: ${x.d.name}, ${Math.round(metres(x.g.best, x.d))} m away`));
console.log(`\nKept places Google says are closed:`);
kept.filter(x => x.g.best?.status && x.g.best.status !== 'OPERATIONAL').forEach(x => console.log(`  ${x.d.name} → ${x.g.best.name}: ${x.g.best.status}${x.right ? '' : ' (different place)'}`));
console.log(`\nClosed/temporary drops Google calls open:`);
rows.filter(x => ['closed', 'temporary'].includes(x.d.dropReason) && x.g.best?.status === 'OPERATIONAL')
  .forEach(x => console.log(`  [${x.d.dropReason}] ${x.pick.name} → ${x.g.best.name}, ${x.g.best.address}`));
