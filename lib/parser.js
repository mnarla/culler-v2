/**
 * parser.js — Defensive parser for Spotify Pathfinder GraphQL payloads.
 *
 * Isolates ALL Pathfinder payload unwrapping into a single pure function so
 * any Spotify schema drift is caught and logged in one place rather than
 * scattering null-checks across the codebase.
 *
 * Design principles (from implementation plan §2):
 *   - Validate the JSON shape at every nesting level before accessing deeper fields.
 *   - Malformed individual rows are SKIPPED and logged — they never crash the batch.
 *   - Emit a structured SCHEMA_MISMATCH warning if the Pathfinder envelope changes.
 *   - Return a typed result object so callers always know what they received.
 *
 * Export:
 *   parsePathfinderPlaylistPayload(json)   → ParseResult
 *   mergePlaylistBatches(existing, batch)  → ParseResult (for pagination)
 */

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CullerTrack
 * @property {number}      originalIndex  - 1-indexed position in the playlist.
 * @property {string}      uri            - Spotify track URI (e.g. "spotify:track:...").
 * @property {string}      name           - Track title.
 * @property {string[]}    artists        - Array of artist name strings.
 * @property {string}      album          - Album name.
 * @property {number|null} durationMs     - Duration in milliseconds, or null if missing.
 * @property {string|null} addedAt        - ISO 8601 timestamp when added, or null if missing.
 */

/**
 * @typedef {Object} ParseResult
 * @property {boolean}      ok              - True if at least some tracks were parsed.
 * @property {string|null}  playlistId      - Spotify playlist ID.
 * @property {string}       playlistName    - Playlist display name.
 * @property {number|null}  totalExpected   - Total declared track count from Spotify.
 * @property {CullerTrack[]} tracks         - Successfully parsed tracks.
 * @property {number}       skippedRows     - Number of rows that failed validation.
 * @property {boolean}      schemaMismatch  - True if the response envelope doesn't match.
 * @property {string[]}     warnings        - Non-fatal warning messages.
 */

/**
 * Parse a raw Pathfinder GraphQL payload into a typed ParseResult.
 *
 * @param {Object} json - The parsed JSON body from the intercepted Pathfinder response.
 * @returns {ParseResult}
 */
export function parsePathfinderPlaylistPayload(json) {
  const result = _emptyResult();

  // ── Validate envelope ──────────────────────────────────────────────────────
  const data = json?.data;
  if (!data) {
    result.schemaMismatch = true;
    result.warnings.push('SCHEMA_MISMATCH: top-level "data" key missing from Pathfinder response.');
    console.warn('[Culler Parser]', result.warnings[result.warnings.length - 1]);
    return result;
  }

  // Spotify returns either playlistV2 or playlist depending on client version
  const playlistNode = data.playlistV2 || data.playlist;
  if (!playlistNode) {
    result.schemaMismatch = true;
    result.warnings.push('SCHEMA_MISMATCH: neither "data.playlistV2" nor "data.playlist" found in Pathfinder response.');
    console.warn('[Culler Parser]', result.warnings[result.warnings.length - 1]);
    return result;
  }

  // Playlist identity
  result.playlistName = _safeString(playlistNode.name) || 'Unknown Playlist';
  result.name = result.playlistName;
  result.playlistId = _safeString(playlistNode.uri)?.split(':').pop() || null;

  // Content node
  const content = playlistNode.content;
  if (!content) {
    // Check if this is a playlist metadata/header query (attributes without track content)
    if (playlistNode.name || playlistNode.uri || playlistNode.description) {
      result.isMetadataOnly = true;
      result.ok = true;
      return result;
    }
    result.schemaMismatch = true;
    result.warnings.push('SCHEMA_MISMATCH: "content" key missing from playlistV2 node.');
    console.warn('[Culler Parser]', result.warnings[result.warnings.length - 1]);
    return result;
  }

  // Total expected from Spotify pagination metadata
  if (typeof content.totalCount === 'number') {
    result.totalExpected = content.totalCount;
  }

  // Items array
  const items = content.items;
  if (!Array.isArray(items)) {
    result.schemaMismatch = true;
    result.warnings.push('SCHEMA_MISMATCH: "content.items" is not an array.');
    console.warn('[Culler Parser]', result.warnings[result.warnings.length - 1]);
    return result;
  }

  // ── Parse individual track items ───────────────────────────────────────────
  // Spotify paginates in 50-track batches; `offset` tells us where in the
  // playlist this batch starts, so we can assign correct 1-indexed positions.
  const batchOffset = typeof content.offset === 'number' ? content.offset : 0;

  items.forEach((item, batchIndex) => {
    const originalIndex = batchOffset + batchIndex + 1; // 1-indexed

    const track = _parseItem(item, originalIndex);
    if (track === null) {
      result.skippedRows++;
    } else {
      result.tracks.push(track);
    }
  });

  result.ok = result.tracks.length > 0;
  return result;
}

/**
 * Merge a new batch ParseResult into an existing accumulated result.
 * Used during pagination to build up a full playlist across multiple fetches.
 *
 * @param {ParseResult} existing - Accumulated result from previous batches.
 * @param {ParseResult} batch    - Result from the latest batch fetch.
 * @returns {ParseResult} Merged result.
 */
