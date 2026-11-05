// Learns from your review-page decisions:
//   - saves every place you confirmed to known-places.json, which verify.js, geocode.js
//     and the review page use for the same restaurant in other videos
//   - reports how often each kind of suggestion was right, to tune what's ticked
//     automatically and when a pick needs reviewing at all
// Merges in the newest verify-decisions*.json from ~/Downloads or ~/Documents.
// Usage: node learn.js
import fs from 'fs';
import os from 'os';
import path from 'path';
import { KNOWN_FILE } from './known.js';

const DECISIONS = 'verify-decisions.json';

// Newest export from Downloads or Documents ("verify-decisions (2).json" etc.), merged into ours: an
// export only adds or changes decisions, so one from a browser that lost its saved
// answers can't wipe the earlier ones
const keyOf = d => d.kind === 'pin' ? `pin:${d.creator}:${d.name}` : `${d.creator}:${d.videoId}:${d.originalName}`;
const exported = ['Downloads', 'Documents'].map(dir => path.join(os.homedir(), dir)).filter(dir => fs.existsSync(dir))
  .flatMap(dir => fs.readdirSync(dir).filter(f => /^verify-decisions.*\.json$/.test(f)).map(f => path.join(dir, f)))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const ours = fs.existsSync(DECISIONS) ? JSON.parse(fs.readFileSync(DECISIONS, 'utf8')) : [];
// Merging the same export again changes nothing, so the newest is always merged
if (exported) {
  const merged = new Map(ours.map(d => [keyOf(d), d]));
  const before = merged.size;
  let changed = 0;
  for (const d of JSON.parse(fs.readFileSync(exported, 'utf8'))) {
    const old = merged.get(keyOf(d));
    if (old && JSON.stringify(old) !== JSON.stringify(d)) changed++;
    merged.set(keyOf(d), d);
  }
  fs.writeFileSync(DECISIONS, JSON.stringify([...merged.values()], null, 1));
  console.log(`Merged ${exported} → ${DECISIONS}: ${merged.size - before} new, ${changed} changed, ${merged.size} in all`);
}
if (!fs.existsSync(DECISIONS)) {
  console.error(`No ${DECISIONS} yet: Export decisions from the review page first.`);
  process.exit(1);
}

// Corrections made outside the review page (e.g. a pin fixed from Google), applied over
// your exports so the browser's older answer doesn't undo them
const FIXES = 'decision-fixes.json';
const fixes = fs.existsSync(FIXES) ? JSON.parse(fs.readFileSync(FIXES, 'utf8')) : [];
const all = JSON.parse(fs.readFileSync(DECISIONS, 'utf8'));
for (const fix of fixes) {
  const d = all.find(d => keyOf(d) === fix.key);
  if (d) Object.assign(d, fix.set);
  // A pick you never saw on the page (Claude was sure about it): the fix is the decision
  else { const [creator, videoId, ...name] = fix.key.split(':'); all.push({ creator, videoId, originalName: name.join(':'), ...fix.set }); }
}
fs.writeFileSync(DECISIONS, JSON.stringify(all, null, 1));
// Pin check decisions (moved map pins) are applied by geocode.js, not learned from
const decisions = all.filter(d => d.kind !== 'pin');

// ─── Confirmed places ───────────────────────────────────────────────────────

const known = decisions
  .filter(d => d.keep && (d.placeId || d.lat))
  .map(d => ({
    names: [...new Set([d.originalName, d.claude?.name, d.name].filter(Boolean))],
    area: d.area || null, name: d.name, placeId: d.placeId || null, lat: d.lat, lon: d.lon,
    creator: d.creator, videoId: d.videoId,
  }));
fs.writeFileSync(KNOWN_FILE, JSON.stringify(known, null, 1) + '\n');
console.log(`${known.length} confirmed places → ${KNOWN_FILE}\n`);

// ─── How good were the suggestions? ─────────────────────────────────────────

const pct = (n, d) => d ? `${Math.round(100 * n / d)}% (${n}/${d})` : 'n/a';
const kept = decisions.filter(d => d.keep);
const withContext = decisions.filter(d => d.claude); // exported before sources were recorded: no context

