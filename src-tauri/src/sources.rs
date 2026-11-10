//! Turns a pasted link (Spotify, SoundCloud, YouTube) into a list of tracks.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::tools::{self, Tool};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Track {
    pub artist: String,
    pub title: String,
    pub album: String,
    /// Length in seconds.
    pub length: Option<u32>,
    /// Page of the track on its source (used for the SoundCloud fallback).
    pub url: Option<String>,
    /// YouTube video id, when the source is YouTube.
    pub yt_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Playlist {
    pub name: String,
    /// "spotify" | "soundcloud" | "youtube"
    pub source: String,
    pub tracks: Vec<Track>,
    /// True when the source only returned part of the list (Spotify links: 100 max).
    pub truncated: bool,
}

const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .build()
        .map_err(|e| e.to_string())
}

pub fn detect(url: &str) -> Option<&'static str> {
    let u = url.to_lowercase();
    if u.contains("spotify.com") || u.starts_with("spotify:") {
        Some("spotify")
    } else if u.contains("soundcloud.com") {
        Some("soundcloud")
    } else if u.contains("youtube.com") || u.contains("youtu.be") {
        Some("youtube")
    } else {
        None
    }
}

pub async fn resolve(app: &tauri::AppHandle, url: &str) -> Result<Playlist, String> {
    let url = url.trim();
    match detect(url) {
        Some("spotify") => spotify(url).await,
        Some("soundcloud") => soundcloud(url).await,
        Some("youtube") => youtube(app, url).await,
        _ => Err("Lien non reconnu : colle un lien Spotify, SoundCloud ou YouTube.".into()),
    }
}

/// Splits "Artist - Title" (also with en/em dashes). None when there is no separator.
pub fn split_artist_title(s: &str) -> Option<(String, String)> {
    for sep in [" - ", " – ", " — "] {
        // Ignore separators inside brackets: "A -b (C - D)" is not artist "A -b (C".
        let mut depth = 0i32;
        for (i, c) in s.char_indices() {
            match c {
                '(' | '[' => depth += 1,
                ')' | ']' => depth -= 1,
                _ if depth == 0 && s[i..].starts_with(sep) => {
                    let (a, t) = (s[..i].trim(), s[i + sep.len()..].trim());
                    if !a.is_empty() && !t.is_empty() {
                        return Some((a.to_string(), t.to_string()));
                    }
                }
                _ => {}
            }
        }
    }
    None
}

// ─── Spotify ────────────────────────────────────────────────────────────────
// The public embed page carries the list without any login, capped at 100 tracks.

fn spotify_kind_and_id(url: &str) -> Option<(String, String)> {
    if let Some(rest) = url.strip_prefix("spotify:") {
        let mut parts = rest.split(':');
        return Some((parts.next()?.to_string(), parts.next()?.to_string()));
    }
    let path = url.split("spotify.com/").nth(1)?;
    let path = path.split(['?', '#']).next()?;
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty() && !s.starts_with("intl-")).collect();
    let i = segs.iter().position(|s| matches!(*s, "playlist" | "album" | "track"))?;
    Some((segs[i].to_string(), segs.get(i + 1)?.to_string()))
}

fn next_data(html: &str) -> Result<Value, String> {
    let start_tag = "<script id=\"__NEXT_DATA__\" type=\"application/json\">";
    let start = html.find(start_tag).ok_or("Page Spotify illisible (format inattendu)")? + start_tag.len();
    let end = html[start..].find("</script>").ok_or("Page Spotify illisible")? + start;
    serde_json::from_str(&html[start..end]).map_err(|e| e.to_string())
}

