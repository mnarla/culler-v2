/**
 * injected.js — Non-destructive window.fetch interceptor and pagination engine for Spotify GraphQL.
 * Runs in the page's MAIN execution world to monitor and replay Pathfinder requests.
 */

(() => {
  if (window.__culler_injected) return;
  window.__culler_injected = true;

  console.log('[Culler v2] Interceptor attached in MAIN world.');

  const originalFetch = window.fetch;

  // Stored request template for auto-pagination
  let lastPlaylistRequest = null;
  let isPaginating = false;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');

      if (url.includes('pathfinder/v2/query')) {
        // Extract headers
        const headersObj = {};
        if (args[1] && args[1].headers) {
          const rawHeaders = args[1].headers;
          if (typeof rawHeaders.forEach === 'function') {
            rawHeaders.forEach((val, key) => { headersObj[key] = val; });
          } else if (typeof rawHeaders === 'object') {
            Object.assign(headersObj, rawHeaders);
          }
        }

        const authHeader = headersObj['authorization'] || headersObj['Authorization'] || null;

        // Circuit breaker: Check for 401 unauthorized
        if (response.status === 401) {
          console.warn('[Culler v2] Pathfinder API returned 401 Unauthorized. Session token expired.');
          window.postMessage({
            type: 'CULLER_AUTH_EXPIRED',
            status: 401,
          }, '*');
          return response;
        }

        // Clone stream to inspect payload non-destructively
        const clone = response.clone();
        clone.json().then((payload) => {
          const playlistNode = payload?.data?.playlistV2 || payload?.data?.playlist;
          if (playlistNode) {
            // Save request template if this request had track content
            if (playlistNode.content && Array.isArray(playlistNode.content.items)) {
              lastPlaylistRequest = {
                url: url,
                method: args[1]?.method || 'GET',
                headers: headersObj,
                body: args[1]?.body || null,
                totalExpected: playlistNode.content.totalCount || null,
                currentOffset: playlistNode.content.offset || 0,
              };
            }

            window.postMessage({
              type: 'CULLER_INTERCEPTED_PLAYLIST',
              payload: payload,
              authHeader: authHeader,
              url: url,
              // Always include the playlist ID from the current page URL for reliable switch detection
              urlPlaylistId: _getPlaylistIdFromUrl(window.location.pathname),
            }, '*');
          }
        }).catch(() => {
          // Non-JSON response; ignore
        });
      }
    } catch (err) {
      console.warn('[Culler v2] Non-fatal error in fetch interceptor:', err);
    }

    return response;
  };

  // ── Playlist URL Switch Detection ──────────────────────────────────────────

  /**
   * Extract the Spotify playlist ID from a pathname like /playlist/37i9dQZF1DX...
   * Returns null for any other path (artist page, album, etc.)
   */
  function _getPlaylistIdFromUrl(pathname) {
    const m = (pathname || '').match(/^\/playlist\/([a-zA-Z0-9]{22})(?:\/|$)/);
    return m ? m[1] : null;
  }

  let _lastKnownPlaylistId = _getPlaylistIdFromUrl(window.location.pathname);

  function _checkForPlaylistSwitch() {
    const current = _getPlaylistIdFromUrl(window.location.pathname);
    if (current && _lastKnownPlaylistId && current !== _lastKnownPlaylistId) {
      console.log(`[Culler v2] Playlist navigated: "${_lastKnownPlaylistId}" → "${current}"`);
      window.postMessage({
        type: 'CULLER_PLAYLIST_SWITCHED',
        fromPlaylistId: _lastKnownPlaylistId,
        toPlaylistId: current,
      }, '*');
    }
    if (current) {
      _lastKnownPlaylistId = current;
    }
  }

  // Patch history.pushState and history.replaceState so SPA navigations fire an event
  const _origPushState = history.pushState.bind(history);
  const _origReplaceState = history.replaceState.bind(history);

  history.pushState = function (...args) {
    _origPushState(...args);
    _checkForPlaylistSwitch();
  };

  history.replaceState = function (...args) {
    _origReplaceState(...args);
    _checkForPlaylistSwitch();
  };

  // Also catch browser back/forward
  window.addEventListener('popstate', _checkForPlaylistSwitch);

  // ── Auto-Pagination Loop ───────────────────────────────────────────────────

  function buildPaginatedUrl(originalUrl, newOffset, limit = 50) {
    try {
      const parsedUrl = new URL(originalUrl, window.location.origin);
      const varsParam = parsedUrl.searchParams.get('variables');
      if (varsParam) {
        const vars = JSON.parse(varsParam);
        vars.offset = newOffset;
        vars.limit = limit;
        parsedUrl.searchParams.set('variables', JSON.stringify(vars));
        return parsedUrl.toString();
      }
      if (parsedUrl.searchParams.has('offset')) {
        parsedUrl.searchParams.set('offset', newOffset);
        parsedUrl.searchParams.set('limit', limit);
        return parsedUrl.toString();
      }
      return originalUrl;
    } catch (e) {
      console.warn('[Culler v2] Failed to construct paginated URL:', e);
      return originalUrl;
    }
  }

  function buildPaginatedBody(originalBody, newOffset, limit = 50) {
    try {
      if (typeof originalBody === 'string') {
        const parsed = JSON.parse(originalBody);
        if (parsed.variables) {
          parsed.variables.offset = newOffset;
          parsed.variables.limit = limit;
          return JSON.stringify(parsed);
        }
      }
      return originalBody;
    } catch (e) {
      console.warn('[Culler v2] Failed to construct paginated body:', e);
      return originalBody;
    }
  }

  async function runAutoPagination(startOffset, totalExpected) {
    if (isPaginating) {
      console.warn('[Culler v2] Auto-pagination is already running.');
      return;
    }

    if (!lastPlaylistRequest) {
      window.postMessage({
        type: 'CULLER_PAGINATION_ERROR',
        error: 'No playlist request signature captured yet. Scroll slightly in the playlist first.',
      }, '*');
      return;
    }

    isPaginating = true;
    console.log(`[Culler v2] Starting auto-pagination from offset ${startOffset} to ${totalExpected}...`);

    try {
      for (let offset = startOffset; offset < totalExpected; offset += 50) {
        if (!isPaginating) {
          console.log('[Culler v2] Auto-pagination cancelled.');
          break;
        }

        const fetchUrl = lastPlaylistRequest.method === 'GET'
          ? buildPaginatedUrl(lastPlaylistRequest.url, offset, 50)
          : lastPlaylistRequest.url;

        const fetchBody = lastPlaylistRequest.method === 'POST'
          ? buildPaginatedBody(lastPlaylistRequest.body, offset, 50)
          : undefined;

        const fetchOptions = {
          method: lastPlaylistRequest.method,
          headers: lastPlaylistRequest.headers,
          body: fetchBody,
        };

        window.postMessage({
          type: 'CULLER_PAGINATION_PROGRESS',
          currentOffset: offset,
          totalExpected: totalExpected,
        }, '*');

        const res = await originalFetch(fetchUrl, fetchOptions);

        // 401 Circuit Breaker
        if (res.status === 401 || res.status === 403) {
          console.warn(`[Culler v2] Token expired at offset ${offset} (status ${res.status}). Stopping cleanly.`);
          window.postMessage({
            type: 'CULLER_AUTH_EXPIRED',
            offset: offset,
            status: res.status,
          }, '*');
          break;
        }

        if (!res.ok) {
          console.warn(`[Culler v2] HTTP error ${res.status} at offset ${offset}. Stopping pagination.`);
          break;
        }

        const payload = await res.json();

        window.postMessage({
          type: 'CULLER_INTERCEPTED_PLAYLIST',
          payload: payload,
          authHeader: lastPlaylistRequest.headers?.['authorization'] || null,
          url: fetchUrl,
          isPaginationBatch: true,
        }, '*');

        // Modest delay (200ms) to respect rate limits
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      window.postMessage({
        type: 'CULLER_PAGINATION_COMPLETE',
        totalExpected: totalExpected,
      }, '*');
    } catch (err) {
      console.error('[Culler v2] Pagination failed:', err);
      window.postMessage({
        type: 'CULLER_PAGINATION_ERROR',
        error: err.message,
      }, '*');
    } finally {
      isPaginating = false;
    }
  }

  // Listen for trigger from content.js
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'CULLER_TRIGGER_PAGINATION') {
      const { startOffset, totalExpected } = event.data;
      runAutoPagination(startOffset || 0, totalExpected || 0);
    } else if (event.data.type === 'CULLER_ABORT_PAGINATION') {
      isPaginating = false;
    }
  });
})();
