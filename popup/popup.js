/**
 * popup.js — User Interface controller for Culler v2.
 */

import {
  getApiKey,
  setApiKey,
  getCurrentPlaylist,
  getActiveSession,
  setActiveSession,
  getCullReport,
  setCullReport,
  getCheckedTracks,
  setCheckedTracks,
} from '../lib/storage.js';

// DOM Elements
const btnSettings = document.getElementById('btn-settings');
const settingsPane = document.getElementById('settings-pane');
const inputApiKey = document.getElementById('input-api-key');
const btnSaveKey = document.getElementById('btn-save-key');
const btnCloseSettings = document.getElementById('btn-close-settings');

const playlistStatusTag = document.getElementById('playlist-status-tag');
const playlistNameEl = document.getElementById('playlist-name');
const playlistTrackCountEl = document.getElementById('playlist-track-count');
const btnFetchAll = document.getElementById('btn-fetch-all');
const paginationProgressBar = document.getElementById('pagination-progress-bar');
const paginationProgressFill = document.getElementById('pagination-progress-fill');

const statSkipsEl = document.getElementById('stat-skips');
const statKeepsEl = document.getElementById('stat-keeps');
const btnToggleSession = document.getElementById('btn-toggle-session');
const btnPauseSession = document.getElementById('btn-pause-session');
const sessionStatusBadge = document.getElementById('session-status-badge');
const btnQuickScan = document.getElementById('btn-quick-scan');

const aiLoading = document.getElementById('ai-loading');
const loadingMsg = document.getElementById('loading-msg');

const cullReportCard = document.getElementById('cull-report-card');
const reportTitleLabel = document.getElementById('report-title-label');
const reportPageInfo = document.getElementById('report-page-info');
const checklistContainer = document.getElementById('checklist-container');
const paginationControls = document.getElementById('pagination-controls');
const btnShowMore = document.getElementById('btn-show-more');
const btnShowAll = document.getElementById('btn-show-all');
const btnExportCsv = document.getElementById('btn-export-csv');
const btnExportMd = document.getElementById('btn-export-md');

const countAllEl = document.getElementById('count-all');
const countHighEl = document.getElementById('count-high');
const countModEl = document.getElementById('count-mod');
const countReviewEl = document.getElementById('count-review');
const tierFilterPills = document.querySelectorAll('.filter-pill');

const PAGE_SIZE = 15;
let currentVisibleLimit = PAGE_SIZE;
let activeTierFilter = 'ALL';

// ── State Initialization ─────────────────────────────────────────────────────

async function init() {
  await loadSettings();
  await loadPlaylistState();
  await loadSessionState();
  await loadCullReport();
  setupEventListeners();
  setupStorageListener();
  setupRuntimeMessageListener();
}

function setupStorageListener() {
  // Auto-refresh playlist status whenever background.js updates storage
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.culler_current_playlist) loadPlaylistState();
    if (changes.culler_active_session) loadSessionState();
    if (changes.culler_latest_cull_report) loadCullReport();
  });
}

function setupRuntimeMessageListener() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CULLER_PAGINATION_PROGRESS') {
      const pct = Math.round((msg.currentOffset / msg.totalExpected) * 100);
      paginationProgressBar.classList.remove('hidden');
      paginationProgressFill.style.width = `${pct}%`;
      btnFetchAll.textContent = `Fetching (${msg.currentOffset}/${msg.totalExpected})...`;
    } else if (msg.type === 'CULLER_PAGINATION_COMPLETE') {
      paginationProgressFill.style.width = '100%';
      setTimeout(() => {
        paginationProgressBar.classList.add('hidden');
        loadPlaylistState();
      }, 500);
    } else if (msg.type === 'CULLER_PAGINATION_ERROR') {
      alert(`Pagination error: ${msg.error}`);
      btnFetchAll.disabled = false;
      loadPlaylistState();
    } else if (msg.type === 'CULLER_AUTH_EXPIRED') {
      alert(`Spotify session token expired at track #${msg.offset || 'unknown'}. Please scroll slightly in Spotify or refresh the tab to renew the token.`);
      btnFetchAll.disabled = false;
      loadPlaylistState();
    }
  });
}

async function loadSettings() {
  const key = await getApiKey();
  if (key) {
    inputApiKey.value = key;
  } else {
    // Show settings pane on first load if no key is found
    settingsPane.classList.remove('hidden');
  }
}

