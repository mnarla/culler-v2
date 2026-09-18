/**
 * background.js — MV3 Service Worker.
 *
 * Orchestrates extension state, listening telemetry sessions,
 * and calls to Gemini AI for batch predictions and self-calibration.
 */

import { generateContent } from './lib/gemini.js';
import { buildCalibrationPrompt, buildPlaylistProfileHeader, buildBatchScoringPromptForChunk } from './lib/heuristics.js';
import { parsePathfinderPlaylistPayload, mergePlaylistBatches } from './lib/parser.js';
import {
  getApiKey,
  getActiveModel,
  getActiveSession,
  setActiveSession,
  getHeuristicRules,
  setHeuristicRules,
  getCurrentPlaylist,
  setCurrentPlaylist,
  setCullReport,
  getCullReport,
  getReviewedTracks,
  setReviewedTracks,
  getCheckedTracks,
  setCheckedTracks,
  getTelemetryHistory,
  setTelemetryHistory,
} from './lib/storage.js';

console.log('[Culler v2] Background service worker registered.');

// ── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error('[Culler Background] Message error:', err);
      sendResponse({ error: err.message });
    });
  return true; // Keep message port open for async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CULLER_INTERCEPTED_PLAYLIST':
      return onPlaylistIntercepted(message.payload, message.authHeader, message.url, sender?.tab?.url || sender?.url, message.urlPlaylistId);

    case 'CULLER_PLAYLIST_SWITCHED':
      return onPlaylistSwitched(message.fromPlaylistId, message.toPlaylistId);

    case 'CULLER_START_SESSION':
      return onStartSession(message.playlistId, message.playlistName);

    case 'CULLER_PAUSE_SESSION':
      return onPauseSession();

    case 'CULLER_STOP_SESSION':
      return onStopSession();

    case 'CULLER_STOP_AND_GENERATE':
      return onStopAndGenerate();

    case 'CULLER_TRACK_PLAYBACK_EVENT':
      return onTrackPlaybackEvent(message.event);

    case 'CULLER_RUN_BATCH_PREDICTIONS':
      return onRunBatchPredictions();

    case 'CULLER_RUN_CALIBRATION':
      return onRunCalibration();

    case 'CULLER_FETCH_FULL_PLAYLIST':
      return onFetchFullPlaylist(message.startOffset, message.totalExpected);

    case 'CULLER_RECORD_REVIEW':
      return onRecordReview(message.confirmedSkips, message.rejectedSkips);

    default:
      return { status: 'unknown_message_type' };
  }
}

async function onFetchFullPlaylist(startOffset, totalExpected) {
  const tabs = await chrome.tabs.query({ url: '*://open.spotify.com/*' });
  if (!tabs || tabs.length === 0) {
    throw new Error('No open Spotify tab found.');
  }

  const activeTab = tabs.find(t => t.active) || tabs[0];
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(activeTab.id, {
      type: 'CULLER_START_PAGINATION',
      startOffset,
      totalExpected,
    }, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(res);
      }
    });
  });
}

// ── Playlist Switch (URL-level detection, fires before GraphQL response) ──────

/**
 * Called immediately when the user navigates to a different Spotify playlist URL.
 * Fires BEFORE any GraphQL response arrives, so the popup sees a clean slate.
 */
async function onPlaylistSwitched(fromPlaylistId, toPlaylistId) {
  console.log(`[Culler Background] Playlist switch detected: "${fromPlaylistId}" → "${toPlaylistId}". Clearing predictions.`);
  await setCullReport(null);
  await setCheckedTracks({});
  await setCurrentPlaylist(null);
  return { success: true, cleared: true, toPlaylistId };
}

// ── Session Event Handlers ───────────────────────────────────────────────────

async function onStartSession(playlistId, playlistName) {
  const session = {
    isActive: true,
    isPaused: false,
    playlistId: playlistId || null,
    playlistName: playlistName || 'Active Playlist',
    startTime: Date.now(),
    events: [],
  };
  await setActiveSession(session);
  return { success: true, session };
}

async function onPauseSession() {
  const session = await getActiveSession();
  if (!session || !session.isActive) return { success: false, reason: 'no_active_session' };
  session.isPaused = !session.isPaused;
  await setActiveSession(session);
  console.log(`[Culler Background] Session telemetry ${session.isPaused ? 'paused' : 'resumed'}.`);
  return { success: true, isPaused: session.isPaused, session };
}

