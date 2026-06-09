# ☕ yt-mp3

YouTube to MP3 downloader. One command to run locally. Deploy-ready for Render.

## Run locally

**Requires Node.js 18+**

```bash
npm install
node index.js
```

Open **http://localhost:3000**

- `yt-dlp` binary is **auto-downloaded** into `bin/` on first start (Linux/macOS).
- `ffmpeg` comes bundled via the `ffmpeg-static` npm package — **nothing extra to install**.

---

## Deploy to Render (free tier)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New → Web Service**
3. Connect your repo
4. Render reads `render.yaml` automatically — just click **Deploy**

Settings (auto-applied from `render.yaml`):
- **Build command:** `npm install`
- **Start command:** `node index.js`

> ⚠️ Do **not** use Railway — they ban yt-dlp.

---

## How it works

1. Paste a YouTube URL → click **Get Info** (calls `/info`, returns title + thumbnail)
2. Click **Download MP3** (calls `/download`, server runs `yt-dlp -x --audio-format mp3`)
3. File is converted via the bundled ffmpeg binary and streamed directly to your browser
4. Temp file in `/tmp` is deleted immediately after serving

## Stack

- **express** — HTTP server
- **yt-dlp** — audio extraction (binary auto-downloaded at startup)
- **ffmpeg-static** — bundled ffmpeg binary, no system install needed
