// Re-checks every scraped pick with Claude, one video at a time:
//   - keeps only places the creator visited and reviewed themselves (not a guest's
//     recommendations, a guest's own restaurant, stalls at the creator's own events,
//     or places outside London)
//   - flags sponsored videos
//   - corrects misheard names (using chapters and comments too) and picks the matching place from places.json
//   - rewrites the notes to cover only what the creator said
//
// Usage: node verify.js <creator> --dry-run     fetch video details (free) and estimate the cost
//        node verify.js <creator> --limit 5     check the first 5 videos only
//        node verify.js <creator>               check everything (resumes where it left off)
//        node verify.js <creator> --recheck     check again the videos that have unsure picks
//        node verify.js <creator> --only <id,id> check again just these videos
//        add --transcripts to also read video transcripts and chapters (needs a working yt-dlp)
//        add --frames to also show Claude video frames around each pick (on-screen name graphics)
//
// Reads <creator>-scraped.json (+ -geocoded.json for current locations) → writes <creator>-verified.json,
// which geocode.js then uses instead of the scraped file.
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Anthropic from '@anthropic-ai/sdk';
import { creatorFromArgs, addressInText, nameKey, tidyName } from './shared.js';
import { PLACES_FILE, squash, similarity, metres, sameName } from './link.js';
import { matchGraphics } from './graphics.js';
import { loadKnown, findKnown } from './known.js';
import { saysWhere } from './comments.js';

const MODEL          = 'claude-haiku-4-5-20251001';
const PRICE          = { input: 1 / 1e6, output: 5 / 1e6 }; // US$ per token for MODEL
const MAX_CALLS      = 400;    // hard stop, whatever happens
const YT_DLP         = process.env.YT_DLP || 'yt-dlp';
const CACHE_DIR      = 'cache';

const creator     = creatorFromArgs();
const MAX_TRANSCRIPT = Math.max(creator.maxText || 0, 60_000); // characters
const DRY_RUN     = process.argv.includes('--dry-run');
const TRANSCRIPTS = process.argv.includes('--transcripts');
const RECHECK     = process.argv.includes('--recheck');
const FRAMES      = process.argv.includes('--frames');
const MAX_SHEETS  = 4; // storyboard images per video, each 9 frames about 5 s apart
const MARK_EVERY  = 5;  // seconds between [m:ss] markers in transcripts, to line up with the frames
const ONLY        = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;
const LIMIT       = Number(process.argv[process.argv.indexOf('--limit') + 1]) || Infinity;
const OUTPUT      = `${creator.key}-verified.json`;

// ─── Video details (YouTube Data API: free within the daily quota) ──────────

async function videoDetails(videoIds) {
  const cacheFile = `${CACHE_DIR}/${creator.key}-videos.json`;
  const cached = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  const missing = videoIds.filter(id => !cached[id]);
  for (let i = 0; i < missing.length; i += 50) {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'snippet,paidProductPlacementDetails');
    url.searchParams.set('id', missing.slice(i, i + 50).join(','));
    url.searchParams.set('key', process.env.YOUTUBE_API_KEY);
    const data = await (await fetch(url)).json();
    if (data.error) throw new Error(`YouTube API: ${data.error.message}`);
    for (const item of data.items) {
      cached[item.id] = {
        description: item.snippet.description,
        paidPromotion: !!item.paidProductPlacementDetails?.hasPaidProductPlacement,
      };
    }
  }
  fs.writeFileSync(cacheFile, JSON.stringify(cached));
  return cached;
}

