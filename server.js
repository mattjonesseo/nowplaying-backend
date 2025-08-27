// ✅ server.js (pass-through by default; stable mode via ?stable=1)
require('dotenv').config();
const express = require('express');
const request = require('request');
const cors = require('cors');
const querystring = require('querystring');

const app = express();
const PORT = process.env.PORT || 8888;

app.use(cors());

const client_id = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
const redirect_uri = process.env.REDIRECT_URI;
const frontend_uri = process.env.FRONTEND_URI;

// Per-token memory for stable mode guards
const lastByToken = new Map(); // { item, is_playing, progress_ms, timestamp, accepted_at, source_status }

const generateRandomString = (length) => {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < length; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
};

function setNoStore(res) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store',
    'CDN-Cache-Control': 'no-store',
    'Vary': 'Authorization'
  });
}

app.get('/login', (req, res) => {
  const state = generateRandomString(16);
  const scope = 'user-read-playback-state user-read-currently-playing';
  res.redirect('https://accounts.spotify.com/authorize?' + querystring.stringify({
    response_type: 'code',
    client_id,
    scope,
    redirect_uri,
    state,
    show_dialog: true
  }));
});

app.get('/callback', (req, res) => {
  const code = req.query.code || null;

  const authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    form: { code, redirect_uri, grant_type: 'authorization_code' },
    headers: { 'Authorization': 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64') },
    json: true,
    timeout: 8000
  };

  request.post(authOptions, (error, response, body) => {
    if (!error && response.statusCode === 200) {
      const access_token = body.access_token;
      const refresh_token = body.refresh_token;
      const query = querystring.stringify({ access_token, refresh_token });
      res.redirect(`${frontend_uri}/?${query}`);
    } else {
      res.redirect(`${frontend_uri}/?error=invalid_token`);
    }
  });
});

app.get('/refresh_token', (req, res) => {
  const refresh_token = req.query.refresh_token;
  const authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    headers: { 'Authorization': 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64') },
    form: { grant_type: 'refresh_token', refresh_token },
    json: true,
    timeout: 8000
  };

  request.post(authOptions, (error, response, body) => {
    if (!error && response.statusCode === 200) {
      res.send({ access_token: body.access_token });
    } else {
      res.status(400).send({ error: 'Failed to refresh token' });
    }
  });
});

app.get('/now-playing', (req, res) => {
  const access_token = req.query.access_token;
  if (!access_token) {
    setNoStore(res);
    return res.status(400).json({ error: 'Missing access token' });
  }

  const useStable = req.query.stable === '1';
  const server_now = Date.now();

  request.get({
    url: 'https://api.spotify.com/v1/me/player/currently-playing',
    qs: { market: 'from_token' },
    headers: {
      'Authorization': 'Bearer ' + access_token,
      'Accept': 'application/json'
    },
    json: true,
    timeout: 8000
  }, (error, response, body) => {
    setNoStore(res);

    const status = (response && response.statusCode) || 500;

    // Standardized "nothing playing"
    const nothingPlaying = {
      item: null,
      is_playing: false,
      progress_ms: 0,
      timestamp: server_now,
      server_now,
      source_status: status
    };

    // Pass-through mode (default) — keep React preview happy
    if (!useStable) {
      if (error) return res.status(200).json(nothingPlaying);

      if (status === 204) return res.status(200).json({ ...nothingPlaying, source_status: 204 });

      if (status !== 200 || typeof body !== 'object') {
        return res.status(200).json({ ...nothingPlaying, error: 'spotify_non_200' });
      }

      // Pass Spotify payload through, just add server_now
      return res.status(200).json({ ...body, server_now });
    }

    // Stable mode (for OBS) — guards against stale samples & early next-track
    if (error) return res.status(200).json(nothingPlaying);

    if (status === 204) {
      lastByToken.set(access_token, { ...nothingPlaying, accepted_at: server_now });
      return res.status(200).json(nothingPlaying);
    }

    if (status !== 200 || typeof body !== 'object') {
      return res.status(200).json({ ...nothingPlaying, error: 'spotify_non_200' });
    }

    const sample = {
      item: body.item || null,
      is_playing: !!body.is_playing,
      progress_ms: typeof body.progress_ms === 'number' ? body.progress_ms : 0,
      timestamp: typeof body.timestamp === 'number' ? body.timestamp : server_now,
      currently_playing_type: body.currently_playing_type || null
    };

    const last = lastByToken.get(access_token) || null;

    // Guard 1: stale sample (older than last by >1s)
    if (last && sample.timestamp + 1000 < last.timestamp) {
      return res.status(200).json({ ...last, server_now, stale_guard: true });
    }

    // Guard 2: early next-track (progress<1.2s while current not ~finished)
    if (last && last.item && sample.item && last.item.id !== sample.item.id) {
      const prevDuration = (last.item && Number(last.item.duration_ms)) || 0;
      const elapsed = server_now - (last.accepted_at || server_now);
      const estLocal = last.is_playing ? Math.min(last.progress_ms + elapsed, prevDuration || Infinity) : last.progress_ms;
      const nearEnd = prevDuration > 0 && (estLocal / prevDuration) >= 0.92;
      const newIsYoung = sample.progress_ms < 1200;
      if (!nearEnd && newIsYoung) {
        return res.status(200).json({ ...last, server_now, early_switch_suppressed: true });
      }
    }

    const accepted = {
      item: sample.item,
      is_playing: sample.is_playing,
      progress_ms: sample.progress_ms,
      timestamp: sample.timestamp,
      server_now,
      accepted_at: server_now,
      source_status: 200
    };
    lastByToken.set(access_token, accepted);
    return res.status(200).json(accepted);
  });
});

app.get('/', (req, res) => {
  res.send('NowPlayingOverlay backend running');
});

app.listen(PORT, '0.0.0.0', () =>
  console.log(`✅ Backend running on http://localhost:${PORT}`)
);
