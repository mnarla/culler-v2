/**
 * background.js — MV3 Service Worker.
 *
 * Orchestrates extension state, listening telemetry sessions,
 * and calls to Gemini AI for batch predictions and self-calibration.
 */

import { generateContent } from './lib/gemini.js';
import { buildBatchScoringPrompt, buildCalibrationPrompt } from './lib/heuristics.js';
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
      return onPlaylistIntercepted(message.payload, message.authHeader);

    case 'CULLER_START_SESSION':
      return onStartSession(message.playlistId, message.playlistName);

    case 'CULLER_STOP_SESSION':
      return onStopSession();

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

// ── Session Event Handlers ───────────────────────────────────────────────────

async function onStartSession(playlistId, playlistName) {
  const session = {
    isActive: true,
    playlistId: playlistId || null,
    playlistName: playlistName || 'Active Playlist',
    startTime: Date.now(),
    events: [],
  };
  await setActiveSession(session);
  return { success: true, session };
}

async function onStopSession() {
  const session = await getActiveSession();
  session.isActive = false;
  await setActiveSession(session);
  return { success: true, session };
}

async function onTrackPlaybackEvent(event) {
  const session = await getActiveSession();
  if (!session || !session.isActive) return { success: false, reason: 'no_active_session' };

  // Append new event
  session.events = session.events || [];
  session.events.push(event);
  await setActiveSession(session);
  return { success: true, count: session.events.length };
}

async function onPlaylistIntercepted(rawPayload, authHeader) {
  const batch = parsePathfinderPlaylistPayload(rawPayload);

  // If this specific query doesn't match, do not overwrite any already-loaded valid playlist
  if (batch.schemaMismatch) {
    console.warn('[Culler Background] Unrecognized Pathfinder query shape (ignored):', batch.warnings);
    return { success: false, schemaMismatch: true, warnings: batch.warnings };
  }

  const existing = await getCurrentPlaylist();

  // Reset if navigating to a completely different playlist ID
  const isDifferentPlaylist = existing && existing.playlistId && batch.playlistId && existing.playlistId !== batch.playlistId;

  let merged;
  if (!existing || isDifferentPlaylist) {
    merged = batch;
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
    const key = `${track.name}::${track.artist}`;
    if (!newCulled.includes(key)) newCulled.push(key);
  });

  const newKept = [...(reviewed.kept || [])];
  rejectedSkips.forEach(track => {
    const exists = newKept.some(k => k.name === track.name && k.artist === track.artist);
    if (!exists) newKept.push({ name: track.name, artist: track.artist, reason: track.reason });
  });

  await setReviewedTracks({ culled: newCulled, kept: newKept });
  await setCullReport(null);

  console.log(`[Culler Background] Recorded review: ${confirmedSkips.length} culled, ${rejectedSkips.length} kept as overrides.`);
  return { success: true, totalCulled: newCulled.length, totalKept: newKept.length };
}

async function onRunBatchPredictions() {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('Gemini API key is not configured. Please add it in settings.');

  const model = await getActiveModel();
  const playlist = await getCurrentPlaylist();
  const activeRules = await getHeuristicRules();
  const reviewed = await getReviewedTracks();

  if (!playlist || !playlist.tracks || playlist.tracks.length === 0) {
    throw new Error('No playlist tracks loaded yet. Please open a playlist on Spotify first.');
  }

  // Exclude tracks that user has already confirmed to cull or explicitly kept
  const culledSet = new Set(reviewed.culled || []);
  const keptSet = new Set((reviewed.kept || []).map(k => `${k.name}::${k.artist}`));

  const candidateTracks = playlist.tracks.filter(t => {
    const artistStr = Array.isArray(t.artists) ? t.artists.join(', ') : (t.artists || 'Unknown');
    const key = `${t.name}::${artistStr}`;
    return !culledSet.has(key) && !keptSet.has(key);
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
  const prompt = buildBatchScoringPrompt(candidateTracks, activeRules, playlistTitle);
  const predictions = await generateContent(prompt, apiKey, { model });

  let normalizedSkips = predictions;
  if (!Array.isArray(normalizedSkips) && typeof normalizedSkips === 'object' && normalizedSkips !== null) {
    normalizedSkips = normalizedSkips.predictions || normalizedSkips.skips || normalizedSkips.tracks || [];
  }
  if (!Array.isArray(normalizedSkips)) {
    normalizedSkips = [];
  }

  // Filter out any matches against culled/kept sets
  normalizedSkips = normalizedSkips.filter(s => {
    const key = `${s.name}::${s.artist}`;
    return !culledSet.has(key) && !keptSet.has(key);
  });

  await setCullReport({
    playlistName: playlistTitle,
    timestamp: Date.now(),
    predictions: normalizedSkips,
  });

  return { success: true, predictions: normalizedSkips };
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

  if (!hasSessionEvents && !hasUserOverrides) {
    throw new Error('No listening telemetry or review feedback available to calibrate from.');
  }

  // Pass reviewed.kept as explicit active-learning negative feedback
  const prompt = buildCalibrationPrompt(session || { events: [] }, currentRules, reviewed.kept || []);
  const result = await generateContent(prompt, apiKey, { model });

  if (result && Array.isArray(result.updatedRules)) {
    await setHeuristicRules(result.updatedRules);
    console.log('[Culler Background] Calibrated rules updated:', result.updatedRules);
  }

  return { success: true, calibration: result };
}
