import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const YT_DLP = '/Users/matthew.webster/Library/Python/3.9/bin/yt-dlp';

// ─── Config ──────────────────────────────────────────────────────────────────

const CHANNEL_HANDLE   = 'eatingwithtod';
const OUTPUT_FILE      = 'tod-scraped.json';
const DELAY_BETWEEN_MS = 1000;        // pause between Claude calls to avoid rate-limiting
const MAX_TRANSCRIPT   = 15_000;      // chars — keeps costs reasonable while capturing full context

const YOUTUBE_API_KEY  = process.env.YOUTUBE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── Clients ─────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── YouTube helpers ──────────────────────────────────────────────────────────

async function ytGet(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  Object.entries({ ...params, key: YOUTUBE_API_KEY }).forEach(([k, v]) =>
    url.searchParams.set(k, v)
  );
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API ${res.status}: ${body}`);
  }
  return res.json();
}

async function getUploadsPlaylistId(handle) {
  const data = await ytGet('channels', {
    part: 'contentDetails,snippet',
    forHandle: handle,
  });
  if (!data.items?.length) throw new Error(`Channel @${handle} not found`);
  const channel = data.items[0];
  console.log(`Channel: ${channel.snippet.title}`);
  return channel.contentDetails.relatedPlaylists.uploads;
}

async function getAllVideos(uploadsPlaylistId) {
  const videos = [];
  let pageToken = null;

  do {
    const params = {
      part: 'snippet',
      playlistId: uploadsPlaylistId,
      maxResults: 50,
    };
    if (pageToken) params.pageToken = pageToken;

    const data = await ytGet('playlistItems', params);
    for (const item of data.items) {
      const videoId = item.snippet.resourceId.videoId;
      const title   = item.snippet.title;
      // Skip deleted/private videos
      if (title !== 'Deleted video' && title !== 'Private video') {
        videos.push({ videoId, title });
      }
    }
    pageToken = data.nextPageToken || null;
    process.stdout.write(`  ${videos.length} videos found so far...\r`);
  } while (pageToken);

  return videos;
}

// ─── Transcript helper ────────────────────────────────────────────────────────

function parseVtt(vtt) {
  // Extract cue text lines (skip headers, timestamps, blank lines, cue numbers)
  const lines = vtt
    .split('\n')
    .filter(l => l && !l.startsWith('WEBVTT') && !l.startsWith('NOTE') && !l.startsWith('Kind:') && !l.startsWith('Language:') && !/^\d{2}:\d{2}/.test(l) && !/^\d+$/.test(l.trim()))
    .map(l => l.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim())
    .filter(Boolean);

  // VTT auto-captions repeat lines in a sliding window — deduplicate consecutive dupes
  const deduped = lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
  return deduped.join(' ').replace(/\s+/g, ' ').trim();
}

async function getTranscript(videoId) {
  const prefix = `/tmp/yt-${videoId}`;
  try {
    await execFileAsync(YT_DLP, [
      '--cookies', 'cookies.txt',
      '--write-auto-subs',
      '--write-subs',
      '--sub-langs', 'en.*',
      '--skip-download',
      '-o', `${prefix}.%(ext)s`,
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { timeout: 60000 });

    // Pick up whichever VTT file was written (en.vtt or en-orig.vtt, prefer non-orig)
    const vttFile = [`${prefix}.en.vtt`, `${prefix}.en-orig.vtt`].find(f => fs.existsSync(f));
    if (!vttFile) return null;

    const text = parseVtt(fs.readFileSync(vttFile, 'utf8'));
    [vttFile, `${prefix}.en.vtt`, `${prefix}.en-orig.vtt`].forEach(f => { try { fs.unlinkSync(f); } catch {} });
    return text || null;

  } catch (err) {
    console.log(`  Transcript error: ${err.message.split('\n')[0]}`);
    // Clean up any partial files
    [`${prefix}.en.vtt`, `${prefix}.en-orig.vtt`].forEach(f => { try { fs.unlinkSync(f); } catch {} });
    return null;
  }
}

// ─── Claude extraction ────────────────────────────────────────────────────────

async function extractRestaurants(title, transcript) {
  const truncated = transcript.length > MAX_TRANSCRIPT
    ? transcript.slice(0, MAX_TRANSCRIPT) + '… [truncated]'
    : transcript;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are analysing a YouTube food video transcript from @eatingwithtod, a London restaurant reviewer. Extract information about London restaurants only — ignore any non-London or international mentions.

Video title: "${title}"

Transcript:
${truncated}

For each London restaurant or food spot mentioned, return a JSON object with these fields:
- "name": restaurant name (string)
- "location": neighbourhood, area, or street if mentioned — otherwise null
- "rating": the numerical score Tod gives (e.g. if he says "8 out of 10" or "7/10" use 8 or 7) — null if he gives no numerical rating
- "rating_out_of": the scale he uses (e.g. 10 if he says "out of 10") — null if no rating given
- "sentiment": one of "positive", "negative", or "mixed" — infer from his tone and language even if no numerical rating is given
- "notes": 1–2 sentences summarising what Tod said about the food, service, or experience

Tod typically gives explicit numerical ratings (e.g. "I'd give it a 7 out of 10", "solid 8/10", "9 out of 10 for me"). Look carefully for these throughout the transcript including at the end of the video where he often gives a final verdict.

Return ONLY a valid JSON array with no extra text or markdown. If no London restaurants are mentioned, return [].`,
    }],
  });

  const text = response.content[0].text.trim();
  // Strip markdown code fences if the model wraps in them
  const json = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(json);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadExistingResults() {
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    } catch {
      console.warn(`Warning: could not parse ${OUTPUT_FILE}, starting fresh`);
    }
  }
  return [];
}