console.log(`${decisions.length} decisions: ${kept.length} kept, ${decisions.length - kept.length} dropped`);
if (withContext.length < decisions.length) {
  console.log(`(${decisions.length - withContext.length} were made before the page recorded suggestions, so they only count as confirmed places)`);
}
if (!withContext.length) process.exit(0);

// Fully right: the keep/drop call, and for a keep, the place too. If you had to find the place
// yourself (search, Google, a Maps link), Claude didn't get it right.
const claudeRight = d => d.keep === d.claude.keep && (!d.keep || (d.claude.placeId && d.placeId === d.claude.placeId));

console.log(`\nClaude's keep/drop call was right: ${pct(withContext.filter(d => d.keep === d.claude.keep).length, withContext.length)}`);
console.log(`…and the right place too:          ${pct(withContext.filter(claudeRight).length, withContext.length)}`);
const claudeGuessed = withContext.filter(d => d.keep && d.claude.placeId);
console.log(`Claude's place guess was right:   ${pct(claudeGuessed.filter(d => d.placeId === d.claude.placeId).length, claudeGuessed.length)}`);

const keptWithContext = withContext.filter(d => d.keep && d.source);
console.log(`\nWhere your answers came from:`);
const bySource = keptWithContext.reduce((n, d) => ({ ...n, [d.source]: (n[d.source] || 0) + 1 }), {});
for (const [source, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) console.log(`  ${source.padEnd(14)} ${n}`);

console.log(`\nThe ticked option was right:`);
const ticked = keptWithContext.filter(d => d.suggested);
for (const [label, test] of [
  ['overall', () => true],
  ['video named an area', d => d.area],
  ['no area', d => !d.area],
]) {
  const group = ticked.filter(test);
  console.log(`  ${label.padEnd(20)} ${pct(group.filter(d => d.source === d.suggested).length, group.length)}`);
}
for (const s of [...new Set(ticked.map(d => d.suggested))]) {
  const group = ticked.filter(d => d.suggested === s);
  console.log(`  ticked ${s.padEnd(13)} ${pct(group.filter(d => d.source === s).length, group.length)}`);
}

const spot = withContext.filter(d => d.spot);
if (spot.length) {
  console.log(`\nSpot check (picks Claude was sure about): right ${pct(spot.filter(claudeRight).length, spot.length)}`);
  spot.filter(d => !claudeRight(d)).forEach(d => console.log(`  wrong: "${d.originalName}" → Claude: ${d.claude.keep ? `"${d.claude.name}"` : `drop (${d.claude.reason})`} → you: ${d.keep ? `"${d.name}"` : `drop (${d.dropReason})`}`));
}

// Mistakes by kind: what you dropped that Claude kept, and Claude's drop reasons you overruled
const tally = (list, key) => Object.entries(list.reduce((n, d) => ({ ...n, [key(d)]: (n[key(d)] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
const wrongKeeps = withContext.filter(d => d.claude.keep && !d.keep);
if (wrongKeeps.length) {
  console.log(`\nClaude kept, you dropped (${wrongKeeps.length}):`);
  for (const [why, n] of tally(wrongKeeps, d => d.dropReason || 'no reason given')) console.log(`  ${why.padEnd(22)} ${n}`);
}
const wrongDrops = withContext.filter(d => !d.claude.keep && d.keep);
if (wrongDrops.length) {
  console.log(`\nClaude dropped, you kept (${wrongDrops.length}), by Claude's reason:`);
  for (const [why, n] of tally(wrongDrops, d => d.claude.reason || '?')) console.log(`  ${why.padEnd(22)} ${n}`);
}

const renamed = withContext.filter(d => d.keep && d.claude.name && d.name && d.claude.name.toLowerCase() !== d.name.toLowerCase());
if (renamed.length) {
  console.log(`\nNames you corrected (examples for Claude's prompt later):`);
  renamed.slice(0, 15).forEach(d => console.log(`  "${d.originalName}" → Claude: "${d.claude.name}" → you: "${d.name}"${d.area ? ` (${d.area})` : ''}`));
}
