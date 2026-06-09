'use strict';

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const ffmpegPath = require('ffmpeg-static');
const youtubedl  = require('youtube-dl-exec');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────────────────────
function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return /^(www\.)?(youtube\.com|youtu\.be)$/.test(u.hostname);
  } catch {
    return false;
  }
}

// Safe ASCII filename for Content-Disposition
function safeFilename(title) {
  return (title || 'audio')
    .replace(/[^\w\s\-().]/g, '')   // strip non-ASCII / special chars
    .replace(/\s+/g, '_')
    .slice(0, 80)
    .concat('.mp3');
}

// Clean up a file silently
function cleanup(filePath) {
  if (filePath) fs.unlink(filePath, () => {});
}

// ── Shared yt-dlp base options ────────────────────────────────────────────────
// These args bypass YouTube bot-detection without needing a logged-in account.
// youtube-dl-exec always uses the latest yt-dlp binary, so bot-detection fixes
// land automatically on every `npm install` / server restart.
const BASE_OPTS = {
  noPlaylist:   true,
  noWarnings:   true,
  noUpdate:     true,
  // Use the Android client — it does not trigger the "Sign in to confirm"
  // challenge that the default web client now faces on many IPs.
  extractorArgs: 'youtube:player_client=android',
};

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

// GET /info?url=...  →  { title, thumbnail, duration_string, uploader }
app.get('/info', async (req, res) => {
  const { url } = req.query;
  if (!url || !isYouTubeUrl(url))
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });

  try {
    const info = await youtubedl(url, {
      ...BASE_OPTS,
      dumpSingleJson: true,
    });

    res.json({
      title:           info.title            || '',
      thumbnail:       info.thumbnail        || '',
      duration_string: info.duration_string  || '',
      uploader:        info.uploader         || '',
    });
  } catch (e) {
    const msg = (e.stderr || e.message || 'Could not fetch video info.')
      .replace(/\n/g, ' ').slice(0, 300);
    res.status(400).json({ error: msg });
  }
});

// GET /download?url=...&title=...  →  streams MP3 file
app.get('/download', async (req, res) => {
  const { url, title } = req.query;
  if (!url || !isYouTubeUrl(url))
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });

  const id      = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outPath = path.join(os.tmpdir(), `${id}.mp3`);
  const filename = safeFilename(title || id);

  console.log(`[download] start "${filename}"`);

  try {
    await youtubedl(url, {
      ...BASE_OPTS,
      ffmpegLocation: ffmpegPath,   // use ffmpeg-static — no apt-get needed
      extractAudio:   true,
      audioFormat:    'mp3',
      audioQuality:   0,
      output:         outPath,
    });

    if (!fs.existsSync(outPath)) {
      return res.status(500).json({ error: 'Conversion produced no output file.' });
    }

    const stat = fs.statSync(outPath);

    res.setHeader('Content-Type',        'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length',      stat.size);

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);

    let cleaned = false;
    const done = () => { if (!cleaned) { cleaned = true; cleanup(outPath); } };
    res.on('finish', done);
    res.on('close',  done);

    stream.on('error', (err) => {
      console.error('[stream error]', err.message);
      cleanup(outPath);
    });

    console.log(`[download] serving "${filename}" (${(stat.size / 1e6).toFixed(1)} MB)`);
  } catch (e) {
    cleanup(outPath);
    const msg = (e.stderr || e.message || 'Download or conversion failed.')
      .replace(/\n/g, ' ').slice(0, 400);
    console.error('[download error]', msg);
    if (!res.headersSent) res.status(500).json({ error: msg });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n☕  yt-mp3 listening on http://localhost:${PORT}\n`);
  console.log('ffmpeg path:', ffmpegPath);
  console.log('yt-dlp:      managed by youtube-dl-exec (latest binary)\n');
});
