/**
 * injected.js — Non-destructive window.fetch interceptor for Spotify GraphQL.
 * Runs in the page's MAIN execution world to monitor Pathfinder responses.
 */

(() => {
  if (window.__culler_injected) return;
  window.__culler_injected = true;

  console.log('[Culler v2] Interceptor attached in MAIN world.');

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');

      if (url.includes('api-partner.spotify.com/pathfinder/v2/query')) {
        // Capture authorization header if present
        let authHeader = null;
        if (args[1] && args[1].headers) {
          const headers = args[1].headers;
          if (typeof headers.get === 'function') {
            authHeader = headers.get('authorization') || headers.get('Authorization');
          } else if (typeof headers === 'object') {
            authHeader = headers['authorization'] || headers['Authorization'];
          }
        }

        // Circuit breaker: Check for 401 unauthorized / expired session token
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
          if (payload && payload.data && (payload.data.playlistV2 || payload.data.playlist)) {
            window.postMessage({
              type: 'CULLER_INTERCEPTED_PLAYLIST',
              payload: payload,
              authHeader: authHeader,
              url: url,
            }, '*');
          }
        }).catch(() => {
          // Non-JSON or streaming response; ignore
        });
      }
    } catch (err) {
      console.warn('[Culler v2] Non-fatal error in fetch interceptor:', err);
    }

    return response;
  };
})();
