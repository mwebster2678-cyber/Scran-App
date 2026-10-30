// Learns from your review-page decisions:
//   - saves every place you confirmed to known-places.json, which verify.js, geocode.js
//     and the review page use for the same restaurant in other videos
//   - reports how often each kind of suggestion was right, to tune what's ticked
//     automatically and when a pick needs reviewing at all
// Picks up the newest verify-decisions*.json from ~/Downloads if it's newer than ours.
// Usage: node learn.js
import fs from 'fs';
import os from 'os';
import path from 'path';
import { KNOWN_FILE } from './known.js';

const DECISIONS = 'verify-decisions.json';

// Newest export from Downloads ("verify-decisions (2).json" etc.)
const downloads = path.join(os.homedir(), 'Downloads');
const exported = fs.existsSync(downloads) ? fs.readdirSync(downloads)
  .filter(f => /^verify-decisions.*\.json$/.test(f))
  .map(f => path.join(downloads, f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] : null;
if (exported && (!fs.existsSync(DECISIONS) || fs.statSync(exported).mtimeMs > fs.statSync(DECISIONS).mtimeMs)) {
  fs.copyFileSync(exported, DECISIONS);
  console.log(`Copied ${exported} → ${DECISIONS}`);
}
if (!fs.existsSync(DECISIONS)) {
  console.error(`No ${DECISIONS} yet: Export decisions from the review page first.`);
  process.exit(1);
}
const decisions = JSON.parse(fs.readFileSync(DECISIONS, 'utf8'));

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

console.log(`\nClaude's keep/drop call was right: ${pct(withContext.filter(d => d.keep === d.claude.keep).length, withContext.length)}`);
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
  console.log(`\nSpot check (picks Claude was sure about): keep/drop right ${pct(spot.filter(d => d.keep === d.claude.keep).length, spot.length)}`);
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
