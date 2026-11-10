//! Locating and installing the external programs the app drives:
//! sldl (Soulseek), ffmpeg (+ ffprobe) and yt-dlp (SoundCloud / YouTube).

use std::path::PathBuf;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Sldl,
    Ffmpeg,
    Ffprobe,
    YtDlp,
}

impl Tool {
    fn exe(self) -> &'static str {
        match (self, cfg!(windows)) {
            (Tool::Sldl, true) => "sldl.exe",
            (Tool::Sldl, false) => "sldl",
            (Tool::Ffmpeg, true) => "ffmpeg.exe",
            (Tool::Ffmpeg, false) => "ffmpeg",
            (Tool::Ffprobe, true) => "ffprobe.exe",
            (Tool::Ffprobe, false) => "ffprobe",
            (Tool::YtDlp, true) => "yt-dlp.exe",
            (Tool::YtDlp, false) => "yt-dlp",
        }
    }
}

/// Where the app keeps its own copy of a tool (app data dir).
pub fn local_path(app: &AppHandle, tool: Tool) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(tool.exe()))
}

/// The app's own copy first, then anything on PATH.
pub fn find(app: &AppHandle, tool: Tool) -> Option<String> {
    if let Ok(p) = local_path(app, tool) {
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    let sep = if cfg!(windows) { ';' } else { ':' };
    std::env::var("PATH").ok()?.split(sep).find_map(|dir| {
        let p = PathBuf::from(dir).join(tool.exe());
        p.exists().then(|| p.to_string_lossy().into_owned())
    })
}

// Console programs spawned from a GUI app would each get their own empty
// console window on Windows; their output is piped into the app instead.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn hidden_std_command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub fn hidden_command(program: &str) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// True when the binary exists and answers `--version` (catches corrupt installs).
pub fn runs(path: &str, version_arg: &str) -> bool {
    hidden_std_command(path)
        .arg(version_arg)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn emit_progress(app: &AppHandle, channel: &str, step: &str, percent: u32, message: &str) {
    app.emit(channel, serde_json::json!({ "step": step, "percent": percent, "message": message }))
        .ok();
}

pub fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("dj-playlist-toolkit")
        .build()
        .map_err(|e| e.to_string())
}

/// sldl is pinned: from 3.0 it was renamed "sockseek" with a different CLI.
const SLDL_RELEASE: &str = "tags/v2.6.0";

/// Finds the download URL of the first asset of a GitHub release ("latest" or
/// "tags/<tag>") for which `pick` returns true (tried in order of `picks`).
async fn release_asset_url(
    client: &reqwest::Client,
    repo: &str,
    release: &str,
    picks: &[&(dyn Fn(&str) -> bool + Sync)],
) -> Result<String, String> {
    let release: serde_json::Value = client
        .get(format!("https://api.github.com/repos/{repo}/releases/{release}"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let assets = release["assets"].as_array().cloned().unwrap_or_default();
    for pick in picks {
        if let Some(url) = assets
            .iter()
            .find(|a| pick(&a["name"].as_str().unwrap_or("").to_lowercase()))
            .and_then(|a| a["browser_download_url"].as_str())
        {
            return Ok(url.to_string());
        }
    }
    Err(format!("Aucun fichier adapté pour ce système dans la release de {repo}"))
}

/// Downloads a URL into memory, reporting progress between 5 % and 85 %.
async fn download_bytes(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    channel: &str,
) -> Result<Vec<u8>, String> {
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Téléchargement refusé ({})", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut bytes = Vec::with_capacity(total as usize);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        bytes.extend_from_slice(&chunk);
        if total > 0 {
            let pct = (bytes.len() as f64 / total as f64 * 80.0) as u32 + 5;
            emit_progress(
                app,
                channel,
                "downloading",
                pct,
                &format!("{:.0}/{:.0} Mo", bytes.len() as f64 / 1e6, total as f64 / 1e6),
            );
        }
    }
    Ok(bytes)
}

/// Extracts every zip entry whose (lowercased) name ends with one of `wanted`'s
/// suffixes into the given destination. Returns how many were written.
fn extract_from_zip(bytes: Vec<u8>, wanted: &[(&str, PathBuf)]) -> Result<usize, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let mut written = 0;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_lowercase();
        if let Some((_, dest)) = wanted.iter().find(|(suffix, _)| name.ends_with(suffix)) {
            let mut out = std::fs::File::create(dest).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
            written += 1;
        }
    }
    Ok(written)
}

#[cfg(unix)]
fn make_executable(path: &PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).ok();
    }
}
#[cfg(not(unix))]
fn make_executable(_path: &PathBuf) {}

