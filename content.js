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
      url: event.data.url,
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

// ── Continuous Auto-Scroller to Track in Spotify ─────────────────────────────

let activeAutoScrollTimer = null;

function getSpotifyScrollContainer() {
  // Directly finds the scrollable container that contains the playlist rows
  const allDivs = document.querySelectorAll('div');
  for (const el of allDivs) {
    if (el.scrollHeight > el.clientHeight && el.clientHeight > 200) {
      if (el.querySelector('[data-testid="tracklist-row"], [data-testid="playlist-page"]')) {
        return el;
      }
    }
  }

  // Fallback: walk up from a tracklist row
  const row = document.querySelector('[data-testid="tracklist-row"]');
  if (row) {
    let p = row.parentElement;
    while (p && p !== document.body) {
      if (p.scrollHeight > p.clientHeight + 20) {
        return p;
      }
      p = p.parentElement;
    }
  }

  return document.querySelector('main') || document.documentElement;
}

async function scrollToTrack(name, artist, originalIndex) {
  if (activeAutoScrollTimer) {
    clearTimeout(activeAutoScrollTimer);
    activeAutoScrollTimer = null;
  }

  const cleanName = (name || '').trim();
  const needle = cleanName.toLowerCase();
  const cleanArtist = (artist || '').toLowerCase().trim();
  const targetIndex = Number(originalIndex);

  const getMainRoot = () => document.querySelector('main, #main, [data-testid="playlist-page"]') || document;

  const findRow = () => {
    const rows = getMainRoot().querySelectorAll('[data-testid="tracklist-row"]');
    for (const row of rows) {
      const nameEl = row.querySelector('[data-testid="internal-track-link"] span, [data-testid="internal-track-link"], a[href*="/track/"]');
      if (nameEl) {
        const text = nameEl.textContent.toLowerCase().trim();
        if (text === needle || text.includes(needle) || needle.includes(text)) {
          return row;
        }
      }
      const rowText = row.textContent.toLowerCase();
      if (rowText.includes(needle)) {
        if (!cleanArtist || rowText.includes(cleanArtist)) {
          return row;
        }
      }
    }
    return null;
  };

  const highlightRow = (row) => {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.style.outline = '3px solid #1ed760';
    row.style.boxShadow = '0 0 25px rgba(30, 215, 96, 0.85)';
    row.style.borderRadius = '4px';
    row.style.transition = 'all 0.3s ease-in-out';

    // 1. Simulate mouse hover so Spotify renders action buttons
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

    // 2. Open Spotify's native context menu
    setTimeout(() => {
      // Strategy A: Find the explicit "More options" button (···) inside this row and click it
      const moreBtn = row.querySelector('button[data-testid="more-button"], button[aria-label*="More options" i], button[aria-label*="More" i]');
      if (moreBtn) {
        moreBtn.click();
      } else {
        // Strategy B: Dispatch a native right-click (contextmenu) event on the row
        const rect = row.getBoundingClientRect();
        const clientX = rect.left + rect.width * 0.5;
        const clientY = rect.top + rect.height * 0.5;

        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX,
          clientY,
          button: 2
        }));
      }
    }, 450);

    setTimeout(() => {
      row.style.outline = '';
      row.style.boxShadow = '';
      row.style.borderRadius = '';
    }, 4000);
  };

  // 1. If track is already rendered, highlight immediately
  let found = findRow();
  if (found) {
    highlightRow(found);
    return;
  }

  // 2. Locate the Spotify scroll container (guaranteed to be the main view)
  const container = getSpotifyScrollContainer();
  if (!container) return;

  // 3. Continuous bi-directional auto-scroll loop
  const getRenderedIndices = () => {
    const rows = getMainRoot().querySelectorAll('[data-testid="tracklist-row"]');
    let min = Infinity, max = -Infinity;
    rows.forEach(r => {
      // Check column 1 number (human track index like "12", "45")
      const col1 = r.querySelector('[aria-colindex="1"] span, [aria-colindex="1"]');
      const textNum = parseInt((col1?.textContent || '').trim(), 10);
      if (!isNaN(textNum) && textNum > 0) {
        if (textNum < min) min = textNum;
        if (textNum > max) max = textNum;
      }

      // Check aria-rowindex
      const ariaRow = r.getAttribute('aria-rowindex');
      if (ariaRow) {
        const idx = parseInt(ariaRow, 10) - 1; // row 1 is header
        if (!isNaN(idx) && idx > 0) {
          if (idx < min) min = idx;
          if (idx > max) max = idx;
        }
      }
    });
    return { min, max };
  };

  // Determine smart initial direction
  let dir = 1;
  const initial = getRenderedIndices();
  if (targetIndex > 0 && initial.min !== Infinity) {
    if (targetIndex < initial.min) {
      dir = -1; // Target is above us -> scroll UP!
    } else {
      dir = 1;  // Target is below us -> scroll DOWN!
    }
  } else if (container.scrollTop > 500 && targetIndex && targetIndex < 30) {
    dir = -1;
  }

  const startTime = Date.now();
  const maxDurationMs = 12000; // max 12 seconds auto-scrolling
  let stuckCount = 0;
  let hasBounced = false; // allow reversing direction once if we hit an edge

  return new Promise((resolve) => {
    const scrollStep = () => {
      // Check if found in DOM
      found = findRow();
      if (found) {
        activeAutoScrollTimer = null;
        highlightRow(found);
        resolve(true);
        return;
      }

      if (Date.now() - startTime > maxDurationMs) {
        activeAutoScrollTimer = null;
        console.warn(`[Culler v2] Auto-scroll timed out looking for: ${cleanName}`);
        resolve(false);
        return;
      }

      const stepPx = dir * 340;

      // Move scroll position directly
      const prevTop = container.scrollTop;
      container.scrollTop += stepPx;
      container.dispatchEvent(new Event('scroll', { bubbles: true }));

      // Detect edge collisions (top or bottom)
      const isAtTop = container.scrollTop <= 5;
      const isAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 15;
      const isStuck = Math.abs(container.scrollTop - prevTop) < 2;

      if ((isAtTop && dir === -1) || (isAtBottom && dir === 1) || isStuck) {
        stuckCount++;
        if (stuckCount >= 6) {
          if (!hasBounced) {
            // Reverse direction to sweep the other way!
            hasBounced = true;
            dir = -dir;
            stuckCount = 0;
          } else {
            // We swept in both directions and hit the edge: stop
            activeAutoScrollTimer = null;
            console.warn(`[Culler v2] Sweep completed without finding: ${cleanName}`);
            resolve(false);
            return;
          }
        }
      } else {
        stuckCount = 0;
      }

      // Schedule next scroll tick (~35ms for optimal DOM updates)
      activeAutoScrollTimer = setTimeout(scrollStep, 35);
    };

    activeAutoScrollTimer = setTimeout(scrollStep, 35);
  });
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
