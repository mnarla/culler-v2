/**
 * background.js — MV3 Service Worker.
 *
 * Orchestrates extension state, listening telemetry sessions,
 * and calls to Gemini AI for batch predictions and self-calibration.
 */

import { generateContent } from './lib/gemini.js';
import { buildBatchScoringPrompt, buildCalibrationPrompt } from './lib/heuristics.js';
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

    default:
      return { status: 'unknown_message_type' };
  }
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
  // Store raw payload temporarily until parser.js is integrated in next step
  await setCurrentPlaylist({
    rawPayload: rawPayload,
    authHeader: authHeader,
    updatedAt: Date.now(),
  });
  return { success: true };
}

// ── Gemini AI Actions ────────────────────────────────────────────────────────

async function onRunBatchPredictions() {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('Gemini API key is not configured. Please add it in settings.');

  const model = await getActiveModel();
  const playlist = await getCurrentPlaylist();
  const activeRules = await getHeuristicRules();

  if (!playlist || !playlist.tracks || playlist.tracks.length === 0) {
    throw new Error('No playlist tracks loaded yet. Please open a playlist on Spotify first.');
  }

  const prompt = buildBatchScoringPrompt(playlist.tracks, activeRules, playlist.name);
  const predictions = await generateContent(prompt, apiKey, { model });

  await setCullReport({
    playlistName: playlist.name,
    timestamp: Date.now(),
    predictions: predictions,
  });

  return { success: true, predictions };
}

async function onRunCalibration() {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('Gemini API key is not configured.');

  const model = await getActiveModel();
  const session = await getActiveSession();
  const currentRules = await getHeuristicRules();

  if (!session || !session.events || session.events.length === 0) {
    throw new Error('No listening telemetry collected in this session to calibrate from.');
  }

  const prompt = buildCalibrationPrompt(session, currentRules);
  const result = await generateContent(prompt, apiKey, { model });

  if (result && Array.isArray(result.updatedRules)) {
    await setHeuristicRules(result.updatedRules);
  }

  return { success: true, calibration: result };
}