export function mergePlaylistBatches(existing, batch) {
  // If batch is metadata only, preserve existing tracks and update title if available
  if (batch.isMetadataOnly) {
    const updatedName = (batch.playlistName && batch.playlistName !== 'Unknown Playlist')
      ? batch.playlistName
      : (existing.playlistName || existing.name || 'Unknown Playlist');
    return {
      ...existing,
      playlistName: updatedName,
      name: updatedName,
      playlistId: batch.playlistId || existing.playlistId,
    };
  }

  // Determine canonical title (prefer explicit name over "Unknown Playlist")
  let canonicalName = batch.playlistName;
  if ((!canonicalName || canonicalName === 'Unknown Playlist') && existing.playlistName && existing.playlistName !== 'Unknown Playlist') {
    canonicalName = existing.playlistName;
  } else if (!canonicalName || canonicalName === 'Unknown Playlist') {
    canonicalName = existing.name || existing.playlistName || 'Unknown Playlist';
  }

  // Deduplicate tracks by URI
  const existingTracks = existing.tracks || [];
  const existingUris = new Set(existingTracks.map(t => t.uri));
  const newTracks = (batch.tracks || []).filter(t => !existingUris.has(t.uri));
  const mergedTracks = [...existingTracks, ...newTracks];

  // Maintain 1-indexed playlist order
  mergedTracks.sort((a, b) => (a.originalIndex || 0) - (b.originalIndex || 0));

  return {
    ok: existing.ok || batch.ok,
    playlistId: batch.playlistId || existing.playlistId,
    playlistName: canonicalName,
    name: canonicalName,
    totalExpected: batch.totalExpected ?? existing.totalExpected,
    tracks: mergedTracks,
    skippedRows: (existing.skippedRows || 0) + (batch.skippedRows || 0),
    schemaMismatch: false,
    warnings: [...(existing.warnings || []), ...(batch.warnings || [])],
  };
}

// ── Private helpers ──────────────────────────────────────────────────────────

function _emptyResult() {
  return {
    ok: false,
    playlistId: null,
    playlistName: '',
    name: '',
    totalExpected: null,
    tracks: [],
    skippedRows: 0,
    schemaMismatch: false,
    isMetadataOnly: false,
    warnings: [],
  };
}

/**
 * Parse a single item from content.items[] into a CullerTrack.
 * Returns null if the item is missing required fields (uri or name).
 *
 * Spotify wraps the actual track data in two possible shapes:
 *   item.itemV2.data  → standard track
 *   item.track.data   → legacy format
 *
 * @param {Object} item          - Raw item from content.items[].
 * @param {number} originalIndex - 1-indexed playlist position.
 * @returns {CullerTrack|null}
 */
function _parseItem(item, originalIndex) {
  if (!item || typeof item !== 'object') return null;

  // Unwrap the track data node — try both known shapes
  const trackData =
    item?.itemV2?.data ||
    item?.track?.data ||
    null;

  if (!trackData) {
    console.debug(`[Culler Parser] Row #${originalIndex}: no trackData node (itemV2.data or track.data).`);
    return null;
  }

  // Required: URI
  const uri = _safeString(trackData.uri);
  if (!uri || !uri.startsWith('spotify:track:')) {
    console.debug(`[Culler Parser] Row #${originalIndex}: missing or malformed URI.`);
    return null;
  }

  // Required: name
  const name = _safeString(trackData.name);
  if (!name) {
    console.debug(`[Culler Parser] Row #${originalIndex}: missing track name.`);
    return null;
  }

  // Artists: items[].profile.name
  const artists = _parseArtists(trackData.artists);

  // Album name
  const album = _safeString(trackData.albumOfTrack?.name) || 'Unknown Album';

  // Duration — stored as trackDuration.totalMilliseconds (may be string or number)
  const rawMs = trackData.trackDuration?.totalMilliseconds;
  let durationMs = null;
  if (rawMs !== undefined && rawMs !== null) {
    const parsed = Number(rawMs);
    durationMs = isNaN(parsed) ? null : parsed;
  }

  // Added at — from item.addedAt.isoString (NOT from trackData)
  const addedAt = _safeString(item.addedAt?.isoString) || null;

  return {
    originalIndex,
    uri,
    name,
    artists,
    album,
    durationMs,
    addedAt,
  };
}

/**
 * Safely extract artist name strings from the Pathfinder artists object.
 *
 * Expected shape: { items: [{ profile: { name: "..." } }] }
 * Falls back to an empty array if the structure is missing.
 *
 * @param {Object|undefined} artistsNode
 * @returns {string[]}
 */
function _parseArtists(artistsNode) {
  if (!artistsNode || !Array.isArray(artistsNode.items)) {
    return ['Unknown Artist'];
  }

  const names = artistsNode.items
    .map(a => _safeString(a?.profile?.name))
    .filter(Boolean);

  return names.length > 0 ? names : ['Unknown Artist'];
}

/**
 * Safely coerce a value to a non-empty trimmed string, or return null.
 * Prevents crashes from unexpected numbers, booleans, or null values.
 *
 * @param {any} val
 * @returns {string|null}
 */
function _safeString(val) {
  if (val === null || val === undefined) return null;
  const str = String(val).trim();
  return str.length > 0 ? str : null;
}