async function onStopSession() {
  const session = await getActiveSession();
  session.isActive = false;
  session.isPaused = false;
  await setActiveSession(session);
  return { success: true, session };
}

function isAdvertisementEvent(event) {
  if (!event || !event.name) return true;
  const name = (event.name || '').toLowerCase().trim();
  const artist = (event.artist || '').toLowerCase().trim();

  if (
    name === 'advertisement' ||
    name.startsWith('advertisement') ||
    name === 'spotify' ||
    name.includes('spotify ad') ||
    name.includes('audio ad')
  ) {
    return true;
  }

  if (
    artist === 'spotify' ||
    artist === 'advertiser' ||
    artist.includes('advertisement') ||
    artist.includes('spotify ad')
  ) {
    return true;
  }

  return false;
}

function isTrackInPlaylist(event, playlistTracks) {
  if (!playlistTracks || playlistTracks.length === 0) return true;
  const eventName = (event.name || '').toLowerCase().trim();
  const eventArtist = (event.artist || '').toLowerCase().trim();

  return playlistTracks.some(t => {
    const tName = (t.name || '').toLowerCase().trim();
    if (tName === eventName) return true;
    if (tName.includes(eventName) || eventName.includes(tName)) {
      const tArtists = Array.isArray(t.artists)
        ? t.artists.map(a => (a || '').toLowerCase().trim())
        : [(t.artists || '').toLowerCase().trim()];
      if (tArtists.some(a => a && (eventArtist.includes(a) || a.includes(eventArtist)))) {
        return true;
      }
    }
    return false;
  });
}

async function onTrackPlaybackEvent(event) {
  const session = await getActiveSession();
  if (!session || !session.isActive) return { success: false, reason: 'no_active_session' };
  if (session.isPaused) {
    console.log('[Culler Background] Suppressed playback event: session is paused.');
    return { success: false, reason: 'session_paused' };
  }

  // 1. Filter out advertisements
  if (isAdvertisementEvent(event)) {
    console.log('[Culler Background] Suppressed advertisement playback event:', event.name);
    return { success: false, reason: 'ignored_advertisement' };
  }

  // 2. Filter out tracks not in active playlist
  const playlist = await getCurrentPlaylist();
  if (playlist && Array.isArray(playlist.tracks) && playlist.tracks.length > 0) {
    if (!isTrackInPlaylist(event, playlist.tracks)) {
      console.log('[Culler Background] Suppressed external track outside active playlist:', event.name, event.artist);
      return { success: false, reason: 'outside_active_playlist' };
    }
  }

  // Append new event and purge any previously recorded ad events
  session.events = (session.events || []).filter(e => !isAdvertisementEvent(e));
  session.events.push(event);
  await setActiveSession(session);

  // Accumulate cumulative telemetry history (scoped per playlist)
  const allHistory = await getTelemetryHistory();
  const pid = session.playlistId || '__global__';
  if (!allHistory[pid]) allHistory[pid] = []; // ponytail: flat array fallback not needed, playlistId always present when session is active
  allHistory[pid].push(event);
  await setTelemetryHistory(allHistory);

  return { success: true, count: session.events.length };
}

