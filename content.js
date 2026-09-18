/**
 * content.js — Isolated world bridge and DOM telemetry monitor.
 *
 * 1. Receives intercepted GraphQL payloads from injected.js via window.postMessage.
 * 2. Relays payloads and auth status to background service worker.
 * 3. Observes player bar DOM for track transitions and play duration during active sessions.
 */

console.log('[Culler v2] Content script initialized.');

// ── Safe Runtime Messaging (Guard against Extension Context Invalidated) ─────

function safeSendMessage(msg) {
  if (!chrome.runtime?.id) {
    // Extension was reloaded or updated; context invalidated
    return;
  }
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});
    }
  } catch (e) {
    // Suppress synchronous context invalidation errors
  }
}

// ── Bridge: Listen to messages from injected.js (MAIN world) ────────────────

window.addEventListener('message', (event) => {
  // Only accept messages from same origin
  if (event.source !== window || !event.data || !event.data.type) return;

  if (event.data.type === 'CULLER_INTERCEPTED_PLAYLIST') {
    safeSendMessage({
      type: 'CULLER_INTERCEPTED_PLAYLIST',
      payload: event.data.payload,
      authHeader: event.data.authHeader,
    });
  } else if (event.data.type === 'CULLER_AUTH_EXPIRED') {
    safeSendMessage({
      type: 'CULLER_AUTH_EXPIRED',
    });
  } else if (
    event.data.type === 'CULLER_PAGINATION_PROGRESS' ||
    event.data.type === 'CULLER_PAGINATION_COMPLETE' ||
    event.data.type === 'CULLER_PAGINATION_ERROR'
  ) {
    safeSendMessage(event.data);
  }
});

// Listen for pagination commands from background or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CULLER_START_PAGINATION') {
    window.postMessage({
      type: 'CULLER_TRIGGER_PAGINATION',
      startOffset: message.startOffset,
      totalExpected: message.totalExpected,
    }, '*');
    sendResponse({ status: 'started' });
  } else if (message.type === 'CULLER_STOP_PAGINATION') {
    window.postMessage({ type: 'CULLER_ABORT_PAGINATION' }, '*');
    sendResponse({ status: 'stopped' });
  } else if (message.type === 'CULLER_SCROLL_TO_TRACK') {
    scrollToTrack(message.name, message.artist, message.originalIndex);
    sendResponse({ status: 'scrolled' });
  }
});

// ── Scroll to Track ──────────────────────────────────────────────────────────

async function scrollToTrack(name, artist, originalIndex) {
  const needle = (name || '').toLowerCase().trim();

  // Helper to find the row if it exists in DOM
  const findRow = () => {
    const rows = document.querySelectorAll('[data-testid="tracklist-row"]');
    for (const row of rows) {
      const nameEl = row.querySelector('[data-testid="internal-track-link"] span, a[href*="/track/"]');
      if (nameEl && nameEl.textContent.toLowerCase().trim() === needle) return row;
    }
    for (const row of rows) {
      if (row.textContent.toLowerCase().includes(needle)) return row;
    }
    return null;
  };

  let found = findRow();

  // If not found in DOM and we have an index, force scroll the virtual container
  if (!found && typeof originalIndex === 'number' && originalIndex > 0) {
    const scrollContainer = document.querySelector('.os-viewport') || window;
    // Spotify playlist rows are exactly 56px high. originalIndex is 1-based.
    const estimatedTop = (originalIndex - 1) * 56;
    
    if (scrollContainer.scrollTo) {
      scrollContainer.scrollTo({ top: Math.max(0, estimatedTop - 200), behavior: 'smooth' });
    }
    
    // Wait for Spotify's React tree to mount the virtual rows
    await new Promise(r => setTimeout(r, 600));
    found = findRow();
  }

  if (found) {
    found.scrollIntoView({ behavior: 'smooth', block: 'center' });
    found.style.outline = '2px solid #1ed760';
    found.style.borderRadius = '4px';
    setTimeout(() => {
      found.style.outline = '';
      found.style.borderRadius = '';
    }, 2500);
  }
}

// ── DOM Playback Telemetry ───────────────────────────────────────────────────

let currentTrackState = {
  title: null,
  artist: null,
  maxPositionSec: 0,
  durationSec: null,
};

let activeSession = null;

// Sync session state from storage
async function refreshSessionState() {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  chrome.storage.local.get(['culler_active_session'], (result) => {
    activeSession = result.culler_active_session || null;
  });
}

