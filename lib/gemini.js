/**
 * gemini.js — REST client for Gemini 1.5 Flash API.
 *
 * Provides a simple wrapper around the Google Generative Language API
 * suitable for use in both Node.js (for CLI testing) and the browser
 * (for the Chrome extension background worker).
 */

/**
 * Calls the Gemini 1.5 Flash model to generate content.
 *
 * @param {string} prompt - The prompt string to send to the model.
 * @param {string} apiKey - The user's Gemini API key.
 * @param {Object} [options] - Optional configuration.
 * @param {number} [options.temperature=0.3] - Sampling temperature (lower = more deterministic).
 * @returns {Promise<any>} A promise that resolves to the parsed JSON response object.
 * @throws {Error} If the API request fails or the response cannot be parsed as JSON.
 */
export async function generateContent(prompt, apiKey, options = {}) {
  if (!apiKey) {
    throw new Error('Gemini API key is required.');
  }

  const model = options.model || 'gemini-3.5-flash-lite';
  const temperature = options.temperature ?? 0.3;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: temperature,
      // Enforce JSON output for structured parsing
      responseMimeType: 'application/json',
    }
  };

  const maxRetries = 3;
  let attempt = 0;
  let lastError = null;

  while (attempt < maxRetries) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 429) {
          // Rate limit: exponential backoff
          const delay = Math.pow(2, attempt) * 1000;
          console.warn(`[Gemini API] Rate limited (429). Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          attempt++;
          continue;
        }
        throw new Error(`Gemini API Error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      
      // Extract the text content from the first candidate
      if (
        data.candidates && 
        data.candidates.length > 0 && 
        data.candidates[0].content && 
        data.candidates[0].content.parts && 
        data.candidates[0].content.parts.length > 0
      ) {
        const textResponse = data.candidates[0].content.parts[0].text;
        
        // Resilient JSON parsing (handles markdown fences, leading/trailing whitespace, wrapped keys)
        const parsed = cleanAndParseJson(textResponse);
        if (parsed !== null) {
          return parsed;
        }

        console.error('[Gemini API] Failed to parse model response as JSON. Raw text:\n', textResponse);
        throw new Error('Model returned invalid JSON format.');
      } else {
        throw new Error('Unexpected response structure from Gemini API: ' + JSON.stringify(data));
      }

    } catch (error) {
      if (error.message.includes('Rate limited') || attempt > 0) {
        lastError = error;
      } else {
        throw error; // Rethrow immediately if not a retriable error
      }
    }
  }

  throw new Error(`Gemini API request failed after ${maxRetries} attempts. Last error: ${lastError?.message}`);
}

/**
 * Resilient JSON parser that handles Markdown code blocks, trailing commas,
 * leading/trailing whitespace, and common LLM response artifacts.
 *
 * @param {string} rawText - Raw string from model output.
 * @returns {any|null} Parsed JSON or null if unparseable.
 */
function cleanAndParseJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  let text = rawText.trim();

  // Try parsing directly first
  try {
    return JSON.parse(text);
  } catch (_) {}

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  if (text.includes('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try {
      return JSON.parse(text);
    } catch (_) {}
  }

  // Extract from the outermost brackets: [ ... ] or { ... }
  const firstBracket = text.indexOf('[');
  const firstBrace = text.indexOf('{');

  let startIndex = -1;
  let endIndex = -1;

  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    startIndex = firstBracket;
    endIndex = text.lastIndexOf(']');
  } else if (firstBrace !== -1) {
    startIndex = firstBrace;
    endIndex = text.lastIndexOf('}');
  }

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const candidate = text.substring(startIndex, endIndex + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  // Recovery: if model output was cut off mid-stream by token limit before closing ']',
  // salvage all complete objects by closing after the last complete '}'
  if (firstBracket !== -1) {
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace > firstBracket) {
      const repaired = text.substring(firstBracket, lastBrace + 1) + ']';
      try {
        const salvaged = JSON.parse(repaired);
        console.warn(`[Gemini API] Salvaged ${salvaged.length} complete items from truncated response.`);
        return salvaged;
      } catch (_) {}
    }
  }

  return null;
}