/// Asset-name fragment for this OS / CPU, as used by sldl and ffmpeg-static.
fn mac_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }
}

pub async fn install_sldl(app: &AppHandle) -> Result<(), String> {
    let ch = "sldl-install-progress";
    let dest = local_path(app, Tool::Sldl)?;
    emit_progress(app, ch, "fetching", 0, "Recherche de la version…");
    let client = http_client()?;
    let os_asset = if cfg!(windows) {
        "sldl_win-x86_self-contained.zip".to_string()
    } else if cfg!(target_os = "macos") {
        format!("sldl_osx-{}.zip", mac_arch())
    } else if cfg!(target_arch = "aarch64") {
        "sldl_linux-arm.zip".to_string()
    } else {
        "sldl_linux-x64.zip".to_string()
    };
    let url = release_asset_url(&client, "fiso64/sldl", SLDL_RELEASE, &[&|n: &str| n == os_asset]).await?;
    emit_progress(app, ch, "downloading", 5, "Téléchargement…");
    let bytes = download_bytes(app, &client, &url, ch).await?;
    emit_progress(app, ch, "extracting", 88, "Extraction…");
    if extract_from_zip(bytes, &[(Tool::Sldl.exe(), dest.clone())])? == 0 {
        return Err("sldl introuvable dans l'archive".into());
    }
    make_executable(&dest);
    emit_progress(app, ch, "done", 100, "installé");
    Ok(())
}

pub async fn install_ffmpeg(app: &AppHandle) -> Result<(), String> {
    let ch = "ffmpeg-install-progress";
    let ffmpeg = local_path(app, Tool::Ffmpeg)?;
    let ffprobe = local_path(app, Tool::Ffprobe)?;
    emit_progress(app, ch, "fetching", 0, "Recherche de la dernière version…");
    let client = http_client()?;

    if !cfg!(windows) {
        // BtbN has no macOS builds: static binaries from ffmpeg-static instead.
        let platform = if cfg!(target_os = "macos") {
            format!("darwin-{}", mac_arch())
        } else if cfg!(target_arch = "aarch64") {
            "linux-arm64".to_string()
        } else {
            "linux-x64".to_string()
        };
        for (i, (name, dest)) in [("ffmpeg", &ffmpeg), ("ffprobe", &ffprobe)].into_iter().enumerate() {
            let asset = format!("{name}-{platform}");
            let url = release_asset_url(&client, "eugeneware/ffmpeg-static", "latest", &[&|n: &str| n == asset]).await?;
            emit_progress(app, ch, "downloading", 5, &format!("Téléchargement de {name} ({}/2)…", i + 1));
            let bytes = download_bytes(app, &client, &url, ch).await?;
            std::fs::write(dest, bytes).map_err(|e| e.to_string())?;
            make_executable(dest);
        }
        emit_progress(app, ch, "done", 100, "installé");
        return Ok(());
    }

    let url = release_asset_url(
        &client,
        "BtbN/FFmpeg-Builds",
        "latest",
        &[
            &|n: &str| n.contains("win64") && n.contains("lgpl") && n.ends_with(".zip") && !n.contains("shared"),
            &|n: &str| n.contains("win64") && n.ends_with(".zip") && !n.contains("shared"),
        ],
    )
    .await?;
    emit_progress(app, ch, "downloading", 5, "Téléchargement…");
    let bytes = download_bytes(app, &client, &url, ch).await?;
    emit_progress(app, ch, "extracting", 88, "Extraction…");
    let n = extract_from_zip(bytes, &[("bin/ffmpeg.exe", ffmpeg.clone()), ("bin/ffprobe.exe", ffprobe)])?;
    if n == 0 || !ffmpeg.exists() {
        return Err("ffmpeg.exe introuvable dans l'archive".into());
    }
    emit_progress(app, ch, "done", 100, "installé");
    Ok(())
}

pub async fn install_ytdlp(app: &AppHandle) -> Result<(), String> {
    let ch = "ytdlp-install-progress";
    let dest = local_path(app, Tool::YtDlp)?;
    emit_progress(app, ch, "fetching", 0, "Recherche de la dernière version…");
    let client = http_client()?;
    let asset = if cfg!(windows) { "yt-dlp.exe" } else if cfg!(target_os = "macos") { "yt-dlp_macos" } else { "yt-dlp" };
    let url = release_asset_url(&client, "yt-dlp/yt-dlp", "latest", &[&|n: &str| n == asset]).await?;
    emit_progress(app, ch, "downloading", 5, "Téléchargement…");
    let bytes = download_bytes(app, &client, &url, ch).await?;
    std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    make_executable(&dest);
    emit_progress(app, ch, "done", 100, "installé");
    Ok(())
}