refreshSessionState();

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.culler_active_session) {
    activeSession = changes.culler_active_session.newValue;
  }
});

function isAdvertisement(title, artist) {
  if (!title) return true;
  const t = title.toLowerCase().trim();
  const a = (artist || '').toLowerCase().trim();

  // Keyword check
  if (
    t === 'advertisement' ||
    t.startsWith('advertisement') ||
    t === 'spotify' ||
    t.includes('spotify ad') ||
    t.includes('audio ad')
  ) {
    return true;
  }

  if (
    a === 'spotify' ||
    a === 'advertiser' ||
    a.includes('advertisement') ||
    a.includes('spotify ad')
  ) {
    return true;
  }

  // DOM indicator checks
  if (typeof document !== 'undefined') {
    if (document.querySelector('[aria-label*="advertisement" i], [data-testid="track-info-advertiser"], [data-testid="ad-indicator"]')) {
      return true;
    }
    const widget = document.querySelector('[data-testid="now-playing-widget"]');
    if (widget) {
      if (widget.querySelector('a[href*="/ad/"], a[href*="advertiser"], a[href*="spotify:ad"]')) {
        return true;
      }
    }
  }

  return false;
}

// Poll player bar periodically (every 1s) to track progress reliably without DOM overload
const telemetryTimer = setInterval(() => {
  if (!chrome.runtime?.id) {
    clearInterval(telemetryTimer);
    return;
  }
  if (!activeSession || !activeSession.isActive || activeSession.isPaused) {
    if (activeSession?.isPaused && currentTrackState.title) {
      currentTrackState = {
        title: null,
        artist: null,
        maxPositionSec: 0,
        durationSec: null,
      };
    }
    return;
  }

  const titleEl = document.querySelector('[data-testid="context-item-info-title"]');
  const artistEl = document.querySelector('[data-testid="context-item-info-artist"]');
  const posEl = document.querySelector('[data-testid="playback-position"]');
  const durEl = document.querySelector('[data-testid="playback-duration"]');

  if (!titleEl || !posEl) return;

  const title = titleEl.textContent?.trim();
  const artist = artistEl?.textContent?.trim() || 'Unknown';
  const posText = posEl.textContent?.trim();
  const durText = durEl?.textContent?.trim();

  const isCurrentAd = isAdvertisement(title, artist);

  // Detect track change
  if (title && title !== currentTrackState.title) {
    // If previous track had play history, report its completion/skip
    if (currentTrackState.title && currentTrackState.durationSec) {
      evaluateAndReportTrack(currentTrackState);
    }

    // Reset state for new track
    currentTrackState = {
      title: title,
      artist: artist,
      maxPositionSec: 0,
      durationSec: parseSeconds(durText),
      isAd: isCurrentAd,
    };
  }

  if (isCurrentAd) {
    currentTrackState.isAd = true;
  }

  // Update playback position
  const currentPos = parseSeconds(posText);
  if (currentPos !== null && currentPos > currentTrackState.maxPositionSec) {
    currentTrackState.maxPositionSec = currentPos;
  }

  if (durText && !currentTrackState.durationSec) {
    currentTrackState.durationSec = parseSeconds(durText);
  }
}, 1000);

function parseSeconds(str) {
  if (!str || str === '-:--' || str === '--:--') return null;
  const parts = str.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function evaluateAndReportTrack(trackState) {
  if (!trackState || !trackState.title) return;
  if (activeSession?.isPaused) return;

  // Silently drop advertisements
  if (trackState.isAd || isAdvertisement(trackState.title, trackState.artist)) {
    console.log('[Culler Telemetry] Suppressed ad playback event:', trackState.title);
    return;
  }

  if (!trackState.durationSec || trackState.durationSec <= 0) return;

  const pctPlayed = (trackState.maxPositionSec / trackState.durationSec) * 100;

  // Thresholds: < 20% = SKIP, > 65% = KEEP
  let eventType = null;
  if (pctPlayed < 20) {
    eventType = 'SKIP';
  } else if (pctPlayed > 65) {
    eventType = 'KEEP';
  }

  if (eventType) {
    safeSendMessage({
      type: 'CULLER_TRACK_PLAYBACK_EVENT',
      event: {
        name: trackState.title,
        artist: trackState.artist,
        event: eventType,
        percentPlayed: Math.round(pctPlayed),
        timestamp: Date.now(),
      }
    });
  }
}
