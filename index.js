import express from 'express';
import path    from 'path';
import fs      from 'fs';
import os      from 'os';
import https   from 'https';
import { fileURLToPath } from 'url';
import { spawn }         from 'child_process';
import YTDlpWrap         from 'yt-dlp-wrap';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// ── yt-dlp binary ─────────────────────────────────────────────────────────────
// Auto-download the yt-dlp binary into bin/ on first start (Linux/macOS).
// On Windows, yt-dlp-wrap falls back to the system PATH automatically.
const BIN_DIR     = path.join(__dirname, 'bin');
const YTDLP_PATH  = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_PATH)) {
    console.log('yt-dlp binary already present at', YTDLP_PATH);
    return YTDLP_PATH;
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  console.log('Downloading yt-dlp binary…');
  await YTDlpWrap.downloadFromGithub(YTDLP_PATH);
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
// Uses `yt-dlp --dump-json` — fast, no download, returns full metadata
app.get('/info', async (req, res) => {
  const { url } = req.query;
  if (!url || !isYouTubeUrl(url))
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });

  try {
    const ytdlp = new YTDlpWrap(app.locals.ytdlpPath);

    // --dump-json prints one JSON object to stdout then exits — very fast
    const info = await ytdlp.getVideoInfo(url);

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
// Uses `yt-dlp -x --audio-format mp3` — extracts audio and converts via ffmpeg
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

    // yt-dlp flags:
    //   -x                   extract audio only
    //   --audio-format mp3   convert to mp3
    //   --audio-quality 0    best VBR quality
    //   --ffmpeg-location    point to bundled ffmpeg
    //   -o                   output path (without .mp3 suffix — yt-dlp adds it)
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