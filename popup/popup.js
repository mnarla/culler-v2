/**
 * popup.js — User Interface controller for Culler v2.
 */

import {
  getApiKey,
  setApiKey,
  getCurrentPlaylist,
  getActiveSession,
  getCullReport,
  setCullReport,
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

const btnPredict = document.getElementById('btn-predict');
const btnCalibrate = document.getElementById('btn-calibrate');
const aiLoading = document.getElementById('ai-loading');
const loadingMsg = document.getElementById('loading-msg');

const cullReportCard = document.getElementById('cull-report-card');
const checklistContainer = document.getElementById('checklist-container');
const btnExportCsv = document.getElementById('btn-export-csv');
const btnExportMd = document.getElementById('btn-export-md');

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

async function loadSessionState() {
  const session = await getActiveSession();
  if (session && session.isActive) {
    btnToggleSession.textContent = 'Stop Culling Session';
    btnToggleSession.className = 'btn btn-danger full-width';
  } else {
    btnToggleSession.textContent = 'Start Culling Session';
    btnToggleSession.className = 'btn btn-accent full-width';
  }

  const events = (session && session.events) || [];
  const skips = events.filter(e => e.event === 'SKIP').length;
  const keeps = events.filter(e => e.event === 'KEEP').length;

  statSkipsEl.textContent = skips;
  statKeepsEl.textContent = keeps;
}

async function loadCullReport() {
  const report = await getCullReport();
  if (report && report.predictions && report.predictions.length > 0) {
    cullReportCard.classList.remove('hidden');
    const titleLabel = document.getElementById('report-title-label');
    if (titleLabel) {
      titleLabel.textContent = `Predicted Skips (${report.predictions.length})`;
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

  // Session start/stop
  btnToggleSession.addEventListener('click', async () => {
    const session = await getActiveSession();
    if (session && session.isActive) {
      chrome.runtime.sendMessage({ type: 'CULLER_STOP_SESSION' }, () => {
        loadSessionState();
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

  // Run predictions
  btnPredict.addEventListener('click', async () => {
    setLoading(true, 'Predicting skips with Gemini...');
    chrome.runtime.sendMessage({ type: 'CULLER_RUN_BATCH_PREDICTIONS' }, (res) => {
      setLoading(false);
      if (res && res.error) {
        alert(`Prediction Error: ${res.error}`);
      } else {
        const count = Array.isArray(res?.predictions) ? res.predictions.length : 0;
        if (count === 0) {
          alert('Gemini evaluated all tracks and did not find any skips based on current rules. Your playlist is clean!');
        }
        loadCullReport();
      }
    });
  });

  // Run calibration
  btnCalibrate.addEventListener('click', async () => {
    setLoading(true, 'Calibrating heuristics with Gemini...');
    chrome.runtime.sendMessage({ type: 'CULLER_RUN_CALIBRATION' }, (res) => {
      setLoading(false);
      if (res && res.error) {
        alert(`Calibration Error: ${res.error}`);
      } else {
        alert('Heuristics successfully calibrated against your listening session!');
      }
    });
  });

  // Export CSV
  btnExportCsv.addEventListener('click', async () => {
    const report = await getCullReport();
    if (!report || !report.predictions) return;

    let csvContent = 'data:text/csv;charset=utf-8,Position,Track,Artist,Confidence,Reason\n';
    report.predictions.forEach(p => {
      const reason = (p.reason || '').replace(/"/g, '""');
      csvContent += `${p.originalIndex},"${p.name}","${p.artist}",${p.confidence}%,"${reason}"\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `cull_report_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });

  // Copy Markdown
  btnExportMd.addEventListener('click', async () => {
    const report = await getCullReport();
    if (!report || !report.predictions) return;

    let md = `# Culler Report — ${report.playlistName || 'Playlist'}\n\n`;
    md += '| # | Track | Artist | Confidence | Reason |\n';
    md += '|---|-------|--------|------------|--------|\n';
    report.predictions.forEach(p => {
      md += `| ${p.originalIndex} | ${p.name} | ${p.artist} | ${p.confidence}% | ${p.reason} |\n`;
    });

    await navigator.clipboard.writeText(md);
    alert('Report copied to clipboard as Markdown!');
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
    btnPredict.disabled = true;
    btnCalibrate.disabled = true;
  } else {
    aiLoading.classList.add('hidden');
    btnPredict.disabled = false;
    btnCalibrate.disabled = false;
  }
}

// ── Checklist Rendering & State Persistence ──────────────────────────────────

function renderChecklist(predictions) {
  checklistContainer.innerHTML = '';

  predictions.forEach((item, index) => {
    const el = document.createElement('div');
    el.className = `checklist-item ${item.checked ? 'removed' : ''}`;

    el.innerHTML = `
      <input type="checkbox" id="check-${index}" ${item.checked ? 'checked' : ''}>
      <div class="checklist-content">
        <div class="item-title-row">
          <span>${item.name}</span>
          <span class="item-index">#${item.originalIndex}</span>
        </div>
        <div class="item-reason">${item.artist} • ${item.reason}</div>
      </div>
    `;

    const checkbox = el.querySelector('input');
    checkbox.addEventListener('change', async (e) => {
      item.checked = e.target.checked;
      el.classList.toggle('removed', item.checked);

      // Persist checked state
      const report = await getCullReport();
      if (report && report.predictions) {
        report.predictions[index].checked = item.checked;
        await setCullReport(report);
      }
    });

    checklistContainer.appendChild(el);
  });
}

// Start
document.addEventListener('DOMContentLoaded', init);
