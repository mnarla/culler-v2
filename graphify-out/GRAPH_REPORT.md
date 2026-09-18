# Graph Report - cullerv2  (2026-09-17)

## Corpus Check
- Corpus is ~13,358 words - fits in a single context window. You may not need a graph.

## Summary
- 156 nodes · 320 edges · 9 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Popup UI & DOM Controller
- Background Service Worker & Message Router
- Extension Manifest & Metadata
- Popup State & Storage Sync
- Gemini AI Scoring & Prompt Heuristics
- Content Script & Spotify DOM Integration
- GraphQL & Payload Parsers
- Package Config & Node Modules
- Injected Network Sniffer & Pagination

## God Nodes (most connected - your core abstractions)
1. `onRunBatchPredictions()` - 15 edges
2. `setupEventListeners()` - 14 edges
3. `onRunCalibration()` - 12 edges
4. `handleMessage()` - 11 edges
5. `getActiveSession()` - 11 edges
6. `getStorageItem()` - 10 edges
7. `getCurrentPlaylist()` - 10 edges
8. `setActiveSession()` - 10 edges
9. `onTrackPlaybackEvent()` - 9 edges
10. `setStorageItem()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `onTrackPlaybackEvent()` --calls--> `getCurrentPlaylist()`  [EXTRACTED]
  background.js → lib/storage.js
- `onPlaylistIntercepted()` --calls--> `parsePathfinderPlaylistPayload()`  [EXTRACTED]
  background.js → lib/parser.js
- `onPlaylistIntercepted()` --calls--> `getCurrentPlaylist()`  [EXTRACTED]
  background.js → lib/storage.js
- `onRunBatchPredictions()` --calls--> `generateContent()`  [EXTRACTED]
  background.js → lib/gemini.js
- `onRunBatchPredictions()` --calls--> `buildBatchScoringPromptForChunk()`  [EXTRACTED]
  background.js → lib/heuristics.js

## Import Cycles
- None detected.

## Communities (9 total, 0 thin omitted)

### Community 0 - "Popup UI & DOM Controller"
Cohesion: 0.05
Nodes (38): aiLoading, btnBackToReport, btnCloseSettings, btnExportCsv, btnExportMd, btnFetchAll, btnPauseSession, btnQuickScan (+30 more)

### Community 1 - "Background Service Worker & Message Router"
Cohesion: 0.17
Nodes (31): handleMessage(), isAdvertisementEvent(), isTrackInPlaylist(), onFetchFullPlaylist(), onPauseSession(), onPlaylistIntercepted(), onRecordReview(), onRunBatchPredictions() (+23 more)

### Community 2 - "Extension Manifest & Metadata"
Cohesion: 0.08
Nodes (25): action, default_icon, default_popup, default_title, background, service_worker, type, content_scripts (+17 more)

### Community 3 - "Popup State & Storage Sync"
Cohesion: 0.23
Nodes (17): getApiKey(), getCheckedTracks(), getCullReport(), getCurrentPlaylist(), getStorageItem(), init(), isAdName(), loadCullReport() (+9 more)

### Community 4 - "Gemini AI Scoring & Prompt Heuristics"
Cohesion: 0.24
Nodes (12): cleanAndParseJson(), generateContent(), buildBatchScoringPrompt(), buildBatchScoringPromptForChunk(), buildCalibrationPrompt(), formatRulesBlock(), formatTelemetryBlock(), formatTrackFeatures() (+4 more)

### Community 5 - "Content Script & Spotify DOM Integration"
Cohesion: 0.33
Nodes (8): currentTrackState, evaluateAndReportTrack(), getSpotifyScrollContainer(), isAdvertisement(), parseSeconds(), safeSendMessage(), scrollToTrack(), telemetryTimer

### Community 6 - "GraphQL & Payload Parsers"
Cohesion: 0.73
Nodes (5): _emptyResult(), _parseArtists(), _parseItem(), parsePathfinderPlaylistPayload(), _safeString()

### Community 7 - "Package Config & Node Modules"
Cohesion: 0.40
Nodes (4): description, name, type, version

### Community 8 - "Injected Network Sniffer & Pagination"
Cohesion: 0.83
Nodes (3): buildPaginatedBody(), buildPaginatedUrl(), runAutoPagination()

## Knowledge Gaps
- **64 isolated node(s):** `currentTrackState`, `manifest_version`, `name`, `version`, `description` (+59 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `generateContent()` connect `Gemini AI Scoring & Prompt Heuristics` to `Background Service Worker & Message Router`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Why does `getActiveSession()` connect `Background Service Worker & Message Router` to `Popup UI & DOM Controller`, `Popup State & Storage Sync`?**
  _High betweenness centrality (0.024) - this node is a cross-community bridge._
- **Why does `setActiveSession()` connect `Background Service Worker & Message Router` to `Popup UI & DOM Controller`, `Popup State & Storage Sync`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **What connects `currentTrackState`, `manifest_version`, `name` to the rest of the system?**
  _64 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Popup UI & DOM Controller` be split into smaller, more focused modules?**
  _Cohesion score 0.05128205128205128 - nodes in this community are weakly interconnected._
- **Should `Extension Manifest & Metadata` be split into smaller, more focused modules?**
  _Cohesion score 0.07692307692307693 - nodes in this community are weakly interconnected._