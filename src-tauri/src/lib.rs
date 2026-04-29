use std::path::PathBuf;
use std::sync::Mutex;
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use serde::{Deserialize, Serialize};

// Stores the PID of the running sldl process so stop_sldl can kill it.
struct SldlProcess(Mutex<Option<u32>>);

#[derive(Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub username: String,
    pub password: String,
    pub output_dir: String,
}

// ─── sldl discovery ──────────────────────────────────────────────────────────

fn sldl_local_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let exe = if cfg!(windows) { "sldl.exe" } else { "sldl" };
    Ok(dir.join(exe))
}

fn find_sldl(app: &AppHandle) -> Option<String> {
    if let Ok(p) = sldl_local_path(app) {
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    let sep = if cfg!(windows) { ';' } else { ':' };
    let exe = if cfg!(windows) { "sldl.exe" } else { "sldl" };
    std::env::var("PATH").ok()?.split(sep).find_map(|dir| {
        let p = PathBuf::from(dir).join(exe);
        p.exists().then(|| p.to_string_lossy().into_owned())
    })
}

fn emit_progress(app: &AppHandle, channel: &str, step: &str, percent: u32, message: &str) {
    app.emit(channel, serde_json::json!({ "step": step, "percent": percent, "message": message })).ok();
}

fn ffmpeg_local_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    Ok(dir.join(exe))
}

fn find_ffmpeg(app: &AppHandle) -> Option<String> {
    if let Ok(p) = ffmpeg_local_path(app) {
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    let sep = if cfg!(windows) { ';' } else { ':' };
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    std::env::var("PATH").ok()?.split(sep).find_map(|dir| {
        let p = PathBuf::from(dir).join(exe);
        p.exists().then(|| p.to_string_lossy().into_owned())
    })
}

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn check_ffmpeg(app: AppHandle) -> bool {
    find_ffmpeg(&app).is_some()
}

#[tauri::command]
async fn download_ffmpeg(app: AppHandle) -> Result<(), String> {
    let local_path = ffmpeg_local_path(&app)?;

    emit_progress(&app, "ffmpeg-install-progress", "fetching", 0, "Récupération de la dernière version…");

    let client = reqwest::Client::builder()
        .user_agent("sldl-dj-toolkit")
        .build()
        .map_err(|e| e.to_string())?;

    let release: serde_json::Value = client
        .get("https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest")
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    let url = release["assets"]
        .as_array()
        .and_then(|assets| {
            // Prefer win64 lgpl static (no "shared" in name)
            let lgpl = assets.iter().find(|a| {
                let n = a["name"].as_str().unwrap_or("").to_lowercase();
                n.contains("win64") && n.contains("lgpl") && n.ends_with(".zip") && !n.contains("shared")
            });
            let fallback = assets.iter().find(|a| {
                let n = a["name"].as_str().unwrap_or("").to_lowercase();
                n.contains("win64") && n.ends_with(".zip") && !n.contains("shared")
            });
            lgpl.or(fallback)
        })
        .and_then(|a| a["browser_download_url"].as_str())
        .ok_or("Aucune release Windows ffmpeg trouvée sur GitHub")?
        .to_string();

    emit_progress(&app, "ffmpeg-install-progress", "downloading", 5, "Téléchargement ffmpeg…");

    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let total = resp.content_length().unwrap_or(0);
    let mut zip_bytes: Vec<u8> = Vec::new();
    let mut downloaded = 0u64;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        zip_bytes.extend_from_slice(&chunk);
        if total > 0 {
            let pct = (downloaded as f64 / total as f64 * 80.0) as u32 + 5;
            emit_progress(&app, "ffmpeg-install-progress", "downloading", pct,
                &format!("{:.0}/{:.0} MB", downloaded as f64 / 1_000_000.0, total as f64 / 1_000_000.0));
        }
    }

    emit_progress(&app, "ffmpeg-install-progress", "extracting", 88, "Extraction de ffmpeg.exe…");

    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    let mut found = false;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_lowercase();
        if name.ends_with("bin/ffmpeg.exe") {
            let mut out = std::fs::File::create(&local_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
            found = true;
            break;
        }
    }

    if !found {
        return Err("ffmpeg.exe introuvable dans l'archive téléchargée".to_string());
    }

    emit_progress(&app, "ffmpeg-install-progress", "done", 100, "ffmpeg installé !");
    Ok(())
}

