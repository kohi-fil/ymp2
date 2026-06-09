'use strict';

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');
const { spawn } = require('child_process');
const os        = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Paths ─────────────────────────────────────────────────────────────────────
const BIN_DIR   = path.join(__dirname, 'bin');
const YTDLP_BIN = path.join(BIN_DIR, 'yt-dlp');

// Use system ffmpeg (available on Render) or fall back to ffmpeg-static if present
function getFfmpegPath() {
  try {
    // Try ffmpeg-static first (works locally)
    return require('ffmpeg-static');
  } catch {
    // Render and most Linux servers have ffmpeg on PATH
    return 'ffmpeg';
  }
}
const ffmpegPath = getFfmpegPath();

// ── Boot: ensure bin dir exists ───────────────────────────────────────────────
fs.mkdirSync(BIN_DIR, { recursive: true });

// ── yt-dlp auto-download ──────────────────────────────────────────────────────
let ytdlpReady = false;
let ytdlpReadyPromise = null;

function ensureYtDlp() {
  if (ytdlpReadyPromise) return ytdlpReadyPromise;
  ytdlpReadyPromise = new Promise((resolve, reject) => {
    if (fs.existsSync(YTDLP_BIN)) {
      console.log('✅ yt-dlp binary present');
      ytdlpReady = true;
      return resolve();
    }
    console.log('⬇️  Downloading yt-dlp binary…');
    const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    const tmp = YTDLP_BIN + '.tmp';
    const file = fs.createWriteStream(tmp);

    function get(downloadUrl) {
      https.get(downloadUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(tmp, () => {});
          return reject(new Error(`yt-dlp download failed: HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.rename(tmp, YTDLP_BIN, (err) => {
              if (err) return reject(err);
              fs.chmod(YTDLP_BIN, 0o755, (err2) => {
                if (err2) return reject(err2);
                console.log('✅ yt-dlp ready');
                ytdlpReady = true;
                resolve();
              });
            });
          });
        });
        file.on('error', (err) => { fs.unlink(tmp, () => {}); reject(err); });
      }).on('error', (err) => { fs.unlink(tmp, () => {}); reject(err); });
    }
    get(url);
  });
  return ytdlpReadyPromise;
}

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

function safeFilename(title) {
  return (title || 'audio')
    .replace(/[^\w\s\-().]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80)
    .concat('.mp3');
}

function cleanup(filePath) {
  if (filePath) fs.unlink(filePath, () => {});
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

// GET /info?url=...  →  { title, thumbnail, duration_string, uploader }
app.get('/info', async (req, res) => {
  const { url } = req.query;
  if (!url || !isYouTubeUrl(url))
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });

  try { await ensureYtDlp(); }
  catch (e) { return res.status(500).json({ error: 'Binary setup failed: ' + e.message }); }

  let stdout = '', stderr = '';
  const proc = spawn(YTDLP_BIN, [
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--no-update',
    '--extractor-args', 'youtube:player_client=android',
    url
  ]);

  proc.stdout.on('data', (d) => (stdout += d));
  proc.stderr.on('data', (d) => (stderr += d));

  proc.on('close', (code) => {
    if (code !== 0) {
      const msg = stderr.replace(/\n/g, ' ').slice(0, 300);
      return res.status(400).json({ error: msg || 'Could not fetch video info.' });
    }
    try {
      const info = JSON.parse(stdout);
      res.json({
        title:           info.title            || '',
        thumbnail:       info.thumbnail        || '',
        duration_string: info.duration_string  || '',
        uploader:        info.uploader         || '',
      });
    } catch {
      res.status(500).json({ error: 'Failed to parse video metadata.' });
    }
  });

  proc.on('error', (e) => res.status(500).json({ error: e.message }));
});

// GET /download?url=...&title=...  →  streams MP3 file
app.get('/download', async (req, res) => {
  const { url, title } = req.query;
  if (!url || !isYouTubeUrl(url))
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });

  try { await ensureYtDlp(); }
  catch (e) { return res.status(500).json({ error: 'Binary setup failed: ' + e.message }); }

  const id      = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outPath = path.join(os.tmpdir(), `${id}.mp3`);
  const filename = safeFilename(title || id);

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-update',
    '--extractor-args', 'youtube:player_client=android',
    '--ffmpeg-location', ffmpegPath,
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '-o', outPath,
    url
  ];

  console.log(`[download] start "${filename}" | ffmpeg: ${ffmpegPath}`);

  const proc = spawn(YTDLP_BIN, args);
  let stderr = '';
  let responded = false;

  proc.stderr.on('data', (d) => (stderr += d));

  proc.on('close', (code) => {
    if (responded) return;

    if (code !== 0 || !fs.existsSync(outPath)) {
      responded = true;
      cleanup(outPath);
      const msg = stderr.replace(/\n/g, ' ').slice(0, 400);
      return res.status(500).json({ error: msg || 'Download or conversion failed.' });
    }

    const stat = fs.statSync(outPath);

    responded = true;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stat.size);

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
  });

  proc.on('error', (e) => {
    if (!responded) {
      responded = true;
      cleanup(outPath);
      res.status(500).json({ error: e.message });
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  console.log('☕ Starting yt-mp3…');
  console.log('ffmpeg path:', ffmpegPath);
  await ensureYtDlp();
  app.listen(PORT, () => console.log(`\n☕  Listening on http://localhost:${PORT}\n`));
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});