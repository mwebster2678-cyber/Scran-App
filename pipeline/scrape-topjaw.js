import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

// ─── Config ──────────────────────────────────────────────────────────────────

const CHANNEL_HANDLE   = 'topjaw';
const OUTPUT_FILE      = 'topjaw-scraped.json';
const DELAY_BETWEEN_MS = 300;    // no yt-dlp bottleneck — can run faster
const MAX_DESC         = 3_000;  // descriptions are shorter than transcripts
const MIN_DESC_LENGTH  = 80;     // skip very short descriptions (Shorts / teasers)

const YOUTUBE_API_KEY   = process.env.YOUTUBE_API_KEY;
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
      const videoId     = item.snippet.resourceId.videoId;
      const title       = item.snippet.title;
      const description = item.snippet.description || '';
      if (title !== 'Deleted video' && title !== 'Private video') {
        videos.push({ videoId, title, description });
      }
    }
    pageToken = data.nextPageToken || null;
    process.stdout.write(`  ${videos.length} videos found so far...\r`);
  } while (pageToken);

  return videos;
}

// ─── Claude extraction ────────────────────────────────────────────────────────

async function extractRestaurants(title, description) {
  const truncated = description.length > MAX_DESC
    ? description.slice(0, MAX_DESC) + '… [truncated]'
    : description;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are analysing a YouTube video title and description from @topjaw, a popular London restaurant guide channel. Extract information about London restaurants only — ignore any non-London or international mentions.

Video title: "${title}"

Description:
${truncated}

For each London restaurant or food spot mentioned, return a JSON object with these fields:
- "name": restaurant name (string)
- "location": neighbourhood, area, or street if mentioned — otherwise null
- "rating": a numerical score if one is explicitly stated — null if none (Topjaw rarely give explicit scores)
- "rating_out_of": the scale used — null if none
- "sentiment": one of "positive", "negative", or "mixed" — Topjaw typically recommend places so most will be "positive"
- "notes": 1–2 sentences summarising what was said about the food, vibe, or standout dishes — if the description is brief, infer from the title and context

Return ONLY a valid JSON array with no extra text or markdown. If no London restaurants are mentioned, return [].`,
    }],
  });

  const text = response.content[0].text.trim();
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
  if (!YOUTUBE_API_KEY)   throw new Error('YOUTUBE_API_KEY missing from .env');
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing from .env');

  // Resume: only skip videos that were previously processed with a result
  // (i.e. not previously skipped — those get another attempt with descriptions)
  const results      = loadExistingResults();
  const processedIds = new Set(
    results.filter(r => !r.skipped).map(r => r.videoId)
  );
  // Drop old skipped entries so we reprocess them cleanly
  const freshResults = results.filter(r => !r.skipped);
  if (freshResults.length) {
    console.log(`Resuming — ${freshResults.length} videos already have results\n`);
  }

  console.log(`Fetching channel info for @${CHANNEL_HANDLE}...`);
  const uploadsPlaylistId = await getUploadsPlaylistId(CHANNEL_HANDLE);

  console.log('Fetching video list + descriptions...');
  const videos    = await getAllVideos(uploadsPlaylistId);
  const toProcess = videos.filter(v => !processedIds.has(v.videoId));

  console.log(`\nTotal videos : ${videos.length}`);
  console.log(`Already done : ${videos.length - toProcess.length}`);
  console.log(`To process   : ${toProcess.length}\n`);

  for (let i = 0; i < toProcess.length; i++) {
    const { videoId, title, description } = toProcess[i];
    console.log(`[${i + 1}/${toProcess.length}] ${title}`);
    console.log(`  https://youtube.com/watch?v=${videoId}`);

    // Skip Shorts and teasers — descriptions are too short to extract anything useful
    if (description.length < MIN_DESC_LENGTH) {
      console.log(`  Description too short (${description.length} chars), skipping`);
      freshResults.push({ videoId, title, restaurants: [], skipped: true });
      save(freshResults);
      continue;
    }

    process.stdout.write(`  Description: ${description.length} chars — Extracting restaurants... `);
    try {
      const restaurants = await extractRestaurants(title, description);
      console.log(`${restaurants.length} found`);
      if (restaurants.length) {
        restaurants.forEach(r => {
          const rating = r.rating != null ? ` — ${r.rating}/${r.rating_out_of ?? '?'}` : '';
          console.log(`    • ${r.name}${r.location ? ` (${r.location})` : ''}${rating} [${r.sentiment}]`);
        });
      }
      freshResults.push({ videoId, title, restaurants });
    } catch (err) {
      console.error(`  Claude error: ${err.message}`);
      freshResults.push({ videoId, title, restaurants: [], error: err.message });
    }

    save(freshResults);

    if (i < toProcess.length - 1) await sleep(DELAY_BETWEEN_MS);
  }

  // ── Summary ──
  const allRestaurants = freshResults.flatMap(r => r.restaurants);
  const uniqueNames    = new Set(allRestaurants.map(r => r.name?.toLowerCase()).filter(Boolean));
  const skippedCount   = freshResults.filter(r => r.skipped).length;

  console.log('\n─────────────────────────────────────');
  console.log(`Videos processed    : ${freshResults.length}`);
  console.log(`Videos skipped      : ${skippedCount} (description too short)`);
  console.log(`Restaurant mentions : ${allRestaurants.length}`);
  console.log(`Unique restaurants  : ${uniqueNames.size}`);
  console.log(`Saved to            : ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
