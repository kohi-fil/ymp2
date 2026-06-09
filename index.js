import express from 'express';
import path    from 'path';
import fs      from 'fs';
import os      from 'os';
import https   from 'https';
import { fileURLToPath } from 'url';
import { spawn }         from 'child_process';
import YTDlpWrapModule from 'yt-dlp-wrap';
const YTDlpWrap = YTDlpWrapModule.default ?? YTDlpWrapModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// ── yt-dlp binary ─────────────────────────────────────────────────────────────
const BIN_DIR    = path.join(__dirname, 'bin');
const YTDLP_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// Download yt-dlp directly from GitHub releases, following redirects.
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode} downloading yt-dlp`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
    get(url);
  });
}

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_PATH)) {
    console.log('yt-dlp binary already present at', YTDLP_PATH);
    return YTDLP_PATH;
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  console.log('Downloading yt-dlp binary…');

  const asset = process.platform === 'win32' ? 'yt-dlp.exe'
              : process.platform === 'darwin' ? 'yt-dlp_macos'
              : 'yt-dlp';  // linux

  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  await downloadFile(url, YTDLP_PATH);
  fs.chmodSync(YTDLP_PATH, 0o755);
  console.log('✅ yt-dlp downloaded to', YTDLP_PATH);
  return YTDLP_PATH;
}

// ── ffmpeg path ───────────────────────────────────────────────────────────────
async function resolveFfmpeg() {
  try {
    const mod = await import('ffmpeg-static');
    return mod.default;
  } catch {
    return 'ffmpeg';
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────────────────────
function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return /^(www\.)?(youtube\.com|youtu\.be)$/.test(u.hostname);
  } catch { return false; }
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

// GET /info?url=...
app.get('/info', async (req, res) => {
  const { url } = req.query;
  if (!url || !isYouTubeUrl(url))
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });

  try {
    const ytdlp = new YTDlpWrap(app.locals.ytdlpPath);
    const info  = await ytdlp.getVideoInfo(url);

    const thumb = (info.thumbnails || [])
      .sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0]
      ?.url || info.thumbnail || '';

    const duration = info.duration
      ? (() => {
          const s = Math.round(info.duration);
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          const sec = s % 60;
          if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
          return `${m}:${String(sec).padStart(2,'0')}`;
        })()
      : '';

    return res.json({
      title:           info.title || '',
      thumbnail:       thumb,
      duration_string: duration,
      uploader:        info.uploader || info.channel || '',
    });
  } catch (e) {
    console.error('[info error]', e.message);
    return res.status(400).json({ error: e.message || 'Could not fetch video info.' });
  }
});

// GET /download?url=...&title=...
app.get('/download', async (req, res) => {
  const { url, title } = req.query;
  if (!url || !isYouTubeUrl(url))
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });

  const id       = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const mp3Path  = path.join(os.tmpdir(), `${id}.mp3`);
  const filename = safeFilename(title || id);

  console.log(`[download] start "${filename}"`);

  try {
    const ytdlp = new YTDlpWrap(app.locals.ytdlpPath);

    await ytdlp.execPromise([
      url,
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--ffmpeg-location', path.dirname(app.locals.ffmpegPath),
      '--no-playlist',
      '-o', path.join(os.tmpdir(), `${id}.%(ext)s`),
    ]);

    if (!fs.existsSync(mp3Path))
      return res.status(500).json({ error: 'Conversion produced no output file.' });

    const stat = fs.statSync(mp3Path);
    res.setHeader('Content-Type',        'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length',      stat.size);

    const fileStream = fs.createReadStream(mp3Path);
    fileStream.pipe(res);

    let cleaned = false;
    const done = () => { if (!cleaned) { cleaned = true; cleanup(mp3Path); } };
    res.on('finish', done);
    res.on('close',  done);
    fileStream.on('error', (err) => { console.error('[stream error]', err.message); cleanup(mp3Path); });

    console.log(`[download] serving "${filename}" (${(stat.size / 1e6).toFixed(1)} MB)`);
  } catch (e) {
    cleanup(mp3Path);
    console.error('[download error]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message || 'Download failed.' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  app.locals.ffmpegPath = await resolveFfmpeg();
  app.locals.ytdlpPath  = await ensureYtDlp();

  console.log('ffmpeg:', app.locals.ffmpegPath);
  console.log('yt-dlp:', app.locals.ytdlpPath);

  app.listen(PORT, () => console.log(`\n☕  Listening on http://localhost:${PORT}\n`));
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});