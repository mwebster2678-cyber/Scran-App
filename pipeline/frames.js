// Reads on-screen text that names a place (title cards, signs, menus, receipts) from full-size
// video frames around a moment. ffmpeg fetches single 720p frames straight from YouTube, so only
// the bit of video each frame needs is downloaded; Claude reads them. Frames and readings are
// cached in cache/frames/, so re-runs are free.
// In a test on 62 answered picks this named the place in 10 of the 31 Claude had named wrongly
// (the small storyboard frames: 1), but about half the text it reads is something else: title
// cards, neighbouring shops, other stops, the odd misread. So it's evidence, never the answer.
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const YT_DLP = process.env.YT_DLP || `${os.homedir()}/.local/bin/yt-dlp`;
export const FFMPEG = `${os.homedir()}/.local/bin/ffmpeg`;
const MODEL  = 'claude-haiku-4-5-20251001';
const PRICE  = { input: 1 / 1e6, output: 5 / 1e6 };
const DIR    = 'cache/frames';
export const BEFORE = 10, AFTER = 45; // seconds of video read around a moment
const EVERY  = 4; // one frame every EVERY seconds
const run = promisify(execFile);
// The static ffmpeg needs to be told where macOS keeps its certificates
const ENV = { ...process.env, SSL_CERT_FILE: '/etc/ssl/cert.pem' };

export const hasFfmpeg = () => fs.existsSync(FFMPEG);
export const clock = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// Frames every EVERY s from `at` - BEFORE to `at` + AFTER, scaled to 960 px on the long side
export async function frames(videoId, at) {
  const start = Math.max(0, at - BEFORE);
  const dir = `${DIR}/${videoId}-${start}`;
  const times = Array.from({ length: Math.floor((BEFORE + AFTER) / EVERY) + 1 }, (_, i) => start + i * EVERY);
  if (!fs.existsSync(`${dir}/done`)) {
    fs.mkdirSync(dir, { recursive: true });
    const { stdout } = await run(YT_DLP, ['--cookies', 'cookies.txt', '-g', '-f', 'bv*[height<=720][ext=mp4]/bv*[height<=720]',
      `https://www.youtube.com/watch?v=${videoId}`], { timeout: 60_000 });
    const url = stdout.trim().split('\n')[0];
    for (let i = 0; i < times.length; i += 4) { // a few at a time
      await Promise.all(times.slice(i, i + 4).map(t => run(FFMPEG, ['-loglevel', 'error', '-ss', String(t), '-i', url,
        '-frames:v', '1', '-vf', `scale='if(gt(iw,ih),960,-2)':'if(gt(iw,ih),-2,960)'`, '-q:v', '4', '-y', `${dir}/${t}.jpg`],
        { env: ENV, timeout: 120_000 }).catch(() => {}))); // past the end of the video: no frame
    }
    fs.writeFileSync(`${dir}/done`, '');
  }
  return times.filter(t => fs.existsSync(`${dir}/${t}.jpg`))
    .map(t => ({ t, data: fs.readFileSync(`${dir}/${t}.jpg`).toString('base64') }));
}

const TOOL = {
  name: 'record_text',
  description: 'Record on-screen text that names a restaurant, café, bar, pub, bakery or food stall.',
  input_schema: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The name exactly as written on screen' },
            at:   { type: 'string', description: 'Frame time, m:ss' },
            kind: { type: 'string', enum: ['title_card', 'sign', 'menu', 'receipt_or_packaging', 'other'] },
          },
          required: ['text', 'at', 'kind'],
        },
      },
    },
    required: ['names'],
  },
};

