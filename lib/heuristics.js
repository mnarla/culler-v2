/**
 * heuristics.js — Prompt builder for the Culler v2 calibration & batch scoring pipeline.
 *
 * Ported from Culler v1's prompts.py and consolidate_rules.py, adapted for the
 * Chrome extension context where:
 *   - Features come from intercepted Spotify Pathfinder GraphQL payloads
 *     (name, artist, album, durationMs, addedAt) rather than SQLite + Last.fm enrichment.
 *   - Rules are stored in chrome.storage.local as a JSON array rather than a SQLite table.
 *   - The LLM backend is Gemini 1.5 Flash (structured JSON output) instead of local Qwen3 8B.
 *
 * Exports:
 *   buildCalibrationPrompt(sessionData, activeRules)
 *     → Prompt string for post-session heuristic self-calibration.
 *
 *   buildBatchScoringPrompt(unplayedTracks, activeRules)
 *     → Prompt string for batch skip/keep prediction on unplayed tracks.
 *
 *   buildRuleSynthesisPrompt(missCluster)
 *     → Prompt string for synthesizing a new rule from a cluster of mispredictions.
 *
 *   buildRuleMergePrompt(ruleA, ruleB)
 *     → Prompt string for merging two overlapping rules into one.
 *
 * JSON Output Contracts:
 *   Calibration → { updatedRules: [...], changes: [...] }
 *   Batch Scoring → [ { originalIndex, name, artist, decision, confidence, reason } ]
 *   Rule Synthesis → { rule_text, confidence, verdict_direction, rationale }
 *   Rule Merge → { rule_text, verdict_direction, rationale }
 */

// ── Track Feature Formatting ─────────────────────────────────────────────────

/**
 * Format a track object from the intercepted Pathfinder payload into a
 * human-readable feature block for the LLM prompt.
 *
 * Unlike v1 which had Last.fm enrichment (genre tags, artist co-occurrence,
 * personal scrobble counts), v2 works with what the Spotify client provides
 * natively: track name, artist(s), album name, duration, and date added.
 *
 * @param {Object} track - Track object with fields from parser.js output.
 * @param {number} track.originalIndex - 1-indexed position in the playlist.
 * @param {string} track.name - Track title.
 * @param {string[]} track.artists - Array of artist names.
 * @param {string} track.album - Album name.
 * @param {number} track.durationMs - Duration in milliseconds.
 * @param {string|null} track.addedAt - ISO 8601 timestamp when track was added.
 * @returns {string} Formatted feature block string.
 */
export function formatTrackFeatures(track) {
  const artistStr = Array.isArray(track.artists)
    ? track.artists.join(', ')
    : (track.artists || 'Unknown Artist');

  const durationSec = track.durationMs
    ? Math.round(track.durationMs / 1000)
    : null;
  const durationStr = durationSec !== null
    ? `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, '0')}`
    : 'Unknown';

  let daysSinceAdded = 'Unknown';
  if (track.addedAt) {
    const addedDate = new Date(track.addedAt);
    const now = new Date();
    const diffMs = now - addedDate;
    if (!isNaN(diffMs)) {
      daysSinceAdded = String(Math.floor(diffMs / (1000 * 60 * 60 * 24)));
    }
  }

  return [
    `  - Track: "${track.name || 'Unknown'}" by ${artistStr}`,
    `  - Album: ${track.album || 'Unknown'}`,
    `  - Duration: ${durationStr}`,
    `  - Days Since Added: ${daysSinceAdded}`,
    `  - Playlist Position: #${track.originalIndex || '?'}`,
  ].join('\n');
}


// ── Active Rules Formatting ──────────────────────────────────────────────────

/**
 * Format the active rules array into a numbered list for prompt injection.
 *
 * @param {Array<{rule_text: string, verdict_direction?: string}>} rules
 * @returns {string} Formatted rules block, or empty string if no rules exist.
 */
function formatRulesBlock(rules) {
  if (!rules || rules.length === 0) return '';

  const lines = ['Guidelines from past listening sessions:'];
  rules.forEach((rule, i) => {
    const direction = rule.verdict_direction
      ? ` [${rule.verdict_direction}]`
      : '';
    lines.push(`  ${i + 1}. ${rule.rule_text.trim()}${direction}`);
  });
  return lines.join('\n');
}


