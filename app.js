const SUPABASE_URL = 'https://gcyezgildizquectvrbe.supabase.co';
const SUPABASE_KEY = 'sb_publishable_E2_XaAQrwmGpOc8PpdEkeg_hTnk7OrH';
const sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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
    minZoomForPlaces: 13,
    placesUrl: 'data/places.json',
    // Browser key — public by design; restricted to SCRAN's web addresses in Google Cloud
    googleMapsKey: 'AIzaSyAP7wkccKRKXO1DhpUbfghTcvW5pH5N7V8',
    storageKey: 'london-eats-ratings',
    bookmarkKey: 'london-eats-bookmarks',
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
          if (error) console.warn('Cloud sync failed:', error.message);
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
            .then(({ error }) => { if (error) console.warn('Cloud sync failed:', error.message); });
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
          .then(({ error }) => { if (error) console.warn('Cloud sync failed:', error.message); });
      }
    }

    function count() {
      return Object.keys(_load()).length;
    }

    function getAll() { return _load(); }

    async function syncFromCloud() {
      const user = typeof Auth !== 'undefined' && Auth.currentUser();
      if (!user) return;
      const { data, error } = await sbClient.from('ratings').select('*').eq('user_id', user.id);
      if (error || !data) return;
      const stored = {};
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
    }

    return { get, set, setNote, remove, count, getKey, getAll, syncFromCloud };
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
    function set(type, id, name, lat, lon, cuisine) {
      const data = _load();
      data[key(type, id)] = { name, lat, lon, cuisine, timestamp: Date.now() };
      _save(data);
    }
    function remove(type, id) {
      const data = _load();
      delete data[key(type, id)];
      _save(data);
    }
    function getAll() { return _load(); }
    return { get, set, remove, getAll, key };
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
        if (!bool) {
          overlay.classList.add('hidden');
          firstLoad = false;
        }
        return;
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

    // Dots shrink as you zoom out so dense areas stay readable
    function _dotSize(zoom) {
      if (zoom <= 13) return { radius: 2.5, weight: 0 };
      if (zoom === 14) return { radius: 3.5, weight: 1 };
      return { radius: 5, weight: 1.5 };
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
            color: '#fff', fillColor: KIND_COLOURS[place.kind], fillOpacity: 0.9,
          });
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        CreatorPanel.close();
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

    function clearAll() {
      markers.forEach(m => m.remove());
      markers.clear();
    }

    function getMarker(type, id) {
      return type === PLACE_TYPE ? markers.get(id) || null : null;
    }

    return { init, show, refreshMarkerIcon, clearAll, getMarker };
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
    const btn    = document.getElementById('list-toggle');
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

    function init(map) {
      _map = map;
      btn.addEventListener('click', () => {
        _active = !_active;
        btn.classList.toggle('active', _active);
        _active ? _addPins(FilterBar.getCuisine()) : _removePins();
      });
    }

    return { init, refresh, filter };
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
  // To add a creator: add an entry here, a <key>-mode-btn in index.html,
  // and data/<key>.json from the pipeline.
  const CREATORS = [
    {
      key: 'topjaw',
      name: 'Topjaw',
      label: '📷 Topjaw',
      activeLabel: '✕ Topjaw',
      avatar: 'images/topjaw.jpg',
      colour: '#0e7490',
      textColour: '#0e7490',
      zIndexOffset: 490,
    },
    {
      key: 'tod',
      name: 'Tod',
      label: '⭐ Tod Mode',
      activeLabel: '✕ Tod Mode',
      avatar: 'images/tod.jpg',
      colour: '#D4AC0D',
      textColour: '#A07D00',
      zIndexOffset: 500,
    },
  ];

  // Best overall score, falling back to the highest single-video score
  function creatorRating(restaurant) {
    const best = normalizeRating(restaurant.bestRating, restaurant.bestRatingOutOf);
    if (best != null) return best;
    const ratings = restaurant.mentions
      .map(m => normalizeRating(m.rating, m.rating_out_of))
      .filter(r => r != null);
    return ratings.length ? Math.max(...ratings) : null;
  }

  // One bottom panel shared by every creator, recoloured per creator
  const CreatorPanel = (() => {
    const panel      = document.getElementById('creator-panel');
    const nameEl     = document.getElementById('creator-panel-name');
    const locEl      = document.getElementById('creator-panel-location');
    const ratingEl   = document.getElementById('creator-panel-rating');
    const mentionsEl = document.getElementById('creator-panel-mentions');
    const rateBtn    = document.getElementById('creator-rate-btn');

    function open(creator, restaurant) {
      panel.style.setProperty('--creator-colour', creator.colour);
      panel.style.setProperty('--creator-text', creator.textColour);

      nameEl.textContent = restaurant.name;
      locEl.textContent  = restaurant.location || '';

      const rating = creatorRating(restaurant);
      ratingEl.innerHTML = rating != null ? `<div class="creator-rating-badge">&#11088; ${rating}/10</div>` : '';

      mentionsEl.innerHTML = restaurant.mentions.map(m => {
        const ratingStr = m.rating != null
          ? `<div class="creator-mention-rating">&#11088; ${normalizeRating(m.rating, m.rating_out_of)}/10</div>`
          : '';
        return `<div class="creator-mention">
          <div class="creator-mention-title">
            <a href="https://youtube.com/watch?v=${encodeURIComponent(m.videoId)}" target="_blank" rel="noopener">&#9654; ${escapeHtml(m.videoTitle)}</a>
          </div>
          ${ratingStr}
          <div class="creator-mention-notes">${escapeHtml(m.notes)}</div>
        </div>`;
      }).join('');

      const id = `${creator.key}_` + restaurant.name.toLowerCase().replace(/\s+/g, '_');
      const existing = Storage.get(creator.key, id);
      rateBtn.innerHTML = existing ? `&#9733; Your rating: ${existing.rating}/10` : '&#9733; Rate this restaurant';
      rateBtn.classList.toggle('has-rating', !!existing);
      rateBtn.onclick = (e) => {
        e.stopPropagation();
        close();
        RatingPanel.open({ type: creator.key, id, name: restaurant.name, cuisine: [], lat: restaurant.lat, lon: restaurant.lon });
      };

      panel.classList.add('open');
    }

    function close() {
      panel.classList.remove('open');
    }

    document.getElementById('creator-panel-close').addEventListener('click', close);

    return { open, close };
  })();

  // A toggleable set of map pins for one creator
  function CreatorLayer(creator) {
    const btn = document.getElementById(`${creator.key}-mode-btn`);
    const dataPromise = fetch(`data/${creator.key}.json`)
      .then(r => { if (!r.ok) throw new Error(`http_${r.status}`); return r.json(); })
      .catch(e => {
        console.error(`[SCRAN] ${creator.key} data failed:`, e);
        return null;
      });

    let _map     = null;
    let _active  = false;
    let _entries = []; // [{ marker, restaurant }]

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
      const data = await dataPromise;
      if (!data) {
        UI.showError(`Could not load ${creator.name} restaurants.`);
        return;
      }
      if (!_active || _entries.length) return; // toggled off, or already added, while loading
      data.forEach(restaurant => {
        const marker = L.marker([restaurant.lat, restaurant.lon], {
          icon: _icon(restaurant),
          zIndexOffset: creator.zIndexOffset,
        });
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          RatingPanel.close();
          CreatorPanel.open(creator, restaurant);
        });
        marker.addTo(_map);
        _entries.push({ marker, restaurant });
      });
    }

    function _removePins() {
      _entries.forEach(e => e.marker.remove());
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
          if (!_map.hasLayer(marker)) marker.addTo(_map);
        } else {
          if (_map.hasLayer(marker)) marker.remove();
        }
      });
    }

    function init(map) {
      _map = map;
      btn.addEventListener('click', async () => {
        _active = !_active;
        btn.classList.toggle('active', _active);
        btn.textContent = _active ? creator.activeLabel : creator.label;
        if (_active) {
          await _addPins();
          filter(FilterBar.getArea(), FilterBar.getCuisine());
        } else {
          _removePins();
          CreatorPanel.close();
        }
      });
    }

    return { init, filter };
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
  // 12. APP (main controller)
  // ─────────────────────────────────────────
  const App = (() => {
    const creatorLayers = CREATORS.map(CreatorLayer);
    let _map          = null;
    let _allActive    = false;
    let _pendingShare = null; // { type, id, name, lat, lon } — open once places have loaded

    async function _showPlacesInView() {
      if (!_allActive) return;

      if (_map.getZoom() < CONFIG.minZoomForPlaces) {
        MarkerManager.clearAll();
        UI.setStatus('Zoom in to see places');
        return;
      }

      try {
        UI.setLoading(true);
        await Places.load();
      } catch (e) {
        console.error('[SCRAN] places failed to load:', e);
        UI.setLoading(false);
        UI.showError('Could not load restaurants — check your connection and try again.');
        return;
      }
      if (!_allActive) return; // toggled off while loading

      const places = Places.query(_map.getBounds(), { kind: FilterBar.getKind(), cuisine: FilterBar.getCuisine() });
      MarkerManager.show(places);
      UI.setLoading(false, `${places.length.toLocaleString()} places in view`);
      _openPendingShare();
    }

    function _openPendingShare() {
      if (!_pendingShare) return;
      const { type, id, name, lat, lon } = _pendingShare;
      _pendingShare = null;
      const place = type === PLACE_TYPE ? Places.get(id) : null;
      RatingPanel.open(place ? placeRef(place) : { type, id, name, cuisine: [], lat, lon });
    }

    function _setAllActive(active) {
      _allActive = active;
      document.getElementById('all-restaurants-btn').classList.toggle('active', active);
      if (active) {
        _showPlacesInView();
      } else {
        MarkerManager.clearAll();
        UI.setStatus('');
      }
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
      if (_allActive) _showPlacesInView();
      else _setAllActive(true);
    }

    function init() {
      _map = L.map('map', {
        center: CONFIG.mapCenter,
        zoom: CONFIG.defaultZoom,
        minZoom: CONFIG.minZoom,
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
      creatorLayers.forEach(layer => layer.init(_map));
      MyListManager.init(_map);
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

      document.getElementById('all-restaurants-btn')
        .addEventListener('click', () => _setAllActive(!_allActive));

      setTimeout(UI.hideFirstLoadOverlay, 1500);
      _handleShareLink();

      _map.on('moveend', _showPlacesInView);

      // Close panel on map click
      _map.on('click', () => {
        RatingPanel.close();
        CreatorPanel.close();
      });

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
        signinBtn.style.display = 'none';
        userInfo.style.display  = 'flex';
        _currentUser = session.user;
      } else {
        signinBtn.style.display = '';
        userInfo.style.display  = 'none';
        _currentUser = null;
      }
    }

    async function init() {
      const { data: { session } } = await sbClient.auth.getSession();
      _setUI(session);

      sbClient.auth.onAuthStateChange((_event, session) => {
        _setUI(session);
        if (session) Storage.syncFromCloud();
      });

      signinBtn.addEventListener('click', () => {
        sbClient.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo: window.location.href }
        });
      });

      signoutBtn.addEventListener('click', () => {
        sbClient.auth.signOut();
      });
    }

    return { init, currentUser };
  })();

  // ─────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────
  Auth.init();
  App.init();

  // ── Profile panel ──
  (function () {
    const panel         = document.getElementById('profile-panel');
    const btn           = document.getElementById('profile-btn');
    const closeBtn      = document.getElementById('profile-close');
    const totalEl       = document.getElementById('profile-total');
    const avgEl         = document.getElementById('profile-avg');
    const topEl         = document.getElementById('profile-top');
    const barsEl        = document.getElementById('profile-bars');
    const listEl        = document.getElementById('profile-list');
    const userEl        = document.getElementById('profile-user');
    const emailEl       = document.getElementById('profile-email');
    const signoutBtn    = document.getElementById('profile-signout-btn');

    signoutBtn.addEventListener('click', () => {
      sbClient.auth.signOut();
      panel.classList.remove('open');
    });

    const barColour = score =>
      score >= 7 ? '#27AE60' : score >= 4 ? '#F39C12' : '#C0392B';

    const scoreClass = score =>
      score >= 7 ? 'score-high' : score >= 4 ? 'score-mid' : 'score-low';

    function build() {
      const user = typeof Auth !== 'undefined' && Auth.currentUser();
      if (user) {
        emailEl.textContent = user.email || '';
        userEl.style.display = 'flex';
      } else {
        userEl.style.display = 'none';
      }

      const all = Storage.getAll();
      const entries = Object.values(all).filter(e => e.rating != null);
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

    btn.addEventListener('click', () => {
      build();
      panel.classList.add('open');
    });

    closeBtn.addEventListener('click', () => panel.classList.remove('open'));
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