function save(results) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!YOUTUBE_API_KEY)   throw new Error('YOUTUBE_API_KEY is missing — copy .env.example to .env and fill it in');
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is missing — copy .env.example to .env and fill it in');

  // Resume support — skip videos already in the output file
  const results     = loadExistingResults();
  const processedIds = new Set(results.map(r => r.videoId));
  if (results.length) {
    console.log(`Resuming — ${results.length} videos already processed\n`);
  }

  console.log(`Fetching channel info for @${CHANNEL_HANDLE}...`);
  const uploadsPlaylistId = await getUploadsPlaylistId(CHANNEL_HANDLE);

  console.log('Fetching video list...');
  const videos    = await getAllVideos(uploadsPlaylistId);
  const toProcess = videos.filter(v => !processedIds.has(v.videoId));

  console.log(`\nTotal videos : ${videos.length}`);
  console.log(`Already done : ${videos.length - toProcess.length}`);
  console.log(`To process   : ${toProcess.length}\n`);

  for (let i = 0; i < toProcess.length; i++) {
    const { videoId, title } = toProcess[i];
    console.log(`[${i + 1}/${toProcess.length}] ${title}`);
    console.log(`  https://youtube.com/watch?v=${videoId}`);

    // Transcript
    process.stdout.write('  Fetching transcript... ');
    const transcript = await getTranscript(videoId);
    if (!transcript) {
      console.log('no transcript available, skipping');
      results.push({ videoId, title, restaurants: [], skipped: true });
      save(results);
      continue;
    }
    console.log(`${transcript.length.toLocaleString()} chars`);

    // Claude
    process.stdout.write('  Extracting restaurants... ');
    try {
      const restaurants = await extractRestaurants(title, transcript);
      console.log(`${restaurants.length} found`);
      if (restaurants.length) {
        restaurants.forEach(r => {
          const rating = r.rating != null ? ` — ${r.rating}/${r.rating_out_of ?? '?'}` : '';
          console.log(`    • ${r.name}${r.location ? ` (${r.location})` : ''}${rating} [${r.sentiment}]`);
        });
      }
      results.push({ videoId, title, restaurants });
    } catch (err) {
      console.error(`  Claude error: ${err.message}`);
      results.push({ videoId, title, restaurants: [], error: err.message });
    }

    save(results);

    if (i < toProcess.length - 1) await sleep(DELAY_BETWEEN_MS);
  }

  // ── Summary ──
  const allRestaurants  = results.flatMap(r => r.restaurants);
  const uniqueNames     = new Set(allRestaurants.map(r => r.name?.toLowerCase()).filter(Boolean));
  const skippedCount    = results.filter(r => r.skipped).length;

  console.log('\n─────────────────────────────────────');
  console.log(`Videos processed : ${results.length}`);
  console.log(`Videos skipped   : ${skippedCount} (no transcript)`);
  console.log(`Restaurant mentions : ${allRestaurants.length}`);
  console.log(`Unique restaurants  : ${uniqueNames.size}`);
  console.log(`Saved to : ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
