# sldl dj toolkit

Desktop app to download music from Soulseek via a Spotify playlist CSV export, with optional AIFF conversion for Pioneer DJ gear.

Built with [Tauri](https://tauri.app) (Rust + React).

---

## Installation

Download the latest installer from the [Releases](../../releases/latest) page:

- **sldl-dj-toolkit_x64-setup.exe** — recommended
- **sldl-dj-toolkit_x64_en-US.msi** — alternative

**sldl** and **ffmpeg** are downloaded and installed automatically on first launch. No manual setup required.

---

## Usage

1. Export your Spotify playlist as CSV using [exportify.net](https://exportify.net)
2. Open the app and drop the CSV file onto the interface
3. Select the tracks you want, set a folder name and output directory
4. Enter your Soulseek credentials in ⚙ Config
5. Hit **Télécharger** — files land in `Music/SLDL/<playlist name>/`
6. Optionally toggle **Convertir en AIFF** to get Pioneer-ready files

---

## Dev

```bash
npm install
npm run tauri dev
```

Requires [Rust](https://rustup.rs) and [Node.js](https://nodejs.org) 20+.
