# SCRAN data pipeline

Builds the data files SCRAN loads from `../data/`.

## All places (`places.json`)

`node places.js` — every restaurant, pub, bar and café inside the M25 from the latest
[Overture Maps](https://overturemaps.org) release (Meta, Microsoft, Foursquare and others).
No API keys or cost; takes about 20 seconds. Re-run monthly to pick up new openings.

## Creator pins (`<creator>.json`)

Turns YouTube restaurant reviews into the creator pins SCRAN shows.
Creators are configured in `shared.js` (`tod`, `topjaw`).

Setup: `npm install`, then copy `.env.example` to `.env` and fill in the keys.
Tod's scraper also needs `yt-dlp` and a `cookies.txt` exported from a logged-in YouTube session.

| Step | Command | Reads → writes |
|---|---|---|
| 1. Scrape videos (YouTube + Claude) | `node scrape-tod.js` / `node scrape-topjaw.js` | → `<creator>-scraped.json` |
| 2. Group by restaurant and locate (Google) | `node geocode.js <creator>` | `-scraped` → `<creator>-geocoded.json` |
| 3. Review restaurants that couldn't be located | `node build-review.js <creator>`, open `review-<creator>.html`, approve/remove, Export | → `<creator>-corrections.json` |
| 4. Apply corrections (also runs step 5) | `node apply-corrections.js <creator>` | `-corrections` + `-geocoded` → `-geocoded` |
| 5. Export to the app | `node inject.js <creator>` | `-geocoded` → `../data/<creator>.json` |

Steps 1 and 2 call paid APIs; scraping resumes where it left off if re-run.