async function loadPlaylistState() {
  const playlist = await getCurrentPlaylist();
  const name = playlist?.name || playlist?.playlistName;
  const count = playlist?.tracks ? playlist.tracks.length : 0;
  const total = playlist?.totalExpected || null;

  if (playlist && (name || count > 0)) {
    playlistStatusTag.textContent = count > 0 ? 'Active' : 'Connecting';
    playlistStatusTag.className = 'status-tag status-active';
    playlistNameEl.textContent = name || 'Active Playlist';

    if (total && total > 0) {
      playlistTrackCountEl.textContent = `${count} / ${total} tracks captured`;
      if (count < total) {
        btnFetchAll.classList.remove('hidden');
        btnFetchAll.textContent = `Fetch All (${total}) ⚡`;
        btnFetchAll.disabled = false;
      } else {
        btnFetchAll.classList.remove('hidden');
        btnFetchAll.textContent = `All ${total} tracks loaded ✓`;
        btnFetchAll.disabled = true;
        paginationProgressBar.classList.add('hidden');
      }
    } else {
      playlistTrackCountEl.textContent = `${count} tracks captured`;
      btnFetchAll.classList.add('hidden');
    }
  } else {
    playlistStatusTag.textContent = 'Not Connected';
    playlistStatusTag.className = 'status-tag status-idle';
    playlistNameEl.textContent = 'Open a Spotify playlist...';
    playlistTrackCountEl.textContent = '0 tracks captured';
    btnFetchAll.classList.add('hidden');
  }
}

function isAdName(name, artist) {
  const n = (name || '').toLowerCase().trim();
  const a = (artist || '').toLowerCase().trim();
  return (
    n === 'advertisement' ||
    n.startsWith('advertisement') ||
    n === 'spotify' ||
    n.includes('spotify ad') ||
    n.includes('audio ad') ||
    a === 'spotify' ||
    a === 'advertiser' ||
    a.includes('advertisement')
  );
}

async function loadSessionState() {
  const session = await getActiveSession();
  const events = (session && session.events) || [];
  const validEvents = events.filter(e => !isAdName(e.name, e.artist));

  // Purge any lingering ad events from storage if present
  if (session && session.events && session.events.length !== validEvents.length) {
    session.events = validEvents;
    await setActiveSession(session);
  }

  const skips = validEvents.filter(e => e.event === 'SKIP').length;
  const keeps = validEvents.filter(e => e.event === 'KEEP').length;

  statSkipsEl.textContent = skips;
  statKeepsEl.textContent = keeps;

  if (session && session.isActive) {
    btnToggleSession.textContent = `✨ Stop & Generate Cull List (${skips} skips, ${keeps} keeps)`;
    btnToggleSession.className = 'btn btn-magic full-width';
    if (btnQuickScan) btnQuickScan.classList.add('hidden');

    if (btnPauseSession) {
      btnPauseSession.classList.remove('hidden');
      if (session.isPaused) {
        btnPauseSession.textContent = '▶️ Resume Session';
        if (sessionStatusBadge) {
          sessionStatusBadge.textContent = 'PAUSED';
          sessionStatusBadge.className = 'status-tag status-paused';
          sessionStatusBadge.classList.remove('hidden');
        }
      } else {
        btnPauseSession.textContent = '⏸️ Pause Session';
        if (sessionStatusBadge) {
          sessionStatusBadge.textContent = 'ACTIVE';
          sessionStatusBadge.className = 'status-tag status-active';
          sessionStatusBadge.classList.remove('hidden');
        }
      }
    }
  } else {
    btnToggleSession.textContent = 'Start Culling Session 🎧';
    btnToggleSession.className = 'btn btn-accent full-width';
    if (btnQuickScan) btnQuickScan.classList.remove('hidden');
    if (btnPauseSession) btnPauseSession.classList.add('hidden');
    if (sessionStatusBadge) sessionStatusBadge.classList.add('hidden');
  }
}

async function loadCullReport() {
  const report = await getCullReport();
  if (report && report.predictions && report.predictions.length > 0) {
    const checkedMap = await getCheckedTracks();
    report.predictions.forEach(p => {
      const key = p.uid || p.uri || `${p.name}::${p.artist}`;
      if (checkedMap[key] !== undefined) {
        p.checked = Boolean(checkedMap[key]);
      }
    });
    cullReportCard.classList.remove('hidden');
    if (reportTitleLabel) {
      reportTitleLabel.textContent = `Predicted Skips (${report.predictions.length})`;
    }
    renderChecklist(report.predictions);
  } else {
    cullReportCard.classList.add('hidden');
  }
}

