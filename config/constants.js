/**
 * constants.js — Storage keys and model defaults.
 */

export const STORAGE_KEYS = {
  GEMINI_API_KEY: 'culler_gemini_api_key',
  ACTIVE_MODEL: 'culler_active_model',
  CURRENT_PLAYLIST: 'culler_current_playlist',
  ACTIVE_SESSION: 'culler_active_session',
  HEURISTIC_RULES: 'culler_heuristic_rules',
  CULL_REPORT: 'culler_latest_cull_report',
  REVIEWED_TRACKS: 'culler_reviewed_tracks',
  USER_PREFERENCES: 'culler_user_preferences',
};

export const MODEL_DEFAULTS = {
  DEFAULT_MODEL: 'gemini-3.5-flash-lite',
};