async function transcript(videoId) {
  const cacheFile = `${CACHE_DIR}/${videoId}.transcript-${MARK_EVERY}s.txt`;
  if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile, 'utf8') || null;
  const prefix = `${CACHE_DIR}/${videoId}`;
  try {
    await promisify(execFile)(YT_DLP, ['--cookies', 'cookies.txt', '--write-auto-subs', '--write-subs',
      '--sub-langs', 'en.*', '--skip-download', '-o', `${prefix}.%(ext)s`,
      `https://www.youtube.com/watch?v=${videoId}`], { timeout: 60_000 });
  } catch { /* no transcript; fall back to the description */ }
  const vtt = [`${prefix}.en.vtt`, `${prefix}.en-orig.vtt`].find(f => fs.existsSync(f));
  const text = vtt ? captionText(fs.readFileSync(vtt, 'utf8')) : '';
  [`${prefix}.en.vtt`, `${prefix}.en-orig.vtt`].forEach(f => fs.rmSync(f, { force: true }));
  fs.writeFileSync(cacheFile, text);
  return text || null;
}

// The most relevant comments on a video (YouTube Data API, free within the daily quota):
// viewers and the creator often say where a place is. [{ text, likes, creator }]
async function comments(videoId) {
  const cacheFile = `${CACHE_DIR}/${videoId}.comments.json`;
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const url = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
  url.search = new URLSearchParams({ part: 'snippet', videoId, order: 'relevance', maxResults: '20',
    textFormat: 'plainText', key: process.env.YOUTUBE_API_KEY });
  const data = await (await fetch(url)).json();
  if (data.error && data.error.errors?.[0]?.reason !== 'commentsDisabled') throw new Error(`YouTube comments: ${data.error.message}`);
  const list = (data.items || []).map(t => {
    const c = t.snippet.topLevelComment.snippet;
    return { text: c.textDisplay.replace(/\s+/g, ' ').trim().slice(0, 300), likes: c.likeCount,
      creator: c.authorChannelId?.value === t.snippet.channelId };
  });
  fs.writeFileSync(cacheFile, JSON.stringify(list));
  return list;
}

// YouTube's chapters (often generated automatically, and they tend to spell the
// restaurant's name correctly where captions mishear it), as [{ start, title }]
async function chapters(videoId) {
  const cacheFile = `${CACHE_DIR}/${videoId}.chapters.json`;
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  let list = [];
  try {
    const { stdout } = await promisify(execFile)(YT_DLP, ['--cookies', 'cookies.txt', '--skip-download',
      '--print', '%(chapters)j', `https://www.youtube.com/watch?v=${videoId}`], { timeout: 60_000 });
    list = (JSON.parse(stdout.trim()) || []).map(c => ({ start: Math.round(c.start_time), title: c.title }));
  } catch { /* no chapters */ }
  fs.writeFileSync(cacheFile, JSON.stringify(list));
  return list;
}

// YouTube's storyboard sheets (the timeline hover previews: 3×3 frames, 960×540) around the
// given moments, as [{ start, end, type, data }]. Name graphics like "CANAL RESTAURANT 115 WOODFIELD RD"
// are readable in them, and they need no video download.
async function storyboard(videoId, moments) {
  const metaFile = `${CACHE_DIR}/${videoId}.storyboard.json`;
  let durations = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null;
  let urls = null;
  const load = async () => {
    const { stdout } = await promisify(execFile)(YT_DLP, ['--cookies', 'cookies.txt', '-f', 'sb0', '--skip-download',
      '--print', '%(fragments)j', `https://www.youtube.com/watch?v=${videoId}`], { timeout: 60_000 });
    const fragments = JSON.parse(stdout.trim());
    urls = fragments.map(f => f.url);
    durations = fragments.map(f => f.duration);
    fs.writeFileSync(metaFile, JSON.stringify(durations));
  };
  if (!durations) {
    try { await load(); } catch { durations = []; fs.writeFileSync(metaFile, '[]'); }
  }
  if (!durations.length) return [];

  const starts = durations.map((_, i) => durations.slice(0, i).reduce((a, b) => a + b, 0));
  const sheetAt = t => Math.max(0, starts.findLastIndex(start => start <= t));
  // The sheet each moment falls in and the next one (a moment marks just before the mention)
  const wanted = new Set(moments.length ? moments.flatMap(t => [sheetAt(t), sheetAt(t) + 1]) : [0, 1, 2, 3]);
  const sheets = [];
  for (const i of [...wanted].filter(i => i < durations.length).sort((a, b) => a - b).slice(0, MAX_SHEETS)) {
    const file = `${CACHE_DIR}/${videoId}.sb${i}.jpg`;
    if (!fs.existsSync(file)) {
      try {
        if (!urls) await load();
        const res = await fetch(urls[i]);
        if (!res.ok) continue;
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      } catch { continue; }
    }
    const bytes = fs.readFileSync(file);
    // YouTube serves these as WebP despite the .jpg name
    const type = bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : bytes[0] === 0x89 ? 'image/png' : 'image/jpeg';
    sheets.push({ start: Math.round(starts[i]), end: Math.round(starts[i] + durations[i]), type, data: bytes.toString('base64') });
  }
  return sheets;
}

