import express from 'express';
import path    from 'path';
import fs      from 'fs';
import os      from 'os';
import { fileURLToPath } from 'url';
import { Innertube }     from 'youtubei.js';
import { spawn }         from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// ── youtubei.js client (created once at startup) ──────────────────────────────
let yt = null;
async function getYT() {
  if (!yt) yt = await Innertube.create({ retrieve_player: true });
  return yt;
}

// ── ffmpeg: use ffmpeg-static if available, fall back to system ffmpeg ─────────
function getFfmpeg() {
  try {
    const { default: p } = await import('ffmpeg-static');
    return p;
  } catch { return 'ffmpeg'; }
}
// resolve synchronously at startup via dynamic import workaround
let ffmpegPath = 'ffmpeg';
try {
  const mod = await import('ffmpeg-static');
  ffmpegPath = mod.default;
} catch { /* use system ffmpeg */ }

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────────────────────
function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return /^(www\.)?(youtube\.com|youtu\.be)$/.test(u.hostname);
  } catch { return false; }
}

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
    return u.searchParams.get('v');
  } catch { return null; }
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

  const videoId = extractVideoId(url);
  if (!videoId)
    return res.status(400).json({ error: 'Could not extract video ID from URL.' });

  try {
    const youtube = await getYT();
    const info    = await youtube.getBasicInfo(videoId);
    const details = info.basic_info;

    res.json({
      title:           details.title            || '',
      thumbnail:       details.thumbnail?.[0]?.url || '',
      duration_string: formatDuration(details.duration),
      uploader:        details.author            || '',
    });
  } catch (e) {
    console.error('[info error]', e.message);
    res.status(400).json({ error: e.message || 'Could not fetch video info.' });
  }
});

// GET /download?url=...&title=...
app.get('/download', async (req, res) => {
  const { url, title } = req.query;
  if (!url || !isYouTubeUrl(url))
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });

  const videoId = extractVideoId(url);
  if (!videoId)
    return res.status(400).json({ error: 'Could not extract video ID from URL.' });

  const id      = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const rawPath = path.join(os.tmpdir(), `${id}.webm`);  // audio stream from YT is webm/opus
  const mp3Path = path.join(os.tmpdir(), `${id}.mp3`);
  const filename = safeFilename(title || id);

  console.log(`[download] start "${filename}"`);

  try {
    const youtube = await getYT();
    const info    = await youtube.getInfo(videoId);

    // Stream the best audio-only format to a temp file
    const stream  = await youtube.download(videoId, {
      type:    'audio',
      quality: 'best',
      format:  'any',
    });

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(rawPath);
      stream.pipe(file);
      file.on('finish', resolve);
      file.on('error', reject);
      stream.on('error', reject);
    });

    // Convert to MP3 with ffmpeg
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, [
        '-y',
        '-i', rawPath,
        '-vn',
        '-acodec', 'libmp3lame',
        '-q:a', '0',
        mp3Path
      ]);
      let stderr = '';
      proc.stderr.on('data', (d) => (stderr += d));
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr.slice(-300)));
        else resolve();
      });
      proc.on('error', reject);
    });

    cleanup(rawPath);

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
    cleanup(rawPath);
    cleanup(mp3Path);
    console.error('[download error]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message || 'Download failed.' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

// ── Start ─────────────────────────────────────────────────────────────────────
console.log('☕ Initialising youtubei.js…');
console.log('ffmpeg:', ffmpegPath);
await getYT(); // warm up the InnerTube session
app.listen(PORT, () => console.log(`\n☕  Listening on http://localhost:${PORT}\n`));