async fn spotify(url: &str) -> Result<Playlist, String> {
    let (kind, id) = spotify_kind_and_id(url).ok_or("Lien Spotify non reconnu (playlist, album ou titre attendu).")?;
    let html = client()?
        .get(format!("https://open.spotify.com/embed/{kind}/{id}"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|_| "Playlist Spotify introuvable ou privée.".to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let data = next_data(&html)?;
    let entity = &data["props"]["pageProps"]["state"]["data"]["entity"];
    let name = entity["name"].as_str().or(entity["title"].as_str()).unwrap_or("Spotify").to_string();
    let album = if kind == "album" { name.clone() } else { String::new() };

    let tracks: Vec<Track> = entity["trackList"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|t| Track {
                    title: t["title"].as_str().unwrap_or("").to_string(),
                    artist: t["subtitle"].as_str().unwrap_or("").replace('\u{a0}', " "),
                    album: album.clone(),
                    length: t["duration"].as_u64().map(|ms| (ms / 1000) as u32),
                    url: t["uri"].as_str().map(String::from),
                    yt_id: None,
                })
                .filter(|t| !t.title.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if tracks.is_empty() {
        return Err("Aucun morceau trouvé dans ce lien Spotify (playlist privée ?).".into());
    }
    let truncated = kind == "playlist" && tracks.len() >= 100;
    Ok(Playlist { name, source: "spotify".into(), tracks, truncated })
}

// ─── SoundCloud ─────────────────────────────────────────────────────────────
// Uses the same public API as the SoundCloud website, with the web client id.

const SC_API: &str = "https://api-v2.soundcloud.com";

async fn soundcloud_client_id(http: &reqwest::Client) -> Result<String, String> {
    let home = http
        .get("https://soundcloud.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let re_src = regex::Regex::new(r#"<script[^>]+src="([^"]+)""#).unwrap();
    let re_id = regex::Regex::new(r#"client_id\s*:\s*"([0-9a-zA-Z]{32})""#).unwrap();
    let srcs: Vec<String> = re_src.captures_iter(&home).map(|c| c[1].to_string()).collect();
    for src in srcs.iter().rev() {
        let Ok(resp) = http.get(src).send().await else { continue };
        let Ok(js) = resp.text().await else { continue };
        if let Some(c) = re_id.captures(&js) {
            return Ok(c[1].to_string());
        }
    }
    Err("Impossible de contacter SoundCloud (identifiant client introuvable).".into())
}

async fn sc_get(http: &reqwest::Client, url: &str, client_id: &str) -> Result<Value, String> {
    let sep = if url.contains('?') { '&' } else { '?' };
    http.get(format!("{url}{sep}client_id={client_id}"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| match e.status().map(|s| s.as_u16()) {
            Some(404) => "Introuvable sur SoundCloud (lien privé ou supprimé ?).".to_string(),
            _ => format!("Erreur SoundCloud : {e}"),
        })?
        .json()
        .await
        .map_err(|e| e.to_string())
}

fn sc_track(t: &Value) -> Track {
    let raw_title = t["title"].as_str().unwrap_or("").trim().to_string();
    let uploader = t["user"]["username"].as_str().unwrap_or("").to_string();
    let label_artist = t["publisher_metadata"]["artist"].as_str().unwrap_or("").trim().to_string();
    let (artist, title) = if !label_artist.is_empty() {
        // Labels often still write "Artist - Title" in the title: drop the duplicate artist.
        let title = match split_artist_title(&raw_title) {
            Some((a, t)) if a.eq_ignore_ascii_case(&label_artist) => t,
            _ => raw_title.clone(),
        };
        (label_artist, title)
    } else if let Some((a, t)) = split_artist_title(&raw_title) {
        (a, t)
    } else {
        (uploader, raw_title)
    };
    let ms = t["full_duration"].as_u64().or(t["duration"].as_u64());
    Track {
        artist,
        title,
        album: t["publisher_metadata"]["album_title"].as_str().unwrap_or("").to_string(),
        length: ms.map(|ms| (ms / 1000) as u32),
        url: t["permalink_url"].as_str().map(String::from),
        yt_id: None,
    }
}

async fn soundcloud(url: &str) -> Result<Playlist, String> {
    let http = client()?;
    // Short links (on.soundcloud.com) redirect to the real page.
    let mut url = url.split(['?', '#']).next().unwrap_or(url).trim_end_matches('/').to_string();
    if url.contains("on.soundcloud.com") {
        url = http.get(&url).send().await.map_err(|e| e.to_string())?.url().to_string();
        url = url.split('?').next().unwrap_or(&url).trim_end_matches('/').to_string();
    }
    url = url.replace("://m.soundcloud.com", "://soundcloud.com");
    let client_id = soundcloud_client_id(&http).await?;

    // Likes of a profile: /<user>/likes
    if let Some(profile) = url.strip_suffix("/likes") {
        let user = sc_get(&http, &format!("{SC_API}/resolve?url={}", urlencode(profile)), &client_id).await?;
        let user_id = user["id"].as_u64().ok_or("Profil SoundCloud introuvable.")?;
        let username = user["username"].as_str().unwrap_or("SoundCloud").to_string();
        let mut tracks = Vec::new();
        let mut next = Some(format!("{SC_API}/users/{user_id}/likes?limit=200"));
        while let Some(page_url) = next.take() {
            let page = sc_get(&http, &page_url, &client_id).await?;
            for item in page["collection"].as_array().into_iter().flatten() {
                if item["track"].is_object() {
                    tracks.push(sc_track(&item["track"]));
                }
            }
            next = page["next_href"].as_str().map(String::from);
        }
        return Ok(Playlist { name: format!("{username} likes"), source: "soundcloud".into(), tracks, truncated: false });
    }

    let obj = sc_get(&http, &format!("{SC_API}/resolve?url={}", urlencode(&url)), &client_id).await?;
    match obj["kind"].as_str() {
        Some("track") => Ok(Playlist {
            name: obj["title"].as_str().unwrap_or("SoundCloud").to_string(),
            source: "soundcloud".into(),
            tracks: vec![sc_track(&obj)],
            truncated: false,
        }),
        Some("playlist") | Some("system-playlist") => {
            let items = obj["tracks"].as_array().cloned().unwrap_or_default();
            // Only the first few tracks come complete; the rest are stubs with an id.
            let missing: Vec<u64> = items
                .iter()
                .filter(|t| t["title"].is_null())
                .filter_map(|t| t["id"].as_u64())
                .collect();
            let mut full: std::collections::HashMap<u64, Value> = items
                .iter()
                .filter(|t| !t["title"].is_null())
                .filter_map(|t| Some((t["id"].as_u64()?, t.clone())))
                .collect();
            for chunk in missing.chunks(50) {
                let ids = chunk.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
                let list = sc_get(&http, &format!("{SC_API}/tracks?ids={ids}"), &client_id).await?;
                for t in list.as_array().into_iter().flatten() {
                    if let Some(id) = t["id"].as_u64() {
                        full.insert(id, t.clone());
                    }
                }
            }
            let tracks = items
                .iter()
                .filter_map(|t| full.get(&t["id"].as_u64()?))
                .map(sc_track)
                .collect();
            Ok(Playlist {
                name: obj["title"].as_str().unwrap_or("SoundCloud").to_string(),
                source: "soundcloud".into(),
                tracks,
                truncated: false,
            })
        }
        Some("user") => Err("C'est un profil : colle le lien d'une playlist, d'un morceau, ou du profil suivi de /likes.".into()),
        _ => Err("Lien SoundCloud non reconnu.".into()),
    }
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

// ─── YouTube ────────────────────────────────────────────────────────────────
// yt-dlp lists the playlist; sldl later parses "Artist - Title (Official Video)".

async fn youtube(app: &tauri::AppHandle, url: &str) -> Result<Playlist, String> {
    let ytdlp = tools::find(app, Tool::YtDlp).ok_or("yt-dlp n'est pas installé. Relance l'application.")?;
    let out = tools::hidden_command(&ytdlp)
        .args(["--flat-playlist", "-J", "--no-warnings", url])
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("YouTube : {}", err.lines().last().unwrap_or("lecture impossible")));
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let entries: Vec<Value> = match v["entries"].as_array() {
        Some(e) => e.clone(),
        None => vec![v.clone()], // a single video
    };
    let tracks = entries
        .iter()
        .filter(|e| e["title"].as_str().is_some_and(|t| t != "[Deleted video]" && t != "[Private video]"))
        .map(|e| Track {
            // Raw video title + channel: sldl's --yt-parse turns them into artist / title.
            title: e["title"].as_str().unwrap_or("").to_string(),
            artist: e["channel"].as_str().or(e["uploader"].as_str()).unwrap_or("").trim_end_matches(" - Topic").to_string(),
            album: String::new(),
            length: e["duration"].as_f64().map(|d| d as u32),
            url: e["url"].as_str().map(String::from),
            yt_id: e["id"].as_str().map(String::from),
        })
        .collect();
    Ok(Playlist {
        name: v["title"].as_str().unwrap_or("YouTube").to_string(),
        source: "youtube".into(),
        tracks,
        truncated: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spotify_urls() {
        assert_eq!(
            spotify_kind_and_id("https://open.spotify.com/intl-fr/playlist/37i9dQZF1DX4UtSsGT1Sbe?si=abc"),
            Some(("playlist".into(), "37i9dQZF1DX4UtSsGT1Sbe".into()))
        );
        assert_eq!(spotify_kind_and_id("spotify:album:123"), Some(("album".into(), "123".into())));
    }

    #[test]
    fn splits_artist_title() {
        assert_eq!(split_artist_title("Papa Jazz - ppppuuunnntttaaaa (050)"), Some(("Papa Jazz".into(), "ppppuuunnntttaaaa (050)".into())));
        assert_eq!(split_artist_title("Soma"), None);
        assert_eq!(split_artist_title("Viken Arman -lose You Self (Amram Solar - re)"), None);
        assert_eq!(split_artist_title("Rosas (NU Remix) - Viken Arman"), Some(("Rosas (NU Remix)".into(), "Viken Arman".into())));
    }

    #[test]
    fn sc_track_prefers_label_artist() {
        let t = serde_json::json!({
            "title": "Lil Louis - Club Lonely (J. Cub Remix)",
            "user": {"username": "Stamp The Wax"},
            "publisher_metadata": {"artist": "Lil Louis"},
            "full_duration": 438000,
            "permalink_url": "https://soundcloud.com/x/y"
        });
        let tr = sc_track(&t);
        assert_eq!((tr.artist.as_str(), tr.title.as_str(), tr.length), ("Lil Louis", "Club Lonely (J. Cub Remix)", Some(438)));
    }

    // Network tests: cargo test -- --ignored
    #[tokio::test]
    #[ignore]
    async fn live_spotify() {
        let p = spotify("https://open.spotify.com/playlist/37i9dQZF1DX4UtSsGT1Sbe").await.unwrap();
        println!("{} — {} tracks, truncated={}", p.name, p.tracks.len(), p.truncated);
        assert!(!p.tracks.is_empty());
    }

    #[tokio::test]
    #[ignore]
    async fn live_soundcloud_likes() {
        let p = soundcloud("https://soundcloud.com/charlie85/likes").await.unwrap();
        println!("{} — {} tracks; first: {:?}", p.name, p.tracks.len(), p.tracks.first());
        assert!(p.tracks.len() > 100);
    }
}
