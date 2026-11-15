const SUPABASE_URL = 'https://gcyezgildizquectvrbe.supabase.co';
const SUPABASE_KEY = 'sb_publishable_E2_XaAQrwmGpOc8PpdEkeg_hTnk7OrH';
const sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // Saving to or loading from your account failed: say so, rather than quietly keeping it only here
  function cloudError(error) {
    console.warn('[SCRAN] account sync failed:', error);
    UI.showError(`Couldn’t sync with your account: ${error.message}`);
  }

  // 'place/abc' → ['place', 'abc'] (Storage and BookmarkStorage keys)
  function splitKey(key) {
    const i = key.indexOf('/');
    return [key.slice(0, i), key.slice(i + 1)];
  }

  function normalizeRating(rating, outOf) {
    if (rating == null || outOf == null || outOf <= 0) return null;
    return parseFloat(((rating / outOf) * 10).toFixed(1));
  }

  // ─────────────────────────────────────────
  // 1. CONFIG
  // ─────────────────────────────────────────
  const CONFIG = {
    mapCenter: [51.5074, -0.1278],
    defaultZoom: 13,
    minZoom: 10,
    minZoomForAllPlaces: 16, // below this, only creator picks and your own places show
    placesUrl: 'data/places.json',
    // Browser key — public by design; restricted to SCRAN's web addresses in Google Cloud
    googleMapsKey: 'AIzaSyAP7wkccKRKXO1DhpUbfghTcvW5pH5N7V8',
    storageKey: 'london-eats-ratings',
    bookmarkKey: 'london-eats-bookmarks',
    accountKey: 'scran-synced-account', // whose account this browser's ratings and saved places came from
    // Approximate M25 polygon, clockwise from South Mimms
    m25Polygon: [
      [51.716, -0.198],
      [51.726, -0.100],
      [51.710,  0.020],
      [51.670,  0.095],
      [51.535,  0.215],
      [51.450,  0.290],
      [51.390,  0.270],
      [51.330,  0.200],
      [51.285,  0.100],
      [51.255,  0.005],
      [51.240, -0.130],
      [51.270, -0.320],
      [51.325, -0.430],
      [51.375, -0.515],
      [51.435, -0.555],
      [51.495, -0.570],
      [51.560, -0.535],
      [51.615, -0.498],
      [51.680, -0.430],
    ],
    // Bounding box that contains the M25
    m25Bounds: [[51.22, -0.62], [51.74, 0.32]],
  };

  // ─────────────────────────────────────────
  // 2. STORAGE
  // ─────────────────────────────────────────
  const Storage = (() => {
    function _load() {
      try {
        return JSON.parse(localStorage.getItem(CONFIG.storageKey) || '{}');
      } catch { return {}; }
    }

    function _save(data) {
      try {
        localStorage.setItem(CONFIG.storageKey, JSON.stringify(data));
        return true;
      } catch (e) {
        UI.showError('Storage full — rating saved in memory only.');
        return false;
      }
    }

    function getKey(type, id) {
      return `${type}/${id}`;
    }

    function get(type, id) {
      return _load()[getKey(type, id)] || null;
    }

    function set(type, id, rating, name, lat, lon, cuisine, note) {
      const data = _load();
      const existing = data[getKey(type, id)] || {};
      const resolvedNote = note ?? existing.note ?? '';
      data[getKey(type, id)] = { rating, name, lat, lon, cuisine, note: resolvedNote, timestamp: Date.now() };
      _save(data);
      const user = typeof Auth !== 'undefined' && Auth.currentUser();
      if (user) {
        sbClient.from('ratings').upsert({
          user_id: user.id,
          osm_type: type,
          osm_id: String(id),
          restaurant_name: name,
          lat, lon,
          cuisine: cuisine || [],
          rating,
          note: resolvedNote,
        }, { onConflict: 'user_id,osm_type,osm_id' }).then(({ error }) => {
          if (error) cloudError(error);
        });
      }
    }

    function setNote(type, id, note) {
      const data = _load();
      if (data[getKey(type, id)]) {
        data[getKey(type, id)].note = note;
        _save(data);
        const user = typeof Auth !== 'undefined' && Auth.currentUser();
        if (user) {
          sbClient.from('ratings')
            .update({ note })
            .eq('user_id', user.id)
            .eq('osm_type', type)
            .eq('osm_id', String(id))
            .then(({ error }) => { if (error) cloudError(error); });
        }
      }
    }

    function remove(type, id) {
      const data = _load();
      delete data[getKey(type, id)];
      _save(data);
      const user = typeof Auth !== 'undefined' && Auth.currentUser();
      if (user) {
        sbClient.from('ratings')
          .delete()
          .eq('user_id', user.id)
          .eq('osm_type', type)
          .eq('osm_id', String(id))
          .then(({ error }) => { if (error) cloudError(error); });
      }
    }

    function count() {
      return Object.keys(_load()).length;
    }

    function getAll() { return _load(); }

    // Ratings made while signed out go up to the account, then this browser keeps everything on
    // the account. Once this browser has synced with the account (`fromSignedOut` false), the
    // account is the truth, so a rating removed on another device goes here too.
    async function syncFromCloud(fromSignedOut) {
      const user = typeof Auth !== 'undefined' && Auth.currentUser();
      if (!user) return false;
      const { data, error } = await sbClient.from('ratings').select('*').eq('user_id', user.id);
      if (error || !data) return false;
      const local = _load();
      const onAccount = new Set(data.map(r => getKey(r.osm_type, r.osm_id)));
      const signedOut = fromSignedOut ? Object.entries(local).filter(([k, e]) => !onAccount.has(k) && e.rating != null) : [];
      if (signedOut.length) {
        const { error: upErr } = await sbClient.from('ratings').upsert(signedOut.map(([k, e]) => {
          const [type, id] = splitKey(k);
          return { user_id: user.id, osm_type: type, osm_id: id, restaurant_name: e.name, lat: e.lat, lon: e.lon,
            cuisine: e.cuisine || [], rating: e.rating, note: e.note || '' };
        }), { onConflict: 'user_id,osm_type,osm_id' });
        if (upErr) cloudError(upErr);
      }
      const stored = Object.fromEntries(signedOut);
      data.forEach(r => {
        stored[getKey(r.osm_type, r.osm_id)] = {
          rating: r.rating,
          name: r.restaurant_name,
          lat: r.lat,
          lon: r.lon,
          cuisine: r.cuisine || [],
          note: r.note || '',
          timestamp: new Date(r.created_at).getTime(),
        };
      });
      _save(stored);
      return true;
    }

    // Signing out leaves the next person on this browser with an empty list (yours stay on your account)
    function clear() { _save({}); }

    return { get, set, setNote, remove, count, getKey, getAll, syncFromCloud, clear };
  })();

  // ─────────────────────────────────────────
  // 2b. BOOKMARK STORAGE
  // ─────────────────────────────────────────
  const BookmarkStorage = (() => {
    function _load() {
      try { return JSON.parse(localStorage.getItem(CONFIG.bookmarkKey) || '{}'); }
      catch { return {}; }
    }
    function _save(data) {
      try { localStorage.setItem(CONFIG.bookmarkKey, JSON.stringify(data)); }
      catch { UI.showError('Storage full — bookmark not saved.'); }
    }
    function key(type, id) { return `${type}/${id}`; }
    function get(type, id) { return !!_load()[key(type, id)]; }
    const _user = () => typeof Auth !== 'undefined' && Auth.currentUser();
    const _warn = ({ error }) => { if (error) cloudError(error); };
    function set(type, id, name, lat, lon, cuisine) {
      const data = _load();
      data[key(type, id)] = { name, lat, lon, cuisine, timestamp: Date.now() };
      _save(data);
      const user = _user();
      if (user) {
        sbClient.from('bookmarks').upsert({ user_id: user.id, place_type: type, place_id: String(id),
          name, lat, lon, cuisine: cuisine || [] }).then(_warn);
      }
    }
    function remove(type, id) {
      const data = _load();
      delete data[key(type, id)];
      _save(data);
      const user = _user();
      if (user) {
        sbClient.from('bookmarks').delete()
          .eq('user_id', user.id).eq('place_type', type).eq('place_id', String(id)).then(_warn);
      }
    }
    function getAll() { return _load(); }

    // Same as Storage.syncFromCloud: places saved while signed out join the account's
    async function syncFromCloud(fromSignedOut) {
      const user = _user();
      if (!user) return false;
      const { data, error } = await sbClient.from('bookmarks').select('*').eq('user_id', user.id);
      if (error || !data) return false;
      const local = _load();
      const onAccount = new Set(data.map(b => key(b.place_type, b.place_id)));
      const signedOut = fromSignedOut ? Object.entries(local).filter(([k]) => !onAccount.has(k)) : [];
      if (signedOut.length) {
        await sbClient.from('bookmarks').upsert(signedOut.map(([k, b]) => {
          const [type, id] = splitKey(k);
          return { user_id: user.id, place_type: type, place_id: id, name: b.name, lat: b.lat, lon: b.lon,
            cuisine: b.cuisine || [] };
        })).then(_warn);
      }
      const stored = Object.fromEntries(signedOut);
      data.forEach(b => {
        stored[key(b.place_type, b.place_id)] = { name: b.name, lat: b.lat, lon: b.lon, cuisine: b.cuisine || [],
          timestamp: new Date(b.created_at).getTime() };
      });
      _save(stored);
      return true;
    }

    function clear() { _save({}); }

    return { get, set, remove, getAll, key, syncFromCloud, clear };
  })();

  // ─────────────────────────────────────────
  // 3. UI
  // ─────────────────────────────────────────
  const UI = (() => {
    const overlay   = document.getElementById('loading-overlay');
    const toast     = document.getElementById('error-toast');
    const dot       = document.getElementById('status-dot');
    const msg       = document.getElementById('status-msg');
    let toastTimer  = null;
    let statusTimer = null;
    let firstLoad   = true;

    function setLoading(bool, statusMsg) {
      if (firstLoad) {
        if (bool) return; // the first-load overlay is already showing
        overlay.classList.add('hidden');
        firstLoad = false;
      }
      clearTimeout(statusTimer);
      if (bool) {
        dot.classList.add('pulsing');
        msg.textContent = statusMsg || 'Loading restaurants\u2026';
      } else {
        dot.classList.remove('pulsing');
        msg.textContent = statusMsg || '';
        if (!statusMsg) {
          statusTimer = setTimeout(() => { msg.textContent = ''; }, 3000);
        }
      }
    }

    function setStatus(text) {
      clearTimeout(statusTimer);
      dot.classList.remove('pulsing');
      msg.textContent = text;
    }

    function showError(errorMsg) {
      clearTimeout(toastTimer);
      toast.textContent = errorMsg;
      toast.classList.remove('success');
      toast.classList.add('show');
      toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
    }

    function showSuccess(msg) {
      clearTimeout(toastTimer);
      toast.textContent = msg;
      toast.classList.add('show', 'success');
      toastTimer = setTimeout(() => toast.classList.remove('show', 'success'), 3000);
    }

    function updateStatsCount() {
      // no-op: stats moved to profile panel
    }

    function hideFirstLoadOverlay() {
      overlay.classList.add('hidden');
      firstLoad = false;
    }

    return { setLoading, setStatus, showError, showSuccess, updateStatsCount, hideFirstLoadOverlay };
  })();

  // ─────────────────────────────────────────
  // 4. PLACES (restaurants, pubs, cafés — data/places.json, built by pipeline/places.js)
  // ─────────────────────────────────────────
  const PLACE_TYPE = 'place'; // Storage/Supabase type for places from this file

  const Places = (() => {
    let _places = [];
    let _byId   = new Map();
    let _loaded = null;

    // Loads the file once; later calls reuse the same promise (or retry after a failure)
    function load() {
      if (!_loaded) {
        _loaded = fetch(CONFIG.placesUrl)
          .then(r => { if (!r.ok) throw new Error(`http_${r.status}`); return r.json(); })
          .then(data => {
            _places = data.places.map(([id, name, lat, lon, kind, cuisine, address]) =>
              ({ id, name, lat, lon, kind, cuisine: cuisine.map(i => data.cuisines[i]), address }));
            _byId = new Map(_places.map(p => [p.id, p]));
          })
          .catch(e => { _loaded = null; throw e; });
      }
      return _loaded;
    }

    // Places inside `bounds` matching the kind ('eat' | 'pub' | 'cafe') and cuisine filters
    function query(bounds, { kind, cuisine }) {
      return _places.filter(p =>
        bounds.contains([p.lat, p.lon]) &&
        (!kind || p.kind === kind) &&
        (!cuisine || p.cuisine.includes(cuisine)));
    }

    function get(id) { return _byId.get(id) || null; }

    return { load, query, get };
  })();

  // What the rating panel and storage need to know about a place
  function placeRef(place) {
    const { id, name, cuisine, lat, lon, address } = place;
    return { type: PLACE_TYPE, id, name, cuisine, lat, lon, address };
  }

  // ─────────────────────────────────────────
  // 5. MARKER MANAGER
  // ─────────────────────────────────────────
  // Unrated places are small canvas dots (fast for thousands); rated or
  // bookmarked places get a full pin.
  const MarkerManager = (() => {
    const KIND_COLOURS = { eat: '#8E44AD', pub: '#A0522D', cafe: '#E67E22' };
    const markers = new Map(); // place id → marker
    let _map      = null;
    let _renderer = null;
    let _zoom     = null; // zoom the dots were last sized for

    // Dots only appear from street level (CONFIG.minZoomForAllPlaces) and grow as you zoom in
    function _dotSize(zoom) {
      return zoom <= 16 ? { radius: 4, weight: 1 } : { radius: 5, weight: 1.5 };
    }

    function init(map) {
      _map = map;
      _renderer = L.canvas({ padding: 0.5 });
    }

    function _pinIcon(id) {
      const stored = Storage.get(PLACE_TYPE, id);
      if (stored) {
        const cls = stored.rating >= 8 ? 'pin-high' : stored.rating >= 4 ? 'pin-mid' : 'pin-low';
        return L.divIcon({
          className: '',
          html: `<div class="map-pin ${cls} pin-rated"><span class="pin-rating">${stored.rating}</span></div>`,
          iconSize: [34, 44], iconAnchor: [17, 44], popupAnchor: [0, -46],
        });
      }
      if (BookmarkStorage.get(PLACE_TYPE, id)) {
        return L.divIcon({
          className: '',
          html: '<div class="map-pin pin-bookmarked"></div>',
          iconSize: [28, 36], iconAnchor: [14, 36], popupAnchor: [0, -38],
        });
      }
      return null;
    }

    function _createMarker(place) {
      const icon = _pinIcon(place.id);
      const marker = icon
        ? L.marker([place.lat, place.lon], { icon, riseOnHover: true })
        : L.circleMarker([place.lat, place.lon], {
            renderer: _renderer, ..._dotSize(_map.getZoom()),
            color: '#fff', fillColor: KIND_COLOURS[place.kind], fillOpacity: 0.55, // a quiet background to the creator pins
          });
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        RatingPanel.open(placeRef(place));
      });
      return marker.addTo(_map);
    }

    // Show exactly these places, keeping markers that are already on the map
    function show(places) {
      const zoom = _map.getZoom();
      if (zoom !== _zoom) {
        _zoom = zoom;
        const size = _dotSize(zoom);
        markers.forEach(m => { if (m instanceof L.CircleMarker) m.setStyle(size).setRadius(size.radius); });
      }
      const wanted = new Set(places.map(p => p.id));
      markers.forEach((marker, id) => {
        if (!wanted.has(id)) { marker.remove(); markers.delete(id); }
      });
      places.forEach(p => { if (!markers.has(p.id)) markers.set(p.id, _createMarker(p)); });
    }

    // Swap dot ↔ pin after a rating or bookmark changes
    function refreshMarkerIcon(type, id) {
      if (type !== PLACE_TYPE || !markers.has(id)) return;
      const place = Places.get(id);
      if (!place) return;
      markers.get(id).remove();
      markers.set(id, _createMarker(place));
    }

    return { init, show, refreshMarkerIcon };
  })();

  // ─────────────────────────────────────────
  // 6. GOOGLE PLACE INFO (Places API: rating, opening hours, a photo)
  // ─────────────────────────────────────────
  // Google's rules: only shown on the Google base map, with the Google Maps logo, the
  // photographer credited and a link to the place on Google Maps. Only the Google place ID
  // may be stored, so everything else is fetched fresh each time a place is opened.
  // Cost: finding the place ID is free; details and the photo are each 1,000 free a month,
  // and the daily caps set in Google Cloud stop it going past that.
  const GooglePlaceInfo = (() => {
    const API      = 'https://places.googleapis.com/v1';
    const IDS_KEY  = 'scran-google-place-ids'; // SCRAN place → Google place ID ('' = not on Google)
    const FIELDS   = 'id,displayName,location,rating,userRatingCount,priceLevel,currentOpeningHours,websiteUri,googleMapsUri,photos';
    const PRICES   = { PRICE_LEVEL_INEXPENSIVE: '£', PRICE_LEVEL_MODERATE: '££', PRICE_LEVEL_EXPENSIVE: '£££', PRICE_LEVEL_VERY_EXPENSIVE: '££££' };
    const el       = document.getElementById('panel-google');
    const _details = new Map(); // fetched this visit, so reopening a place costs nothing

    let _showing = null; // the place currently in the panel, so late replies for others are ignored

    function _savedIds() {
      try { return JSON.parse(localStorage.getItem(IDS_KEY)) || {}; } catch { return {}; }
    }

    function _saveId(key, googleId) {
      try { localStorage.setItem(IDS_KEY, JSON.stringify({ ..._savedIds(), [key]: googleId })); } catch { /* ignore */ }
    }

    async function _call(path, options = {}, fields) {
      const res = await fetch(`${API}/${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': CONFIG.googleMapsKey, 'X-Goog-FieldMask': fields },
      });
      if (!res.ok) throw new Error(res.status === 429 ? 'limit' : `http_${res.status}`);
      return res.json();
    }

    // Google's ID for the place with this name within ~150 m (the free "IDs only" search)
    async function _findId({ name, lat, lon }) {
      const d = 0.0015;
      const data = await _call('places:searchText', {
        method: 'POST',
        body: JSON.stringify({
          textQuery: name,
          pageSize: 1,
          locationRestriction: { rectangle: {
            low:  { latitude: lat - d, longitude: lon - d * 1.6 },
            high: { latitude: lat + d, longitude: lon + d * 1.6 },
          } },
        }),
      }, 'places.id');
      return data.places?.[0]?.id || '';
    }

    // The search can return a neighbour, so check the names share a word
    function _sameName(a, b) {
      const words = s => new Set(s.toLowerCase().replace(/&/g, 'and').split(/[^a-z0-9]+/)
        .filter(w => w.length > 2 && !['the', 'and', 'restaurant', 'cafe', 'bar', 'pub', 'london'].includes(w)));
      const wa = words(a), wb = words(b);
      if (!wa.size || !wb.size) return a.toLowerCase().trim() === b.toLowerCase().trim();
      return [...wa].some(w => wb.has(w));
    }

    async function _load(place) {
      const ids = _savedIds();
      let googleId = ids[place.key];
      if (googleId === undefined) {
        googleId = await _findId(place);
        _saveId(place.key, googleId);
      }
      if (!googleId) return null;
      if (!_details.has(googleId)) {
        const details = await _call(`places/${googleId}?languageCode=en-GB&regionCode=GB`, {}, FIELDS);
        _details.set(googleId, _sameName(place.name, details.displayName?.text || '') ? details : null);
      }
      return _details.get(googleId);
    }

    function _hoursHtml(hours) {
      if (!hours) return '';
      const status = hours.openNow != null
        ? `<span class="g-${hours.openNow ? 'open' : 'closed'}">${hours.openNow ? 'Open now' : 'Closed now'}</span>` : '';
      const days = hours.weekdayDescriptions || [];
      if (!days.length) return status;
      const today = (new Date().getDay() + 6) % 7; // Google lists Monday first
      const list = days.map((d, i) => `<li${i === today ? ' class="g-today"' : ''}>${escapeHtml(d)}</li>`).join('');
      return `<details class="g-hours"><summary>${status || 'Opening hours'}</summary><ul>${list}</ul></details>`;
    }

    function _photoHtml(photo) {
      if (!photo) return '';
      const src = `${API}/${photo.name}/media?maxWidthPx=600&key=${CONFIG.googleMapsKey}`;
      const credit = (photo.authorAttributions || []).map(a =>
        a.uri ? `<a href="${escapeHtml(a.uri)}" target="_blank" rel="noopener">${escapeHtml(a.displayName)}</a>` : escapeHtml(a.displayName)
      ).join(', ');
      return `<figure class="g-photo"><img src="${escapeHtml(src)}" alt="" loading="lazy">
        ${credit ? `<figcaption>Photo: ${credit}</figcaption>` : ''}</figure>`;
    }

    function _render(d) {
      const summary = [
        d.rating != null ? `<span class="g-rating">&#9733; ${d.rating.toFixed(1)}</span> <span class="g-muted">(${(d.userRatingCount || 0).toLocaleString('en-GB')})</span>` : '',
        PRICES[d.priceLevel] ? `<span class="g-muted">${PRICES[d.priceLevel]}</span>` : '',
      ].filter(Boolean).join(' · ');
      const links = [
        d.googleMapsUri ? `<a href="${escapeHtml(d.googleMapsUri)}" target="_blank" rel="noopener">View on Google Maps</a>` : '',
        d.websiteUri ? `<a href="${escapeHtml(d.websiteUri)}" target="_blank" rel="noopener">Website</a>` : '',
      ].filter(Boolean).join(' · ');
      el.innerHTML = `
        ${summary ? `<div class="g-summary">${summary}</div>` : ''}
        ${_hoursHtml(d.currentOpeningHours)}
        ${_photoHtml(d.photos?.[0])}
        <div class="g-footer"><span class="g-logo">Google Maps</span><span class="g-links">${links}</span></div>`;
    }

    function _message(text) {
      el.innerHTML = `<div class="g-muted">${text}</div>`;
    }

    // place: { key, name, lat, lon }
    async function show(place) {
      _showing = place.key;
      el.innerHTML = '';
      el.hidden = true;
      try {
        if (!await BaseMap.isGoogle()) return; // Google's terms: Places info only on a Google map
        if (_showing !== place.key) return;
        el.hidden = false;
        _message('Loading Google info…');
        const details = await _load(place);
        if (_showing !== place.key) return;
        if (details) _render(details);
        else el.hidden = true;
      } catch (e) {
        if (_showing !== place.key) return;
        console.warn('[SCRAN] Google place info failed:', e.message);
        _message(e.message === 'limit' ? 'Google info has hit its daily limit — back tomorrow.' : 'Google info unavailable right now.');
      }
    }

    function hide() {
      _showing = null;
    }

    return { show, hide };
  })();

  // ─────────────────────────────────────────
  // 7. RATING PANEL
  // ─────────────────────────────────────────
  const RatingPanel = (() => {
    const panel       = document.getElementById('rating-panel');
    const nameEl      = document.getElementById('panel-name');
    const addressEl   = document.getElementById('panel-address');
    const cuisineEl   = document.getElementById('panel-cuisine');
    const creatorsEl  = document.getElementById('panel-creators');
    const peopleEl    = document.getElementById('panel-people');
    const btnsEl      = document.getElementById('rating-buttons');
    const closeBtn    = document.getElementById('panel-close');
    const clearBtn    = document.getElementById('clear-rating-btn');
    const bookmarkBtn = document.getElementById('bookmark-btn');
    const shareBtn    = document.getElementById('share-btn');
    const noteEl      = document.getElementById('panel-note');

    let _current   = null; // { type, id, name, cuisine, lat, lon }
    let _noteTimer = null;

    function _renderRatingButtons(currentRating) {
      btnsEl.innerHTML = '';
      for (let i = 1; i <= 10; i++) {
        const btn = document.createElement('button');
        btn.className = 'rating-btn';
        btn.textContent = i;
        btn.setAttribute('aria-label', `Rate ${i} out of 10`);
        if (currentRating === i) {
          btn.classList.add(i >= 8 ? 'selected-high' : i >= 4 ? 'selected-mid' : 'selected-low');
        }
        btn.addEventListener('click', () => _handleRatingClick(i));
        btnsEl.appendChild(btn);
      }
    }

    function _handleRatingClick(value) {
      if (!_current) return;
      Storage.set(_current.type, _current.id, value, _current.name, _current.lat, _current.lon, _current.cuisine, noteEl.value.trim());
      MarkerManager.refreshMarkerIcon(_current.type, _current.id);
      UI.updateStatsCount();
      MyListManager.refresh();
      _renderRatingButtons(value);
      if (navigator.vibrate) navigator.vibrate(30);
    }

    function _updateStatusBtns(type, id) {
      const isBookmarked = BookmarkStorage.get(type, id);
      bookmarkBtn.classList.toggle('bookmarked', isBookmarked);
    }

    let _hideTimer = null;

    function open({ type, id, name, cuisine, lat, lon, address }) {
      if (!requireSignIn('Sign in to open places, see what creators said and rate them.')) return;
      // Cancel any pending hide from a previous close()
      clearTimeout(_hideTimer);

      _current = { type, id, name, cuisine, lat, lon };
      nameEl.textContent = name;
      addressEl.textContent = address || '';
      // Cuisines run general → specific (European, Italian, Pizza); show the specific end
      cuisineEl.innerHTML = cuisine.slice(-2)
        .map(c => `<span class="cuisine-tag">${escapeHtml(c)}</span>`).join('');
      const stored = Storage.get(type, id);
      _renderRatingButtons(stored ? stored.rating : null);
      noteEl.value = stored?.note || '';
      _updateStatusBtns(type, id);
      creatorsEl.innerHTML = '';
      CreatorPicks.load().then(() => {
        if (_current?.id === id) creatorsEl.innerHTML = creatorVerdictsHtml(CreatorPicks.forPlace(id));
      });
      peopleEl.innerHTML = peopleVerdictsHtml(PeopleLayer.forPlace(type, id));
      GooglePlaceInfo.show({ key: `${type}/${id}`, name, lat, lon });

      panel.classList.remove('hidden');
      panel.getBoundingClientRect();
      panel.classList.add('open');
    }

    function close() {
      panel.classList.remove('open');
      _hideTimer = setTimeout(() => panel.classList.add('hidden'), 400);
      _current = null;
      GooglePlaceInfo.hide();
    }

    closeBtn.addEventListener('click', close);

    peopleEl.addEventListener('click', (e) => {
      const row = e.target.closest('[data-person]');
      if (!row) return;
      close(); // the profile opens underneath this card otherwise
      ProfilePanel.open(row.dataset.person);
    });

    noteEl.addEventListener('input', () => {
      if (!_current) return;
      clearTimeout(_noteTimer);
      _noteTimer = setTimeout(() => {
        Storage.setNote(_current.type, _current.id, noteEl.value.trim());
      }, 600);
    });

    clearBtn.addEventListener('click', () => {
      if (!_current) return;
      Storage.remove(_current.type, _current.id);
      MarkerManager.refreshMarkerIcon(_current.type, _current.id);
      UI.updateStatsCount();
      MyListManager.refresh();
      _renderRatingButtons(null);
      noteEl.value = '';
    });

    bookmarkBtn.addEventListener('click', () => {
      if (!_current) return;
      const { type, id, name, lat, lon, cuisine } = _current;
      if (BookmarkStorage.get(type, id)) {
        BookmarkStorage.remove(type, id);
      } else {
        BookmarkStorage.set(type, id, name, lat, lon, cuisine);
      }
      _updateStatusBtns(type, id);
      MarkerManager.refreshMarkerIcon(type, id);
      MyListManager.refresh();
    });

    shareBtn.addEventListener('click', () => {
      if (!_current) return;
      const { type, id, name, lat, lon } = _current;
      const url = new URL(window.location.href);
      url.search = '';
      url.searchParams.set('lat', lat.toFixed(6));
      url.searchParams.set('lon', lon.toFixed(6));
      url.searchParams.set('type', type);
      url.searchParams.set('id', id);
      url.searchParams.set('name', name);
      navigator.clipboard.writeText(url.toString())
        .then(() => UI.showSuccess('Link copied!'))
        .catch(() => UI.showError('Could not copy link.'));
    });

    return { open, close };
  })();


  // ─────────────────────────────────────────
  // ─────────────────────────────────────────
  // 8. MY RESTAURANTS MANAGER
  // ─────────────────────────────────────────
  const MyListManager = (() => {
    let _map     = null;
    let _active  = false;
    let _entries = []; // [{ marker, key }]

    function _buildIcon(rating) {
      if (rating != null) {
        const cls = rating >= 8 ? 'pin-high' : rating >= 4 ? 'pin-mid' : 'pin-low';
        return L.divIcon({
          className: '',
          html: `<div class="map-pin ${cls} pin-rated"><span class="pin-rating">${rating}</span></div>`,
          iconSize: [34, 44], iconAnchor: [17, 44], popupAnchor: [0, -46],
        });
      }
      return L.divIcon({
        className: '',
        html: `<div class="map-pin pin-bookmarked pin-rated"><span class="pin-rating" style="font-size:13px">★</span></div>`,
        iconSize: [34, 44], iconAnchor: [17, 44], popupAnchor: [0, -46],
      });
    }

    function _addPins(cuisine) {
      if (!_map) return;
      const cuisineLc = cuisine ? cuisine.toLowerCase() : '';

      Object.entries(Storage.getAll()).forEach(([key, data]) => {
        if (!data.lat || !data.lon) return;
        if (cuisineLc && !(data.cuisine || []).some(c => c.toLowerCase() === cuisineLc)) return;
        const [type, id] = key.split('/');
        const marker = L.marker([data.lat, data.lon], { icon: _buildIcon(data.rating), zIndexOffset: 510 });
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          RatingPanel.open({ type, id, name: data.name, cuisine: data.cuisine || [], lat: data.lat, lon: data.lon });
        });
        marker.addTo(_map);
        _entries.push({ marker, key });
      });

      const ratedKeys = new Set(Object.keys(Storage.getAll()));
      Object.entries(BookmarkStorage.getAll()).forEach(([key, data]) => {
        if (ratedKeys.has(key)) return;
        if (!data.lat || !data.lon) return;
        if (cuisineLc && !(data.cuisine || []).some(c => c.toLowerCase() === cuisineLc)) return;
        const [type, id] = key.split('/');
        const marker = L.marker([data.lat, data.lon], { icon: _buildIcon(null), zIndexOffset: 505 });
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          RatingPanel.open({ type, id, name: data.name, cuisine: data.cuisine || [], lat: data.lat, lon: data.lon });
        });
        marker.addTo(_map);
        _entries.push({ marker, key });
      });
    }

    function _removePins() {
      _entries.forEach(e => e.marker.remove());
      _entries = [];
    }

    function refresh() {
      if (!_active) return;
      _removePins();
      _addPins(FilterBar.getCuisine());
    }

    function filter(cuisine) {
      if (!_active) return;
      _removePins();
      _addPins(cuisine);
    }

    function setActive(active) {
      if (active === _active) return;
      _active = active;
      _active ? _addPins(FilterBar.getCuisine()) : _removePins();
    }

    function init(map) { _map = map; }

    return { init, refresh, filter, setActive };
  })();

  // 9. FILTER BAR
  // ─────────────────────────────────────────
  const FilterBar = (() => {
    const AREA_COORDS = {
      'Soho':            [51.5137, -0.1337],
      'Covent Garden':   [51.5117, -0.1240],
      'Mayfair':         [51.5101, -0.1476],
      'Marylebone':      [51.5200, -0.1558],
      'Fitzrovia':       [51.5183, -0.1389],
      'Clerkenwell':     [51.5230, -0.1073],
      'Shoreditch':      [51.5227, -0.0793],
      'Dalston':         [51.5461, -0.0756],
      'Hackney':         [51.5450, -0.0553],
      'Bethnal Green':   [51.5270, -0.0590],
      'Canary Wharf':    [51.5051, -0.0207],
      'Greenwich':       [51.4826, -0.0077],
      'Borough':         [51.5014, -0.0904],
      'Bermondsey':      [51.4982, -0.0640],
      'Peckham':         [51.4736, -0.0688],
      'Brixton':         [51.4613, -0.1156],
      'Clapham':         [51.4621, -0.1388],
      'Chelsea':         [51.4875, -0.1687],
      'Kensington':      [51.4992, -0.1916],
      'Notting Hill':    [51.5109, -0.2023],
      'Hammersmith':     [51.4927, -0.2239],
      'Richmond':        [51.4613, -0.3037],
      'Wimbledon':       [51.4224, -0.2076],
      'Camden':          [51.5390, -0.1426],
      'Islington':       [51.5362, -0.1033],
      'Stoke Newington': [51.5607, -0.0737],
    };

    let _selectedArea    = '';
    let _selectedCuisine = '';
    let _selectedKind    = '';
    let _onArea    = null;
    let _onCuisine = null;
    let _onKind    = null;

    function _highlight(filterType, value) {
      document.querySelectorAll(`.fs-chip[data-filter="${filterType}"]`).forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.value === value);
      });
    }

    function init(onAreaFn, onCuisineFn, onKindFn) {
      _onArea    = onAreaFn;
      _onCuisine = onCuisineFn;
      _onKind    = onKindFn;

      document.querySelectorAll('.fs-chip[data-filter="kind"]').forEach(btn => {
        btn.addEventListener('click', () => {
          _selectedKind = btn.dataset.value;
          _highlight('kind', _selectedKind);
          _onKind(_selectedKind);
        });
      });

      document.querySelectorAll('.fs-chip[data-filter="area"]').forEach(btn => {
        btn.addEventListener('click', () => {
          _selectedArea = btn.dataset.value;
          _highlight('area', _selectedArea);
          if (_selectedArea && AREA_COORDS[_selectedArea]) {
            const [lat, lon] = AREA_COORDS[_selectedArea];
            _onArea(lat, lon);
          } else {
            _onArea(null, null);
          }
        });
      });

      document.querySelectorAll('.fs-chip[data-filter="cuisine"]').forEach(btn => {
        btn.addEventListener('click', () => {
          _selectedCuisine = btn.dataset.value;
          _highlight('cuisine', _selectedCuisine);
          _onCuisine(_selectedCuisine);
        });
      });
    }

    function getCuisine() { return _selectedCuisine; }
    function getArea()    { return _selectedArea; }
    function getKind()    { return _selectedKind; }

    return { init, getCuisine, getArea, getKind };
  })();

  // ─────────────────────────────────────────
  // 10. CREATOR LAYERS (YouTube reviewers)
  // ─────────────────────────────────────────
  // To add a creator: add an entry here and data/<key>.json from the pipeline.
  // `draft: true` shows a creator only on this computer or your Wi-Fi (local preview), so their
  // picks can be checked before they go on the live site.
  const PREVIEW = /^(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)$/.test(location.hostname);
  const CREATORS = [
    {
      key: 'topjaw',
      name: 'Topjaw',
      avatar: 'images/topjaw.jpg',
      colour: '#0e7490',
      textColour: '#0e7490',
      zIndexOffset: 490,
    },
    {
      key: 'tod',
      name: 'Tod',
      avatar: 'images/tod.jpg',
      colour: '#D4AC0D',
      textColour: '#A07D00',
      zIndexOffset: 500,
    },
    {
      key: 'bitetwice',
      name: 'Bite Twice',
      avatar: 'images/bitetwice.jpg',
      colour: '#D35400',
      textColour: '#B34700',
      zIndexOffset: 480,
    },
  ].filter(c => !c.draft || PREVIEW);

  // Best overall score, falling back to the highest single-video score
  function creatorRating(restaurant) {
    const best = normalizeRating(restaurant.bestRating, restaurant.bestRatingOutOf);
    if (best != null) return best;
    const ratings = restaurant.mentions
      .map(m => normalizeRating(m.rating, m.rating_out_of))
      .filter(r => r != null);
    return ratings.length ? Math.max(...ratings) : null;
  }

  // Nearby creator pins merge into a numbered bubble until street level.
  // The bubble takes the creator's colour when every pin in it is theirs.
  function creatorPinGroup() {
    return L.markerClusterGroup({
      maxClusterRadius: 45,
      disableClusteringAtZoom: CONFIG.minZoomForAllPlaces,
      showCoverageOnHover: false,
      iconCreateFunction(cluster) {
        const children = cluster.getAllChildMarkers();
        const colours = new Set(children.map(m => m.options.creatorColour));
        const colour = colours.size === 1 ? [...colours][0] : 'var(--primary)';
        const count = children.length;
        const size = count < 10 ? 34 : count < 50 ? 40 : 46;
        return L.divIcon({
          className: '',
          html: `<div class="creator-cluster" style="--cluster-colour:${colour};width:${size}px;height:${size}px">${count}</div>`,
          iconSize: [size, size],
        });
      },
    });
  }

  // Every creator's picks, loaded once. Picks the pipeline linked to places.json share
  // that place's ID; the rest get one from their name and rough location, so two
  // creators reviewing the same unlinked restaurant still share a card.
  const CreatorPicks = (() => {
    const byPlace = new Map(); // place id → [{ creator, restaurant }]
    let _loading  = null;

    function placeIdFor(restaurant) {
      if (restaurant.placeId) return restaurant.placeId;
      const name = restaurant.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return `pick-${name}-${restaurant.lat.toFixed(2)},${restaurant.lon.toFixed(2)}`;
    }

    function load() {
      // Resolves to { tod: [restaurant…], topjaw: […] }
      _loading = _loading || Promise.all(CREATORS.map(async creator => {
        try {
          const res = await fetch(`data/${creator.key}.json`);
          if (!res.ok) throw new Error(`http_${res.status}`);
          const restaurants = await res.json();
          restaurants.forEach(restaurant => {
            restaurant.id = placeIdFor(restaurant);
            if (!byPlace.has(restaurant.id)) byPlace.set(restaurant.id, []);
            byPlace.get(restaurant.id).push({ creator, restaurant });
          });
          return [creator.key, restaurants];
        } catch (e) {
          console.error(`[SCRAN] ${creator.key} data failed:`, e);
          UI.showError(`Could not load ${creator.name} restaurants.`);
          return [creator.key, []];
        }
      })).then(Object.fromEntries);
      return _loading;
    }

    function forPlace(id) {
      return byPlace.get(id) || [];
    }

    return { load, forPlace };
  })();

  // Opens the place card for a creator pick: the place from places.json when linked,
  // otherwise one made from the pick itself
  async function openCreatorPick(restaurant) {
    try { await Places.load(); } catch { /* fall back to the pick's own details */ }
    const place = Places.get(restaurant.id);
    RatingPanel.open(place ? placeRef(place) : {
      type: PLACE_TYPE, id: restaurant.id, name: restaurant.name,
      cuisine: [], lat: restaurant.lat, lon: restaurant.lon, address: restaurant.location,
    });
  }

  // What each creator said about a place, for the top of the place card
  function creatorVerdictsHtml(picks) {
    return picks.map(({ creator, restaurant }) => {
      const rating = creatorRating(restaurant);
      const mentions = restaurant.mentions.map(m => {
        // Other platforms can supply `url`; YouTube picks only have the video ID
        // `at` is the moment in the video the place comes up, in seconds
        const url = m.url || `https://youtube.com/watch?v=${encodeURIComponent(m.videoId)}${m.at ? `&t=${m.at}s` : ''}`;
        const mentionRating = m.rating != null
          ? `<div class="creator-mention-rating">&#11088; ${normalizeRating(m.rating, m.rating_out_of)}/10</div>` : '';
        const dishes = m.dishes?.length
          ? `<div class="creator-mention-dishes">Try: ${m.dishes.map(escapeHtml).join(', ')}</div>` : '';
        return `<div class="creator-mention">
          <div class="creator-mention-title">
            ${m.sponsored ? '<span class="creator-mention-ad" title="Paid partnership or sponsored video">Ad</span>' : ''}
            <a href="${escapeHtml(url)}" target="_blank" rel="noopener">&#9654; ${escapeHtml(m.videoTitle)}</a>
          </div>
          ${m.moved ? '<div class="creator-mention-moved">Moved since this video: the map shows where it is now</div>' : ''}
          ${mentionRating}
          <div class="creator-mention-notes">${escapeHtml(m.notes)}</div>
          ${dishes}
        </div>`;
      }).join('');
      return `<div class="creator-verdict" style="--creator-colour:${creator.colour};--creator-text:${creator.textColour}">
        <div class="creator-verdict-head">
          <img class="creator-verdict-avatar" src="${creator.avatar}" alt="">
          <span class="creator-verdict-name">${escapeHtml(creator.name)}</span>
          ${rating != null ? `<span class="creator-rating-badge">&#11088; ${rating}/10</span>` : ''}
        </div>
        ${mentions}
      </div>`;
    }).join('');
  }

  // A toggleable set of map pins for one creator
  function CreatorLayer(creator) {
    let _pins     = null; // cluster group shared by all creators
    let _onToggle = null;
    let _active   = false;
    let _entries  = [];   // [{ marker, restaurant }]

    function _icon(restaurant) {
      const rating = creatorRating(restaurant);
      const badge = rating != null ? `<span class="pin-score-badge">${rating}</span>` : '';
      return L.divIcon({
        className: '',
        html: `<div class="map-pin pin-creator pin-rated" style="--creator-colour:${creator.colour}"><img class="pin-avatar" src="${creator.avatar}" alt="${creator.name}">${badge}</div>`,
        iconSize: [34, 44],
        iconAnchor: [17, 44],
        popupAnchor: [0, -46],
      });
    }

    async function _addPins() {
      const restaurants = (await CreatorPicks.load())[creator.key];
      if (!_active || _entries.length) return; // toggled off, or already added, while loading
      restaurants.forEach(restaurant => {
        const marker = L.marker([restaurant.lat, restaurant.lon], {
          icon: _icon(restaurant),
          zIndexOffset: creator.zIndexOffset,
          creatorColour: creator.colour, // read by creatorPinGroup's bubbles
        });
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          openCreatorPick(restaurant);
        });
        _entries.push({ marker, restaurant });
      });
      _pins.addLayers(_entries.map(e => e.marker));
    }

    function _removePins() {
      _pins.removeLayers(_entries.map(e => e.marker));
      _entries = [];
    }

    function filter(area, cuisine) {
      if (!_active) return;
      const areaLc    = area ? area.toLowerCase() : '';
      const cuisineLc = cuisine ? cuisine.toLowerCase() : '';
      _entries.forEach(({ marker, restaurant }) => {
        const loc  = (restaurant.location || '').toLowerCase();
        const text = [restaurant.name, restaurant.location,
          ...restaurant.mentions.map(m => m.notes || '')].join(' ').toLowerCase();
        const okArea    = !areaLc    || loc.includes(areaLc);
        const okCuisine = !cuisineLc || text.includes(cuisineLc);
        if (okArea && okCuisine) {
          if (!_pins.hasLayer(marker)) _pins.addLayer(marker);
        } else {
          if (_pins.hasLayer(marker)) _pins.removeLayer(marker);
        }
      });
    }

    async function _setActive(active) {
      _active = active;
      if (_active) {
        await _addPins();
        filter(FilterBar.getArea(), FilterBar.getCuisine());
      } else {
        _removePins();
      }
      _onToggle();
    }

    // Creator picks are SCRAN's headline, so they start switched on (Views switches them).
    // onToggle runs after the pins change, so the map can hide or show the plain dots under them.
    function init(pins, onToggle) {
      _pins = pins;
      _onToggle = onToggle;
      _setActive(true);
    }

    return { key: creator.key, init, filter, setActive: _setActive, isActive: () => _active };
  }

  // ─────────────────────────────────────────
  // 11. BASE MAP (Google Map Tiles API, Esri if Google is unavailable)
  // ─────────────────────────────────────────
  const BaseMap = (() => {
    const API         = 'https://tile.googleapis.com';
    const SESSION_KEY = 'scran-google-tile-session';

    // Muted grey map so the coloured place dots stand out
    const STYLES = [
      { stylers: [{ saturation: -100 }, { lightness: 40 }] },
      { featureType: 'poi', stylers: [{ visibility: 'off' }] },
      { featureType: 'poi.park', stylers: [{ visibility: 'on' }, { color: '#e4e9de' }] },
      { featureType: 'poi.park', elementType: 'labels', stylers: [{ visibility: 'off' }] },
      { featureType: 'water', stylers: [{ color: '#d5dee5' }] },
      { featureType: 'transit', stylers: [{ visibility: 'simplified' }] },
    ];

    const MAX_FAILED_TILES = 5; // in a row, before giving up on the current tiles

    let _map = null;
    let _copyright = '';
    let _logo = null;
    let _onZoom = null; // refreshes the copyright for the current session

    // Google sessions last two weeks; reuse one until a day before it expires
    async function _session(forceNew = false) {
      const hiDpi = window.devicePixelRatio > 1;
      const request = {
        mapType: 'roadmap', language: 'en-GB', region: 'GB',
        scale: hiDpi ? 'scaleFactor2x' : 'scaleFactor1x', highDpi: hiDpi,
        styles: STYLES,
      };
      const requestKey = JSON.stringify(request);
      try {
        const cached = forceNew ? null : JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
        if (cached?.requestKey === requestKey && cached.expiry * 1000 > Date.now() + 864e5) return cached.session;
      } catch { /* ignore */ }

      const resp = await fetch(`${API}/v1/createSession?key=${CONFIG.googleMapsKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestKey,
      });
      if (!resp.ok) throw new Error(`createSession http_${resp.status}`);
      const { session, expiry } = await resp.json();
      try { localStorage.setItem(SESSION_KEY, JSON.stringify({ session, expiry, requestKey })); } catch { /* ignore */ }
      return session;
    }

    // Google requires the copyright text for the visible area
    async function _updateCopyright(session) {
      const b = _map.getBounds();
      const params = new URLSearchParams({
        session, key: CONFIG.googleMapsKey, zoom: _map.getZoom(),
        north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest(),
      });
      try {
        const { copyright } = await (await fetch(`${API}/tile/v1/viewport?${params}`)).json();
        if (copyright && copyright !== _copyright) {
          if (_copyright) _map.attributionControl.removeAttribution(_copyright);
          _copyright = copyright;
          _map.attributionControl.addAttribution(copyright);
        }
      } catch { /* keep the previous text */ }
    }

    function _addGoogleLogo() {
      if (_logo) return;
      const Logo = L.Control.extend({
        onAdd() {
          const img = L.DomUtil.create('img', 'google-logo');
          img.src = 'images/google-logo.svg';
          img.alt = 'Google';
          return img;
        },
      });
      _logo = new Logo({ position: 'bottomleft' }).addTo(_map);
    }

    function _removeGoogleBranding() {
      if (_logo) { _logo.remove(); _logo = null; }
      if (_copyright) { _map.attributionControl.removeAttribution(_copyright); _copyright = ''; }
      if (_onZoom) { _map.off('zoomend', _onZoom); _onZoom = null; }
    }

    function _addEsri() {
      const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
      L.tileLayer(`${esri}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
        attribution: 'Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxNativeZoom: 16, maxZoom: 20,
      }).addTo(_map);
      L.tileLayer(`${esri}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, {
        maxNativeZoom: 16, maxZoom: 20,
      }).addTo(_map);
    }

    // Adds Google tiles; calls onFail if tiles keep failing (expired session, daily cap reached…)
    function _addGoogle(session, onFail) {
      let failedInARow = 0;
      const layer = L.tileLayer(`${API}/v1/2dtiles/{z}/{x}/{y}?session=${session}&key=${CONFIG.googleMapsKey}`, {
        maxZoom: 20,
      });
      layer.on('tileload', () => { failedInARow = 0; });
      layer.on('tileerror', () => {
        if (++failedInARow === MAX_FAILED_TILES) {
          _map.removeLayer(layer);
          onFail();
        }
      });
      layer.addTo(_map);
      _addGoogleLogo();
      if (_onZoom) _map.off('zoomend', _onZoom);
      _onZoom = () => _updateCopyright(session);
      _map.on('zoomend', _onZoom);
      _onZoom();
    }

    function _useEsri(reason) {
      console.warn('[SCRAN] Google map unavailable, using Esri:', reason);
      try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
      _removeGoogleBranding();
      _addEsri();
    }

    // Try the saved Google session, then a fresh one, then fall back to Esri
    let _started = null;
    function init(map) {
      _map = map;
      _started = _start();
    }

    async function _start() {
      try {
        _addGoogle(await _session(), async () => {
          try {
            _addGoogle(await _session(true), () => _useEsri('tiles failing'));
          } catch (e) {
            _useEsri(e.message);
          }
        });
      } catch (e) {
        _useEsri(e.message);
      }
    }

    // Whether the Google map is showing, once the first session request has finished
    async function isGoogle() {
      await _started;
      return !!_logo;
    }

    return { init, isGoogle };
  })();

  // ─────────────────────────────────────────
  // 11b. SOCIAL (profiles and follows in Supabase)
  // ─────────────────────────────────────────
  // What the Following view shows: your own ratings and saved places, the people you follow
  // and the creators you follow. Signed out, followed creators are kept in this browser only.
  const FOLLOWING = {
    me: true,     // your ratings and saved places (MyListManager)
    people: [],   // profiles you follow: [{ id, name, avatar_url }]
    creators: [], // creator keys you follow, e.g. 'tod'
  };

  const Social = (() => {
    const LOCAL_CREATORS = 'scran-following';
    const PROFILE = 'id, name, avatar_url';
    const _user = () => Auth.currentUser();
    const _warn = ({ error }) => { if (error) cloudError(error); };

    function _localCreators() {
      try { return JSON.parse(localStorage.getItem(LOCAL_CREATORS)) || []; } catch { return []; }
    }
    function _saveLocalCreators() {
      try { localStorage.setItem(LOCAL_CREATORS, JSON.stringify(FOLLOWING.creators)); } catch {}
    }

    // Who you follow. Creators followed while signed out join the account at sign-in.
    async function load() {
      const user = _user();
      const local = _localCreators().filter(k => CREATORS.some(c => c.key === k));
      if (!user) {
        FOLLOWING.people = [];
        FOLLOWING.creators = local;
        return;
      }
      const { data, error } = await sbClient.from('follows')
        .select(`creator_key, followee:profiles!follows_followee_id_fkey(${PROFILE})`)
        .eq('follower_id', user.id).order('created_at');
      if (error) { cloudError(error); return; }
      const creators = data.filter(f => f.creator_key).map(f => f.creator_key);
      const newOnes = local.filter(k => !creators.includes(k));
      if (newOnes.length) {
        await sbClient.from('follows').insert(newOnes.map(k => ({ follower_id: user.id, creator_key: k }))).then(_warn);
      }
      FOLLOWING.creators = [...creators, ...newOnes].filter(k => CREATORS.some(c => c.key === k));
      FOLLOWING.people = data.filter(f => f.followee).map(f => f.followee);
      try { localStorage.removeItem(LOCAL_CREATORS); } catch {}
    }

    async function setCreator(key, follow) {
      FOLLOWING.creators = FOLLOWING.creators.filter(k => k !== key).concat(follow ? [key] : []);
      const user = _user();
      if (!user) return _saveLocalCreators();
      const q = sbClient.from('follows');
      await (follow ? q.insert({ follower_id: user.id, creator_key: key })
                    : q.delete().eq('follower_id', user.id).eq('creator_key', key)).then(_warn);
    }

    // `person` is a profile ({ id, name, avatar_url })
    async function setPerson(person, follow) {
      const user = _user();
      if (!user) { UI.showError('Sign in to follow people.'); return false; }
      FOLLOWING.people = FOLLOWING.people.filter(p => p.id !== person.id).concat(follow ? [person] : []);
      const q = sbClient.from('follows');
      await (follow ? q.insert({ follower_id: user.id, followee_id: person.id })
                    : q.delete().eq('follower_id', user.id).eq('followee_id', person.id)).then(_warn);
      return true;
    }

    const isFollowing = id => FOLLOWING.people.some(p => p.id === id);

    // Other people on SCRAN, newest first, that you don't follow yet; `text` narrows by name
    async function findPeople(text = '') {
      let q = sbClient.from('profiles').select(PROFILE).order('created_at', { ascending: false }).limit(10);
      if (text) q = q.ilike('name', `%${text.replace(/[%_,()]/g, ' ')}%`);
      const { data } = await q;
      const me = _user()?.id;
      return (data || []).filter(p => p.id !== me && (text || !isFollowing(p.id)));
    }

    async function profile(id) {
      const [{ data: person }, { data: ratings }, followers, following] = await Promise.all([
        sbClient.from('profiles').select(PROFILE).eq('id', id).maybeSingle(),
        sbClient.from('ratings').select('osm_type, osm_id, restaurant_name, lat, lon, cuisine, rating, note').eq('user_id', id),
        sbClient.from('follows').select('*', { count: 'exact', head: true }).eq('followee_id', id),
        sbClient.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', id).not('followee_id', 'is', null),
      ]);
      return { person, ratings: ratings || [], followers: followers.count || 0, following: following.count || 0 };
    }

    return { load, setCreator, setPerson, isFollowing, findPeople, profile };
  })();

  // Small round photo for a person, or their initial if they have none
  function personAvatar(p, cls) {
    return p.avatar_url
      ? `<img class="${cls}" src="${escapeHtml(p.avatar_url)}" alt="" referrerpolicy="no-referrer">`
      : `<div class="${cls} person-initial">${escapeHtml((p.name || '?')[0].toUpperCase())}</div>`;
  }

  // ─────────────────────────────────────────
  // 11c. PEOPLE LAYER (ratings by the people you follow)
  // ─────────────────────────────────────────
  const PeopleLayer = (() => {
    let _map     = null;
    let _active  = false;
    let _byPlace = new Map(); // 'type/id' → [{ person, rating, note, name, lat, lon, cuisine, type, id }]
    let _markers = [];

    async function load() {
      const people = new Map(FOLLOWING.people.map(p => [p.id, p]));
      _byPlace = new Map();
      if (people.size) {
        const { data, error } = await sbClient.from('ratings')
          .select('user_id, osm_type, osm_id, restaurant_name, lat, lon, cuisine, rating, note')
          .in('user_id', [...people.keys()]);
        if (error) cloudError(error);
        (data || []).forEach(r => {
          if (!r.lat || !r.lon) return;
          const key = `${r.osm_type}/${r.osm_id}`;
          if (!_byPlace.has(key)) _byPlace.set(key, []);
          _byPlace.get(key).push({ person: people.get(r.user_id), rating: r.rating, note: r.note,
            name: r.restaurant_name, lat: r.lat, lon: r.lon, cuisine: r.cuisine || [], type: r.osm_type, id: r.osm_id });
        });
      }
      _draw();
    }

    function _icon(entries) {
      const first = entries[0];
      const more = entries.length > 1 ? `<span class="pin-people-count">+${entries.length - 1}</span>` : '';
      return L.divIcon({
        className: '',
        html: `<div class="map-pin pin-creator pin-rated" style="--creator-colour:var(--primary)">${personAvatar(first.person, 'pin-avatar')}<span class="pin-score-badge">${first.rating}</span>${more}</div>`,
        iconSize: [34, 44], iconAnchor: [17, 44], popupAnchor: [0, -46],
      });
    }

    function _draw() {
      _markers.forEach(m => m.remove());
      _markers = [];
      if (!_active || !_map) return;
      _byPlace.forEach(entries => {
        const { type, id, name, lat, lon, cuisine } = entries[0];
        const marker = L.marker([lat, lon], { icon: _icon(entries), zIndexOffset: 515 });
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          const place = type === PLACE_TYPE ? Places.get(id) : null;
          RatingPanel.open(place ? placeRef(place) : { type, id, name, cuisine, lat, lon });
        });
        marker.addTo(_map);
        _markers.push(marker);
      });
    }

    function setActive(active) { _active = active; _draw(); }
    function forPlace(type, id) { return _byPlace.get(`${type}/${id}`) || []; }
    function init(map) { _map = map; }

    return { init, load, setActive, forPlace };
  })();

  // What the people you follow said, on the place card
  function peopleVerdictsHtml(entries) {
    if (!entries.length) return '';
    return `<div class="people-verdicts"><div class="people-verdicts-title">People you follow</div>${entries.map(e => `
      <div class="person-verdict" data-person="${e.person.id}">
        ${personAvatar(e.person, 'person-verdict-avatar')}
        <div class="person-verdict-text">
          <div class="person-verdict-name">${escapeHtml(e.person.name)}</div>
          ${e.note ? `<div class="person-verdict-note">${escapeHtml(e.note)}</div>` : ''}
        </div>
        <div class="profile-score ${e.rating >= 7 ? 'score-high' : e.rating >= 4 ? 'score-mid' : 'score-low'}">${e.rating}</div>
      </div>`).join('')}</div>`;
  }

  // ─────────────────────────────────────────
  // 11d. VIEWS (Following / Explore bottom nav and its sheet)
  // ─────────────────────────────────────────
  // Explore shows the creators you switch on in its sheet; Following shows what's in FOLLOWING.
  const Views = (() => {
    const buttons = document.querySelectorAll('#bottom-nav button');
    const emptyEl = document.getElementById('following-empty');
    const sheet   = document.getElementById('sheet');
    const toggle  = document.getElementById('sheet-toggle');
    const body    = document.getElementById('sheet-body');

    let _layers    = [];
    let _view      = 'explore';
    let _exploreOn = new Set(CREATORS.map(c => c.key)); // creators switched on in Explore
    let _counts    = {};                                // picks per creator, once loaded
    let _suggested = null;                              // people to follow, once loaded
    let _search    = { text: '', results: null };       // Explore's people search, kept across redraws
    let _ready     = false;

    function _mineCount() {
      return Storage.count() + Object.keys(BookmarkStorage.getAll()).length;
    }

    function _followingIsEmpty() {
      return !(FOLLOWING.me && _mineCount()) && !FOLLOWING.people.length && !FOLLOWING.creators.length;
    }

    const _switch = (on, attrs) =>
      `<button class="sheet-switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" ${attrs}></button>`;

    function _row({ avatar, colour, name, sub, person }, actions) {
      return `<div class="sheet-row" style="--creator-colour:${colour}"${person ? ` data-person="${person}"` : ''}>
        ${avatar}
        <div class="sheet-row-text">
          <div class="sheet-row-name">${escapeHtml(name)}</div>
          <div class="sheet-row-sub">${sub}</div>
        </div>
        ${actions}
      </div>`;
    }

    function _creatorRow(c, actions) {
      const n = _counts[c.key];
      return _row({ avatar: `<img class="sheet-avatar" src="${c.avatar}" alt="">`, colour: c.colour,
        name: c.name, sub: n == null ? '' : `${n} picks` }, actions);
    }

    function _personRow(p) {
      const followed = Social.isFollowing(p.id);
      return _row({ avatar: personAvatar(p, 'sheet-avatar'), colour: 'var(--primary)', name: p.name,
        sub: 'View profile', person: p.id },
        `<button class="sheet-btn${followed ? '' : ' follow'}" data-person-follow="${p.id}">${followed ? 'Unfollow' : 'Follow'}</button>`);
    }

    // People shown in the sheet, so a Follow button can find the profile it belongs to
    const _shown = new Map();
    const _people = list => list.map(p => { _shown.set(p.id, p); return _personRow(p); }).join('');

    function _searchResultsHtml() {
      if (!_search.text || !_search.results) return '';
      return _people(_search.results) || '<div class="sheet-empty">No one by that name yet.</div>';
    }

    function _render() {
      if (_view === 'explore') {
        body.innerHTML = '<div class="sheet-title">Creators</div>' + CREATORS.map(c => {
          const followed = FOLLOWING.creators.includes(c.key);
          return _creatorRow(c,
            `<button class="sheet-btn${followed ? ' followed' : ''}" data-follow="${c.key}">${followed ? 'Following' : 'Follow'}</button>` +
            _switch(_exploreOn.has(c.key), `data-creator="${c.key}" aria-label="Show ${escapeHtml(c.name)} on the map"`));
        }).join('')
          + '<div class="sheet-title">People</div>'
          + (Auth.currentUser()
            ? `<input id="people-search" type="search" placeholder="Search people on SCRAN by name" autocomplete="off"
                value="${escapeHtml(_search.text)}">
              <div id="people-results">${_searchResultsHtml()}</div>`
            : '<div class="sheet-empty">Sign in to search for people and follow them. <button class="sheet-link" data-signin>Sign in</button></div>');
        return;
      }
      const signedIn = !!Auth.currentUser();
      const creators = CREATORS.filter(c => FOLLOWING.creators.includes(c.key));
      body.innerHTML = '<div class="sheet-title">You</div>'
        + _row({ avatar: '<div class="sheet-avatar sheet-avatar-me">&#x2605;</div>', colour: 'var(--primary)',
            name: 'Your places', sub: `${_mineCount()} rated or saved` },
            _switch(FOLLOWING.me, 'data-me aria-label="Show your places on the map"'))
        + '<div class="sheet-title">People</div>'
        + (signedIn
          ? (_people(FOLLOWING.people) || '<div class="sheet-empty">You&rsquo;re not following anyone yet. Search for people in Explore.</div>')
          : '<div class="sheet-empty">Sign in to follow people and see their ratings on the map.</div>')
        + '<div class="sheet-title">Creators</div>'
        + (creators.map(c => _creatorRow(c, `<button class="sheet-btn" data-follow="${c.key}">Unfollow</button>`)).join('')
          || '<div class="sheet-empty">Tap Follow next to a creator in Explore.</div>')
        + (signedIn ? `<div class="sheet-title">Suggested</div>
            <div id="people-suggested">${_suggested == null ? '<div class="sheet-empty">Loading…</div>'
              : _people(_suggested.filter(p => !Social.isFollowing(p.id)))
                || '<div class="sheet-empty">No suggestions yet: you&rsquo;ll see people here as they join SCRAN.</div>'}</div>` : '');
      if (signedIn && _suggested == null) {
        Social.findPeople().then(list => { _suggested = list; if (_view === 'following') _render(); });
      }
    }

    // Switch the map's layers to match the current view, then redraw the sheet
    function refresh() {
      if (!_ready) return;
      const following = _view === 'following';
      buttons.forEach(b => b.classList.toggle('active', b.dataset.view === _view));
      _layers.forEach(layer => {
        const on = following ? FOLLOWING.creators.includes(layer.key) : _exploreOn.has(layer.key);
        if (on !== layer.isActive()) layer.setActive(on);
      });
      MyListManager.setActive(following && FOLLOWING.me);
      PeopleLayer.setActive(following);
      emptyEl.hidden = !(following && !sheet.classList.contains('open') && _followingIsEmpty());
      _render();
    }

    function show(view) {
      if (view === 'following' && !requireSignIn('Sign in to follow people and creators, and see their places.')) return;
      _view = view;
      refresh();
    }

    function setSheet(open) {
      if (open === sheet.classList.contains('open')) return;
      sheet.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open);
      refresh();
    }

    // After sign-in or sign-out: reload who you follow and their ratings
    async function reload() {
      _suggested = null;
      await Social.load();
      await PeopleLayer.load();
      refresh();
    }

    let _searchTimer = null;

    function init(creatorLayers) {
      _layers = creatorLayers;
      _ready = true;
      buttons.forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
      toggle.addEventListener('click', () => setSheet(!sheet.classList.contains('open')));
      body.addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        const row = e.target.closest('[data-person]');
        if (!b && row) { ProfilePanel.open(row.dataset.person); return; }
        if (!b) return;
        const { creator, follow, personFollow } = b.dataset;
        if ('signin' in b.dataset) { AuthDialog.open(); return; }
        if (follow && !requireSignIn('Sign in to follow creators.')) return;
        if (creator) _exploreOn.has(creator) ? _exploreOn.delete(creator) : _exploreOn.add(creator);
        else if (follow) await Social.setCreator(follow, !FOLLOWING.creators.includes(follow));
        else if ('me' in b.dataset) FOLLOWING.me = !FOLLOWING.me;
        else if (personFollow) {
          const person = _shown.get(personFollow);
          if (!await Social.setPerson(person, !Social.isFollowing(person.id))) return;
          await PeopleLayer.load();
        }
        refresh();
      });
      body.addEventListener('input', (e) => {
        if (e.target.id !== 'people-search') return;
        clearTimeout(_searchTimer);
        const text = e.target.value.trim();
        _search = { text, results: null };
        _searchTimer = setTimeout(async () => {
          const list = text ? await Social.findPeople(text) : null;
          if (_search.text !== text) return; // typed more while this was loading
          _search.results = list;
          const results = document.getElementById('people-results');
          if (results) results.innerHTML = _searchResultsHtml();
        }, 300);
      });
      CreatorPicks.load().then(picks => {
        _counts = Object.fromEntries(Object.entries(picks).map(([k, list]) => [k, list.length]));
        _render();
      });
      reload();
    }

    return { init, show, setSheet, refresh, reload };
  })();

  // ─────────────────────────────────────────
  // 12. APP (main controller)
  // ─────────────────────────────────────────
  const App = (() => {
    const creatorLayers = CREATORS.map(CreatorLayer);
    let _map          = null;
    let _pendingShare = null; // { type, id, name, lat, lon } — open once places have loaded

    // A creator pin already marks this place, so it needs no dot or pin of its own
    function _hasCreatorPin(id) {
      return CreatorPicks.forPlace(id).some(({ creator }) =>
        creatorLayers.find(layer => layer.key === creator.key).isActive());
    }

    async function _showPlacesInView() {
      try {
        UI.setLoading(true);
        await Places.load();
      } catch (e) {
        console.error('[SCRAN] places failed to load:', e);
        UI.setLoading(false);
        UI.showError('Could not load restaurants — check your connection and try again.');
        return;
      }
      // Zoomed out, the 50k places would bury the creator picks: show only ones you've rated or saved
      const zoomedIn = _map.getZoom() >= CONFIG.minZoomForAllPlaces;
      let places = Places.query(_map.getBounds(), { kind: FilterBar.getKind(), cuisine: FilterBar.getCuisine() })
        .filter(p => !_hasCreatorPin(p.id));
      if (!zoomedIn) places = places.filter(p => Storage.get(PLACE_TYPE, p.id) || BookmarkStorage.get(PLACE_TYPE, p.id));
      MarkerManager.show(places);
      UI.setLoading(false, zoomedIn ? `${places.length.toLocaleString()} places in view` : 'Zoom in to see all places');
      _openPendingShare();
    }

    function _openPendingShare() {
      if (!_pendingShare) return;
      const { type, id, name, lat, lon } = _pendingShare;
      _pendingShare = null;
      const place = type === PLACE_TYPE ? Places.get(id) : null;
      RatingPanel.open(place ? placeRef(place) : { type, id, name, cuisine: [], lat, lon });
    }

    function _handleShareLink() {
      const params = new URLSearchParams(window.location.search);
      const lat  = parseFloat(params.get('lat'));
      const lon  = parseFloat(params.get('lon'));
      const type = params.get('type');
      const id   = params.get('id');
      const name = params.get('name') || 'Restaurant';
      if (!lat || !lon || !type || !id) return;
      _pendingShare = { type, id, name, lat, lon };
      _map.setView([lat, lon], 16);
    }

    function init() {
      _map = L.map('map', {
        center: CONFIG.mapCenter,
        zoom: CONFIG.defaultZoom,
        minZoom: CONFIG.minZoom,
        maxZoom: 20, // same as the base map layers
        maxBounds: CONFIG.m25Bounds,
        maxBoundsViscosity: 1.0,
        zoomControl: false,
      });

      document.getElementById('zoom-in').addEventListener('click', () => _map.zoomIn());
      document.getElementById('zoom-out').addEventListener('click', () => _map.zoomOut());

      BaseMap.init(_map);
      _map.attributionControl.addAttribution(
        'Places &copy; <a href="https://overturemaps.org">Overture Maps Foundation</a>');

      // Dim everything outside the M25
      L.polygon(
        [
          [[90, -180], [90, 180], [-90, 180], [-90, -180]], // world
          CONFIG.m25Polygon,                                 // hole = inside M25
        ],
        {
          color: 'none',
          fillColor: '#b0a898',
          fillOpacity: 0.45,
          interactive: false,
        }
      ).addTo(_map);

      // Draw the M25 boundary line
      L.polygon(CONFIG.m25Polygon, {
        color: '#6C3483',
        weight: 2,
        dashArray: '10, 7',
        fillOpacity: 0,
        interactive: false,
      }).addTo(_map);

      MarkerManager.init(_map);
      const creatorPins = creatorPinGroup().addTo(_map);
      creatorLayers.forEach(layer => layer.init(creatorPins, _showPlacesInView));
      MyListManager.init(_map);
      PeopleLayer.init(_map);
      Views.init(creatorLayers);
      UI.updateStatsCount();

      FilterBar.init(
        (lat, lon) => {
          if (lat && lon) _map.flyTo([lat, lon], 15, { duration: 1.0 });
          creatorLayers.forEach(layer => layer.filter(FilterBar.getArea(), FilterBar.getCuisine()));
        },
        (cuisine) => {
          _showPlacesInView();
          creatorLayers.forEach(layer => layer.filter(FilterBar.getArea(), cuisine));
          MyListManager.filter(cuisine);
        },
        () => _showPlacesInView()
      );

      setTimeout(UI.hideFirstLoadOverlay, 1500);
      _showPlacesInView();
      _handleShareLink();

      _map.on('moveend', _showPlacesInView);

      // Close panel on map click
      _map.on('click', () => { RatingPanel.close(); Views.setSheet(false); });

      // Keyboard — close panel on Escape, block browser zoom shortcuts
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') RatingPanel.close();
        if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0'].includes(e.key)) {
          e.preventDefault();
        }
      });
    }

    return { init };
  })();

  // ─────────────────────────────────────────
  // Auth
  // ─────────────────────────────────────────
  const Auth = (() => {
    const signinBtn  = document.getElementById('signin-btn');
    const signoutBtn = document.getElementById('signout-btn');
    const userInfo   = document.getElementById('user-info');
    const userAvatar = document.getElementById('user-avatar');
    const userName   = document.getElementById('user-name');

    let _currentUser = null;

    function currentUser() { return _currentUser; }

    function _setUI(session) {
      if (session) {
        const meta = session.user.user_metadata;
        userName.textContent = meta.full_name || meta.name || session.user.email;
        userAvatar.innerHTML = personAvatar({ name: userName.textContent, avatar_url: meta.avatar_url || meta.picture }, 'header-avatar');
        signinBtn.style.display = 'none';
        userInfo.style.display  = 'flex';
        _currentUser = session.user;
      } else {
        signinBtn.style.display = '';
        userInfo.style.display  = 'none';
        _currentUser = null;
      }
    }

    async function _accountChanged(signedOut) {
      let owner = null;
      try { owner = localStorage.getItem(CONFIG.accountKey); } catch {}
      if (signedOut) {
        Storage.clear();
        BookmarkStorage.clear();
        try { localStorage.removeItem(CONFIG.accountKey); } catch {}
        RatingPanel.close();
        ProfilePanel.close();
        Views.show('explore');
      } else if (_currentUser) {
        // Another account's leftovers are never uploaded to this one
        const fromSignedOut = !owner;
        if (owner && owner !== _currentUser.id) { Storage.clear(); BookmarkStorage.clear(); }
        const synced = await Promise.all([Storage.syncFromCloud(fromSignedOut), BookmarkStorage.syncFromCloud(fromSignedOut)]);
        if (synced.every(Boolean)) {
          try { localStorage.setItem(CONFIG.accountKey, _currentUser.id); } catch {}
        }
      }
      MyListManager.refresh();
      Views.reload();
    }

    async function init() {
      const { data: { session } } = await sbClient.auth.getSession();
      _setUI(session);

      // Supabase also reports token refreshes here; only a change of account needs a sync
      let syncedFor;
      sbClient.auth.onAuthStateChange((event, session) => {
        _setUI(session);
        if (event === 'PASSWORD_RECOVERY') setTimeout(() => AuthDialog.open(null, 'reset'));
        else if (session) setTimeout(() => AuthDialog.signedIn());
        const id = session?.user.id || null;
        if (id === syncedFor) return;
        const signedOut = !!syncedFor && !id;
        syncedFor = id;
        setTimeout(() => _accountChanged(signedOut)); // Supabase asks for no awaits inside this callback
      });

      signinBtn.addEventListener('click', () => AuthDialog.open());

      signoutBtn.addEventListener('click', () => {
        sbClient.auth.signOut();
      });
    }

    return { init, currentUser };
  })();

  // Signed out, SCRAN is just the Explore map to look around: opening a place, profiles,
  // Following and people search all ask you to sign in first
  function requireSignIn(reason) {
    if (Auth.currentUser()) return true;
    AuthDialog.open(reason);
    return false;
  }

  // ─────────────────────────────────────────
  // Sign-in dialog: Google, or email and password (with sign-up and password reset)
  // ─────────────────────────────────────────
  const AuthDialog = (() => {
    const dialog    = document.getElementById('auth-dialog');
    const titleEl   = document.getElementById('auth-title');
    const reasonEl  = document.getElementById('auth-reason');
    const googleEl  = document.getElementById('auth-google-area');
    const form      = document.getElementById('auth-form');
    const nameEl    = document.getElementById('auth-name');
    const emailEl   = document.getElementById('auth-email');
    const passEl    = document.getElementById('auth-password');
    const submitEl  = document.getElementById('auth-submit');
    const messageEl = document.getElementById('auth-message');
    const forgotEl  = document.getElementById('auth-forgot');
    const switchEl  = document.getElementById('auth-switch');

    const MIN_PASSWORD = 8;
    // Where email links (confirm, reset password) bring you back to
    const here = () => window.location.origin + window.location.pathname;

    const MODES = {
      signin: { title: 'Sign in to SCRAN', submit: 'Sign in', google: true, name: false, email: true, password: true,
        switchText: 'New to SCRAN? Create an account', switchTo: 'signup', forgot: true },
      signup: { title: 'Create your account', submit: 'Create account', google: true, name: true, email: true, password: true,
        switchText: 'Already have an account? Sign in', switchTo: 'signin', forgot: false },
      forgot: { title: 'Reset your password', submit: 'Email me a reset link', google: false, name: false, email: true, password: false,
        switchText: 'Back to sign in', switchTo: 'signin', forgot: false },
      reset:  { title: 'Choose a new password', submit: 'Save password', google: false, name: false, email: false, password: true,
        switchText: '', switchTo: null, forgot: false },
    };
    let _mode = 'signin';

    function _message(text, isError) {
      messageEl.textContent = text;
      messageEl.className = isError ? 'error' : '';
      messageEl.hidden = !text;
    }

    function _setMode(mode) {
      _mode = mode;
      const m = MODES[mode];
      titleEl.textContent = m.title;
      submitEl.textContent = m.submit;
      googleEl.hidden = !m.google;
      nameEl.hidden = !m.name;
      emailEl.hidden = !m.email;
      passEl.hidden = !m.password;
      passEl.placeholder = mode === 'signin' ? 'Password' : `Password (at least ${MIN_PASSWORD} characters)`;
      passEl.autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
      forgotEl.hidden = !m.forgot;
      switchEl.hidden = !m.switchTo;
      switchEl.textContent = m.switchText;
      _message('');
    }

    function open(reason = null, mode = 'signin') {
      reasonEl.textContent = reason || '';
      reasonEl.hidden = !reason;
      _setMode(mode);
      dialog.hidden = false;
      (mode === 'reset' ? passEl : emailEl).focus({ preventScroll: true });
    }

    function close() {
      dialog.hidden = true;
    }

    async function _submit() {
      const name = nameEl.value.trim();
      const email = emailEl.value.trim();
      const password = passEl.value;
      if (MODES[_mode].email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return _message('Enter your email address.', true);
      if (_mode === 'signup' && !name) return _message('Enter your name. It’s shown on your profile.', true);
      if (MODES[_mode].password && _mode !== 'signin' && password.length < MIN_PASSWORD) {
        return _message(`Use at least ${MIN_PASSWORD} characters for your password.`, true);
      }
      if (_mode === 'signin' && !password) return _message('Enter your password.', true);

      submitEl.disabled = true;
      try {
        if (_mode === 'signin') {
          const { error } = await sbClient.auth.signInWithPassword({ email, password });
          if (error) return _message(/confirm/i.test(error.message)
            ? 'Confirm your email first: open the link we sent you.' : 'That email and password don’t match an account.', true);
        } else if (_mode === 'signup') {
          const { data, error } = await sbClient.auth.signUp({ email, password,
            options: { data: { full_name: name }, emailRedirectTo: here() } });
          if (error) return _message(error.message, true);
          if (!data.session) _message(`Nearly done: we’ve emailed a link to ${email}. Open it to confirm your account.`);
        } else if (_mode === 'forgot') {
          const { error } = await sbClient.auth.resetPasswordForEmail(email, { redirectTo: here() });
          if (error) return _message(error.message, true);
          _message('If there’s an account with that email, a reset link is on its way.');
        } else if (_mode === 'reset') {
          const { error } = await sbClient.auth.updateUser({ password });
          if (error) return _message(error.message, true);
          _mode = 'signin';
          close();
          UI.showSuccess('Password saved.');
        }
      } finally {
        submitEl.disabled = false;
      }
    }

    document.getElementById('auth-google').addEventListener('click', () => {
      sbClient.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } });
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); _submit(); });
    forgotEl.addEventListener('click', () => _setMode('forgot'));
    switchEl.addEventListener('click', () => _setMode(MODES[_mode].switchTo));
    document.getElementById('auth-close').addEventListener('click', close);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    // Signed in (from this dialog, or back from Google): done, unless choosing a new password
    function signedIn() { if (_mode !== 'reset') close(); }

    return { open, close, signedIn };
  })();

  // ─────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────
  Auth.init();
  App.init();

  // ── Profile panel: your ratings, or another person's (ProfilePanel.open(id)) ──
  const ProfilePanel = (() => {
    const panel         = document.getElementById('profile-panel');
    const btn           = document.getElementById('profile-btn');
    const closeBtn      = document.getElementById('profile-close');
    const titleEl       = document.getElementById('profile-title');
    const avatarEl      = document.getElementById('profile-avatar');
    const countsEl      = document.getElementById('profile-follow-counts');
    const followBtn     = document.getElementById('profile-follow-btn');
    const totalEl       = document.getElementById('profile-total');
    const avgEl         = document.getElementById('profile-avg');
    const topEl         = document.getElementById('profile-top');
    const barsEl        = document.getElementById('profile-bars');
    const listEl        = document.getElementById('profile-list');
    const userEl        = document.getElementById('profile-user');
    const emailEl       = document.getElementById('profile-email');
    const signoutBtn    = document.getElementById('profile-signout-btn');
    const deleteBtn     = document.getElementById('profile-delete-btn');

    let _person = null; // the profile on show when it isn't yours

    signoutBtn.addEventListener('click', () => {
      sbClient.auth.signOut();
      panel.classList.remove('open');
    });

    const barColour = score =>
      score >= 7 ? '#27AE60' : score >= 4 ? '#F39C12' : '#C0392B';

    const scoreClass = score =>
      score >= 7 ? 'score-high' : score >= 4 ? 'score-mid' : 'score-low';

    // entries: [{ name, rating }]
    function _build(entries) {
      const n = entries.length;

      totalEl.textContent = n;

      if (n === 0) {
        avgEl.textContent = '—';
        topEl.textContent = '—';
        barsEl.innerHTML = '<p style="font-size:0.8rem;color:#999">No ratings yet.</p>';
        listEl.innerHTML = '';
        return;
      }

      const ratings = entries.map(e => e.rating);
      const avg = (ratings.reduce((a, b) => a + b, 0) / n).toFixed(1);
      const top = Math.max(...ratings);
      avgEl.textContent = avg;
      topEl.textContent = top;

      // Breakdown bars 1–10
      const counts = Array(11).fill(0);
      ratings.forEach(r => counts[r]++);
      const maxCount = Math.max(...counts.slice(1));
      barsEl.innerHTML = Array.from({ length: 10 }, (_, i) => {
        const score = 10 - i;
        const c = counts[score];
        const pct = maxCount > 0 ? Math.round((c / maxCount) * 100) : 0;
        return `
          <div class="profile-bar-row">
            <div class="profile-bar-label">${score}</div>
            <div class="profile-bar-track">
              <div class="profile-bar-fill" style="width:${pct}%;background:${barColour(score)}"></div>
            </div>
            <div class="profile-bar-count">${c}</div>
          </div>`;
      }).join('');

      // Sorted list
      const sorted = entries.slice().sort((a, b) => b.rating - a.rating);
      listEl.innerHTML = sorted.map(e => `
        <div class="profile-restaurant-row">
          <div class="profile-restaurant-name">${escapeHtml(e.name || 'Unknown')}</div>
          <div class="profile-score ${scoreClass(e.rating)}">${e.rating}</div>
        </div>`).join('');
    }

    const _counts = (followers, following) =>
      `${followers} follower${followers === 1 ? '' : 's'} · ${following} following`;

    function _showFollow() {
      followBtn.hidden = !_person;
      if (!_person) return;
      const followed = Social.isFollowing(_person.id);
      followBtn.textContent = followed ? 'Unfollow' : 'Follow';
      followBtn.classList.toggle('follow', !followed);
    }

    // No id, or your own: your ratings from this browser
    async function open(id = null) {
      if (!requireSignIn('Sign in to see profiles and keep your own ratings.')) return;
      const user = Auth.currentUser();
      const mine = !id || id === user?.id;
      _person = null;
      countsEl.textContent = '';
      if (mine) {
        const meta = user?.user_metadata || {};
        titleEl.textContent = 'My Ratings';
        avatarEl.innerHTML = user ? personAvatar({ name: meta.full_name || meta.name, avatar_url: meta.avatar_url || meta.picture }, 'profile-avatar') : '';
        emailEl.textContent = user?.email || '';
        userEl.style.display = user ? 'flex' : 'none';
        deleteBtn.hidden = !user;
        _build(Object.values(Storage.getAll()).filter(e => e.rating != null));
      } else {
        titleEl.textContent = '';
        avatarEl.innerHTML = '';
        userEl.style.display = 'none';
        deleteBtn.hidden = true;
        _build([]);
      }
      _showFollow();
      panel.classList.add('open');

      if (mine && !user) return;
      const p = await Social.profile(mine ? user.id : id);
      countsEl.textContent = _counts(p.followers, p.following);
      if (mine || !p.person) return;
      _person = p.person;
      titleEl.textContent = p.person.name;
      avatarEl.innerHTML = personAvatar(p.person, 'profile-avatar');
      _build(p.ratings.map(r => ({ name: r.restaurant_name, rating: r.rating })));
      _showFollow();
    }

    followBtn.addEventListener('click', async () => {
      if (!_person) return;
      const follow = !Social.isFollowing(_person.id);
      if (!await Social.setPerson(_person, follow)) return;
      _showFollow();
      const p = await Social.profile(_person.id);
      countsEl.textContent = _counts(p.followers, p.following);
      await PeopleLayer.load();
      Views.refresh();
    });

    // Removes the account and everything on it (profile, ratings, saved places, follows):
    // delete_my_account in supabase/safety.sql
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete your SCRAN account? Your profile, ratings, notes, saved places and follows will be removed for good.')) return;
      const { error } = await sbClient.rpc('delete_my_account');
      if (error) { cloudError(error); return; }
      panel.classList.remove('open');
      await sbClient.auth.signOut();
      UI.showSuccess('Your account has been deleted.');
    });

    btn.addEventListener('click', () => open());

    const close = () => panel.classList.remove('open');
    closeBtn.addEventListener('click', close);

    return { open, close };
  })();

  // ── Collapsible filter column: starts closed on phones, where it would cover the map ──
  (function () {
    const sidebar = document.getElementById('filter-sidebar');
    const toggle  = document.getElementById('fs-collapse');
    function setOpen(open) {
      sidebar.classList.toggle('closed', !open);
      toggle.setAttribute('aria-expanded', open);
    }
    setOpen(!window.matchMedia('(max-width: 700px)').matches);
    toggle.addEventListener('click', () => setOpen(sidebar.classList.contains('closed')));
    // A dot on the tab shows a filter is on while the column is hidden
    sidebar.addEventListener('click', () => {
      const filtered = [...sidebar.querySelectorAll('.fs-chip.selected')].some(c => c.dataset.value);
      toggle.classList.toggle('filtered', filtered);
    });
  })();

  // ── Collapsible sidebar sections ──
  document.querySelectorAll('.fs-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      const collapsed = target.classList.toggle('collapsed');
      btn.classList.toggle('collapsed', collapsed);
    });
  });

})();