// ── Session Telemetry Formatting ─────────────────────────────────────────────

/**
 * Format session skip/keep telemetry events into a structured block.
 *
 * @param {Object[]} events - Array of telemetry events.
 * @param {string} events[].name - Track name.
 * @param {string} events[].artist - Artist name(s).
 * @param {string} events[].event - 'SKIP' or 'KEEP'.
 * @param {number} events[].percentPlayed - Percentage of track duration played.
 * @returns {string} Formatted telemetry block.
 */
function formatTelemetryBlock(events) {
  if (!events || events.length === 0) return 'No listening data collected.';

  const skips = events.filter(e => e.event === 'SKIP');
  const keeps = events.filter(e => e.event === 'KEEP');

  const lines = [`Session Summary: ${skips.length} skips, ${keeps.length} keeps\n`];

  if (skips.length > 0) {
    lines.push('Skipped Tracks:');
    skips.forEach((e, i) => {
      lines.push(`  ${i + 1}. "${e.name}" by ${e.artist} (played ${Math.round(e.percentPlayed)}%)`);
    });
    lines.push('');
  }

  if (keeps.length > 0) {
    lines.push('Kept Tracks (listened through):');
    keeps.forEach((e, i) => {
      lines.push(`  ${i + 1}. "${e.name}" by ${e.artist} (played ${Math.round(e.percentPlayed)}%)`);
    });
    lines.push('');
  }

  return lines.join('\n');
}


// ── Calibration Prompt ───────────────────────────────────────────────────────

/**
 * Build the self-calibration prompt sent to Gemini after a culling session ends.
 *
 * Given the user's real skip/keep behavior from the session and the current
 * active rules, asks Gemini to:
 *   1. Evaluate which existing rules correctly predicted the session outcomes.
 *   2. Identify patterns in the misses (skips that were predicted as keeps, or vice versa).
 *   3. Synthesize updated rules: keep effective ones, revise or prune ineffective ones,
 *      and propose new rules grounded in the session's error patterns.
 *
 * Mirrors Culler v1's consolidate_rules.py pipeline but in a single LLM call
 * rather than multi-step clustering + synthesis + merge.
 *
 * @param {Object} sessionData
 * @param {string} sessionData.playlistName - Name of the playlist being culled.
 * @param {Object[]} sessionData.events - Array of telemetry events (see formatTelemetryBlock).
 * @param {Array<{rule_text: string, verdict_direction?: string}>} activeRules
 * @returns {string} Complete calibration prompt.
 */
export function buildCalibrationPrompt(sessionData, activeRules) {
  const lines = [];

  // System context
  lines.push(
    'You are an expert music playlist curator analyzing a listener\'s real behavior ' +
    'to improve skip-prediction heuristics.'
  );
  lines.push('');

  // Session context
  lines.push(`Playlist: "${sessionData.playlistName || 'Unknown'}"`);
  lines.push('');

  // Telemetry
  lines.push('=== Listening Session Data ===');
  lines.push(formatTelemetryBlock(sessionData.events));

  // Current rules
  if (activeRules && activeRules.length > 0) {
    lines.push('=== Current Active Rules ===');
    lines.push(formatRulesBlock(activeRules));
    lines.push('');
  } else {
    lines.push('=== Current Active Rules ===');
    lines.push('No rules exist yet. This is the first calibration session.');
    lines.push('');
  }

  // Task instructions
  lines.push('=== Your Task ===');
  lines.push('Analyze the listening session data against the current rules and produce updated heuristics.');
  lines.push('');
  lines.push('For each existing rule, evaluate whether it would have correctly predicted the session outcomes.');
  lines.push('Then:');
  lines.push('  1. KEEP rules that were effective (correctly predicted skips and keeps).');
  lines.push('  2. REVISE rules that were partially effective but need refinement.');
  lines.push('  3. PRUNE rules that consistently mispredicted (accuracy < 40%).');
  lines.push('  4. SYNTHESIZE new rules if you identify clear patterns in the misses that no existing rule covers.');
  lines.push('');
  lines.push('Constraints:');
  lines.push('  - Maximum 12 active rules total.');
  lines.push('  - Each rule must reference specific, observable attributes (artist name, era/decade, album, duration patterns).');
  lines.push('  - Rules must be phrased as actionable curation guidelines (e.g., "Skip tracks by one-off artists added before 2020 that the user hasn\'t engaged with").');
  lines.push('  - Do NOT write generic rules like "skip songs the user doesn\'t like" — that is circular.');
  lines.push('');

  // Output format
  lines.push('Respond with ONLY this JSON object — no explanation, no preamble, no markdown fences:');
  lines.push('');
  lines.push(JSON.stringify({
    updatedRules: [
      { rule_text: '<actionable rule>', verdict_direction: 'favor_skip | favor_keep' }
    ],
    changes: [
      { action: 'kept | revised | pruned | created', rule_text: '<rule>', rationale: '<why>' }
    ]
  }, null, 2));

  return lines.join('\n');
}


