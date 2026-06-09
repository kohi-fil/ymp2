import express from 'express';
import path    from 'path';
import fs      from 'fs';
import os      from 'os';
import https   from 'https';
import { fileURLToPath } from 'url';
import YTDlpWrapModule from 'yt-dlp-wrap';
const YTDlpWrap = YTDlpWrapModule.default ?? YTDlpWrapModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// ── yt-dlp binary ─────────────────────────────────────────────────────────────
const BIN_DIR    = path.join(__dirname, 'bin');
const YTDLP_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return get(res.headers.location);
      if (res.statusCode !== 200) {
        file.close(); fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode} downloading yt-dlp`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => { file.close(); fs.unlink(dest, () => {}); reject(err); });
    get(url);
  });
}

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_PATH)) return YTDLP_PATH;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  console.log('Downloading yt-dlp binary…');
  const asset = process.platform === 'win32' ? 'yt-dlp.exe'
              : process.platform === 'darwin' ? 'yt-dlp_macos'
              : 'yt-dlp';
  await downloadFile(
    `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`,
    YTDLP_PATH
  );
  fs.chmodSync(YTDLP_PATH, 0o755);
  console.log('✅ yt-dlp downloaded to', YTDLP_PATH);
  return YTDLP_PATH;
}

// ── ffmpeg path ───────────────────────────────────────────────────────────────
async function resolveFfmpeg() {
  try { const mod = await import('ffmpeg-static'); return mod.default; }
  catch { return 'ffmpeg'; }
}

// ── Cookies ───────────────────────────────────────────────────────────────────
// Load cookies from COOKIES_PATH env var (a Netscape-format .txt file on disk),
// or fall back to the COOKIES env var (raw file contents as a string).
// If neither is set, yt-dlp runs without cookies (may hit bot-check on some IPs).
function resolveCookiesPath() {
  if (process.env.COOKIES_PATH && fs.existsSync(process.env.COOKIES_PATH)) {
    console.log('🍪 Using cookies file:', process.env.COOKIES_PATH);
    return process.env.COOKIES_PATH;
  }
  if (process.env.COOKIES) {
    const dest = path.join(os.tmpdir(), 'yt-cookies.txt');
    fs.writeFileSync(dest, process.env.COOKIES, 'utf8');
    console.log('🍪 Wrote cookies from env to', dest);
    return dest;
  }
  console.warn('⚠️  No cookies configured — bot-check may block requests on datacenter IPs.');
  return null;
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

function cleanup(p) { if (p) fs.unlink(p, () => {}); }

// Append --cookies <path> to an args array when cookies are available.
function withCookies(args) {
  if (app.locals.cookiesPath) return [...args, '--cookies', app.locals.cookiesPath];
  return args;
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

    const raw = await ytdlp.execPromise(withCookies([
      url,
      '--dump-json',
      '--no-playlist',
      '--extractor-args', 'youtube:player_client=tv',
    ]));

    const info = JSON.parse(raw);
    res.json({
      title:           info.title           || '',
      thumbnail:       info.thumbnail       || '',
      duration_string: info.duration_string || '',
      uploader:        info.uploader        || '',
    });
  } catch (e) {
    console.error('[info error]', e.message);
    res.status(500).json({ error: e.message || 'Could not fetch video info.' });
  }
});

// GET /download?url=...
app.get('/download', async (req, res) => {
  const { url } = req.query;
  if (!url || !isYouTubeUrl(url))
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });

  const id      = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const mp3Path = path.join(os.tmpdir(), `${id}.mp3`);

  try {
    const ytdlp = new YTDlpWrap(app.locals.ytdlpPath);

    // 1. Get title for the filename
    const title = (await ytdlp.execPromise(withCookies([
      url,
      '--print', 'title',
      '--no-playlist',
      '--extractor-args', 'youtube:player_client=tv',
    ]))).trim();

    const filename = safeFilename(title || id);
    console.log(`[download] start "${filename}"`);

    // 2. Download + convert
    await ytdlp.execPromise(withCookies([
      url,
      '-x',
      '--audio-format',    'mp3',
      '--audio-quality',   '0',
      '--ffmpeg-location', path.dirname(app.locals.ffmpegPath),
      '--no-playlist',
      '--extractor-args',  'youtube:player_client=tv',
      '-o', path.join(os.tmpdir(), `${id}.%(ext)s`),
    ]));

    if (!fs.existsSync(mp3Path))
      return res.status(500).json({ error: 'Conversion produced no output file.' });

    const stat = fs.statSync(mp3Path);
    res.setHeader('Content-Type',        'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length',      stat.size);

    const stream = fs.createReadStream(mp3Path);
    stream.pipe(res);

    let cleaned = false;
    const done = () => { if (!cleaned) { cleaned = true; cleanup(mp3Path); } };
    res.on('finish', done);
    res.on('close',  done);
    stream.on('error', (err) => { console.error('[stream error]', err.message); cleanup(mp3Path); });

    console.log(`[download] serving "${filename}" (${(stat.size / 1e6).toFixed(1)} MB)`);
  } catch (e) {
    cleanup(mp3Path);
    console.error('[download error]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message || 'Download failed.' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  app.locals.ffmpegPath  = await resolveFfmpeg();
  app.locals.ytdlpPath   = await ensureYtDlp();
  app.locals.cookiesPath = resolveCookiesPath();
  console.log('ffmpeg:', app.locals.ffmpegPath);
  console.log('yt-dlp:', app.locals.ytdlpPath);
  app.listen(PORT, () => console.log(`\n☕  Listening on http://localhost:${PORT}\n`));
}

start().catch((err) => { console.error('Startup failed:', err); process.exit(1); });
