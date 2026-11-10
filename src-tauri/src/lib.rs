mod sources;
mod tools;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

use sources::{Playlist, Track};
use tools::Tool;

/// The running child process (sldl, yt-dlp or ffmpeg) and a cancel flag for
/// the multi-file steps, so the Stop button can end whatever is in progress.
#[derive(Default)]
struct Job {
    pid: Mutex<Option<u32>>,
    cancelled: AtomicBool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub username: String,
    pub password: String,
    pub output_dir: String,
}

// ─── Tools ────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct ToolStatus {
    sldl: bool,
    ffmpeg: bool,
    ytdlp: bool,
}

#[tauri::command]
fn check_tools(app: AppHandle) -> ToolStatus {
    ToolStatus {
        // sldl --version catches .NET-missing or corrupt installs
        sldl: tools::find(&app, Tool::Sldl).is_some_and(|p| tools::runs(&p, "--version")),
        ffmpeg: tools::find(&app, Tool::Ffmpeg).is_some(),
        ytdlp: tools::find(&app, Tool::YtDlp).is_some_and(|p| tools::runs(&p, "--version")),
    }
}

#[tauri::command]
async fn install_tool(app: AppHandle, tool: String) -> Result<(), String> {
    match tool.as_str() {
        "sldl" => tools::install_sldl(&app).await,
        "ffmpeg" => tools::install_ffmpeg(&app).await,
        "ytdlp" => tools::install_ytdlp(&app).await,
        other => Err(format!("Outil inconnu : {other}")),
    }
}

// ─── Sources ──────────────────────────────────────────────────────────────────

#[tauri::command]
async fn resolve_playlist(app: AppHandle, url: String) -> Result<Playlist, String> {
    sources::resolve(&app, &url).await
}

fn csv_field(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// Characters Windows refuses in file names, plus trailing dots/spaces.
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() { "playlist".into() } else { trimmed.chars().take(120).collect() }
}

/// Writes the selected tracks as the CSV sldl reads (lengths in seconds).
/// The file is named after the playlist because sldl uses it as the list name.
#[tauri::command]
fn write_track_csv(name: String, tracks: Vec<Track>) -> Result<String, String> {
    let dir = std::env::temp_dir().join("dj-playlist-toolkit");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.csv", sanitize_filename(&name)));
    let mut out = String::from("Artist,Title,Album,Length,YT Id\n");
    for t in &tracks {
        out += &[
            csv_field(&t.artist),
            csv_field(&t.title),
            csv_field(&t.album),
            t.length.map(|l| l.to_string()).unwrap_or_default(),
            csv_field(t.yt_id.as_deref().unwrap_or("")),
        ]
        .join(",");
        out.push('\n');
    }
    std::fs::write(&path, out.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// ─── Running sldl ─────────────────────────────────────────────────────────────

/// Reads a stream in chunks, emitting a log event on every \n or \r.
/// This avoids pipe-buffer deadlocks caused by \r-based progress bars.
async fn stream_to_logs<R: tokio::io::AsyncRead + Unpin>(mut reader: R, app: AppHandle, skip: fn(&str) -> bool) {
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::with_capacity(256);
    let mut chunk = [0u8; 1024];
    let flush = |buf: &mut Vec<u8>| {
        let line = String::from_utf8_lossy(buf).trim().to_string();
        if !line.is_empty() && !skip(&line) {
            app.emit("sldl-log", &line).ok();
        }
        buf.clear();
    };
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for &b in &chunk[..n] {
                    if b == b'\n' || b == b'\r' {
                        if !buf.is_empty() {
                            flush(&mut buf);
                        }
                    } else {
                        buf.push(b);
                    }
                }
            }
        }
    }
    if !buf.is_empty() {
        flush(&mut buf);
    }
}

fn no_skip(_: &str) -> bool {
    false
}

/// Runs sldl to completion and returns its exit code. Output goes to "sldl-log" events.
#[tauri::command]
async fn run_sldl(app: AppHandle, job: State<'_, Job>, args: Vec<String>) -> Result<i32, String> {
    let sldl = tools::find(&app, Tool::Sldl).ok_or("sldl introuvable. Relance l'application pour l'installer.")?;
    job.cancelled.store(false, Ordering::SeqCst);

    // With stdout piped, sldl skips its in-place progress bars and prints one
    // line per state change instead.
    let mut child = tools::hidden_command(&sldl)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Impossible de lancer sldl : {e}"))?;
    *job.pid.lock().map_err(|e| e.to_string())? = child.id();

    let out = tokio::spawn(stream_to_logs(child.stdout.take().expect("piped"), app.clone(), no_skip));
    let err = tokio::spawn(stream_to_logs(child.stderr.take().expect("piped"), app.clone(), no_skip));
    let status = child.wait().await.map_err(|e| e.to_string())?;
    out.await.ok();
    err.await.ok();
    *job.pid.lock().map_err(|e| e.to_string())? = None;
    Ok(status.code().unwrap_or(-1))
}