async function onPlaylistIntercepted(rawPayload, authHeader, requestUrl, tabUrl, urlPlaylistId) {
  const batch = parsePathfinderPlaylistPayload(rawPayload);

  // If this specific query doesn't match, do not overwrite any already-loaded valid playlist
  if (batch.schemaMismatch) {
    console.warn('[Culler Background] Unrecognized Pathfinder query shape (ignored):', batch.warnings);
    return { success: false, schemaMismatch: true, warnings: batch.warnings };
  }

  // Resolve playlist ID: prefer GraphQL-extracted ID, then the URL from the page (most reliable),
  // then regex-fallback from the request/tab URL
  if (!batch.playlistId) {
    if (urlPlaylistId) {
      batch.playlistId = urlPlaylistId;
    } else {
      const urlToCheck = requestUrl || tabUrl || '';
      const match = urlToCheck.match(/playlist[/:]([a-zA-Z0-9]{22})/);
      if (match && match[1]) {
        batch.playlistId = match[1];
      }
    }
  }

  const existing = await getCurrentPlaylist();

  // Reset if navigating to a completely different playlist ID
  const isDifferentPlaylist = Boolean(
    existing &&
    existing.playlistId &&
    batch.playlistId &&
    existing.playlistId !== batch.playlistId
  );

  let merged;
  if (!existing || isDifferentPlaylist) {
    merged = batch;
    // Wipe previous playlist's cull report & checked tracks so they never bleed over!
    if (isDifferentPlaylist) {
      console.log(`[Culler Background] Switching playlist: "${existing.playlistId}" -> "${batch.playlistId}". Clearing old predictions.`);
      await setCullReport(null);
      await setCheckedTracks({});
    }
  } else {
    merged = mergePlaylistBatches(existing, batch);
  }

  await setCurrentPlaylist({
    ...merged,
    authHeader: authHeader || existing?.authHeader,
    updatedAt: Date.now(),
  });

  const title = merged.name || merged.playlistName || 'Active Playlist';
  const trackCount = merged.tracks ? merged.tracks.length : 0;
  console.log(`[Culler Background] Playlist "${title}" — ${trackCount} tracks stored.`);
  return { success: true, trackCount: trackCount, playlistName: title };
}

// ── Gemini AI Actions ────────────────────────────────────────────────────────

async function onRecordReview(confirmedSkips = [], rejectedSkips = []) {
  const reviewed = await getReviewedTracks();

  const newCulled = [...(reviewed.culled || [])];
  confirmedSkips.forEach(track => {
    const key = track.uid || track.uri || `${track.name}::${track.artist}`;
    if (!newCulled.includes(key)) newCulled.push(key);
  });

  const newKept = [...(reviewed.kept || [])];
  rejectedSkips.forEach(track => {
    const exists = newKept.some(k => (k.uid || k.name) === (track.uid || track.name) && k.artist === track.artist);
    if (!exists) newKept.push({ name: track.name, artist: track.artist, uid: track.uid, uri: track.uri, reason: track.reason });
  });

  await setReviewedTracks({ culled: newCulled, kept: newKept });

  console.log(`[Culler Background] Recorded review: ${confirmedSkips.length} culled, ${rejectedSkips.length} kept as overrides.`);
  return { success: true, totalCulled: newCulled.length, totalKept: newKept.length };
}