#[tauri::command]
fn check_sldl(app: AppHandle) -> bool {
    let Some(path) = find_sldl(&app) else { return false };
    // Verify the binary actually runs (catches .NET-missing or corrupt installs)
    std::process::Command::new(&path)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
async fn download_sldl(app: AppHandle) -> Result<(), String> {
    let local_path = sldl_local_path(&app)?;

    emit_progress(&app, "sldl-install-progress", "fetching", 0, "Récupération de la dernière version…");

    let client = reqwest::Client::builder()
        .user_agent("sldl-dj-toolkit")
        .build()
        .map_err(|e| e.to_string())?;

    let release: serde_json::Value = client
        .get("https://api.github.com/repos/fiso64/sldl/releases/latest")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let url = release["assets"]
        .as_array()
        .and_then(|assets| {
            let sc = assets.iter().find(|a| {
                let n = a["name"].as_str().unwrap_or("").to_lowercase();
                n.ends_with(".zip") && n.contains("win") && n.contains("self-contained")
            });
            let any = assets.iter().find(|a| {
                let n = a["name"].as_str().unwrap_or("").to_lowercase();
                n.ends_with(".zip") && n.contains("win")
            });
            sc.or(any)
        })
        .and_then(|a| a["browser_download_url"].as_str())
        .ok_or("Aucune release Windows trouvée sur GitHub")?
        .to_string();

    emit_progress(&app, "sldl-install-progress", "downloading", 5, "Téléchargement…");

    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let total = resp.content_length().unwrap_or(0);
    let mut zip_bytes: Vec<u8> = Vec::new();
    let mut downloaded = 0u64;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        zip_bytes.extend_from_slice(&chunk);
        if total > 0 {
            let pct = (downloaded as f64 / total as f64 * 80.0) as u32 + 5;
            emit_progress(&app, "sldl-install-progress", "downloading", pct,
                &format!("{:.0}/{:.0} MB", downloaded as f64 / 1_000_000.0, total as f64 / 1_000_000.0));
        }
    }

    emit_progress(&app, "sldl-install-progress", "extracting", 88, "Extraction de sldl.exe…");

    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    let mut found = false;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        if f.name().to_lowercase().ends_with("sldl.exe") {
            let mut out = std::fs::File::create(&local_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
            found = true;
            break;
        }
    }

    if !found {
        return Err("sldl.exe introuvable dans l'archive téléchargée".to_string());
    }

    emit_progress(&app, "sldl-install-progress", "done", 100, "sldl installé avec succès !");
    Ok(())
}

// Returns true for ffmpeg header lines that are too noisy to show.
fn is_ffmpeg_noise(line: &str) -> bool {
    let t = line.trim();
    t.starts_with("ffmpeg version")
        || t.starts_with("built with")
        || t.starts_with("configuration:")
        || (t.starts_with("lib") && t.contains(" / "))
        || t == "Press [q] to quit, [?] for help"
}

// Reads a stream in chunks, emitting a log event on every \n or \r.
// skip: function that returns true for lines that should be suppressed.
// This avoids pipe-buffer deadlocks caused by sldl's \r-based progress bars.
async fn stream_to_logs<R: tokio::io::AsyncRead + Unpin>(reader: R, app: AppHandle, skip: fn(&str) -> bool) {
    use tokio::io::AsyncReadExt;
    let mut reader = reader;
    let mut buf = Vec::with_capacity(256);
    let mut chunk = [0u8; 1024];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for &b in &chunk[..n] {
                    if b == b'\n' || b == b'\r' {
                        if !buf.is_empty() {
                            let line = String::from_utf8_lossy(&buf).trim().to_string();
                            if !line.is_empty() && !skip(&line) {
                                app.emit("sldl-log", &line).ok();
                            }
                            buf.clear();
                        }
                    } else {
                        buf.push(b);
                    }
                }
            }
        }
    }
    if !buf.is_empty() {
        let line = String::from_utf8_lossy(&buf).trim().to_string();
        if !line.is_empty() && !skip(&line) {
            app.emit("sldl-log", &line).ok();
        }
    }
}

#[tauri::command]
async fn run_sldl(
    app: AppHandle,
    state: State<'_, SldlProcess>,
    args: Vec<String>,
) -> Result<(), String> {
    let sldl_bin = find_sldl(&app)
        .ok_or_else(|| "sldl introuvable. Relancez l'application pour l'installer.".to_string())?;

    let mut child = tokio::process::Command::new(&sldl_bin)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Impossible de lancer sldl: {e}"))?;

    *state.0.lock().map_err(|e| e.to_string())? = child.id();

    let stderr = child.stderr.take().expect("stderr piped");
    let err_task = tokio::spawn(stream_to_logs(stderr, app.clone(), |_| false));

    let status = child.wait().await.map_err(|e| e.to_string())?;
    err_task.await.ok();

    *state.0.lock().map_err(|e| e.to_string())? = None;
    app.emit("sldl-done", status.code().unwrap_or(-1)).ok();
    Ok(())
}