const clock = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// Caption lines as plain text, with a [m:ss] marker every MARK_EVERY seconds or so
// so Claude can say when in the video a place comes up
function captionText(vtt) {
  const out = [];
  let start = 0, lastMarker = -Infinity, previous = '';
  for (const raw of vtt.split('\n')) {
    const time = raw.match(/^(\d+):(\d{2}):(\d{2})\.\d+ -->/);
    if (time) { start = +time[1] * 3600 + +time[2] * 60 + +time[3]; continue; }
    if (!raw || /^(WEBVTT|NOTE|Kind:|Language:|\d+$)/.test(raw)) continue;
    const line = raw.replace(/<[^>]+>/g, '').trim();
    if (!line || line === previous) continue;
    if (start - lastMarker >= MARK_EVERY) {
      out.push(`[${clock(start)}]`);
      lastMarker = start;
    }
    out.push(line);
    previous = line;
  }
  return out.join(' ');
}

// ─── Candidate places from places.json ──────────────────────────────────────

const { places } = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8'));
const placeRows = places.map(([id, name, lat, lon, , , address]) => ({ id, name, lat, lon, address, key: squash(name) }));

// Real places the pick might be: similar names near its current location, plus the
// most similar names anywhere in London (for picks placed in the wrong spot). Names
// must look alike, so a wrong old pin doesn't bring in every shop next to it.
function candidates(name, at) {
  const key = squash(name);
  const scored = placeRows.map(p => ({ p, score: similarity(key, p.key) })).filter(({ p }) => sameName(name, p.name));
  const near = at
    ? scored.filter(({ p }) => metres(at, p) < 400).sort((a, b) => b.score - a.score).slice(0, 6)
    : [];
  const anywhere = scored.filter(({ score }) => score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 5);
  const unique = new Map([...near, ...anywhere].map(({ p }) => [p.id, p]));
  return [...unique.values()]
    .map(p => ({
      id: p.id, name: p.name, address: p.address,
      ...(at ? { metresFromPin: Math.round(metres(at, p)) } : {}),
    }));
}

// ─── Claude ─────────────────────────────────────────────────────────────────

const REASONS = ['own_review', 'guest_recommendation', 'guest_own_place', 'event_stall',
  'not_london', 'not_a_place_to_eat', 'only_mentioned', 'own_place'];

