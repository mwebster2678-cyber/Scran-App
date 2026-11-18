// Vercel function: turns a Google Maps share link (maps.app.goo.gl/…) into the full link it
// points to, because browsers can't follow it themselves. Used by "Add a missing place" in app.js.
// Only follows Google's own short links, so it can't be used to fetch anything else.
const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl']);

module.exports = async (req, res) => {
  let link;
  try { link = new URL(String(req.query.url || '')); } catch { link = null; }
  if (!link || link.protocol !== 'https:' || !SHORT_HOSTS.has(link.hostname)
      || (link.hostname === 'goo.gl' && !link.pathname.startsWith('/maps'))) {
    return res.status(400).json({ error: 'Not a Google Maps share link' });
  }
  try {
    const r = await fetch(link.href, { redirect: 'manual' });
    const to = r.headers.get('location');
    if (!to) return res.status(404).json({ error: 'That link didn’t lead anywhere' });
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).json({ url: to });
  } catch {
    return res.status(502).json({ error: 'Couldn’t reach Google' });
  }
};
