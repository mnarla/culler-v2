/**
 * time.js — Utilities for parsing Spotify playback timestamps and calculating
 * accurate play-duration percentages using hybrid DOM + GraphQL metadata.
 */

/**
 * Parses a formatted Spotify time string (e.g. "3:15", "0:45", "1:02:30")
 * into total seconds. Handles placeholder values like "-:--" safely.
 *
 * @param {string} timeStr - Time string from DOM playback timer.
 * @returns {number|null} Seconds as a number, or null if unparseable / placeholder.
 */
export function parseFormattedTimeToSeconds(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;

  const trimmed = timeStr.trim();
  // Spotify renders "-:--" before playback data initializes
  if (trimmed === '-:--' || trimmed === '--:--' || trimmed === '') {
    return null;
  }

  const parts = trimmed.split(':');
  if (parts.some(p => isNaN(Number(p)))) {
    return null;
  }

  if (parts.length === 2) {
    // "MM:SS"
    const mins = parseInt(parts[0], 10);
    const secs = parseFloat(parts[1]);
    return mins * 60 + secs;
  } else if (parts.length === 3) {
    // "HH:MM:SS"
    const hours = parseInt(parts[0], 10);
    const mins = parseInt(parts[1], 10);
    const secs = parseFloat(parts[2]);
    return hours * 3600 + mins * 60 + secs;
  }

  return null;
}

/**
 * Calculates the percentage of track duration that has elapsed.
 *
 * @param {number} positionSec - Current playback position in seconds.
 * @param {number} durationSec - Total track duration in seconds.
 * @returns {number} Percentage elapsed (0 to 100). Returns 0 if duration is non-positive.
 */
export function computePlayPercentage(positionSec, durationSec) {
  if (!positionSec || !durationSec || durationSec <= 0) return 0;
  const pct = (positionSec / durationSec) * 100;
  return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
}

/**
 * Resolves track duration in seconds using the hybrid approach approved in the plan:
 *  1. Primary: Exact millisecond duration from cached GraphQL Pathfinder payload.
 *  2. Fallback: Parsed DOM playback duration string (e.g. "3:42").
 *
 * @param {string} trackUri - Spotify URI of the track (e.g. "spotify:track:...").
 * @param {string} [domDurationStr] - Formatted duration text from player DOM bar.
 * @param {Array<Object>} [cachedPlaylistTracks] - Array of parsed playlist tracks.
 * @returns {number|null} Duration in seconds, or null if unavailable from both sources.
 */
export function resolveTrackDuration(trackUri, domDurationStr, cachedPlaylistTracks = []) {
  // 1. Primary: Look up in cached GraphQL track items
  if (trackUri && cachedPlaylistTracks && cachedPlaylistTracks.length > 0) {
    const matchedTrack = cachedPlaylistTracks.find(t => t.uri === trackUri);
    if (matchedTrack && typeof matchedTrack.durationMs === 'number' && matchedTrack.durationMs > 0) {
      return Math.round(matchedTrack.durationMs / 1000);
    }
  }

  // 2. Fallback: Parse from DOM string
  if (domDurationStr) {
    const domSeconds = parseFormattedTimeToSeconds(domDurationStr);
    if (domSeconds !== null && domSeconds > 0) {
      return domSeconds;
    }
  }

  return null;
}
