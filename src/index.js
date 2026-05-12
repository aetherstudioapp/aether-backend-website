const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const { fetchSyncedLyrics } = require('./lib/lyrics');
const { ensureYtDlp, getCookieArgs, getMetadata, searchTracks } = require('./lib/yt-dlp');

const app = express();
const port = Number(process.env.PORT || 3333);
const version = require('../package.json').version;
const commit = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'local';

const allowedOrigins = new Set([
  'http://localhost:5173',
  'http://localhost:4173',
  'https://aetherstudio.me',
  'https://www.aetherstudio.me',
  ...(process.env.AETHER_WEB_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean),
]);

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
}));

const queues = new Map();
const getQueue = (id = 'default') => {
  const key = String(id || 'default').slice(0, 80);
  if (!queues.has(key)) {
    queues.set(key, {
      songs: [],
      isPlaying: false,
      currentMs: 0,
      seekOffset: 0,
      lyricOffsetMs: 0,
      updatedAt: new Date().toISOString(),
    });
  }
  return queues.get(key);
};

const touchQueue = (queue) => {
  queue.updatedAt = new Date().toISOString();
  return queue;
};

const STREAM_FORMAT =
  process.env.YTDLP_STREAM_FORMAT
  || 'ba[ext=m4a]/ba[ext=webm]/ba/bestaudio[acodec!=none]/best[acodec!=none]/best';

