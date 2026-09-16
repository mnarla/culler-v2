/**
 * selectors.js — Centralized DOM selectors for Spotify Web Player.
 *
 * All DOM queries against open.spotify.com elements are maintained here
 * so any Spotify markup/attribute changes can be updated in a single place.
 */

export const SELECTORS = {
  // Now Playing bar container
  NOW_PLAYING_BAR: '[data-testid="now-playing-bar"]',

  // Current track title in player bar
  TRACK_TITLE: '[data-testid="context-item-info-title"]',

  // Current track artist(s) in player bar
  TRACK_ARTIST: '[data-testid="context-item-info-artist"]',

  // Current track album artwork link or image
  TRACK_IMAGE: '[data-testid="cover-art-image"]',

  // Playback timeline elements
  PLAYBACK_POSITION: '[data-testid="playback-position"]',
  PLAYBACK_DURATION: '[data-testid="playback-duration"]',
  PLAYBACK_PROGRESS_BAR: '[data-testid="playback-progressbar"]',

  // Playback control buttons
  PLAY_PAUSE_BUTTON: '[data-testid="control-button-playpause"]',
  SKIP_FORWARD_BUTTON: '[data-testid="control-button-skip-forward"]',
  SKIP_BACK_BUTTON: '[data-testid="control-button-skip-back"]',

  // Playlist view selectors (for contextual information if visible)
  PLAYLIST_HEADER_TITLE: '[data-testid="entityTitle"]',
  PLAYLIST_TRACK_ROW: '[data-testid="tracklist-row"]',
};

/**
 * Fallback selector arrays in case primary data-testid selectors undergo schema changes.
 */
export const FALLBACK_SELECTORS = {
  TRACK_TITLE: [
    '[data-testid="context-item-info-title"]',
    'a[data-testid="context-item-link"]',
    '.now-playing-bar [data-testid="track-info-name"]'
  ],
  TRACK_ARTIST: [
    '[data-testid="context-item-info-artist"]',
    'a[data-testid="context-item-info-subartist"]',
    '.now-playing-bar [data-testid="track-info-artists"]'
  ],
  PLAYBACK_POSITION: [
    '[data-testid="playback-position"]',
    '.playback-bar__progress-time-elapsed'
  ],
  PLAYBACK_DURATION: [
    '[data-testid="playback-duration"]',
    '.playback-bar__progress-time-total'
  ]
};