const TOOL = {
  name: 'record_checks',
  description: 'Record the check of every restaurant listed for this video.',
  input_schema: {
    type: 'object',
    properties: {
      sponsored: { type: 'boolean', description: 'The video is an ad, paid partnership or sponsored.' },
      graphics: {
        type: 'array',
        description: 'Every on-screen text graphic naming a restaurant that you can read with certainty in the video frames, copied exactly. Empty without frames.',
        items: { type: 'object', properties: {
          text: { type: 'string' },
          at:   { type: 'string', description: 'The m:ss label of the frame it appears in.' },
        }, required: ['text', 'at'] },
      },
      restaurants: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index:     { type: 'integer', description: 'The number of the restaurant in the list given.' },
            keep:      { type: 'boolean' },
            reason:    { type: 'string', enum: REASONS },
            name:      { type: 'string', description: 'The correct name of the restaurant.' },
            placeId:   { type: ['string', 'null'], description: 'id of the matching candidate place, or null if none matches.' },
            area:      { type: ['string', 'null'], description: 'Branch or area if the video says which, else null.' },
            address:   { type: ['string', 'null'], description: 'Street address only if the transcript, description, a comment or a clearly readable on-screen graphic gives it (e.g. "115 Woodfield Rd"). Never copy a candidate place’s address. null if unsure: a wrong address is worse than none.' },
            notes:     { type: 'string', description: 'If kept: 1–2 sentences on what the creator themself said about it. Empty if dropped.' },
            verdict:   { type: 'string', description: 'If kept: the creator\'s opinion in at most 12 words. Empty if dropped.' },
            dishes:    { type: 'array', items: { type: 'string' }, description: 'Dishes the creator recommends there.' },
            confident: { type: 'boolean', description: 'false if a person should double-check this decision or the place match.' },
            moment:    { type: ['string', 'null'], description: 'The [m:ss] transcript marker just before the restaurant is first named, e.g. "4:30"; null without a transcript.' },
            why:       { type: 'string', description: 'One short sentence explaining the decision.' },
          },
          required: ['index', 'keep', 'reason', 'name', 'placeId', 'area', 'address', 'notes', 'verdict', 'dishes', 'confident', 'why', 'moment'],
        },
      },
    },
    required: ['sponsored', 'graphics', 'restaurants'],
  },
};

