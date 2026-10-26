# Krom FM v8

A kid's pretend radio station: Spotify songs, jingles, news and DJ talk in one running order.
Live at **https://arcuscapital.github.io/djraf7/**. Earlier versions stay live for comparison:
v7 at /djraf6/, v6 at /djraf5/, v5 at /djraf4/, v4 at /djraf3/, v3 at /djraf2/, v2 at /djraf/, and the original at
https://arcuscapital.github.io/raf-radio-station/.

v8 = v7 plus **Raf's own dance party** at the end of a show (no writing): his picture (cut into
body, head, both arms and the decks in `src/assets/raf/`) DJs for ten seconds with his hands in the
air while the three dancers dance and his party song plays (`src/assets/party-music.mp4`), then he
hits a big red button — the song winds down, the disco ball goes off, the dancers say "?" and walk
out of the door, and the picture closes in a circle on him (about 23 s). The story's timing is
`STORY` in `src/celebrate.ts`; the moves are the "v8" section of `src/style.css`. Records still get
their own 40-second scene. `?demo=party` plays it on the first tap (browsers only allow the music after a tap).
- Uses /djraf6/'s Spotify login (same web address), so there's no new redirect address to add.
  Its own show, recordings and settings (`djraf7_*`); records carry over from /djraf6/.

## How it avoids repeated songs
Each "Play N Songs" block hands Spotify an exact list of tracks (`PUT /me/player/play {uris}`).
Spotify plays them back to back and stops by itself after the last one — no playlist, no repeat
mode, nothing to race. `src/runWatch.ts` notices the stop and the show moves on.

## Setup (once)
- Log in on /djraf6/ (this version shares that login). Only if logging in from here: Spotify developer
  dashboard → the Krom FM app → Redirect URIs → add `https://arcuscapital.github.io/djraf7/`.
- Spotify Premium is required for playback control.

## Develop
```
npm install
npm run dev     # http://localhost:5072/djraf7/
npm test
npm run build
```
Every push to `main` builds, tests and deploys via GitHub Actions. Built files get unique names and
`version.json` lets an open copy of the app reload itself when a newer build is live.
