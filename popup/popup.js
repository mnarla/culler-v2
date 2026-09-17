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

  if (playlist && (name || count > 0)) {
    playlistStatusTag.textContent = count > 0 ? 'Active' : 'Connecting';
    playlistStatusTag.className = 'status-tag status-active';
    playlistNameEl.textContent = name || 'Active Playlist';
    playlistTrackCountEl.textContent = `${count} tracks captured`;
  } else {
    playlistStatusTag.textContent = 'Not Connected';
    playlistStatusTag.className = 'status-tag status-idle';
    playlistNameEl.textContent = 'Open a Spotify playlist...';
    playlistTrackCountEl.textContent = '0 tracks captured';
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
