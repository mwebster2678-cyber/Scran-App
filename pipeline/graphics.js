// Matches the on-screen name graphics Claude read in a video (verify.js --frames) to the
// restaurants heard in it. Graphics are evidence for the review page: they never rename a
// pick by themselves, since they can be misread ("GUN & SUM" for Bun & Sum).
import { soundsLike, similarity, squash } from './link.js';

// Graphics come after a restaurant is named, sometimes well after (TopJaw: 20–35 s), rarely before
const BEFORE = 10, AFTER = 45; // seconds a graphic may be before / after the mention
const SOUNDS_LIKE = 0.4; // how alike (soundsLike) a graphic and a heard name must be

export const seconds = t => { const m = String(t || '').match(/^(\d+):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; };

// Sets onScreen/onScreenAt on the restaurants a graphic matches, and returns the graphics
// with the name each matched. Best matches go first, and each restaurant gets one graphic
// and each graphic one restaurant, so a pizza tour's six name cards don't all land on one
// pick. Repeats of an assigned graphic's text count for the same restaurant.
export function matchGraphics(restaurants, graphics = []) {
  for (const r of restaurants) { delete r.onScreen; delete r.onScreenAt; }
  const pairs = [];
  graphics.forEach((g, gi) => {
    const at = seconds(g.at);
    for (const r of restaurants) {
      const mention = seconds(r.moment);
      if (at == null || mention == null || at < mention - BEFORE || at > mention + AFTER) continue;
      const names = [r.originalName, r.name].filter(Boolean);
      const score = Math.max(...names.map(n => soundsLike(g.text, n)));
      // Ties go to the closer whole name ("UTOPIA BAGELS" over "Best Bagels in New York")
      const whole = Math.max(...names.map(n => similarity(squash(g.text), squash(n))));
      if (score >= SOUNDS_LIKE) pairs.push({ gi, r, score, whole });
    }
  });
  pairs.sort((a, b) => b.score - a.score || b.whole - a.whole);

  const matched = new Map(); // graphic index → restaurant
  for (const { gi, r } of pairs) {
    if (matched.has(gi) || r.onScreen) continue;
    matched.set(gi, r);
    Object.assign(r, { onScreen: graphics[gi].text, onScreenAt: graphics[gi].at });
  }
  return graphics.map((g, gi) => {
    const r = matched.get(gi) || restaurants.find(x => x.onScreen && squash(x.onScreen) === squash(g.text));
    return { ...g, matched: r?.originalName ?? null };
  });
}
