/**
 * storage.js — Strongly-typed helper for chrome.storage.local.
 *
 * Provides async getter/setter methods for all state persisted across
 * the extension lifecycle (API key, active playlist, active session,
 * heuristic rules, and the interactive cull report checklist).
 */

import { STORAGE_KEYS, MODEL_DEFAULTS } from '../config/constants.js';

/**
 * Low-level chrome.storage.local getter with fallback.
 * @param {string} key
 * @param {any} defaultValue
 * @returns {Promise<any>}
 */
export async function getStorageItem(key, defaultValue = null) {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      resolve(defaultValue);
      return;
    }
    chrome.storage.local.get([key], (result) => {
      if (chrome.runtime.lastError) {
        console.error(`[Culler Storage] Error reading key "${key}":`, chrome.runtime.lastError);
        resolve(defaultValue);
      } else {
        resolve(result[key] !== undefined ? result[key] : defaultValue);
      }
    });
  });
}

/**
 * Low-level chrome.storage.local setter.
 * @param {string} key
 * @param {any} value
 * @returns {Promise<void>}
 */
export async function setStorageItem(key, value) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      resolve();
      return;
    }
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        console.error(`[Culler Storage] Error writing key "${key}":`, chrome.runtime.lastError);
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}

// ── Strongly-typed helper methods ───────────────────────────────────────────

/**
 * Gemini API Key
 */
export async function getApiKey() {
  return getStorageItem(STORAGE_KEYS.GEMINI_API_KEY, '');
}

export async function setApiKey(key) {
  return setStorageItem(STORAGE_KEYS.GEMINI_API_KEY, (key || '').trim());
}

/**
 * Active Model Selection
 */
export async function getActiveModel() {
  return getStorageItem(STORAGE_KEYS.ACTIVE_MODEL, MODEL_DEFAULTS.DEFAULT_MODEL);
}

export async function setActiveModel(model) {
  return setStorageItem(STORAGE_KEYS.ACTIVE_MODEL, model || MODEL_DEFAULTS.DEFAULT_MODEL);
}

/**
 * Current Intercepted Playlist
 */
export async function getCurrentPlaylist() {
  return getStorageItem(STORAGE_KEYS.CURRENT_PLAYLIST, null);
}

export async function setCurrentPlaylist(playlistData) {
  return setStorageItem(STORAGE_KEYS.CURRENT_PLAYLIST, playlistData);
}

/**
 * Active Listening Session
 */
export async function getActiveSession() {
  return getStorageItem(STORAGE_KEYS.ACTIVE_SESSION, {
    isActive: false,
    playlistId: null,
    playlistName: '',
    startTime: null,
    events: [], // Array of { uri, name, artist, event: 'SKIP'|'KEEP', percentPlayed, timestamp }
  });
}

export async function setActiveSession(sessionData) {
  return setStorageItem(STORAGE_KEYS.ACTIVE_SESSION, sessionData);
}

/**
 * Heuristic Curation Rules
 */
export async function getHeuristicRules() {
  return getStorageItem(STORAGE_KEYS.HEURISTIC_RULES, []);
}

export async function setHeuristicRules(rules) {
  return setStorageItem(STORAGE_KEYS.HEURISTIC_RULES, rules || []);
}

/**
 * Cull Report Checklist (Batch Skip Predictions)
 */
export async function getCullReport() {
  return getStorageItem(STORAGE_KEYS.CULL_REPORT, null);
}

export async function setCullReport(report) {
  return setStorageItem(STORAGE_KEYS.CULL_REPORT, report);
}
