import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildBatchScoringPrompt } from '../lib/heuristics.js';
import { generateContent } from '../lib/gemini.js';

// Load .env via stdlib if present
if (process.loadEnvFile) {
  try { process.loadEnvFile(); } catch (_) {}
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../culler/skip_predictor.db');

function fetchSampleTracks(limit = 15) {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[!] Database not found at ${DB_PATH}`);
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  
  // Check if labels table has rows
  const labelCount = db.prepare("SELECT COUNT(*) as count FROM labels").get().count;

  let rows = [];
  if (labelCount > 0) {
    const query = `
      SELECT 
        t.id as track_id,
        t.title as name,
        t.artist as artists,
        f.release_year,
        f.days_since_added,
        l.label as actual_label
      FROM tracks t
      JOIN features f ON t.id = f.track_id
      JOIN labels l ON t.id = l.track_id
      ORDER BY RANDOM()
      LIMIT ?
    `;
    rows = db.prepare(query).all(limit);
  } else {
    // If no labels were saved, sample directly from tracks + features
    console.log("[Info] No historical labels in labels table — sampling 15 tracks directly from dataset to evaluate prediction quality.");
    const query = `
      SELECT 
        t.id as track_id,
        t.title as name,
        t.artist as artists,
        f.release_year,
        f.days_since_added,
        NULL as actual_label
      FROM tracks t
      JOIN features f ON t.id = f.track_id
      ORDER BY RANDOM()
      LIMIT ?
    `;
    rows = db.prepare(query).all(limit);
  }
  db.close();

  // Convert to V2 track objects
  return rows.map((row, index) => {
    // V2 expects: name, artists (array or string), album, durationMs, addedAt, originalIndex
    // We approximate durationMs and addedAt since v1 DB might not have exact ms or ISO strings readily available in the same format.
    const addedAt = row.days_since_added 
      ? new Date(Date.now() - row.days_since_added * 24 * 60 * 60 * 1000).toISOString()
      : null;

    return {
      originalIndex: index + 1,
      name: row.name,
      artists: row.artists,
      album: `Release Year: ${row.release_year || 'Unknown'}`, // Stuff release year into album for context
      durationMs: 180000, // Mock 3 minutes since v1 DB doesn't store durationMs directly
      addedAt: addedAt,
      _actualLabel: row.actual_label // Hidden field for evaluation
    };
  });
}

async function runTest() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[!] GEMINI_API_KEY environment variable is not set.');
    console.error('    Please create a .env file in the cullerv2 directory or export it.');
    process.exit(1);
  }

  console.log('--- Culler v2: Gemini Quality Gate Test ---');
  console.log(`Fetching 15 labeled tracks from ${DB_PATH}...`);
  
  const tracks = fetchSampleTracks(15);
  if (tracks.length === 0) {
    console.error('No labeled tracks found in the database.');
    process.exit(1);
  }

  // Define some active rules similar to what the user might have
  const activeRules = [
    { rule_text: 'Skip tracks by one-off artists with low engagement that were added more than 3 years ago.', verdict_direction: 'favor_skip' },
    { rule_text: 'Keep tracks that represent core anchor artists in the playlist, even if they are old.', verdict_direction: 'favor_keep' }
  ];

  console.log(`\nBuilding batch scoring prompt for ${tracks.length} tracks...`);
  const prompt = buildBatchScoringPrompt(tracks, activeRules, "Test Playlist");
  
  console.log('\n--- Prompt Snippet ---');
  console.log(prompt.substring(0, 500) + '\n...\n');
  
  console.log('Sending to Gemini (this may take a few seconds)...\n');
  
  try {
    const startTime = Date.now();
    const result = await generateContent(prompt, apiKey, { model: 'gemini-3.5-flash-lite' });
    const duration = Date.now() - startTime;
    
    console.log(`✅ Received response in ${duration}ms`);
    console.log('\n=== Gemini Predictions vs. Ground Truth ===\n');
    
    let correct = 0;
    
    if (!Array.isArray(result)) {
      console.error('Expected JSON array, got:', typeof result);
      console.dir(result, { depth: null });
      return;
    }

    let evaluatedCount = 0;

    result.forEach((prediction) => {
      // Find the original track to get the actual label
      const originalTrack = tracks.find(t => t.originalIndex === Number(prediction.originalIndex));
      if (!originalTrack) return;

      const hasActual = Boolean(originalTrack._actualLabel);
      const actual = hasActual ? originalTrack._actualLabel.toUpperCase() : 'N/A';
      const predicted = String(prediction.decision).toUpperCase();
      
      let matchIcon = '🎵';
      if (hasActual) {
        evaluatedCount++;
        const isMatch = actual === predicted;
        if (isMatch) correct++;
        matchIcon = isMatch ? '✅' : '❌';
      }
      
      console.log(`${matchIcon} [#${prediction.originalIndex}] "${prediction.name}" by ${prediction.artist}`);
      if (hasActual) {
        console.log(`    Actual: ${actual} | Predicted: ${predicted} (Confidence: ${prediction.confidence}%)`);
      } else {
        console.log(`    Predicted: ${predicted} (Confidence: ${prediction.confidence}%)`);
      }
      console.log(`    Reason: ${prediction.reason}`);
      console.log('');
    });
    
    if (evaluatedCount > 0) {
      console.log('=============================================');
      console.log(`Accuracy: ${correct}/${evaluatedCount} (${Math.round((correct/evaluatedCount)*100)}%)`);
      console.log('=============================================');
    } else {
      console.log('=============================================');
      console.log(`Successfully generated predictions for ${result.length} tracks!`);
      console.log('=============================================');
    }
    
  } catch (error) {
    console.error('\n❌ Test failed with error:', error.message);
  }
}

runTest();
