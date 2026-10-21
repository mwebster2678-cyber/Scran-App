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
    minZoomForFetch: 13,
    debounceMs: 600,
    fetchTimeoutMs: 30000,
    resultsCapPerType: 100,
    storageKey: 'london-eats-ratings',
    bookmarkKey: 'london-eats-bookmarks',
    overpassEndpoints: [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
      'https://overpass.openstreetmap.ru/api/interpreter',
    ],
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
  // 4. OVERPASS CLIENT
  // ─────────────────────────────────────────
  const OverpassClient = (() => {
    const LS_KEY = 'scran-area-cache-v3';
    const RADIUS = 0.022; // ~2.4km radius — larger tile = fewer cache misses on pan
    const CACHE_PRECISION = 2; // round to 2dp (~1.1km grid) for cache key

    let _cache = {};
    try { _cache = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { _cache = {}; }

    function _saveCache() {
      try { localStorage.setItem(LS_KEY, JSON.stringify(_cache)); } catch { /* storage full */ }
    }

    function _buildQuery(clat, clon, cuisines) {
      const s = (clat - RADIUS).toFixed(5), n = (clat + RADIUS).toFixed(5);
      const w = (clon - RADIUS).toFixed(5), e = (clon + RADIUS).toFixed(5);
      const bbox = `${s},${w},${n},${e}`;
      const cuisineFilter = (cuisines && cuisines.length)
        ? `["cuisine"~"${cuisines.map(c => c.toLowerCase()).join('|')}",i]`
        : '';
      return `[out:json][timeout:20];
(
  node["amenity"="restaurant"]${cuisineFilter}(${bbox});
  way["amenity"="restaurant"]${cuisineFilter}(${bbox});
);
out center 50;`;
    }

    async function _fetchFrom(endpoint, query) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 22000);
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          body: `data=${encodeURIComponent(query)}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (resp.status === 429) throw new Error('rate_limited');
        if (!resp.ok) throw new Error(`http_${resp.status}`);
        return await resp.json();
      } catch (e) {
        clearTimeout(timer);
        throw e;
      }
    }

    async function query(bounds, cuisines) {
      const clat = parseFloat(((bounds.getNorth() + bounds.getSouth()) / 2).toFixed(CACHE_PRECISION));
      const clon = parseFloat(((bounds.getEast() + bounds.getWest()) / 2).toFixed(CACHE_PRECISION));
      const cuisineKey = (cuisines || []).join(',');
      const cacheKey = `${clat},${clon},${cuisineKey}`;

      if (_cache[cacheKey]) return { elements: _cache[cacheKey] };

      const q = _buildQuery(clat, clon, cuisines);

      // Race all endpoints — use whichever responds first
      const elements = await new Promise((resolve, reject) => {
        let settled = false;
        let errors = 0;
        const total = CONFIG.overpassEndpoints.length;
        CONFIG.overpassEndpoints.forEach(endpoint => {
          _fetchFrom(endpoint, q).then(data => {
            if (!settled) {
              settled = true;
              resolve((data && data.elements) ? data.elements : []);
            }
          }).catch(() => {
            errors++;
            if (errors === total && !settled) {
              settled = true;
              reject(new Error('all_endpoints_failed'));
            }
          });
        });
      });

      _cache[cacheKey] = elements;
      _saveCache();
      return { elements };
    }

    function clearCache() {
      _cache = {};
      try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
    }

    return { query, clearCache };
  })();

  // ─────────────────────────────────────────
  // 5. MARKER MANAGER
  // ─────────────────────────────────────────
  const MarkerManager = (() => {
    const seenIds = new Set();
    const markers = new Map();
    let _map = null;

    function init(map) { _map = map; }

    function _buildIcon(osmType, osmId) {
      const stored = Storage.get(osmType, osmId);
      let cls = 'pin-unrated';
      let rated = false;

      if (stored) {
        cls = stored.rating >= 8 ? 'pin-high' : stored.rating >= 4 ? 'pin-mid' : 'pin-low';
        rated = true;
      } else if (BookmarkStorage.get(osmType, osmId)) {
        cls = 'pin-bookmarked';
      }

      const inner = rated
        ? `<span class="pin-rating">${stored.rating}</span>`
        : '';

      return L.divIcon({
        className: '',
        html: `<div class="map-pin ${cls}${rated ? ' pin-rated' : ''}">${inner}</div>`,
        iconSize:   rated ? [34, 44] : [28, 36],
        iconAnchor: rated ? [17, 44] : [14, 36],
        popupAnchor: [0, rated ? -46 : -38],
      });
    }

    function addElements(elements) {
      elements.forEach(el => {
        const osmType = el.type; // 'node' or 'way'
        const osmId   = el.id;
        const uid     = `${osmType}/${osmId}`;

        if (seenIds.has(uid)) return;
        seenIds.add(uid);

        const lat = el.type === 'node' ? el.lat : el.center?.lat;
        const lon = el.type === 'node' ? el.lon : el.center?.lon;
        if (!lat || !lon) return;

        const name    = el.tags?.name || 'Unnamed Restaurant';
        const cuisine = el.tags?.cuisine
          ? el.tags.cuisine.split(';').map(c => c.trim().replace(/_/g, ' ')).filter(Boolean)
          : [];

        const marker = L.marker([lat, lon], {
          icon: _buildIcon(osmType, osmId),
          riseOnHover: true,
        });

        marker.osmType = osmType;
        marker.osmId   = osmId;
        marker.osmName = name;
        marker.osmCuisine = cuisine;

        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          RatingPanel.open({ type: osmType, id: osmId, name, cuisine, lat, lon });
        });

        marker.addTo(_map);
        markers.set(uid, marker);
      });
    }

    function refreshMarkerIcon(osmType, osmId) {
      const uid = `${osmType}/${osmId}`;
      const marker = markers.get(uid);
      if (marker) marker.setIcon(_buildIcon(osmType, osmId));
    }

    function clearAll() {
      markers.forEach(m => m.remove());
      markers.clear();
      seenIds.clear();
    }

    function getMarker(osmType, osmId) {
      return markers.get(`${osmType}/${osmId}`) || null;
    }

    return { init, addElements, refreshMarkerIcon, clearAll, getMarker };
  })();

  // ─────────────────────────────────────────
  // 6. RATING PANEL
  // ─────────────────────────────────────────
  const RatingPanel = (() => {
    const panel       = document.getElementById('rating-panel');
    const nameEl      = document.getElementById('panel-name');
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

    function open({ type, id, name, cuisine, lat, lon }) {
      // Cancel any pending hide from a previous close()
      clearTimeout(_hideTimer);

      _current = { type, id, name, cuisine, lat, lon };
      nameEl.textContent = name;
      cuisineEl.innerHTML = cuisine.length
        ? cuisine.map(c => `<span class="cuisine-tag">${escapeHtml(c)}</span>`).join('')
        : '';
      const stored = Storage.get(type, id);
      _renderRatingButtons(stored ? stored.rating : null);
      noteEl.value = stored?.note || '';
      _updateStatusBtns(type, id);

      panel.classList.remove('hidden');
      panel.getBoundingClientRect();
      panel.classList.add('open');
    }

    function close() {
      panel.classList.remove('open');
      _hideTimer = setTimeout(() => panel.classList.add('hidden'), 400);
      _current = null;
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
  // 7. MY RESTAURANTS MANAGER
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
        if (cuisineLc) {
          const tags = (data.cuisine || []).map(c => c.toLowerCase());
          if (!tags.some(c => c.includes(cuisineLc))) return;
        }
        const [type, rawId] = key.split('/');
        const id = parseInt(rawId);
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
        if (cuisineLc) {
          const tags = (data.cuisine || []).map(c => c.toLowerCase());
          if (!tags.some(c => c.includes(cuisineLc))) return;
        }
        const [type, rawId] = key.split('/');
        const id = parseInt(rawId);
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
      _addPins(document.getElementById('cuisine-select')?.value || '');
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
        _active ? _addPins(document.getElementById('cuisine-select')?.value || '') : _removePins();
      });
    }

    return { init, refresh, filter };
  })();

  // 8. FILTER BAR
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
    let _onArea    = null;
    let _onCuisine = null;

    function _highlight(filterType, value) {
      document.querySelectorAll(`.fs-chip[data-filter="${filterType}"]`).forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.value === value);
      });
    }

    function init(onAreaFn, onCuisineFn) {
      _onArea    = onAreaFn;
      _onCuisine = onCuisineFn;

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

    return { init, getCuisine, getArea };
  })();

  // ─────────────────────────────────────────
  // 9. CREATOR LAYERS (YouTube reviewers)
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
  // 10. APP (main controller)
  // ─────────────────────────────────────────
  const App = (() => {
    const creatorLayers = CREATORS.map(CreatorLayer);
    let _map           = null;
    let _isFetching    = false;
    let _debounce      = null;
    let _allActive     = false;
    let _currentFilter = []; // [] = any cuisine
    let _pendingShare  = null; // { type, id, name, lat, lon } — open panel after share-link fetch

    function _debounced(fn, delay) {
      return function (...args) {
        clearTimeout(_debounce);
        _debounce = setTimeout(() => fn.apply(this, args), delay);
      };
    }

    async function _fetchForCurrentView() {
      if (!_allActive) return;
      if (_isFetching) return;

      if (_map.getZoom() < CONFIG.minZoomForFetch) {
        UI.setStatus('Zoom in to see restaurants');
        return;
      }

      _isFetching = true;
      UI.setLoading(true);

      try {
        const data = await OverpassClient.query(_map.getBounds(), _currentFilter);
        if (data && data.elements) {
          MarkerManager.addElements(data.elements);
        }
        if (_pendingShare) {
          const { type, id, name, lat, lon } = _pendingShare;
          _pendingShare = null;
          const marker = MarkerManager.getMarker(type, id);
          if (marker) {
            marker.fire('click');
          } else {
            RatingPanel.open({ type, id, name, cuisine: [], lat, lon });
          }
        }
        UI.setLoading(false, `${data?.elements?.length || 0} restaurants found`);
      } catch (e) {
        console.error('[SCRAN] fetch error:', e.name, e.message, e);
        UI.setLoading(false);
        if (e.name === 'AbortError' || e.message === 'all_endpoints_failed') {
          UI.showError('Servers are busy — zoom in or use Search Here to retry.');
        } else if (e.message?.includes('Failed to fetch') || e.message?.includes('network')) {
          UI.showError('Network error — check your connection.');
        } else if (e.message !== 'rate_limited') {
          UI.showError(`Could not load restaurants (${e.message}). Try Search Here.`);
        }
      } finally {
        _isFetching = false;
      }
    }

    const _debouncedFetch = _debounced(_fetchForCurrentView, CONFIG.debounceMs);

    function _handleShareLink() {
      const params = new URLSearchParams(window.location.search);
      const lat  = parseFloat(params.get('lat'));
      const lon  = parseFloat(params.get('lon'));
      const type = params.get('type');
      const id   = parseInt(params.get('id'), 10);
      const name = params.get('name') || 'Restaurant';
      if (!lat || !lon || !type || !id) return false;
      _pendingShare  = { type, id, name, lat, lon };
      _currentFilter = [];
      _allActive     = true;
      const allBtn   = document.getElementById('all-restaurants-btn');
      if (allBtn) allBtn.classList.add('active');
      _map.setView([lat, lon], 16);
      _fetchForCurrentView();
      return true;
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
      document.getElementById('redo-search-btn').addEventListener('click', () => {
        if (!_allActive) {
          _allActive = true;
          const allBtn = document.getElementById('all-restaurants-btn');
          if (allBtn) allBtn.classList.add('active');
          const cuisine = FilterBar.getCuisine();
          _currentFilter = cuisine ? [cuisine] : [];
        }
        OverpassClient.clearCache();
        MarkerManager.clearAll();
        _fetchForCurrentView();
      });

      // Esri Light Gray canvas (no API key needed) — base + label layers
      const esriCanvas = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
      L.tileLayer(`${esriCanvas}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
        attribution: 'Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxNativeZoom: 16,
        maxZoom: 19,
      }).addTo(_map);
      L.tileLayer(`${esriCanvas}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, {
        maxNativeZoom: 16,
        maxZoom: 19,
      }).addTo(_map);

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
          // All Restaurants: re-fetch with new cuisine filter
          if (_allActive) {
            _currentFilter = cuisine ? [cuisine] : [];
            OverpassClient.clearCache();
            MarkerManager.clearAll();
            _fetchForCurrentView();
          }
          // Creators / My Restaurants: keyword-filter existing pins
          creatorLayers.forEach(layer => layer.filter(FilterBar.getArea(), cuisine));
          MyListManager.filter(cuisine);
        }
      );

      // All Restaurants toggle
      const allBtn = document.getElementById('all-restaurants-btn');
      allBtn.addEventListener('click', () => {
        _allActive = !_allActive;
        allBtn.classList.toggle('active', _allActive);
        if (_allActive) {
          const cuisine = FilterBar.getCuisine();
          _currentFilter = cuisine ? [cuisine] : [];
          _fetchForCurrentView();
        } else {
          MarkerManager.clearAll();
          UI.setStatus('');
        }
      });

      // Hide loading overlay; check for share links
      _map.once('load', () => {
        UI.hideFirstLoadOverlay();
        _handleShareLink();
      });

      setTimeout(() => {
        UI.hideFirstLoadOverlay();
        _handleShareLink();
      }, 1500);

      _map.on('moveend', _debouncedFetch);
      _map.on('zoomend', _debouncedFetch);

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
