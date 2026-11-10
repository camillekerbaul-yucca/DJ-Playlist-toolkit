# DJ Playlist toolkit

Desktop app that takes a Spotify, YouTube or SoundCloud playlist and downloads its tracks from Soulseek in lossless (FLAC / WAV), with optional conversion to AIFF for Pioneer DJ gear.

Built with [Tauri](https://tauri.app) (Rust + React).

---

## Installation

Download the latest installer from the [Releases](../../releases/latest) page:

| Platform | File |
|----------|------|
| Windows | `DJ Playlist toolkit_x64-setup.exe` (recommended) |
| Windows | `DJ Playlist toolkit_x64_en-US.msi` (alternative) |
| macOS (Intel + Apple Silicon) | `DJ Playlist toolkit_universal.dmg` |

**sldl**, **ffmpeg** and **yt-dlp** are downloaded automatically on first launch. No manual setup required.

---

## Usage

1. Paste a playlist link and hit **Analyser**:
   - **Spotify**: playlist or album link. No login needed, but only the first 100 tracks are read. For longer playlists, export a CSV from [exportify.net](https://exportify.net) and drop it on the app.
   - **SoundCloud**: playlist, track, or a profile's likes (`https://soundcloud.com/<user>/likes`).
   - **YouTube**: playlist link.
2. Pick the tracks (DJ mixes of 30 min or more are unticked by default) and the folder name.
3. Choose the quality: **FLAC / WAV** (a 320 kbps MP3 is accepted only when no lossless file exists) or **MP3 320**.
4. Optionally:
   - **Convertir en AIFF Pioneer**: AIFF 16-bit / 44.1 kHz with title, artist and cover art. MP3s stay MP3.
   - **Secours SoundCloud** (SoundCloud sources): tracks not found on Soulseek are taken from SoundCloud (160 kbps), with `(SC)` in the file name.
   - **Secours YouTube** (YouTube sources): tracks not found on Soulseek are taken from YouTube as MP3 320 (YouTube audio is ~160 kbps at best), with `(YT)` in the file name.
5. Enter your Soulseek account in ⚙ (a new username/password pair creates the account on first login).
6. Hit **Télécharger**. Files land in `Music/SLDL/<playlist name>/`.

Running the same playlist again into the same folder only fetches tracks that are new or were missing.

---

## Dev

```bash
npm install
npm run tauri dev
```

Requires [Rust](https://rustup.rs) and [Node.js](https://nodejs.org) 20+.

```bash
cd src-tauri && cargo test --lib                 # unit tests
cd src-tauri && cargo test --lib -- --ignored    # live Spotify / SoundCloud checks
```
