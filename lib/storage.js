/**
 * storage.js — Helper for chrome.storage.local using native MV3 Promises.
 */

import { STORAGE_KEYS, MODEL_DEFAULTS } from '../config/constants.js';

export async function getStorageItem(key, defaultValue = null) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return defaultValue;
  try {
    const res = await chrome.storage.local.get(key);
    return res[key] !== undefined ? res[key] : defaultValue;
  } catch (err) {
    console.error(`[Culler Storage] Error reading "${key}":`, err);
    return defaultValue;
  }
}

export async function setStorageItem(key, value) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch (err) {
    console.error(`[Culler Storage] Error writing "${key}":`, err);
  }
}

// ── Strongly-typed storage getters & setters ───────────────────────────────────

export const getApiKey = () => getStorageItem(STORAGE_KEYS.GEMINI_API_KEY, '');
export const setApiKey = (key) => setStorageItem(STORAGE_KEYS.GEMINI_API_KEY, (key || '').trim());

export const getActiveModel = () => getStorageItem(STORAGE_KEYS.ACTIVE_MODEL, MODEL_DEFAULTS.DEFAULT_MODEL);

export const getCurrentPlaylist = () => getStorageItem(STORAGE_KEYS.CURRENT_PLAYLIST, null);
export const setCurrentPlaylist = (data) => setStorageItem(STORAGE_KEYS.CURRENT_PLAYLIST, data);

export const getActiveSession = () => getStorageItem(STORAGE_KEYS.ACTIVE_SESSION, {
  isActive: false,
  isPaused: false,
  playlistId: null,
  playlistName: '',
  startTime: null,
  events: [],
});
export const setActiveSession = (data) => setStorageItem(STORAGE_KEYS.ACTIVE_SESSION, data);

export const getHeuristicRules = () => getStorageItem(STORAGE_KEYS.HEURISTIC_RULES, []);
export const setHeuristicRules = (rules) => setStorageItem(STORAGE_KEYS.HEURISTIC_RULES, rules || []);

export const getCullReport = () => getStorageItem(STORAGE_KEYS.CULL_REPORT, null);
export const setCullReport = (report) => setStorageItem(STORAGE_KEYS.CULL_REPORT, report);

export const getReviewedTracks = () => getStorageItem(STORAGE_KEYS.REVIEWED_TRACKS, { culled: [], kept: [] });
export const setReviewedTracks = (data) => setStorageItem(STORAGE_KEYS.REVIEWED_TRACKS, data);

export const getCheckedTracks = () => getStorageItem(STORAGE_KEYS.CHECKED_TRACKS, {});
export const setCheckedTracks = (data) => setStorageItem(STORAGE_KEYS.CHECKED_TRACKS, data);

export const getTelemetryHistory = () => getStorageItem(STORAGE_KEYS.TELEMETRY_HISTORY, []);
export const setTelemetryHistory = (data) => setStorageItem(STORAGE_KEYS.TELEMETRY_HISTORY, data || []);

