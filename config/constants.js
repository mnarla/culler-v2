/**
 * constants.js — Global constants, configuration defaults, and message action types.
 */

// ── Telemetry & Evaluation Thresholds ────────────────────────────────────────

/**
 * Deterministic skip/keep percentage thresholds based on track duration.
 * Ambiguous range (20% - 65%) is intentionally discarded from session heuristics.
 */
export const THRESHOLDS = {
  SKIP_MAX_PERCENT: 20, // Played < 20% of duration = SKIP
  KEEP_MIN_PERCENT: 65, // Played > 65% of duration = KEEP
};

// ── Storage Keys (chrome.storage.local) ───────────────────────────────────────

export const STORAGE_KEYS = {
  GEMINI_API_KEY: 'culler_gemini_api_key',
  ACTIVE_MODEL: 'culler_active_model',
  CURRENT_PLAYLIST: 'culler_current_playlist', // Full parsed playlist & metadata
  ACTIVE_SESSION: 'culler_active_session',     // Live telemetry session { status, startTime, events }
  HEURISTIC_RULES: 'culler_heuristic_rules',   // Saved curation rules array
  CULL_REPORT: 'culler_latest_cull_report',    // Generated skip predictions checklist
  USER_PREFERENCES: 'culler_user_preferences', // Custom user settings
};

// ── Model & API Defaults ─────────────────────────────────────────────────────

export const MODEL_DEFAULTS = {
  DEFAULT_MODEL: 'gemini-3.5-flash-lite',
  TEMPERATURE: 0.3,
  MAX_RULES: 12,
};

// ── Interception & Network Targets ───────────────────────────────────────────

export const NETWORK = {
  PATHFINDER_URL: 'https://api-partner.spotify.com/pathfinder/v2/query',
  QUERY_OPERATION_PLAYLIST: 'fetchPlaylist',
};

// ── Cross-Context Message Action Types ───────────────────────────────────────

export const MESSAGE_TYPES = {
  // From injected.js (MAIN world) -> content.js (ISOLATED world)
  INTERCEPTED_PLAYLIST: 'CULLER_INTERCEPTED_PLAYLIST',
  INTERCEPTED_AUTH: 'CULLER_INTERCEPTED_AUTH',
  AUTH_EXPIRED: 'CULLER_AUTH_EXPIRED',

  // Session Lifecycle (Popup <-> Background <-> Content)
  START_SESSION: 'CULLER_START_SESSION',
  STOP_SESSION: 'CULLER_STOP_SESSION',
  GET_SESSION_STATE: 'CULLER_GET_SESSION_STATE',
  SESSION_STATE_CHANGED: 'CULLER_SESSION_STATE_CHANGED',
  TRACK_PLAYBACK_EVENT: 'CULLER_TRACK_PLAYBACK_EVENT',

  // AI Actions (Popup -> Background)
  RUN_BATCH_PREDICTIONS: 'CULLER_RUN_BATCH_PREDICTIONS',
  RUN_CALIBRATION: 'CULLER_RUN_CALIBRATION',
  PREDICTIONS_COMPLETED: 'CULLER_PREDICTIONS_COMPLETED',
  CALIBRATION_COMPLETED: 'CULLER_CALIBRATION_COMPLETED',
};