#[tauri::command]
fn stop_job(job: State<'_, Job>) -> Result<(), String> {
    job.cancelled.store(true, Ordering::SeqCst);
    if let Some(pid) = job.pid.lock().map_err(|e| e.to_string())?.take() {
        #[cfg(windows)]
        tools::hidden_std_command("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).output().ok();
        #[cfg(not(windows))]
        std::process::Command::new("kill").args(["-9", &pid.to_string()]).output().ok();
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IndexEntry {
    filepath: String,
    artist: String,
    title: String,
    /// sldl track state: 1 = downloaded, 3 = already there; anything else = not downloaded.
    state: u32,
    failure_reason: u32,
}

/// sldl's index of what it downloaded (and what it could not find).
#[tauri::command]
fn read_sldl_index(path: String) -> Result<Vec<IndexEntry>, String> {
    let mut rdr = csv::Reader::from_path(&path).map_err(|e| format!("Index sldl illisible : {e}"))?;
    let headers = rdr.headers().map_err(|e| e.to_string())?.clone();
    let col = |name: &str| headers.iter().position(|h| h == name);
    let (fp, ar, ti, st, fr) = (col("filepath"), col("artist"), col("title"), col("state"), col("failurereason"));
    let get = |r: &csv::StringRecord, i: Option<usize>| i.and_then(|i| r.get(i)).unwrap_or("").to_string();
    let base = Path::new(&path).parent().map(Path::to_path_buf).unwrap_or_default();
    Ok(rdr
        .records()
        .flatten()
        .map(|r| {
            let mut filepath = get(&r, fp);
            if filepath.starts_with("./") || filepath.starts_with(".\\") {
                filepath = base.join(&filepath[2..]).to_string_lossy().into_owned();
            }
            IndexEntry {
                filepath,
                artist: get(&r, ar),
                title: get(&r, ti),
                state: get(&r, st).parse().unwrap_or(0),
                failure_reason: get(&r, fr).parse().unwrap_or(0),
            }
        })
        .collect())
}

// ─── SoundCloud fallback ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct FallbackItem {
    key: String,
    url: String,
    artist: String,
    title: String,
}

#[derive(Serialize, Clone)]
struct FallbackResult {
    key: String,
    path: Option<String>,
    error: Option<String>,
}

/// The audio file yt-dlp wrote as `<base>.<ext>` (thumbnails are embedded and removed).
fn find_with_stem(base: &Path) -> Option<String> {
    let (dir, stem) = (base.parent()?, base.file_name()?);
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find_map(|p| {
        let ext = p.extension()?.to_str()?.to_lowercase();
        let audio = !["jpg", "jpeg", "png", "webp", "part", "ytdl", "tmp"].contains(&ext.as_str());
        (audio && p.file_stem()? == stem && p.is_file()).then(|| p.to_string_lossy().into_owned())
    })
}

/// Downloads tracks Soulseek did not have straight from SoundCloud with yt-dlp.
/// Files get a "(SC)" suffix so their lower quality stays visible in rekordbox.
#[tauri::command]
async fn soundcloud_fallback(
    app: AppHandle,
    job: State<'_, Job>,
    dir: String,
    items: Vec<FallbackItem>,
) -> Result<Vec<FallbackResult>, String> {
    let ytdlp = tools::find(&app, Tool::YtDlp).ok_or("yt-dlp introuvable. Relance l'application.")?;
    let ffmpeg = tools::find(&app, Tool::Ffmpeg);
    let mut results = Vec::new();
    for item in items {
        if job.cancelled.load(Ordering::SeqCst) {
            break;
        }
        app.emit("fallback-progress", serde_json::json!({ "key": item.key, "status": "running" })).ok();
        let base = Path::new(&dir).join(sanitize_filename(&format!("{} - {} (SC)", item.artist, item.title)));
        let mut cmd = tools::hidden_command(&ytdlp);
        cmd.args([
            "--no-playlist", "--no-progress", "--no-warnings",
            // SoundCloud's own AAC/MP3 streams, or the original file when the artist allows downloads
            "--extractor-args", "soundcloud:formats=*_aac,*_mp3",
            "-f", "bestaudio",
            "--embed-metadata", "--embed-thumbnail", "--convert-thumbnails", "jpg",
            // "Artist - Title" uploads: put the artist in the artist tag
            "--parse-metadata", "title:%(artist)s - %(title)s",
            "--print", "after_move:filepath",
            "-o",
        ]);
        cmd.arg(format!("{}.%(ext)s", base.to_string_lossy()));
        if let Some(ff) = &ffmpeg {
            cmd.arg("--ffmpeg-location").arg(ff);
        }
        cmd.arg(&item.url);
        let child = cmd
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("yt-dlp : {e}"))?;
        *job.pid.lock().map_err(|e| e.to_string())? = child.id();
        let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
        *job.pid.lock().map_err(|e| e.to_string())? = None;

        // yt-dlp prints the path in the console code page on Windows, which mangles
        // emojis and other characters of the folder name: look for the file instead.
        let path = out.status.success().then(|| find_with_stem(&base)).flatten();
        let result = match (out.status.success(), path) {
            (true, Some(p)) if !p.is_empty() => FallbackResult { key: item.key, path: Some(p), error: None },
            _ => FallbackResult {
                key: item.key,
                path: None,
                error: Some(
                    String::from_utf8_lossy(&out.stderr)
                        .lines()
                        .filter(|l| l.contains("ERROR"))
                        .last()
                        .unwrap_or("échec")
                        .to_string(),
                ),
            },
        };
        app.emit("fallback-progress", serde_json::json!({
            "key": result.key, "status": if result.path.is_some() { "ok" } else { "failed" }, "path": result.path
        }))
        .ok();
        results.push(result);
    }
    Ok(results)
}

// ─── AIFF conversion ─────────────────────────────────────────────────────────

/// Formats converted to AIFF. MP3 stays MP3: every CDJ reads it, and converting
/// it would only make the file bigger.
const AIFF_SOURCES: [&str; 8] = ["flac", "wav", "ogg", "opus", "m4a", "aac", "wma", "alac"];

fn ffmpeg_is_noise(line: &str) -> bool {
    let t = line.trim();
    t.starts_with("ffmpeg version")
        || t.starts_with("built with")
        || t.starts_with("configuration:")
        || (t.starts_with("lib") && t.contains(" / "))
}

#[derive(Serialize, Clone)]
struct Converted {
    src: String,
    dst: String,
    ok: bool,
}

/// Converts the given files (or, if empty, every convertible file in `dir`) to
/// AIFF 16-bit / 44.1 kHz with tags and cover art, the format every Pioneer
/// CDJ and rekordbox read. Originals are removed once converted.
#[tauri::command]
async fn convert_to_aiff(
    app: AppHandle,
    job: State<'_, Job>,
    dir: String,
    files: Vec<String>,
) -> Result<Vec<Converted>, String> {
    let ffmpeg = tools::find(&app, Tool::Ffmpeg).ok_or("ffmpeg introuvable")?;
    let is_convertible = |p: &Path| {
        p.extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| AIFF_SOURCES.iter().any(|e| e.eq_ignore_ascii_case(x)))
    };
    let mut list: Vec<PathBuf> = files.iter().map(PathBuf::from).filter(|p| p.exists() && is_convertible(p)).collect();
    if files.is_empty() {
        for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
            if e.path().is_file() && is_convertible(&e.path()) {
                list.push(e.path());
            }
        }
    }

    let total = list.len();
    let mut done = Vec::new();
    for (i, src) in list.iter().enumerate() {
        if job.cancelled.load(Ordering::SeqCst) {
            break;
        }
        let dst = src.with_extension("aiff");
        app.emit("aiff-progress", serde_json::json!({ "index": i, "total": total, "src": src, "status": "running" })).ok();

        // Ogg/Opus keep their tags on the audio stream, not the container.
        let ext = src.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
        let tag_source = if ext == "ogg" || ext == "opus" { "0:s:a:0" } else { "0" };
        let mut child = tools::hidden_command(&ffmpeg)
            .args(["-loglevel", "error", "-y", "-i"])
            .arg(src)
            .args([
                "-map", "0:a:0", "-map", "0:v:0?",
                "-c:a", "pcm_s16be", "-af", "aresample=44100:dither_method=triangular",
                "-c:v", "copy", "-disposition:v:0", "attached_pic",
                "-map_metadata", tag_source,
                "-write_id3v2", "1", "-id3v2_version", "3",
                "-f", "aiff",
            ])
            .arg(&dst)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("ffmpeg : {e}"))?;
        *job.pid.lock().map_err(|e| e.to_string())? = child.id();
        let err = tokio::spawn(stream_to_logs(child.stderr.take().expect("piped"), app.clone(), ffmpeg_is_noise));
        let status = child.wait().await.map_err(|e| e.to_string())?;
        err.await.ok();
        *job.pid.lock().map_err(|e| e.to_string())? = None;

        let ok = status.success() && dst.exists();
        if ok {
            std::fs::remove_file(src).ok();
        } else {
            std::fs::remove_file(&dst).ok();
        }
        let c = Converted { src: src.to_string_lossy().into(), dst: dst.to_string_lossy().into(), ok };
        app.emit("aiff-progress", serde_json::json!({ "index": i, "total": total, "src": c.src, "dst": c.dst, "status": if ok { "ok" } else { "failed" } })).ok();
        done.push(c);
    }

    // Point sldl's index at the new files so a later run of the same playlist
    // recognises them and only fetches what is new.
    let index = Path::new(&dir).join("_index.csv");
    if let Ok(text) = std::fs::read_to_string(&index) {
        let mut text = text;
        for c in done.iter().filter(|c| c.ok) {
            let name_src = Path::new(&c.src).file_name().and_then(|n| n.to_str()).unwrap_or("");
            let name_dst = Path::new(&c.dst).file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !name_src.is_empty() {
                text = text.replace(name_src, name_dst);
            }
        }
        std::fs::write(&index, text).ok();
    }
    Ok(done)
}