const asyncRoute = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    console.error(`[Aether API] ${req.method} ${req.path}: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Aether API error', message: error.message });
    }
  }
};

app.get('/api/system', (req, res) => {
  res.json({
    ok: true,
    service: 'aether-backend-website',
    version,
    commit,
    instance: process.env.RENDER_SERVICE_NAME || 'local',
    time: new Date().toISOString(),
  });
});

app.get('/api/search', asyncRoute(async (req, res) => {
  const results = await searchTracks(req.query.q);
  res.json(results);
}));

app.get('/api/metadata', asyncRoute(async (req, res) => {
  const meta = await getMetadata(req.query.url);
  if (!meta) {
    res.status(404).json({ error: 'Metadata not found' });
    return;
  }
  res.json(meta);
}));

app.get('/stream', asyncRoute(async (req, res) => {
  const rawUrl = String(req.query.url || '');
  if (!rawUrl) {
    res.status(400).send('Missing url');
    return;
  }

  const target = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    res.status(400).send('Invalid url');
    return;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    res.status(400).send('Unsupported protocol');
    return;
  }

  const ytdlpPath = await ensureYtDlp();
  const startedAt = Date.now();
  const cookieArgs = getCookieArgs();
  const baseAttempts = [
    { label: 'default', cookieArgs, extractorArgs: [] },
    { label: 'web-client', cookieArgs, extractorArgs: ['--extractor-args', 'youtube:player_client=web'] },
    { label: 'android-client', cookieArgs, extractorArgs: ['--extractor-args', 'youtube:player_client=android'] },
    { label: 'ios-client', cookieArgs, extractorArgs: ['--extractor-args', 'youtube:player_client=ios'] },
    { label: 'anonymous-default', cookieArgs: [], extractorArgs: [] },
    { label: 'anonymous-web-client', cookieArgs: [], extractorArgs: ['--extractor-args', 'youtube:player_client=web'] },
    { label: 'anonymous-android-client', cookieArgs: [], extractorArgs: ['--extractor-args', 'youtube:player_client=android'] },
  ];
  const attempts = baseAttempts.filter((attempt, index) => {
    if (cookieArgs.length === 0 && attempt.label.startsWith('anonymous-')) return index >= 4;
    return true;
  });

  let responded = false;
  let activeChild = null;
  let requestClosed = false;
  const closeChild = () => {
    requestClosed = true;
    if (activeChild && !activeChild.killed) {
      try { activeChild.kill('SIGKILL'); } catch {}
    }
  };

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  req.on('close', closeChild);

  const runAttempt = (attemptIndex) => {
    if (requestClosed || res.destroyed) return;
    const attempt = attempts[attemptIndex];
    let stderr = '';
    const child = spawn(ytdlpPath, [
      parsed.toString(),
      ...attempt.cookieArgs,
      ...attempt.extractorArgs,
      '--format',
      STREAM_FORMAT,
      '--output',
      '-',
      '--force-overwrites',
      '--no-check-certificates',
      '--no-warnings',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 5000) stderr = stderr.slice(-5000);
    });
    child.stdout.on('data', (chunk) => {
      if (!responded) {
        responded = true;
        console.log(`[Aether API] stream started via ${attempt.label} in ${Date.now() - startedAt}ms`);
      }
      res.write(chunk);
    });
    child.on('error', (error) => {
      const message = error.message || 'stream spawn failed';
      console.warn(`[Aether API] stream attempt ${attempt.label} failed: ${message}`);
      if (!responded && attemptIndex < attempts.length - 1) {
        runAttempt(attemptIndex + 1);
        return;
      }
      if (!res.headersSent) res.status(503).send('Streaming backend unavailable');
      else res.end();
    });
    child.on('close', (code) => {
      if (requestClosed) return;
      if (code !== 0 && !responded) {
        const message = stderr.trim() || `yt-dlp exited with code ${code}`;
        console.warn(`[Aether API] stream attempt ${attempt.label} failed: ${message}`);
        if (attemptIndex < attempts.length - 1) {
          runAttempt(attemptIndex + 1);
          return;
        }
        req.off('close', closeChild);
        if (!res.headersSent) res.status(502).send(message);
        else res.end();
        return;
      }
      req.off('close', closeChild);
      res.end();
    });
  };

  runAttempt(0);
}));

app.get('/api/lyrics', asyncRoute(async (req, res) => {
  const lyrics = await fetchSyncedLyrics({
    track: req.query.track || req.query.title || '',
    artist: req.query.artist || req.query.author || '',
    duration: req.query.duration || 0,
  });
  res.json(lyrics);
}));

app.get('/api/proxy', asyncRoute(async (req, res) => {
  const rawUrl = String(req.query.url || '');
  if (!rawUrl) {
    res.status(400).send('Missing url');
    return;
  }

  const target = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
  const parsed = new URL(target);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    res.status(400).send('Unsupported protocol');
    return;
  }

  const response = await fetch(parsed.toString(), {
    redirect: 'follow',
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'user-agent': 'Aether Website Backend',
    },
  });

  if (!response.ok) {
    res.status(response.status).send('Proxy fetch failed');
    return;
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  res.setHeader('content-type', contentType);
  res.setHeader('cache-control', 'public, max-age=86400, stale-while-revalidate=604800');
  const bytes = Buffer.from(await response.arrayBuffer());
  res.send(bytes);
}));

app.get('/api/queue/:id', (req, res) => {
  res.json(getQueue(req.params.id));
});

app.post('/api/add/:id', (req, res) => {
  const queue = getQueue(req.params.id);
  const track = req.body?.track;
  if (!track || typeof track !== 'object') {
    res.status(400).json({ success: false, error: 'Missing track' });
    return;
  }
  queue.songs.push(track);
  touchQueue(queue);
  res.json({ success: true, position: queue.songs.length - 1, queue });
});

app.post('/api/control/:id', (req, res) => {
  const queue = getQueue(req.params.id);
  const { action, time } = req.body || {};

  if (action === 'pause') queue.isPlaying = false;
  if (action === 'resume' || action === 'play') queue.isPlaying = true;
  if (action === 'seek') queue.seekOffset = Math.max(0, Number(time) || 0);
  if (action === 'skip') {
    queue.songs.shift();
    queue.seekOffset = 0;
    queue.currentMs = 0;
    if (queue.songs.length === 0) queue.isPlaying = false;
  }
  if (action === 'shuffle' && queue.songs.length > 1) {
    for (let i = queue.songs.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue.songs[i], queue.songs[j]] = [queue.songs[j], queue.songs[i]];
    }
  }

  touchQueue(queue);
  res.json({ success: true, queue });
});

app.post('/api/heartbeat/:id', (req, res) => {
  const queue = getQueue(req.params.id);
  queue.currentMs = Math.max(0, Number(req.body?.currentTime) || Number(req.body?.currentMs) || 0);
  if (typeof req.body?.isPlaying === 'boolean') queue.isPlaying = req.body.isPlaying;
  touchQueue(queue);
  res.json({ success: true, queue });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(port, () => {
  console.log(`[Aether API] running on port ${port}`);
});
