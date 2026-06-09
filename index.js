import express from 'express';
import path    from 'path';
import fs      from 'fs';
import os      from 'os';
import { fileURLToPath } from 'url';
import { Innertube }     from 'youtubei.js';
import { generate }      from 'youtube-po-token-generator';
import { spawn }         from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// ── ffmpeg path ───────────────────────────────────────────────────────────────
// Render has ffmpeg natively; ffmpeg-static is optional for local dev.
async function resolveFfmpeg() {
  try {
    const mod = await import('ffmpeg-static');
    return mod.default;
  } catch {
    return 'ffmpeg'; // system ffmpeg (available on Render)
  }
}

// ── PoToken management ────────────────────────────────────────────────────────
// YouTube requires a valid poToken + visitorData pair to serve streams from
// server-side (non-browser) environments. Without it many videos return
// "Video is login required". Tokens expire roughly every 6 hours so we
// refresh them periodically in the background.
let tokenCache = { visitorData: null, poToken: null, expiresAt: 0 };
const TOKEN_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours

async function getPoTokens() {
  if (Date.now() < tokenCache.expiresAt) return tokenCache;
  try {
    console.log('[potoken] generating fresh tokens…');
    const result = await generate();
    tokenCache = {
      visitorData: result.visitorData,
      poToken:     result.poToken,
      expiresAt:   Date.now() + TOKEN_TTL_MS,
    };
    console.log('[potoken] tokens ready, visitor_data prefix:', result.visitorData?.slice(0, 12));
  } catch (e) {
    console.error('[potoken] generation failed, continuing without tokens:', e.message);
    // Return whatever we have (possibly null values); ytjs will still try.
  }
  return tokenCache;
}

// ── youtubei.js client ────────────────────────────────────────────────────────
// We recreate the client whenever tokens are refreshed so the new tokens
// are picked up. A simple "dirty" flag keeps it cheap.
let yt = null;
let ytTokensExpiry = 0;

async function getYT() {
  if (yt && Date.now() < ytTokensExpiry) return yt;

  const { visitorData, poToken, expiresAt } = await getPoTokens();

  yt = await Innertube.create({
    retrieve_player:         true,
    generate_session_locally: true,   // faster startup; avoids extra YT request
    ...(visitorData && { visitor_data: visitorData }),
    ...(poToken     && { po_token:     poToken     }),
  });

  ytTokensExpiry = expiresAt;
  return yt;
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

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('?')[0];
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

function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
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
    const info    = await youtube.getBasicInfo(videoId, 'ANDROID');
    const details = info.basic_info;

    // Pick the best thumbnail (highest res first)
    const thumbs = details.thumbnail || [];
    const thumb  = thumbs.sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || '';

    return res.json({
      title:           details.title                 || '',
      thumbnail:       thumb,
      duration_string: formatDuration(details.duration),
      uploader:        details.author                || '',
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

  const videoId = extractVideoId(url);
  if (!videoId)
    return res.status(400).json({ error: 'Could not extract video ID from URL.' });

  const id       = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const rawPath  = path.join(os.tmpdir(), `${id}.webm`);
  const mp3Path  = path.join(os.tmpdir(), `${id}.mp3`);
  const filename = safeFilename(title || id);

  console.log(`[download] start "${filename}"`);

  try {
    const youtube = await getYT();

    // Use ANDROID client — it bypasses most login/bot-check restrictions
    // and reliably returns non-DRM audio streams.
    const stream = await youtube.download(videoId, {
      type:    'audio',
      quality: 'best',
      format:  'any',
      client:  'ANDROID',
    });

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(rawPath);
      // youtubei.js returns a web ReadableStream; pipe via async iteration
      (async () => {
        try {
          for await (const chunk of stream) file.write(chunk);
          file.end();
        } catch (err) { reject(err); }
      })();
      file.on('finish', resolve);
      file.on('error', reject);
    });

    // Convert webm/opus → mp3 via ffmpeg
    await new Promise((resolve, reject) => {
      const proc = spawn(app.locals.ffmpegPath, [
        '-y', '-i', rawPath,
        '-vn', '-acodec', 'libmp3lame', '-q:a', '0',
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
    fileStream.on('error', (err) => {
      console.error('[stream error]', err.message);
      cleanup(mp3Path);
    });

    console.log(`[download] serving "${filename}" (${(stat.size / 1e6).toFixed(1)} MB)`);
  } catch (e) {
    cleanup(rawPath);
    cleanup(mp3Path);
    console.error('[download error]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message || 'Download failed.' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  app.locals.ffmpegPath = await resolveFfmpeg();
  console.log('☕  Starting yt-mp3…');
  console.log('ffmpeg:', app.locals.ffmpegPath);

  await getYT(); // warm up InnerTube session + generate initial poTokens
  console.log('✅ youtubei.js ready');

  app.listen(PORT, () => console.log(`\n☕  Listening on http://localhost:${PORT}\n`));
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
