const LRCLIB_SEARCH_URL = 'https://lrclib.net/api/search';

const cleanText = (value) => String(value || '')
  .replace(/\s*\((official|lyrics?|audio|video|visualizer|performance|mv|hd|4k).*?\)\s*/gi, ' ')
  .replace(/\s*\[(official|lyrics?|audio|video|visualizer|performance|mv|hd|4k).*?\]\s*/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const parseLrc = (text) => {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const timeRe = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

  for (const line of lines) {
    const lyric = line.replace(timeRe, '').trim();
    if (!lyric) continue;
    const matches = [...line.matchAll(timeRe)];
    matches.forEach((match) => {
      const min = Number(match[1]) || 0;
      const sec = Number(match[2]) || 0;
      const frac = Number(String(match[3] || '0').padEnd(3, '0')) || 0;
      out.push({ time: (min * 60 * 1000) + (sec * 1000) + frac, text: lyric });
    });
  }

  return out.sort((a, b) => a.time - b.time);
};

const scoreCandidate = (candidate, track, artist, durationSec) => {
  const candidateTrack = cleanText(candidate.trackName).toLowerCase();
  const candidateArtist = cleanText(candidate.artistName).toLowerCase();
  const wantedTrack = cleanText(track).toLowerCase();
  const wantedArtist = cleanText(artist).toLowerCase();
  let score = 0;

  if (candidate.syncedLyrics) score += 40;
  if (candidateTrack === wantedTrack) score += 35;
  else if (candidateTrack.includes(wantedTrack) || wantedTrack.includes(candidateTrack)) score += 18;
  if (wantedArtist && candidateArtist === wantedArtist) score += 25;
  else if (wantedArtist && (candidateArtist.includes(wantedArtist) || wantedArtist.includes(candidateArtist))) score += 12;

  const wantedDuration = Number(durationSec) || 0;
  const candidateDuration = Number(candidate.duration) || 0;
  if (wantedDuration > 0 && candidateDuration > 0) {
    const diff = Math.abs(candidateDuration - wantedDuration);
    if (diff <= 2) score += 20;
    else if (diff <= 8) score += 10;
    else if (diff > 25) score -= 12;
  }

  return score;
};

const fetchSyncedLyrics = async ({ track, artist, duration }) => {
  const query = [cleanText(artist), cleanText(track)].filter(Boolean).join(' ').trim();
  if (!query) return [];

  const url = `${LRCLIB_SEARCH_URL}?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Aether Website Backend',
    },
  });
  if (!response.ok) return [];

  const candidates = await response.json();
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const best = candidates
    .filter((candidate) => candidate?.syncedLyrics)
    .sort((a, b) => scoreCandidate(b, track, artist, duration) - scoreCandidate(a, track, artist, duration))[0];

  return parseLrc(best?.syncedLyrics || '');
};

module.exports = {
  fetchSyncedLyrics,
};
