import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Playlist, Source } from "../lib/types";
import { parsePlaylistCsv } from "../lib/csv";
import { FileIcon } from "./Icons";

export const SOURCES: Record<Source, { label: string; short: string; color: string }> = {
  spotify: { label: "Spotify", short: "SPOT", color: "#5bd98b" },
  soundcloud: { label: "SoundCloud", short: "SC", color: "#ffa668" },
  youtube: { label: "YouTube", short: "YT", color: "#ff8a8a" },
  csv: { label: "CSV", short: "CSV", color: "#b4b4bc" },
};

function detect(url: string): Source | null {
  const u = url.toLowerCase();
  if (u.includes("spotify.com") || u.startsWith("spotify:")) return "spotify";
  if (u.includes("soundcloud.com")) return "soundcloud";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  return null;
}

export function SourceScreen({ onLoaded }: { onLoaded: (p: Playlist) => void }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const detected = detect(url);

  const analyse = async () => {
    if (!url.trim() || loading) return;
    setLoading(true); setError(null);
    try {
      onLoaded(await invoke<Playlist>("resolve_playlist", { url }));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const loadCsv = async (path: string) => {
    setError(null);
    try {
      const text = await invoke<string>("read_text_file", { path });
      const tracks = parsePlaylistCsv(text);
      if (!tracks.length) throw new Error("Aucun morceau lisible dans ce fichier CSV.");
      const name = (path.split(/[/\\]/).pop() ?? "playlist").replace(/\.csv$/i, "").replace(/_/g, " ");
      onLoaded({ name, source: "csv", tracks, truncated: false });
    } catch (e) {
      setError(String(e));
    }
  };

  const pickCsv = async () => {
    const path = await invoke<string | null>("pick_csv");
    if (path) loadCsv(path);
  };

  // Tauri delivers dropped files as paths (the webview never sees them).
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "over" || p.type === "enter") setOver(true);
      else if (p.type === "leave") setOver(false);
      else if (p.type === "drop") {
        setOver(false);
        const csv = p.paths.find((x) => x.toLowerCase().endsWith(".csv"));
        if (csv) loadCsv(csv);
        else setError("Dépose un fichier .csv.");
      }
    }).then((f) => { if (cancelled) f(); else off = f; });
    return () => { cancelled = true; off?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="hero stack gap-28">
      <div className="stack gap-10">
        <h1 className="h1">Colle une playlist.<br />Récupère-la en lossless.</h1>
        <p className="lead">Spotify, YouTube ou SoundCloud : chaque morceau est cherché sur Soulseek en FLAC ou WAV, puis converti en AIFF pour tes CDJ si tu veux.</p>
      </div>

      <form className="stack gap-10" onSubmit={(e) => { e.preventDefault(); analyse(); }}>
        <label className="label" htmlFor="url">Lien de la playlist</label>
        <div className="row gap-10">
          <input id="url" className="input mono" style={{ flex: "1 1 340px", height: 52 }} value={url} autoFocus
            onChange={(e) => setUrl(e.target.value)} placeholder="https://open.spotify.com/playlist/…" />
          <button type="submit" className="btn primary big" disabled={!url.trim() || loading}>
            {loading ? "Lecture…" : "Analyser"}
          </button>
        </div>
        <div className="row gap-8" style={{ minHeight: 28 }}>
          {(["spotify", "youtube", "soundcloud"] as const).map((k) => (
            <span key={k} className={`chip${detected === k ? " on" : ""}`} style={detected === k ? { borderColor: SOURCES[k].color } : undefined}>
              <span className="dot" style={{ width: 6, height: 6, background: detected === k ? SOURCES[k].color : "#4a4a52" }} />
              {SOURCES[k].label}{k === "spotify" ? " · 100 max" : ""}
            </span>
          ))}
          <span className="small" style={{ marginLeft: "auto" }}>SoundCloud : playlist, morceau, ou profil/likes</span>
        </div>
      </form>

      {error && <p className="notice error">{error}</p>}

      <div className="divider">ou</div>

      <button type="button" className={`drop${over ? " over" : ""}`} onClick={pickCsv}>
        <FileIcon />
        <span className="stack" style={{ gap: 3 }}>
          <span style={{ fontWeight: 500, color: "var(--text)" }}>{over ? "Lâche le fichier ici" : "Dépose un fichier CSV, ou clique pour le choisir"}</span>
          <span className="small">Pour une playlist Spotify de plus de 100 morceaux (export Exportify).</span>
        </span>
      </button>
    </section>
  );
}
