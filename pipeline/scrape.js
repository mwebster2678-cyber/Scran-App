// Step 1 for any creator in shared.js: lists the channel's videos and asks Claude which London
// restaurants each one reviews, from the title, description and auto-captions together
// (Shorts often name the place only in the title or description).
// Resumes where it left off if re-run.
// Usage: YT_DLP=~/.local/bin/yt-dlp node scrape.js <creator> [--dry-run] [--limit N]
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { creatorFromArgs } from './shared.js';

const creator  = creatorFromArgs();
const DRY_RUN  = process.argv.includes('--dry-run');
const LIMIT    = +(process.argv[process.argv.indexOf('--limit') + 1]) || Infinity;
const YT_DLP   = process.env.YT_DLP || `${os.homedir()}/.local/bin/yt-dlp`;
const OUTPUT   = creator.files.scraped;
const MODEL    = 'claude-haiku-4-5-20251001';
const MAX_TEXT = creator.maxText || 15_000; // characters of captions per video

async function ytGet(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  url.search = new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY });
  const data = await (await fetch(url)).json();
  if (data.error) throw new Error(`YouTube API: ${data.error.message}`);
  return data;
}

// Every upload with its title and description (YouTube Data API, free within the daily quota)
async function channelVideos() {
  const channel = (await ytGet('channels', { part: 'contentDetails,snippet', forHandle: creator.channel })).items?.[0];
  if (!channel) throw new Error(`Channel @${creator.channel} not found`);
  const videos = [];
  let pageToken = '';
  do {
    const data = await ytGet('playlistItems', { part: 'snippet', maxResults: '50',
      playlistId: channel.contentDetails.relatedPlaylists.uploads, ...(pageToken ? { pageToken } : {}) });
    for (const { snippet } of data.items) {
      if (snippet.title === 'Deleted video' || snippet.title === 'Private video') continue;
      videos.push({ videoId: snippet.resourceId.videoId, title: snippet.title, description: snippet.description,
        published: snippet.publishedAt.slice(0, 10) });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return videos;
}

// Auto-captions as plain text, or '' if the video has none
async function captions(videoId) {
  const prefix = `${os.tmpdir()}/yt-${videoId}`;
  const files = [`${prefix}.en.vtt`, `${prefix}.en-orig.vtt`];
  try {
    await promisify(execFile)(YT_DLP, ['--cookies', 'cookies.txt', '--write-auto-subs', '--write-subs',
      '--sub-langs', 'en.*', '--skip-download', '-o', `${prefix}.%(ext)s`,
      `https://www.youtube.com/watch?v=${videoId}`], { timeout: 60_000 });
  } catch { /* no captions: the title and description may still name the place */ }
  const vtt = files.find(f => fs.existsSync(f));
  const lines = vtt ? fs.readFileSync(vtt, 'utf8').split('\n')
    .filter(l => l && !/^(WEBVTT|NOTE|Kind:|Language:)/.test(l) && !/^\d{2}:\d{2}/.test(l) && !/^\d+$/.test(l.trim()))
    .map(l => l.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim()).filter(Boolean) : [];
  files.forEach(f => fs.rmSync(f, { force: true }));
  // Auto-captions repeat each line as they scroll
  return lines.filter((l, i) => l !== lines[i - 1]).join(' ').replace(/\s+/g, ' ').trim();
}

const TOOL = {
  name: 'record_restaurants',
  description: 'Record the London restaurants reviewed in this video.',
  input_schema: {
    type: 'object',
    properties: {
      restaurants: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name:          { type: 'string' },
            location:      { type: ['string', 'null'], description: 'Neighbourhood, area or street if given, else null' },
            rating:        { type: ['number', 'null'], description: 'Their score, e.g. 8 for "8 out of 10", else null' },
            rating_out_of: { type: ['number', 'null'], description: 'The scale, e.g. 10, else null' },
            sentiment:     { type: 'string', enum: ['positive', 'negative', 'mixed'] },
            notes:         { type: 'string', description: '1–2 sentences on what they said about the food, service or experience' },
          },
          required: ['name', 'location', 'rating', 'rating_out_of', 'sentiment', 'notes'],
        },
      },
    },
    required: ['restaurants'],
  },
};

const prompt = (video, text) => `This is a YouTube food video by ${creator.name} (@${creator.channel}), a London food creator.${creator.about ? ' ' + creator.about : ''}
List every London restaurant, café, bar, bakery or food stall the video reviews or visits. Ignore places outside London (they also travel abroad), and leave a place out rather than guess its name. Names in speech are often misheard: the title and description usually spell them correctly.

Title: ${video.title}
Description: ${video.description.slice(0, 3000) || '(none)'}
Captions: ${text ? text.slice(0, MAX_TEXT) : '(none)'}`;

async function main() {
  const done = fs.existsSync(OUTPUT) ? JSON.parse(fs.readFileSync(OUTPUT, 'utf8')) : [];
  const doneIds = new Set(done.map(v => v.videoId));
  const videos = await channelVideos();
  const todo = videos.filter(v => !doneIds.has(v.videoId)).slice(0, LIMIT);
  console.log(`@${creator.channel}: ${videos.length} videos, ${done.length} already scraped, ${todo.length} to scrape now.`);
  // ~4 characters per token; Shorts' captions are short, so this is a generous guess
  const estimate = todo.length * (3000 / 4 * 1 + 300 * 5) / 1e6;
  console.log(`Estimated cost: about $${estimate.toFixed(2)} (${MODEL})`);
  if (DRY_RUN) return;

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  for (const [i, video] of todo.entries()) {
    process.stdout.write(`[${i + 1}/${todo.length}] ${video.title.slice(0, 60)}… `);
    const text = await captions(video.videoId);
    try {
      const res = await anthropic.messages.create({
        model: MODEL, max_tokens: 1024, tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{ role: 'user', content: prompt(video, text) }],
      });
      const { restaurants = [] } = res.content.find(c => c.type === 'tool_use')?.input || {};
      done.push({ videoId: video.videoId, title: video.title, published: video.published, restaurants, ...(text ? {} : { noCaptions: true }) });
      console.log(restaurants.length ? restaurants.map(r => r.name).join(', ') : 'none');
    } catch (err) {
      console.log(`error: ${err.message}`);
      done.push({ videoId: video.videoId, title: video.title, restaurants: [], error: err.message });
    }
    fs.writeFileSync(OUTPUT, JSON.stringify(done, null, 2)); // saved after every video
  }
  const all = done.flatMap(v => v.restaurants);
  console.log(`\n${done.length} videos, ${all.length} restaurant mentions → ${OUTPUT}`);
}

main().catch(err => { console.error(`\nStopped: ${err.message}`); process.exit(1); });
