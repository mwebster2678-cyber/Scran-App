// Test: can full-size video frames name the restaurant? For picks you've already answered on the
// review page, grabs frames around the moment the place comes up (yt-dlp + ffmpeg), asks Claude to
// read any on-screen text naming a restaurant (title cards, signs, menus, receipts), and compares
// what it read with your answer, with Claude's original name and with the small storyboard frames.
// Nothing here changes the map or your decisions.
// Usage: node test-frames.js [--limit 60] [--dry-run]
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import 'dotenv/config';
import { soundsLike } from './link.js';
import { seconds } from './graphics.js';
import { readText, clock } from './frames.js';

const PRICE   = { input: 1 / 1e6, output: 5 / 1e6 };
const LIMIT   = Number(process.argv[process.argv.indexOf('--limit') + 1]) || 60;
const DRY_RUN = process.argv.includes('--dry-run');
const SAME    = 0.6; // soundsLike score that counts as the same name

// Your kept answers, with the moment and storyboard reading from the verified picks
const picks = [];
const verified = {};
for (const d of JSON.parse(fs.readFileSync('verify-decisions.json', 'utf8'))) {
  if (d.kind === 'pin' || !d.keep || !d.claude || !d.name) continue;
  verified[d.creator] ??= JSON.parse(fs.readFileSync(`${d.creator}-verified.json`, 'utf8'));
  const video = verified[d.creator].find(v => v.videoId === d.videoId);
  const pick = video?.restaurants.find(r => r.originalName === d.originalName);
  const at = seconds(pick?.moment);
  if (at == null) continue;
  picks.push({ ...d, at, onScreen: pick.onScreen || null, title: video.title });
}
// Half picks you renamed (where reading the name would help most), half Claude got right,
// in a fixed order so re-runs test the same picks
const differs = p => soundsLike(p.claude.name || p.originalName, p.name) < SAME;
const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const ordered = list => list.sort((a, b) => hash(a.videoId + a.originalName) - hash(b.videoId + b.originalName));
const renamed = ordered(picks.filter(differs)), same = ordered(picks.filter(p => !differs(p)));
const sample = [...renamed.slice(0, Math.ceil(LIMIT / 2)), ...same.slice(0, Math.floor(LIMIT / 2))];
console.log(`${picks.length} answered picks with a moment (${renamed.length} you renamed); testing ${sample.length}.`);
console.log(`Estimated cost: about $${(sample.length * 15 * 750 * PRICE.input + sample.length * 300 * PRICE.output).toFixed(2)}`);
if (DRY_RUN) process.exit(0);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
let spent = 0;
const results = [];
for (const [i, p] of sample.entries()) {
  process.stdout.write(`[${i + 1}/${sample.length}] ${p.name}… `);
  let names, cost;
  try { ({ names, cost } = await readText(anthropic, p.videoId, p.at)); } catch (err) { console.log(`no frames (${err.message.split('\n')[0].slice(0, 80)})`); continue; }
  spent += cost;
  names = names.map(n => ({ ...n, at: clock(n.at) }));
  const best = names.map(n => ({ ...n, score: soundsLike(n.text, p.name) })).sort((a, b) => b.score - a.score)[0];
  const r = {
    creator: p.creator, videoId: p.videoId, at: clock(p.at), answer: p.name, claude: p.claude.name || p.originalName,
    claudeRight: !differs(p), storyboard: p.onScreen, read: names.map(n => `${n.text} [${n.kind} ${n.at}]`),
    frameRight: !!best && best.score >= SAME, storyboardRight: !!p.onScreen && soundsLike(p.onScreen, p.name) >= SAME,
  };
  results.push(r);
  console.log(`${r.frameRight ? 'READ IT' : names.length ? 'other text' : 'nothing'}: ${r.read.slice(0, 4).join('; ') || '-'} ($${spent.toFixed(3)})`);
}
fs.writeFileSync('test-frames-results.json', JSON.stringify(results, null, 1));

// ─── Report ─────────────────────────────────────────────────────────────────
const pct = (n, d) => d ? `${Math.round(100 * n / d)}% (${n}/${d})` : 'n/a';
const report = (label, list) => {
  console.log(`\n${label}: ${list.length} picks`);
  console.log(`  full-size frames named it:   ${pct(list.filter(r => r.frameRight).length, list.length)}`);
  console.log(`  small storyboard named it:   ${pct(list.filter(r => r.storyboardRight).length, list.length)}`);
  console.log(`  frames read text, none right: ${pct(list.filter(r => !r.frameRight && r.read.length).length, list.length)}`);
};
report('All', results);
report('You renamed (Claude had the wrong name)', results.filter(r => !r.claudeRight));
report('Claude had the right name', results.filter(r => r.claudeRight));
console.log(`\nFixed by frames (Claude wrong, frames right):`);
results.filter(r => !r.claudeRight && r.frameRight).forEach(r => console.log(`  ${r.claude} → frames: ${r.read.join('; ')} → you: ${r.answer}`));
console.log(`\nText read that wasn't your answer (check for misreads):`);
results.filter(r => !r.frameRight && r.read.length).forEach(r => console.log(`  you: ${r.answer} | read: ${r.read.join('; ')} | https://youtu.be/${r.videoId}?t=${r.at.replace(':', 'm')}s`));
console.log(`\nSpent $${spent.toFixed(2)}. Results → test-frames-results.json`);
