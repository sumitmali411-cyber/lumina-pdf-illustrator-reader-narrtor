/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Modality } from '@google/genai';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env.local takes precedence; dotenv never overwrites an already-set value.
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const PORT = Number(process.env.PORT) || 8080;
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error(
    'GEMINI_API_KEY is not set. Create a .env.local with GEMINI_API_KEY=<your key> before starting the server.',
  );
  process.exit(1);
}

// The key lives only in this process. It is never sent to the browser.
const ai = new GoogleGenAI({ apiKey: API_KEY });

/** Voices the upstream model accepts. Anything else is rejected. */
const ALLOWED_VOICES = new Set(['Kore', 'Fenrir', 'Zephyr']);

/** Upper bound on a single request, in characters. */
const MAX_TTS_CHARS = 2000;
const MAX_SUMMARY_CHARS = 8000;

/** Rate limit: requests allowed per client per window. */
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;

const app = express();

app.disable('x-powered-by');

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // Tailwind and the animation library write inline style attributes.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  // pdf.js loads its worker from a bundled blob URL.
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  );
  next();
});

// Reject oversized bodies before they are buffered into memory.
app.use(express.json({ limit: '256kb' }));

const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || now >= entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

// Drop expired buckets so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) {
    if (now >= entry.resetAt) hits.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

app.use('/api', (req, res, next) => {
  if (rateLimited(req.ip ?? 'unknown')) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }
  next();
});

app.post('/api/summarize', async (req, res) => {
  const { text } = req.body ?? {};

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'A non-empty "text" string is required.' });
  }

  if (text.length > MAX_SUMMARY_CHARS) {
    return res
      .status(413)
      .json({ error: `"text" must be ${MAX_SUMMARY_CHARS} characters or fewer.` });
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Summarize the following text from a book page concisely in 2-3 sentences. Capture the main events, ideas, or mood:\n\n${text.substring(0, 3000)}`,
    });
    return res.json({ summary: response.text || null });
  } catch (error) {
    console.error('Summarization failed:', error);
    return res.status(502).json({ error: 'Summarization failed. Please try again.' });
  }
});

app.post('/api/tts', async (req, res) => {
  const { text, voice } = req.body ?? {};

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'A non-empty "text" string is required.' });
  }

  if (text.length > MAX_TTS_CHARS) {
    return res
      .status(413)
      .json({ error: `"text" must be ${MAX_TTS_CHARS} characters or fewer.` });
  }

  const voiceName = typeof voice === 'string' ? voice : 'Kore';
  if (!ALLOWED_VOICES.has(voiceName)) {
    return res.status(400).json({ error: 'Unknown voice.' });
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-preview-tts',
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    });

    const base64Audio =
      response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      return res.status(502).json({ error: 'No audio was returned by the speech model.' });
    }

    return res.json({ data: base64Audio });
  } catch (error: any) {
    // Surface quota as a distinct status the client can react to, without
    // echoing the upstream error text (which can carry request details).
    const message = String(error?.message ?? '');
    if (message.includes('429') || message.toLowerCase().includes('quota')) {
      return res.status(429).json({ error: 'API quota reached', code: 'QUOTA_EXCEEDED' });
    }
    console.error('Speech generation failed:', error);
    return res.status(502).json({ error: 'Speech generation failed. Please try again.' });
  }
});

// Serve the production build. In development Vite serves the client and
// proxies /api to this process.
const distDir = path.resolve(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Lumina API listening on http://localhost:${PORT}`);
});