// ── Batch Scoring Prompt ─────────────────────────────────────────────────────

/**
 * Build the batch prediction prompt for scoring unplayed tracks.
 *
 * Given the active heuristic rules and a list of unplayed tracks from the
 * playlist, asks Gemini to predict which tracks the user would skip.
 *
 * Mirrors Culler v1's build_prediction_prompt but operates on batches of
 * tracks rather than individual track inference (leveraging Gemini's larger
 * context window vs. local Qwen3 8B's single-track constraint).
 *
 * @param {Object[]} tracks - Array of unplayed track objects (from parser.js output).
 * @param {Array<{rule_text: string, verdict_direction?: string}>} activeRules
 * @param {string} [playlistName] - Name of the playlist for context.
 * @returns {string} Complete batch scoring prompt.
 */
export function buildBatchScoringPrompt(tracks, activeRules, playlistName) {
  const lines = [];

  // System context
  lines.push(
    'You are an expert music playlist curator with deep knowledge of a listener\'s taste. ' +
    'You have been calibrated with heuristic rules from the listener\'s real skip/keep behavior.'
  );
  lines.push('');

  // Playlist context
  if (playlistName) {
    lines.push(`Playlist: "${playlistName}"`);
    lines.push('');
  }

  // Active rules
  if (activeRules && activeRules.length > 0) {
    lines.push(formatRulesBlock(activeRules));
    lines.push('');
  }

  // Decision framework (adapted from v1)
  lines.push('Decision Framework:');
  lines.push('  - Context: This is a mature playlist where tracks may have been added years ago. Longevity alone is NOT a reason to skip.');
  lines.push('  - Apply the guidelines above as primary signals.');
  lines.push('  - When guidelines conflict or don\'t clearly apply, use your music knowledge to assess whether the track fits the playlist\'s overall taste profile.');
  lines.push('  - Only flag tracks as SKIP when you have genuine confidence — when in doubt, predict KEEP.');
  lines.push('');

  // Track list
  lines.push(`=== Unplayed Tracks to Score (${tracks.length} tracks) ===`);
  lines.push('');
  tracks.forEach((track, i) => {
    lines.push(`[${i + 1}]`);
    lines.push(formatTrackFeatures(track));
    lines.push('');
  });

  // Output format
  lines.push('=== Output Instructions ===');
  lines.push(
    'For each track above, predict whether the listener would SKIP or KEEP it. ' +
    'Only predict SKIP when you have high confidence (≥ 70%).'
  );
  lines.push('');
  lines.push('Respond with ONLY a JSON array — no explanation, no preamble, no markdown fences.');
  lines.push('Each element must have this exact structure:');
  lines.push('');
  lines.push(JSON.stringify([{
    originalIndex: '<number: 1-indexed playlist position>',
    name: '<track name>',
    artist: '<artist name(s)>',
    decision: 'SKIP | KEEP',
    confidence: '<integer 0-100>',
    reason: '<1-2 sentences naming the specific attributes that drove the verdict>'
  }], null, 2));
  lines.push('');
  lines.push(
    'In "reason", name the specific attributes that drove your decision ' +
    '(e.g., "One-off artist not seen elsewhere in playlist, added 4 years ago with no engagement signals"). ' +
    'Generic or vague reasoning like "user might not like this" is not acceptable.'
  );

  return lines.join('\n');
}
