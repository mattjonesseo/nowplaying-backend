// ✅ server.js — pass-through by default; stable mode via ?stable=1
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
const redirect_uri = process.env.REDIRECT_URI;   // e.g. https://<backend>/callback
const frontend_uri = process.env.FRONTEND_URI;   // e.g. https://<frontend>

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

// Ensure return path is a safe, same-site path (avoid open-redirects)
function sanitizeReturnPath(ret) {
  if (typeof ret !== 'string' || !ret.trim()) return '/spotify-overlay';
  // only allow same-site relative paths
  if (!ret.startsWith('/')) return '/spotify-overlay';
  // avoid protocol-like strings in weird cases
  if (ret.startsWith('//')) return '/spotify-overlay';
  return ret;
}

/**
 * LOGIN
 * Accepts optional ?return=/some-route to route users back to a FE page after auth
 * Always forces account chooser with show_dialog=true so it won't silently reuse another session.
 */
app.get('/login', (req, res) => {
  const nonce = generateRandomString(16);
  const scope = 'user-read-playback-state user-read-currently-playing';

  const ret = sanitizeReturnPath(req.query.return || '/spotify-overlay');
  const statePayload = JSON.stringify({ n: nonce, ret });

  const redirect = 'https://accounts.spotify.com/authorize?' + querystring.stringify({
    response_type: 'code',
    client_id,
    scope,
    redirect_uri,
    state: statePayload,
    show_dialog: true, // 🔒 force the account chooser
  });

  res.redirect(redirect);
});

/**
 * CALLBACK
 * Exchanges code for tokens and redirects back to the FE route encoded in state.ret (defaults to /spotify-overlay)
 */
app.get('/callback', (req, res) => {
  let retPath = '/spotify-overlay';
  try {
    if (req.query.state) {
      const parsed = JSON.parse(req.query.state);
      retPath = sanitizeReturnPath(parsed && parsed.ret);
    }
  } catch {
    retPath = '/spotify-overlay';
  }

  const code = req.query.code || null;
  const authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    form: { code, redirect_uri, grant_type: 'authorization_code' },
    headers: { 'Authorization': 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64') },
    json: true,
    timeout: 10000,
  };

  request.post(authOptions, (error, response, body) => {
    if (!error && response && response.statusCode === 200) {
      const access_token = body.access_token;
      const refresh_token = body.refresh_token;
      const q = querystring.stringify({ access_token, refresh_token });
      // redirect to the chosen FE route (e.g., /spotify-overlay) with tokens in query
      return res.redirect(`${frontend_uri}${retPath}?${q}`);
    }
    return res.redirect(`${frontend_uri}${retPath}?error=invalid_token`);
  });
});

/**
 * Refresh access token with refresh_token
 */
app.get('/refresh_token', (req, res) => {
  const refresh_token = req.query.refresh_token;
  if (!refresh_token) return res.status(400).send({ error: 'Missing refresh_token' });

  const authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    headers: { 'Authorization': 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64') },
    form: { grant_type: 'refresh_token', refresh_token },
    json: true,
    timeout: 10000,
  };

  request.post(authOptions, (error, response, body) => {
    if (!error && response && response.statusCode === 200) {
      return res.send({ access_token: body.access_token });
    }
    return res.status(400).send({ error: 'Failed to refresh token' });
  });
});

/**
 * Now Playing
 * - Pass-through by default
 * - Stable mode (?stable=1) guards against early switches and stale samples
 */
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
      'Accept': 'application/json',
    },
    json: true,
    timeout: 10000,
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

    // Pass-through mode (default)
    if (!useStable) {
      if (error) return res.status(200).json(nothingPlaying);

      if (status === 204) return res.status(200).json({ ...nothingPlaying, source_status: 204 });

      if (status !== 200 || typeof body !== 'object') {
        return res.status(200).json({ ...nothingPlaying, error: 'spotify_non_200' });
      }

      // Pass Spotify payload through, just add server_now
      return res.status(200).json({ ...body, server_now });
    }

    // Stable mode — guards against stale samples & early next-track
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