async function onRunBatchPredictions() {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('Gemini API key is not configured. Please add it in settings.');

  const model = await getActiveModel();
  const playlist = await getCurrentPlaylist();
  const activeRules = await getHeuristicRules();

  if (!playlist || !playlist.tracks || playlist.tracks.length === 0) {
    throw new Error('No playlist tracks loaded yet. Please open a playlist on Spotify first.');
  }

  // Safe exclusion filtering: only hard-protect explicitly kept tracks
  const allHistory = await getTelemetryHistory();
  const history = allHistory[playlist.playlistId] || [];
  const reviewed = await getReviewedTracks();
  const keptKeys = new Set();
  
  (reviewed.kept || []).forEach(k => {
    if (k.uid) keptKeys.add(k.uid);
    if (k.uri) keptKeys.add(k.uri);
    if (k.name && k.artist) keptKeys.add(`${k.name}::${k.artist}`.toLowerCase());
  });

  history.forEach(e => {
    if (e.percentPlayed > 65) {
      if (e.uid) keptKeys.add(e.uid);
      if (e.uri) keptKeys.add(e.uri);
      if (e.name && e.artist) keptKeys.add(`${e.name}::${e.artist}`.toLowerCase());
    }
  });

  const candidateTracks = playlist.tracks.filter(t => {
    const uid = t.uid || t.uri;
    const nameKey = t.name && t.artists ? `${t.name}::${Array.isArray(t.artists) ? t.artists.join(', ') : t.artists}`.toLowerCase() : null;
    
    if (uid && keptKeys.has(uid)) return false;
    if (nameKey && keptKeys.has(nameKey)) return false;
    return true;
  });

  if (candidateTracks.length === 0) {
    await setCullReport({
      playlistName: playlist.name || playlist.playlistName,
      timestamp: Date.now(),
      predictions: [],
      allReviewed: true,
    });
    return { success: true, predictions: [], allReviewed: true };
  }

  const playlistTitle = playlist.name || playlist.playlistName || 'Playlist';
  
  const CHUNK_SIZE = 175;
  const chunks = [];
  for (let i = 0; i < candidateTracks.length; i += CHUNK_SIZE) {
    chunks.push(candidateTracks.slice(i, i + CHUNK_SIZE));
  }
  
  const profile = buildPlaylistProfileHeader(candidateTracks);

  console.log(`[Culler Background] Running full scan on ${candidateTracks.length} tracks in ${chunks.length} chunks.`);

  const chunkResults = await Promise.all(
    chunks.map(chunk => {
      const prompt = buildBatchScoringPromptForChunk(chunk, activeRules, playlistTitle, profile);
      return generateContent(prompt, apiKey, { model });
    })
  );

  let normalizedSkips = [];
  chunkResults.forEach(predictions => {
    let skips = predictions;
    if (!Array.isArray(skips) && typeof skips === 'object' && skips !== null) {
      skips = skips.predictions || skips.skips || skips.tracks || [];
    }
    if (Array.isArray(skips)) {
      normalizedSkips.push(...skips);
    }
  });

  // Deduplicate by originalIndex (in case of overlap or weirdness)
  const uniqueSkipsMap = new Map();
  normalizedSkips.forEach(s => {
    if (s && s.originalIndex && !uniqueSkipsMap.has(s.originalIndex)) {
      uniqueSkipsMap.set(s.originalIndex, s);
    } else if (s && !s.originalIndex) {
      uniqueSkipsMap.set(Math.random(), s);
    }
  });
  normalizedSkips = Array.from(uniqueSkipsMap.values());

  // Attach URI/UID, restore checked state, and detect newly-appearing predictions
  const trackByPos = new Map((playlist.tracks || []).map(t => [t.originalIndex, t]));
  const trackByName = new Map((playlist.tracks || []).map(t => {
    const a = Array.isArray(t.artists) ? t.artists.join(', ') : (t.artists || '');
    return [`${t.name}::${a}`.toLowerCase(), t];
  }));

  const checkedMap = await getCheckedTracks();
  const prevReport = await getCullReport();
  
  // Only consider prevReport if it belongs to THIS same playlist!
  const isSamePlaylistReport = Boolean(
    prevReport &&
    ((prevReport.playlistId && prevReport.playlistId === playlist.playlistId) ||
     (!prevReport.playlistId && prevReport.playlistName === playlistTitle))
  );

  const prevUids = new Set(
    (isSamePlaylistReport ? prevReport?.predictions || [] : []).map(p => p.uid || p.uri || `${p.name}::${p.artist}`)
  );
  const isReScan = Boolean(isSamePlaylistReport && Array.isArray(prevReport?.predictions) && prevReport.predictions.length > 0);

  normalizedSkips.forEach(s => {
    // 1. Resolve URI & UID
    const match = trackByPos.get(Number(s.originalIndex)) ||
                  trackByName.get(`${s.name}::${s.artist}`.toLowerCase());
    s.uri = match?.uri || `spotify:track:${s.name}::${s.artist}`;
    s.uid = s.uri;

    // 2. Normalize confidence and tier
    s.confidence = Number(s.confidence) || 60;
    const rawTier = s.tier ? String(s.tier).toUpperCase().replace(/\s+/g, '-') : '';
    if (rawTier.includes('HIGH') || (!s.tier && s.confidence >= 80)) {
      s.tier = 'HIGH';
    } else if (rawTier.includes('MOD') || (!s.tier && s.confidence >= 60)) {
      s.tier = 'MODERATE';
    } else {
      s.tier = 'WORTH-REVIEWING';
    }

    // 3. Mark newly-appearing predictions if this is a re-scan
    const key = s.uid || `${s.name}::${s.artist}`;
    s.isNew = Boolean(isReScan && !prevUids.has(key));

    // 4. Persist checked state across sessions, defaulting HIGH tier to checked
    if (checkedMap[s.uid] !== undefined) {
      s.checked = Boolean(checkedMap[s.uid]);
    } else if (checkedMap[key] !== undefined) {
      s.checked = Boolean(checkedMap[key]);
    } else {
      s.checked = (s.tier === 'HIGH');
    }
  });

  // 5. Merge new predictions only with same-playlist existing report predictions
  const combinedMap = new Map();
  if (isSamePlaylistReport) {
    (prevReport?.predictions || []).forEach(p => {
      const key = (p.uid || p.uri || `${p.name}::${p.artist}`).toLowerCase().trim();
      combinedMap.set(key, { ...p, isNew: false });
    });
  }

  normalizedSkips.forEach(s => {
    const key = (s.uid || s.uri || `${s.name}::${s.artist}`).toLowerCase().trim();
    if (combinedMap.has(key)) {
      const existing = combinedMap.get(key);
      combinedMap.set(key, {
        ...existing,
        confidence: s.confidence,
        tier: s.tier,
        reason: s.reason,
        checked: existing.checked !== undefined ? existing.checked : s.checked,
        isNew: false,
      });
    } else {
      combinedMap.set(key, s);
    }
  });

  const finalList = Array.from(combinedMap.values());

  // 6. Sort: Tiers (HIGH -> MOD -> REVIEW), with newly-appearing predictions sorted to top within their tier
  const tierWeight = { 'HIGH': 3, 'MODERATE': 2, 'WORTH-REVIEWING': 1 };
  finalList.sort((a, b) => {
    const tierDiff = (tierWeight[b.tier] || 0) - (tierWeight[a.tier] || 0);
    if (tierDiff !== 0) return tierDiff;
    if (b.isNew && !a.isNew) return 1;
    if (a.isNew && !b.isNew) return -1;
    return (b.confidence || 0) - (a.confidence || 0);
  });

  await setCullReport({
    playlistId: playlist.playlistId,
    playlistName: playlistTitle,
    timestamp: Date.now(),
    predictions: finalList,
  });

  return { success: true, predictions: finalList };
}