// ── Event Handlers ───────────────────────────────────────────────────────────

function setupEventListeners() {
  // Settings toggle
  btnSettings.addEventListener('click', () => {
    settingsPane.classList.toggle('hidden');
  });

  btnCloseSettings.addEventListener('click', () => {
    settingsPane.classList.add('hidden');
  });

  btnSaveKey.addEventListener('click', async () => {
    const key = inputApiKey.value.trim();
    await setApiKey(key);
    settingsPane.classList.add('hidden');
    alert('API key saved successfully.');
  });

  // Fetch full playlist auto-pagination
  btnFetchAll.addEventListener('click', async () => {
    const playlist = await getCurrentPlaylist();
    const count = playlist?.tracks ? playlist.tracks.length : 0;
    const total = playlist?.totalExpected || 0;

    if (count >= total || total === 0) return;

    btnFetchAll.disabled = true;
    btnFetchAll.textContent = 'Fetching...';
    paginationProgressBar.classList.remove('hidden');
    paginationProgressFill.style.width = `${Math.round((count / total) * 100)}%`;

    chrome.runtime.sendMessage({
      type: 'CULLER_FETCH_FULL_PLAYLIST',
      startOffset: count,
      totalExpected: total,
    }, (res) => {
      if (chrome.runtime.lastError || (res && res.error)) {
        const errMsg = chrome.runtime.lastError?.message || res?.error;
        alert(`Fetch notice: ${errMsg}`);
        btnFetchAll.disabled = false;
        btnFetchAll.textContent = `Fetch All (${total}) ⚡`;
      }
    });
  });

  // Master Action Button (Start Session -> Stop & Generate)
  btnToggleSession.addEventListener('click', async () => {
    const session = await getActiveSession();
    if (session && session.isActive) {
      setLoading(true, 'Stopping session & analyzing listening telemetry with Gemini...');
      chrome.runtime.sendMessage({ type: 'CULLER_STOP_AND_GENERATE' }, (res) => {
        setLoading(false);
        if (chrome.runtime.lastError || (res && res.error)) {
          const errMsg = chrome.runtime.lastError?.message || res?.error;
          alert(`Analysis Error: ${errMsg}`);
        } else {
          const count = Array.isArray(res?.predictions) ? res.predictions.length : 0;
          if (count === 0) {
            alert('Gemini evaluated your unreviewed tracks and found zero skips! Your playlist matches your listening taste.');
          }
          currentVisibleLimit = PAGE_SIZE; // reset pagination to top page
          loadSessionState();
          loadCullReport();
        }
      });
    } else {
      const playlist = await getCurrentPlaylist();
      chrome.runtime.sendMessage({
        type: 'CULLER_START_SESSION',
        playlistId: playlist?.id,
        playlistName: playlist?.name,
      }, () => {
        loadSessionState();
      });
    }
  });

  // Pause / Resume Session Button
  if (btnPauseSession) {
    btnPauseSession.addEventListener('click', async () => {
      btnPauseSession.disabled = true;
      try {
        const res = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'CULLER_PAUSE_SESSION' }, (response) => {
            if (chrome.runtime.lastError) {
              console.error('[Culler Popup] Pause error:', chrome.runtime.lastError);
              resolve({ error: chrome.runtime.lastError.message });
            } else {
              resolve(response || {});
            }
          });
        });
        if (res?.error) {
          alert(`Pause error: ${res.error}`);
        }
      } catch (err) {
        console.error('[Culler Popup] Pause exception:', err);
      } finally {
        btnPauseSession.disabled = false;
        await loadSessionState();
      }
    });
  }

  // Direct Playlist Scan (No Session required)
  if (btnQuickScan) {
    btnQuickScan.addEventListener('click', async () => {
      setLoading(true, 'Scanning unreviewed tracks for skips with Gemini...');
      chrome.runtime.sendMessage({ type: 'CULLER_RUN_BATCH_PREDICTIONS' }, (res) => {
        setLoading(false);
        if (chrome.runtime.lastError || (res && res.error)) {
          const errMsg = chrome.runtime.lastError?.message || res?.error;
          alert(`Scan Error: ${errMsg}`);
        } else {
          const count = Array.isArray(res?.predictions) ? res.predictions.length : 0;
          if (count === 0) {
            alert('Gemini evaluated all tracks and did not find any skips based on current rules.');
          }
          currentVisibleLimit = PAGE_SIZE;
          loadCullReport();
        }
      });
    });
  }

  // Progressive Pagination: Show More
  if (btnShowMore) {
    btnShowMore.addEventListener('click', async () => {
      currentVisibleLimit += PAGE_SIZE;
      const report = await getCullReport();
      if (report && report.predictions) {
        renderChecklist(report.predictions);
      }
    });
  }

  // Progressive Pagination: Show All
  if (btnShowAll) {
    btnShowAll.addEventListener('click', async () => {
      currentVisibleLimit = Infinity;
      const report = await getCullReport();
      if (report && report.predictions) {
        renderChecklist(report.predictions);
      }
    });
  }

  // Tier Filter Pills
  tierFilterPills.forEach(pill => {
    pill.addEventListener('click', async () => {
      tierFilterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeTierFilter = pill.dataset.filter || 'ALL';
      currentVisibleLimit = PAGE_SIZE;
      const report = await getCullReport();
      if (report && report.predictions) {
        renderChecklist(report.predictions);
      }
    });
  });

  // Export CSV (Full Dataset)
  btnExportCsv.addEventListener('click', async () => {
    const report = await getCullReport();
    if (!report || !report.predictions) return;

    let csvContent = 'data:text/csv;charset=utf-8,Position,Track,Artist,Confidence,Tier,Reason\n';
    report.predictions.forEach(p => {
      const reason = (p.reason || '').replace(/"/g, '""');
      const tier = p.tier || (p.confidence >= 80 ? 'HIGH' : (p.confidence >= 60 ? 'MODERATE' : 'WORTH-REVIEWING'));
      csvContent += `${p.originalIndex},"${p.name}","${p.artist}",${p.confidence}%,${tier},"${reason}"\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `cull_report_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });

  // Copy Markdown (Full Dataset)
  btnExportMd.addEventListener('click', async () => {
    const report = await getCullReport();
    if (!report || !report.predictions) return;

    let md = `# Culler Report — ${report.playlistName || 'Playlist'}\n\n`;
    md += '| # | Track | Artist | Confidence | Tier | Reason |\n';
    md += '|---|-------|--------|------------|------|--------|\n';
    report.predictions.forEach(p => {
      const tier = p.tier || (p.confidence >= 80 ? 'HIGH' : (p.confidence >= 60 ? 'MODERATE' : 'WORTH-REVIEWING'));
      md += `| ${p.originalIndex} | ${p.name} | ${p.artist} | ${p.confidence}% | ${tier} | ${p.reason} |\n`;
    });

    await navigator.clipboard.writeText(md);
    alert('Full report copied to clipboard as Markdown!');
  });

  // Apply Review & Save Feedback
  const btnApplyReview = document.getElementById('btn-apply-review');
  if (btnApplyReview) {
    btnApplyReview.addEventListener('click', async () => {
      const report = await getCullReport();
      if (!report || !report.predictions || report.predictions.length === 0) return;

      const confirmed = report.predictions.filter(p => p.checked);
      const rejected = report.predictions.filter(p => !p.checked);

      btnApplyReview.disabled = true;
      btnApplyReview.textContent = 'Saving feedback...';

      chrome.runtime.sendMessage({
        type: 'CULLER_RECORD_REVIEW',
        confirmedSkips: confirmed,
        rejectedSkips: rejected,
      }, (res) => {
        btnApplyReview.disabled = false;
        btnApplyReview.textContent = 'Apply Review & Save Feedback ➔';
        if (res && res.error) {
          alert(`Error saving review: ${res.error}`);
        } else {
          alert(`Review applied! ${confirmed.length} tracks culled, and ${rejected.length} kept tracks saved as feedback to train Gemini.`);
          currentVisibleLimit = PAGE_SIZE;
          loadCullReport();
        }
      });
    });
  }
}

function setLoading(isLoading, message = '') {
  if (isLoading) {
    aiLoading.classList.remove('hidden');
    loadingMsg.textContent = message;
    btnToggleSession.disabled = true;
    if (btnQuickScan) btnQuickScan.disabled = true;
  } else {
    aiLoading.classList.add('hidden');
    btnToggleSession.disabled = false;
    if (btnQuickScan) btnQuickScan.disabled = false;
  }
}

// ── Checklist Rendering with Progressive Pagination ───────────────────────────

function renderChecklist(predictions) {
  checklistContainer.innerHTML = '';

  // 1. Normalize all predictions' tiers defensively
  predictions.forEach(item => {
    const rawTier = item.tier ? String(item.tier).toUpperCase() : '';
    if (rawTier.includes('HIGH') || (!item.tier && item.confidence >= 80)) {
      item.tier = 'HIGH';
    } else if (rawTier.includes('REVIEW') || rawTier.includes('LOW') || (!item.tier && item.confidence < 60)) {
      item.tier = 'WORTH-REVIEWING';
    } else {
      item.tier = 'MODERATE';
    }
  });

  // 2. Update pill counts
  if (countAllEl) countAllEl.textContent = predictions.length;
  if (countHighEl) countHighEl.textContent = predictions.filter(p => p.tier === 'HIGH').length;
  if (countModEl) countModEl.textContent = predictions.filter(p => p.tier === 'MODERATE').length;
  if (countReviewEl) countReviewEl.textContent = predictions.filter(p => p.tier === 'WORTH-REVIEWING').length;

  // 3. Filter by activeTierFilter
  const filtered = activeTierFilter === 'ALL'
    ? predictions
    : predictions.filter(p => p.tier === activeTierFilter);

  const total = filtered.length;
  const visibleCount = Math.min(currentVisibleLimit, total);
  const newCount = filtered.filter(p => p.isNew).length;

  if (reportPageInfo) {
    const tierSuffix = activeTierFilter === 'ALL' ? '' : ` (${activeTierFilter})`;
    const newSuffix = newCount > 0 ? ` • ${newCount} new` : '';
    reportPageInfo.textContent = `Showing ${visibleCount} of ${total} skips${tierSuffix}${newSuffix}`;
  }

  // 4. Render visible slice
  const visibleItems = filtered.slice(0, visibleCount);
  visibleItems.forEach((item) => {
    const el = document.createElement('div');
    el.className = `checklist-item ${item.checked ? 'removed' : ''} ${item.isNew ? 'is-new' : ''}`;

    const isHigh = item.tier === 'HIGH';
    const isReview = item.tier === 'WORTH-REVIEWING';
    const tierClass = isHigh ? 'badge-tier-high' : (isReview ? 'badge-tier-review' : 'badge-tier-mod');
    const tierLabel = isHigh ? 'HIGH' : (isReview ? 'WORTH REVIEWING' : 'MODERATE');
    const newBadgeHtml = item.isNew ? '<span class="badge-new">NEW</span>' : '';

    el.innerHTML = `
      <input type="checkbox" id="check-${item.originalIndex}" ${item.checked ? 'checked' : ''}>
      <div class="checklist-content">
        <div class="item-title-row">
          <span>${item.name} ${newBadgeHtml}</span>
          <span class="item-index">#${item.originalIndex}</span>
        </div>
        <div class="item-reason">
          <span class="${tierClass}">${tierLabel} ${item.confidence}%</span>
          ${item.artist} • ${item.reason}
        </div>
      </div>
    `;

    const checkbox = el.querySelector('input');
    checkbox.addEventListener('change', async (e) => {
      item.checked = e.target.checked;
      el.classList.toggle('removed', item.checked);

      // Persist checked state across sessions in chrome.storage.local (keyed by track URI/UID)
      const trackKey = item.uid || item.uri || `${item.name}::${item.artist}`;
      const checkedMap = await getCheckedTracks();
      if (item.checked) {
        checkedMap[trackKey] = true;
      } else {
        delete checkedMap[trackKey];
      }
      await setCheckedTracks(checkedMap);

      // Persist checked state to current cull report
      const report = await getCullReport();
      if (report && report.predictions) {
        const target = report.predictions.find(p => (p.uid || p.uri || p.originalIndex) === (item.uid || item.uri || item.originalIndex));
        if (target) {
          target.checked = item.checked;
          await setCullReport(report);
        }
      }
    });

    checklistContainer.appendChild(el);
  });

  // Progressive pagination controls
  if (paginationControls) {
    if (visibleCount < total) {
      paginationControls.classList.remove('hidden');
      const remaining = total - visibleCount;
      const nextBatch = Math.min(PAGE_SIZE, remaining);
      btnShowMore.textContent = `▾ Show ${nextBatch} More (${remaining} remaining)`;
    } else {
      paginationControls.classList.add('hidden');
    }
  }
}

// Start
document.addEventListener('DOMContentLoaded', init);