function prompt(video, details, text, chapterList, commentList, picks) {
  return `You are checking restaurant picks taken from a YouTube video by ${creator.name} (@${creator.channel}), a London food creator.${creator.about ? ' ' + creator.about : ''} The picks were extracted automatically and may be wrong. SCRAN, a restaurant map, will show the kept ones under ${creator.name}'s name, so only ${creator.name}'s own first-hand opinions may be kept.

For each restaurant listed, decide:
- keep = true only if ${creator.name} personally visited and gave their own opinion of it (reason "own_review"). Visiting together with a guest still counts if ${creator.name} eats there and gives their own view.
- Otherwise keep = false with the reason:
  - "guest_recommendation": a guest, chef or interviewee recommends or names it and ${creator.name} doesn't review it themself. A guest listing their favourite places or dishes (e.g. a chef's "Top 5 dishes", a "Best of London" street interview) is always this, however vividly the guest describes the food, unless ${creator.name} is also shown eating there and gives their own view. Lists voted for by others still count as "own_review" for each place ${creator.name} then visits and eats at in the video.
  - "guest_own_place": it's the guest's own restaurant, mentioned to introduce them, not reviewed by ${creator.name}.
  - "event_stall": a stall at an event, festival or market that ${creator.name} organised or runs. Stalls at a permanent food hall or market reviewed by ${creator.name} are "own_review".
  - "not_london": outside London.
  - "not_a_place_to_eat": not a restaurant, café, bar, pub, bakery or food stall (e.g. a shop, cookery school, a person's home, a brand).
  - "only_mentioned": named in passing without being reviewed.
  - "own_place": a restaurant ${creator.name} runs, owns or works in.
- name: the restaurant's correct name. Names from speech are often misheard — correct them using the chapters, description, title and candidate places. Chapter titles usually spell the name correctly.
- placeId: the id of the candidate place that is this restaurant (same business; the right branch if it has several), or null if none is.
- sponsored (for the whole video): true if the title or description says ad, AD, #ad, (ad), paid partnership, sponsored, "in partnership with", or YouTube flags paid promotion.
- confident = false whenever you are unsure about keep, the name or the placeId.
- Video frames (if attached, each labelled with its time): list in graphics every on-screen text graphic naming a restaurant (e.g. "CANAL RESTAURANT"), with its frame time. They're matched to the restaurants separately, so don't rename restaurants from them. The frames are small: copy only text you can read with certainty, and never guess or fill in blurry or partly readable text (small address lines usually are). A wrong name or address is far worse than none.
- Comments: viewers saying what or where a place is. Use them to correct names and find the right place, but as hints: viewers can be wrong or name somewhere else entirely. Comments marked [creator] are from ${creator.name}.
- moment: the [m:ss] marker in the transcript just before the creator talks about the restaurant, so a person can jump to it.

Video title: ${video.title}
YouTube paid promotion flag: ${details?.paidPromotion ? 'yes' : 'no'}
Description:
${(details?.description || '(none)').slice(0, 4000)}
${chapterList?.length ? `\nChapters:\n${chapterList.map(c => `[${clock(c.start)}] ${c.title}`).join('\n')}\n` : ''}${commentList?.length ? `\nComments saying what or where a place is:\n${commentList.map(c => `- ${c.creator ? '[creator] ' : ''}${c.text}`).join('\n')}\n` : ''}${text ? `\nTranscript (automatic captions; no speaker names; [m:ss] marks the time):\n${text.slice(0, MAX_TRANSCRIPT)}\n` : ''}
Restaurants extracted from this video:
${picks.map((p, i) => `${i + 1}. "${p.name}"${p.location ? ` (location given: ${p.location})` : ''}
   Extracted notes: ${p.notes || '(none)'}
   Candidate places: ${JSON.stringify(p.candidates)}`).join('\n')}

Record exactly one check for each restaurant listed above, with its number as index, using the record_checks tool. Don't add places that aren't listed.`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const videos = JSON.parse(fs.readFileSync(creator.files.scraped, 'utf8'))
    .filter(v => v.restaurants?.some(r => r.name && r.name !== 'null'));
  let done = fs.existsSync(OUTPUT) ? JSON.parse(fs.readFileSync(OUTPUT, 'utf8')) : [];
  // When each pick comes up, from the last check, to choose which video frames to show
  const moments = new Map(done.map(v => {
    const unsure = v.restaurants.filter(r => !r.confident);
    return [v.videoId, (unsure.length ? unsure : v.restaurants).map(r => String(r.moment || '').match(/^(\d+):(\d{2})$/))
      .filter(Boolean).map(m => +m[1] * 60 + +m[2])];
  }));
  if (RECHECK) done = done.filter(v => v.restaurants.every(r => r.confident));
  if (ONLY) done = done.filter(v => !ONLY.includes(v.videoId));
  const doneIds = new Set(done.map(v => v.videoId));
  const todo = videos.filter(v => !doneIds.has(v.videoId)).slice(0, LIMIT);

  // Current location of each pick, by name, from the last geocode run
  const located = new Map();
  if (fs.existsSync(creator.files.geocoded)) {
    for (const r of JSON.parse(fs.readFileSync(creator.files.geocoded, 'utf8'))) {
      if (r.lat) located.set(nameKey(r.name), { lat: r.lat, lon: r.lon });
    }
  }

  console.log(`${videos.length} ${creator.name} videos with picks; ${done.length} already checked; ${todo.length} to check now.`);
  const details = await videoDetails(todo.map(v => v.videoId));

  const prompts = [];
  for (const video of todo) {
    const picks = video.restaurants.filter(r => r.name && r.name !== 'null').map(r => ({
      ...r, candidates: candidates(r.name, located.get(nameKey(r.name))),
    }));
    const text = TRANSCRIPTS ? await transcript(video.videoId) : null;
    const chapterList = TRANSCRIPTS ? await chapters(video.videoId) : null;
    const commentList = (await comments(video.videoId)).filter(c => saysWhere(c.text));
    const sheets = FRAMES ? await storyboard(video.videoId, moments.get(video.videoId) || []) : [];
    const instructions = prompt(video, details[video.videoId], text, chapterList, commentList, picks);
    const content = sheets.length ? [{ type: 'text', text: instructions }, ...sheets.flatMap(sh => [
      { type: 'text', text: `Video frames (3×3, left to right, top to bottom) at ${
        Array.from({ length: 9 }, (_, k) => clock(Math.round(sh.start + k * (sh.end - sh.start) / 9))).join(', ')}:` },
      { type: 'image', source: { type: 'base64', media_type: sh.type, data: sh.data } },
    ])] : instructions;
    // Everything the video says, to check Claude's addresses came from it
    const evidence = [details[video.videoId]?.description, text, ...(chapterList || []).map(c => c.title), ...commentList.map(c => c.text)].join('\n');
    prompts.push({ video, picks, content, evidence, sheets: sheets.length });
  }

  // ~4 characters per token; output is roughly 150 tokens per restaurant
  const textOf = c => typeof c === 'string' ? c : c.filter(b => b.type === 'text').map(b => b.text).join('');
  const estInput  = prompts.reduce((n, p) => n + textOf(p.content).length / 4 + 900 + 700 * p.sheets, 0);
  const estOutput = prompts.reduce((n, p) => n + 150 * p.picks.length + 50, 0);
  console.log(`Estimated cost: about $${(estInput * PRICE.input + estOutput * PRICE.output).toFixed(2)} ` +
    `(${Math.round(estInput / 1000)}k input + ${Math.round(estOutput / 1000)}k output tokens, ${MODEL})`);
  if (DRY_RUN) return;
  if (prompts.length > MAX_CALLS) throw new Error(`${prompts.length} calls is over the ${MAX_CALLS} limit`);

  const known = loadKnown();
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let spent = 0;
  for (const [i, { video, picks, content, evidence }] of prompts.entries()) {
    process.stdout.write(`[${i + 1}/${prompts.length}] ${video.title.slice(0, 60)}… `);
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content }],
    });
    spent += res.usage.input_tokens * PRICE.input + res.usage.output_tokens * PRICE.output;
    const result = res.content.find(c => c.type === 'tool_use')?.input;
    if (!result?.restaurants) throw new Error(`No result for video ${video.videoId}`);

    const restaurants = picks.map((pick, index) => {
        const check = result.restaurants.find(r => r.index === index + 1);
        const { candidates, ...original } = pick;
        // A place you confirmed on the review page settles where it is (Claude still decides keep/drop)
        const confirmed = check && findKnown(known, { name: check.name, originalName: pick.name, area: check.area || pick.location });
        if (confirmed) Object.assign(check, {
          name: tidyName(confirmed.name), placeId: confirmed.placeId, knownPlace: true,
          confident: check.confident || (check.keep && check.reason === 'own_review'),
        });
        return check
          // candidates are kept for unsure picks so the review page can offer them
          ? { ...original, originalName: pick.name, ...check, index: undefined, ...(check.confident ? {} : { candidates }) }
          : { ...original, originalName: pick.name, keep: false, reason: 'only_mentioned', confident: false, why: 'Claude returned no check for this pick', candidates };
      });
    const graphics = matchGraphics(restaurants, result.graphics);
    // An address the video never gives is a guess (often the guessed place's own address)
    const said = evidence + '\n' + (result.graphics || []).map(g => g.text).join('\n');
    for (const r of restaurants) if (r.address && !addressInText(r.address, said)) r.address = null;
    done.push({ videoId: video.videoId, title: video.title, sponsored: result.sponsored, graphics, restaurants });
    fs.writeFileSync(OUTPUT, JSON.stringify(done, null, 2)); // saved after every video
    const kept = done.at(-1).restaurants.filter(r => r.keep).length;
    console.log(`kept ${kept}/${picks.length}${result.sponsored ? ' (ad)' : ''} — $${spent.toFixed(3)} so far`);
  }

  // Summary
  const all = done.flatMap(v => v.restaurants);
  const byReason = all.reduce((n, r) => ({ ...n, [r.reason]: (n[r.reason] || 0) + 1 }), {});
  console.log(`\nChecked ${done.length} videos, ${all.length} picks:`, byReason);
  console.log(`Sponsored videos: ${done.filter(v => v.sponsored).length}. Spent this run: $${spent.toFixed(2)}`);
  const unsure = all.filter(r => !r.confident);
  console.log(`\n${unsure.length} to double-check:`);
  unsure.forEach(r => console.log(`  ${r.keep ? 'KEEP' : 'DROP'} ${r.originalName} → ${r.name} [${r.reason}] ${r.why}`));
}

main().catch(err => { console.error(`\nStopped: ${err.message}`); process.exit(1); });
