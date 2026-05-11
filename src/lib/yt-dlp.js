const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SEARCH_TIMEOUT_MS = 15000;
const METADATA_TIMEOUT_MS = 18000;

const packagedYtDlpPath = () => {
  const pkgPath = require.resolve('@distube/yt-dlp/package.json');
  const fileName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  return path.join(path.dirname(pkgPath), 'bin', fileName);
};

const resolveYtDlpPath = () => {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  const packaged = packagedYtDlpPath();
  if (fs.existsSync(packaged)) return packaged;
  return 'yt-dlp';
};

let ensurePromise = null;

const ensureYtDlp = async () => {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    const packaged = packagedYtDlpPath();
    if (process.env.YTDLP_PATH || fs.existsSync(packaged)) return resolveYtDlpPath();

    try {
      const ytdlp = require('@distube/yt-dlp');
      if (typeof ytdlp.download === 'function') {
        await ytdlp.download();
      }
    } catch (error) {
      console.warn(`[Aether API] yt-dlp download failed: ${error.message}`);
    }

    return resolveYtDlpPath();
  })();
  return ensurePromise;
};

const runYtDlpLines = async (args, timeoutMs) => {
  const ytdlpPath = await ensureYtDlp();

  return new Promise((resolve, reject) => {
    const child = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      done(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => done(error));
    child.on('close', (code) => {
      if (code !== 0) {
        done(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        return;
      }
      done(null, stdout);
    });
  });
};

const normalizeTrack = (data) => {
  const id = data?.id ? String(data.id) : '';
  if (!id || !data?.title) return null;
  const url = data.webpage_url || data.original_url || data.url || `https://www.youtube.com/watch?v=${id}`;
  const durationMs = Math.max(0, Math.floor(Number(data.duration) || 0) * 1000);
  return {
    id,
    youtubeId: id,
    title: String(data.title || 'Unknown track'),
    author: String(data.uploader || data.channel || data.artist || 'Unknown Artist'),
    duration: durationMs,
    totalDurationMs: durationMs,
    url,
    actualUrl: url,
    thumbnail: data.thumbnail || data.thumbnails?.[0]?.url || '',
  };
};

const searchTracks = async (query) => {
  const q = String(query || '').trim();
  if (!q) return [];

  const stdout = await runYtDlpLines([
    `ytsearch20:${q}`,
    '--dump-json',
    '--flat-playlist',
    '--no-check-certificates',
    '--no-warnings',
    '--skip-download',
  ], SEARCH_TIMEOUT_MS);

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return normalizeTrack(JSON.parse(line)); }
      catch { return null; }
    })
    .filter(Boolean);
};

const getMetadata = async (url) => {
  const target = String(url || '').trim();
  if (!target) return null;

  const stdout = await runYtDlpLines([
    target,
    '--dump-json',
    '--no-check-certificates',
    '--no-warnings',
    '--skip-download',
  ], METADATA_TIMEOUT_MS);

  return normalizeTrack(JSON.parse(stdout));
};

module.exports = {
  ensureYtDlp,
  getMetadata,
  searchTracks,
};
