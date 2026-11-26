// Fixes names misheard from speech using the video's own title and description, without Claude.
// Auto-captions hear "Row on 5" as "Roan 5"; Claude is told to trust the description's spelling
// but sometimes doesn't. If a pick's name isn't written anywhere in the title or description but
// a capitalised phrase there is within a couple of letters of it (ignoring spaces and
// punctuation), that phrase is very likely the real spelling.

const SMALL = new Set(['on', 'the', 'and', 'of', 'at', 'by', 'in', 'de', 'la', 'le', 'du', 'da', 'di', '&', "n'", 'n']);
const IGNORE = /^(london|subscribe|instagram|tiktok|facebook|youtube|merch|follow|like|watch)$/i;
const squash = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

const strong = w => /^[A-Z0-9À-Þ]/.test(w) && !IGNORE.test(w);

// The written spelling of `name` in `texts`, or null if it's already written or nothing is close
export function writtenSpelling(name, texts) {
  const target = squash(name);
  if (target.length < 4) return null;
  const all = texts.filter(Boolean).join('\n');
  if (squash(all).includes(target)) return null; // already spelled this way somewhere
  const found = new Map();
  for (const line of all.split(/\n|[.!?|•·:;,()"“”]+/)) {
    if (/https?:\/\//.test(line)) continue;
    const words = line.split(/\s+/).map(w => w.replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&']+$/gu, '').replace(/'s$/, '')).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      if (!strong(words[i])) continue;
      for (let j = i; j < Math.min(words.length, i + 5); j++) {
        if (j > i && !strong(words[j]) && !SMALL.has(words[j].toLowerCase())) break;
        if (!strong(words[j])) continue; // a phrase ends on a capitalised word or number
        const phrase = words.slice(i, j + 1).join(' ');
        const s = squash(phrase);
        if (s[0] !== target[0] || Math.abs(s.length - target.length) > 2) continue;
        const d = distance(s, target);
        if (d > 0 && d <= Math.max(1, Math.floor(Math.max(s.length, target.length) / 3)) && d <= 2) {
          if (!found.has(s) || found.get(s).d > d) found.set(s, { phrase, d });
        }
      }
    }
  }
  const best = [...found.values()].sort((a, b) => a.d - b.d);
  if (!best.length || (best[1] && best[1].d === best[0].d)) return null; // none, or no clear winner
  return best[0].phrase;
}

// Flags a kept pick whose name the title or description spells differently, so it's reviewed
// (never renamed: descriptions have typos too, e.g. "Beigal Bake"). placeName is the name of the
// place it's linked to, if any: a match there confirms the name, so it isn't flagged.
export function flagSpelling(pick, texts, placeName, sameName) {
  if (!pick.keep || (placeName && sameName(placeName, pick.name))) return false;
  const written = writtenSpelling(pick.name, texts);
  if (!written || written.toLowerCase().replace(/s$/, '') === pick.name.toLowerCase().replace(/s$/, '')) return false;
  Object.assign(pick, { writtenAs: written, confident: false,
    why: `${pick.why} The title or description spells it "${written}".` });
  return true;
}

// node spelling.js → flags existing verified picks (all creators), for the review page
if (process.argv[1] && (await import('url')).fileURLToPath(import.meta.url) === (await import('path')).resolve(process.argv[1])) {
  const fs = await import('fs');
  const { CREATORS } = await import('./shared.js');
  const { PLACES_FILE, sameName } = await import('./link.js');
  const names = new Map(JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8')).places.map(p => [p[0], p[1]]));
  for (const key of Object.keys(CREATORS)) {
    const file = `${key}-verified.json`;
    if (!fs.existsSync(file)) continue;
    const descriptions = fs.existsSync(`cache/${key}-videos.json`) ? JSON.parse(fs.readFileSync(`cache/${key}-videos.json`, 'utf8')) : {};
    const videos = JSON.parse(fs.readFileSync(file, 'utf8'));
    let flagged = 0;
    for (const v of videos) for (const r of v.restaurants) {
      if (r.writtenAs) continue; // already flagged
      if (flagSpelling(r, [v.title, descriptions[v.videoId]?.description], names.get(r.placeId), sameName)) {
        flagged++; console.log(`${CREATORS[key].name}: "${r.name}" → written "${r.writtenAs}"`);
      }
    }
    if (flagged) fs.writeFileSync(file, JSON.stringify(videos, null, 2));
  }
}