#[tauri::command]
fn stop_sldl(state: State<'_, SldlProcess>) -> Result<(), String> {
    if let Some(pid) = state.0.lock().map_err(|e| e.to_string())?.take() {
        #[cfg(target_os = "windows")]
        std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output()
            .map_err(|e| e.to_string())?;
        #[cfg(not(target_os = "windows"))]
        std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let result = app.dialog().file().blocking_pick_folder();
    Ok(result.map(|p| p.to_string()))
}

#[tauri::command]
fn pick_csv(app: AppHandle) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .add_filter("CSV Files", &["csv"])
        .blocking_pick_file();
    Ok(result.map(|p| p.to_string()))
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_temp_csv(content: String) -> Result<String, String> {
    let path = std::env::temp_dir().join("sldl_selection.csv");
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_config(app: AppHandle) -> Result<AppConfig, String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("config.json").map_err(|e| e.to_string())?;

    let default_output = dirs::audio_dir()
        .map(|p| p.join("SLDL").to_string_lossy().to_string())
        .unwrap_or_else(|| "~/Music/SLDL".to_string());

    Ok(AppConfig {
        username: store
            .get("username")
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default(),
        password: store
            .get("password")
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default(),
        output_dir: store
            .get("output_dir")
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or(default_output),
    })
}

#[tauri::command]
fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("config.json").map_err(|e| e.to_string())?;
    store.set("username", serde_json::Value::String(config.username));
    store.set("password", serde_json::Value::String(config.password));
    store.set("output_dir", serde_json::Value::String(config.output_dir));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn convert_to_aiff(app: AppHandle, state: State<'_, SldlProcess>, dir: String) -> Result<(), String> {
    let ffmpeg = find_ffmpeg(&app).ok_or_else(|| "ffmpeg introuvable".to_string())?;

    let audio_exts = ["flac", "wav", "ogg", "opus", "m4a", "aac", "wma"];

    let mut files: Vec<std::path::PathBuf> = Vec::new();
    fn walk(dir: &std::path::Path, files: &mut Vec<std::path::PathBuf>, exts: &[&str]) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() { walk(&p, files, exts); }
                else if p.extension().and_then(|x| x.to_str()).map(|x| exts.iter().any(|e| e.eq_ignore_ascii_case(x))).unwrap_or(false) {
                    files.push(p);
                }
            }
        }
    }
    walk(std::path::Path::new(&dir), &mut files, &audio_exts);

    let total = files.len();
    if total == 0 {
        app.emit("sldl-log", "Aucun fichier audio à convertir.").ok();
        return Ok(());
    }
    app.emit("sldl-log", &format!("── Conversion AIFF ({total} fichiers) ──────────────")).ok();

    for (i, file) in files.iter().enumerate() {
        let name = file.file_name().unwrap_or_default().to_string_lossy();
        let aiff = file.with_extension("aiff");

        app.emit("sldl-log", &format!("[{}/{}] {}", i + 1, total, name)).ok();

        let mut child = tokio::process::Command::new(&ffmpeg)
            .args([
                "-loglevel", "warning",
                "-i", &file.to_string_lossy(),
                "-c:a", "pcm_s16be", "-f", "aiff", "-y",
                &aiff.to_string_lossy(),
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("ffmpeg: {e}"))?;

        *state.0.lock().map_err(|e| e.to_string())? = child.id();

        let stderr = child.stderr.take().expect("stderr piped");
        let err_task = tokio::spawn(stream_to_logs(stderr, app.clone(), is_ffmpeg_noise));

        let status = child.wait().await.map_err(|e| e.to_string())?;
        err_task.await.ok();
        *state.0.lock().map_err(|e| e.to_string())? = None;

        if status.success() {
            std::fs::remove_file(file).ok();
            app.emit("sldl-log", &format!("  ✓ → {}", aiff.file_name().unwrap_or_default().to_string_lossy())).ok();
        } else {
            app.emit("sldl-log", &format!("  ✗ Échec: {name}")).ok();
        }
    }

    app.emit("sldl-log", &format!("── Conversion terminée ─────────────────────────")).ok();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(SldlProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            check_ffmpeg,
            download_ffmpeg,
            check_sldl,
            download_sldl,
            run_sldl,
            stop_sldl,
            pick_folder,
            pick_csv,
            read_text_file,
            write_temp_csv,
            get_config,
            save_config,
            convert_to_aiff,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