async function onStopAndGenerate() {
  const session = await getActiveSession();
  let calibrated = false;

  // 1. If we have listening session telemetry or review overrides, calibrate heuristics first
  if (session && session.events && session.events.length > 0) {
    try {
      await onRunCalibration();
      calibrated = true;
    } catch (calErr) {
      console.warn('[Culler Background] Auto-calibration skipped/warned:', calErr.message);
    }
  }

  // 2. Stop the session
  if (session) {
    session.isActive = false;
    await setActiveSession(session);
  }

  // 3. Run batch predictions with freshly calibrated or fallback rules
  const predResult = await onRunBatchPredictions();

  return {
    success: true,
    calibrated,
    predictions: predResult.predictions || [],
  };
}

async function onRunCalibration() {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('Gemini API key is not configured.');

  const model = await getActiveModel();
  const session = await getActiveSession();
  const currentRules = await getHeuristicRules();
  const reviewed = await getReviewedTracks();

  const hasSessionEvents = session && session.events && session.events.length > 0;
  const hasUserOverrides = reviewed && reviewed.kept && reviewed.kept.length > 0;
  const allHistory = await getTelemetryHistory();
  const history = allHistory[session?.playlistId] || [];

  if (!hasSessionEvents && !hasUserOverrides && (!history || history.length === 0)) {
    throw new Error('No listening telemetry or review feedback available to calibrate from.');
  }

  // Merge session events and telemetry history
  const allEvents = [...history, ...(session?.events || [])];
  
  // Deduplicate by timestamp
  const uniqueEventsMap = new Map();
  allEvents.forEach(e => {
    if (e.timestamp) {
      uniqueEventsMap.set(e.timestamp, e);
    } else {
      uniqueEventsMap.set(Math.random(), e);
    }
  });
  const mergedEvents = Array.from(uniqueEventsMap.values());

  // Pass reviewed.kept as explicit active-learning negative feedback
  const prompt = buildCalibrationPrompt({ events: mergedEvents }, currentRules, reviewed.kept || []);
  const result = await generateContent(prompt, apiKey, { model });

  if (result && Array.isArray(result.updatedRules)) {
    await setHeuristicRules(result.updatedRules);
    console.log('[Culler Background] Calibrated rules updated:', result.updatedRules);
  }

  return { success: true, calibration: result };
}
