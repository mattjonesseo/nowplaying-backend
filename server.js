
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

const generateRandomString = length => {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

const stateKey = 'spotify_auth_state';

app.get('/login', (req, res) => {
  const state = generateRandomString(16);
  const scope = 'user-read-playback-state user-read-currently-playing';
  res.redirect('https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: client_id,
      scope: scope,
      redirect_uri: redirect_uri,
      state: state
    }));
});

app.get('/callback', (req, res) => {
  const code = req.query.code || null;

  const authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    form: {
      code: code,
      redirect_uri: redirect_uri,
      grant_type: 'authorization_code'
    },
    headers: {
      'Authorization': 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64')
    },
    json: true
  };

  request.post(authOptions, (error, response, body) => {
    if (!error && response.statusCode === 200) {
      const access_token = body.access_token;
      const refresh_token = body.refresh_token;
      const query = querystring.stringify({ access_token, refresh_token });
      res.redirect(`${process.env.FRONTEND_URI}/?${query}`);
    } else {
      res.redirect(`${process.env.FRONTEND_URI}/?error=invalid_token`);
    }
  });
});

app.get('/refresh_token', (req, res) => {
  const refresh_token = req.query.refresh_token;
  const authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64')
    },
    form: {
      grant_type: 'refresh_token',
      refresh_token: refresh_token
    },
    json: true
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
  if (!access_token) return res.status(400).json({ error: 'Missing access token' });

  request.get({
    url: 'https://api.spotify.com/v1/me/player/currently-playing',
    headers: { 'Authorization': 'Bearer ' + access_token },
    json: true
  }, (error, response, body) => {
    if (!error && response.statusCode === 200) {
      res.json(body);
    } else {
      res.status(response.statusCode).json({ error: 'Failed to fetch now playing' });
    }
  });
});

app.get('/', (req, res) => {
  console.log('🟢 / route hit');
  res.send('NowPlayingOverlay backend running');
});

app.listen(PORT, '0.0.0.0', () =>
  console.log(`✅ Backend running on http://localhost:${PORT}`)
);