// ─── Files, folders, config ───────────────────────────────────────────────────

#[tauri::command]
fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog().file().blocking_pick_folder().map(|p| p.to_string())
}

#[tauri::command]
fn pick_csv(app: AppHandle) -> Option<String> {
    app.dialog().file().add_filter("CSV", &["csv"]).blocking_pick_file().map(|p| p.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_folder(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_config(app: AppHandle) -> Result<AppConfig, String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("config.json").map_err(|e| e.to_string())?;
    let default_output = dirs::audio_dir()
        .map(|p| p.join("SLDL").to_string_lossy().to_string())
        .unwrap_or_else(|| "~/Music/SLDL".to_string());
    let get = |k: &str| store.get(k).and_then(|v| v.as_str().map(String::from));
    Ok(AppConfig {
        username: get("username").unwrap_or_default(),
        password: get("password").unwrap_or_default(),
        output_dir: get("output_dir").filter(|s| !s.is_empty()).unwrap_or(default_output),
    })
}

#[tauri::command]
fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("config.json").map_err(|e| e.to_string())?;
    store.set("username", serde_json::Value::String(config.username));
    store.set("password", serde_json::Value::String(config.password));
    store.set("output_dir", serde_json::Value::String(config.output_dir));
    store.save().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(Job::default())
        .invoke_handler(tauri::generate_handler![
            check_tools,
            install_tool,
            resolve_playlist,
            write_track_csv,
            run_sldl,
            stop_job,
            read_sldl_index,
            soundcloud_fallback,
            convert_to_aiff,
            pick_folder,
            pick_csv,
            read_text_file,
            open_folder,
            get_config,
            save_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_fallback_file_in_emoji_folder() {
        let dir = std::env::temp_dir().join("djpt-test ⛵ SVP 🌞");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Nu - Maldidi (SC).jpg"), b"x").unwrap();
        std::fs::write(dir.join("Nu - Maldidi (SC).m4a"), b"x").unwrap();
        let found = find_with_stem(&dir.join("Nu - Maldidi (SC)")).unwrap();
        assert!(found.ends_with("Nu - Maldidi (SC).m4a") && Path::new(&found).exists());
        assert!(find_with_stem(&dir.join("Other (SC)")).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    use super::*;

    #[test]
    fn sanitizes_windows_names() {
        assert_eq!(sanitize_filename("AC/DC: Back?"), "AC_DC_ Back_");
        assert_eq!(sanitize_filename("  . "), "playlist");
    }

    #[test]
    fn csv_quotes() {
        assert_eq!(csv_field("say \"hi\", ok"), "\"say \"\"hi\"\", ok\"");
    }
}