const seconds = t => { const m = String(t || '').match(/^(\d+):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; };

// On-screen names around `at` (seconds), as [{ text, at (seconds), kind }], and what reading cost
export async function readText(anthropic, videoId, at) {
  const start = Math.max(0, at - BEFORE);
  const file = `${DIR}/${videoId}-${start}/text.json`;
  if (fs.existsSync(file)) return { names: JSON.parse(fs.readFileSync(file, 'utf8')), cost: 0 };
  const shots = await frames(videoId, at);
  if (!shots.length) return { names: [], cost: 0 };
  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 1024, tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{ role: 'user', content: [
      ...shots.flatMap(s => [{ type: 'text', text: `Frame at ${clock(s.t)}:` }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.data } }]),
      { type: 'text', text: `These are frames from a food video. List every piece of on-screen text that names a restaurant, café, bar, pub, bakery or food stall: title cards and captions, shop signs and awnings, menus, receipts, packaging. Copy only text you can read with certainty, exactly as written. Never guess or complete blurry or partly hidden text: a wrong name is far worse than none. Leave out dish names, prices, brands of drinks or ingredients, and the channel's own logo.` },
    ] }],
  });
  const names = (res.content.find(c => c.type === 'tool_use')?.input.names || [])
    .map(n => ({ text: n.text.trim(), at: seconds(n.at) ?? start, kind: n.kind })).filter(n => n.text);
  fs.writeFileSync(file, JSON.stringify(names));
  return { names, cost: res.usage.input_tokens * PRICE.input + res.usage.output_tokens * PRICE.output };
}

// ─── Which on-screen name is this place? ────────────────────────────────────
// A short, focused question per pick (text only, so cheap): what's said around the moment the
// place comes up, and the on-screen names with their times. Claude judges from the context
// whether a name is shown while they're at or talking about that place, or is something else
// (the video's title card, a neighbouring shop, a market or street, another stop).

const CONTEXT_BEFORE = 30, CONTEXT_AFTER = 90; // seconds of transcript around the moment

// The part of a transcript with [m:ss] markers between two times
export function transcriptAround(text, at) {
  if (!text) return '';
  const parts = text.split(/(?=\[\d+:\d{2}\])/);
  return parts.filter(p => {
    const t = seconds(p.match(/^\[(\d+:\d{2})\]/)?.[1]);
    return t != null && t >= at - CONTEXT_BEFORE && t <= at + CONTEXT_AFTER;
  }).join('').slice(0, 6000);
}

const PICK_TOOL = {
  name: 'record_match',
  description: 'Record which on-screen name, if any, names this place.',
  input_schema: {
    type: 'object',
    properties: {
      text:     { type: ['string', 'null'], description: 'The on-screen text, copied exactly from the list, that names this place; null if none does.' },
      relation: { type: 'string', enum: ['same_name', 'better_name', 'none'],
        description: 'same_name: it is the name already given (spelling or styling aside). better_name: it names this place where the name given is wrong (misheard, or only the market, venue or area). none: no on-screen name is this place.' },
      why:      { type: 'string', description: 'One short sentence.' },
    },
    required: ['text', 'relation', 'why'],
  },
};

// { text, at, kind, relation, why } for the on-screen name of this pick, or null
export async function matchOnScreen(anthropic, { creatorName, heard, name, at, transcript, list }) {
  const nearby = list.filter(n => n.at >= at - BEFORE - 5 && n.at <= at + AFTER + 15);
  if (!nearby.length) return { match: null, cost: 0 };
  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 300, tools: [PICK_TOOL], tool_choice: { type: 'tool', name: PICK_TOOL.name },
    messages: [{ role: 'user', content: `In a food video, ${creatorName} reviews a place heard as "${heard}"${name && name !== heard ? ` (named so far as "${name}")` : ''}, which comes up at ${clock(at)}.

What's said around then (automatic captions, [m:ss] marks the time):
${transcriptAround(transcript, at) || '(no transcript)'}

On-screen text read from the video around then ([m:ss] kind: text):
${nearby.map(n => `[${clock(n.at)}] ${n.kind}: ${n.text}`).join('\n')}

Which on-screen text, if any, names this place? Judge by the timing and what's being said: it counts only if it's shown while they are at or talking about this place (arriving, ordering, eating, reviewing). The video's own title card or caption naming the place counts; its catchphrases, a neighbouring shop, a street, another stop in the video, or a drink or ingredient brand don't. A sign for a stall inside a market or food hall names the stall: that's a better name than the market's. Answer none if unsure: a wrong name is far worse than none.` }],
  });
  const out = res.content.find(c => c.type === 'tool_use')?.input;
  const cost = res.usage.input_tokens * PRICE.input + res.usage.output_tokens * PRICE.output;
  const seen = out?.text && out.relation !== 'none' && nearby.find(n => n.text.trim().toLowerCase() === out.text.trim().toLowerCase());
  return { match: seen ? { ...seen, relation: out.relation, why: out.why } : null, cost };
}
