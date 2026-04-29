import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ─── Types ───────────────────────────────────────────────────────────────────

interface InstallProgress {
  step: "fetching" | "downloading" | "extracting" | "done";
  percent: number;
  message: string;
}

interface Track {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration: string;
  selected: boolean;
  rawLine: string;
}

interface AppConfig {
  username: string;
  password: string;
  output_dir: string;
}

type AppStatus = "idle" | "ready" | "running" | "converting" | "done" | "stopped";

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim()); current = "";
    } else { current += ch; }
  }
  result.push(current.trim());
  return result;
}

function formatDuration(ms: string): string {
  const num = parseInt(ms);
  if (isNaN(num)) return "";
  const s = Math.floor(num / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function parseCSV(text: string): { tracks: Track[]; headerLine: string } {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return { tracks: [], headerLine: "" };
  const headers = parseCSVLine(lines[0]).map((h) => h.replace(/^"|"$/g, ""));
  const find = (...names: string[]) =>
    names.reduce((acc, n) => acc !== -1 ? acc :
      headers.findIndex((h) => h.toLowerCase() === n.toLowerCase()), -1);
  const titleCol = find("Track Name", "Track", "Title", "Song");
  const artistCol = find("Artist Name(s)", "Artist", "Artists");
  const albumCol = find("Album Name", "Album");
  const durCol = find("Track Duration (ms)", "Duration", "Length");
  const tracks: Track[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = parseCSVLine(lines[i]);
    if (f.length < 2) continue;
    const clean = (col: number) => col >= 0 ? (f[col] ?? "").replace(/^"|"$/g, "") : "";
    const track: Track = {
      id: i, title: clean(titleCol), artist: clean(artistCol),
      album: clean(albumCol), duration: formatDuration(clean(durCol)),
      selected: true, rawLine: lines[i],
    };
    if (track.title || track.artist) tracks.push(track);
  }
  return { tracks, headerLine: lines[0] };
}

function buildSelectionCSV(headerLine: string, tracks: Track[]): string {
  return [headerLine, ...tracks.filter((t) => t.selected).map((t) => t.rawLine)].join("\n");
}

// ─── Design tokens ───────────────────────────────────────────────────────────

const C = {
  cyan: "#22d3ee", purple: "#a78bfa", bg: "#0a0e17",
  card: "rgba(255,255,255,0.03)", border: "rgba(255,255,255,0.08)",
  text: "#fff", muted: "rgba(255,255,255,0.4)", dim: "rgba(255,255,255,0.15)",
};

const labelStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: C.muted,
  display: "block", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.05em",
};

const inputStyle: React.CSSProperties = {
  width: "100%", background: "rgba(0,0,0,0.35)", border: `1px solid ${C.border}`,
  borderRadius: 8, padding: "10px 12px", color: C.text,
  fontFamily: "'JetBrains Mono', monospace", fontSize: 13,
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AppStatus }) {
  const map: Record<AppStatus, [string, string]> = {
    idle: ["En attente", "#6b7280"], ready: ["Prêt", "#10b981"],
    running: ["Téléchargement…", "#f59e0b"], converting: ["Conversion AIFF…", "#a78bfa"],
    done: ["Terminé ✓", "#10b981"], stopped: ["Arrêté", "#ef4444"],
  };
  const [label, color] = map[status];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 12px", borderRadius: 20, background: color + "26", color, fontSize: 13, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, animation: status === "running" ? "pulse 1.5s infinite" : "none" }} />
      {label}
    </span>
  );
}

function DropZone({ onContent, isDragging, setIsDragging, onPickFile }: {
  onContent: (content: string, name: string) => void;
  isDragging: boolean; setIsDragging: (v: boolean) => void; onPickFile: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const readFile = (file: File) => {
    const r = new FileReader();
    r.onload = (e) => onContent(e.target!.result as string, file.name);
    r.readAsText(file);
  };
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file?.name.endsWith(".csv")) readFile(file);
  }, []);

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileRef.current?.click()}
        style={{ border: `2px dashed ${isDragging ? C.cyan : C.dim}`, borderRadius: 16, padding: "40px 32px", textAlign: "center", cursor: "pointer", background: isDragging ? "rgba(34,211,238,0.05)" : "rgba(255,255,255,0.02)", transition: "all 0.3s" }}
      >
        <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />
        <div style={{ fontSize: 44, marginBottom: 12, opacity: 0.5 }}>📂</div>
        <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: 17, fontWeight: 500, color: C.muted, margin: 0 }}>
          {isDragging ? "Lâche le fichier ici…" : "Glisse ton CSV Exportify ici"}
        </p>
        <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "rgba(255,255,255,0.25)", marginTop: 6 }}>
          ou clique pour parcourir
        </p>
      </div>
      <button onClick={(e) => { e.stopPropagation(); onPickFile(); }} style={{ width: "100%", marginTop: 8, padding: "10px", borderRadius: 10, border: `1px solid ${C.border}`, background: "rgba(255,255,255,0.03)", color: C.muted, fontFamily: "'Outfit', sans-serif", fontSize: 13, cursor: "pointer" }}>
        Parcourir (sélecteur natif)
      </button>
      <div style={{ marginTop: 14, padding: "14px 16px", background: "rgba(139,92,246,0.07)", borderRadius: 10, border: "1px solid rgba(139,92,246,0.15)" }}>
        <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: 12, fontWeight: 600, color: C.muted, margin: "0 0 6px" }}>💡 Comment obtenir le CSV ?</p>
        <ol style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "rgba(255,255,255,0.4)", margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
          <li>Ouvre <a href="https://exportify.net/" target="_blank" rel="noopener noreferrer" style={{ color: C.purple }}>exportify.net</a></li>
          <li>Connecte-toi avec ton compte Spotify</li>
          <li>Clique "Export" à côté de ta playlist</li>
          <li>Glisse le CSV ici ou utilise le sélecteur natif</li>
        </ol>
      </div>
    </div>
  );
}

function TrackList({ tracks, onToggle, onToggleAll }: { tracks: Track[]; onToggle: (id: number) => void; onToggleAll: () => void }) {
  const selected = tracks.filter((t) => t.selected).length;
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: C.muted }}>{selected}/{tracks.length} sélectionnés</span>
        <button onClick={onToggleAll} style={{ background: "none", border: `1px solid ${C.dim}`, color: C.muted, padding: "3px 10px", borderRadius: 7, fontSize: 12, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
          {selected === tracks.length ? "Tout désélectionner" : "Tout sélectionner"}
        </button>
      </div>
      <div style={{ maxHeight: 300, overflowY: "auto", borderRadius: 12, border: `1px solid ${C.border}` }}>
        {tracks.map((t, i) => (
          <div key={t.id} onClick={() => onToggle(t.id)} style={{ display: "grid", gridTemplateColumns: "24px 1fr 1fr auto", gap: 10, alignItems: "center", padding: "9px 14px", cursor: "pointer", background: i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent", borderBottom: "1px solid rgba(255,255,255,0.03)", opacity: t.selected ? 1 : 0.35, transition: "opacity 0.2s" }}>
            <div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${t.selected ? C.cyan : C.dim}`, background: t.selected ? C.cyan : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#0a0e17", fontWeight: 700, transition: "all 0.15s" }}>
              {t.selected && "✓"}
            </div>
            <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: 500, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
            <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: 12, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.artist}</span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "rgba(255,255,255,0.25)", minWidth: 36, textAlign: "right" }}>{t.duration}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LogTerminal({ logs, status }: { logs: string[]; status: AppStatus }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);
  return (
    <div style={{ background: "rgba(0,0,0,0.5)", borderRadius: 12, padding: "14px 16px", border: `1px solid ${C.border}`, height: 280, overflowY: "auto", fontFamily: "'JetBrains Mono', monospace", fontSize: 12, lineHeight: 1.7 }}>
      {logs.length === 0 && <span style={{ color: C.muted }}>En attente du démarrage…</span>}
      {logs.map((line, i) => {
        const color = /error|fail|not found/i.test(line) ? "#f87171" : /done|success|✓/i.test(line) ? "#34d399" : "rgba(255,255,255,0.7)";
        return <div key={i} style={{ color }}>{line}</div>;
      })}
      {status === "running" && <div style={{ color: C.cyan, animation: "pulse 1.2s infinite" }}>▋</div>}
      <div ref={endRef} />
    </div>
  );
}

function SettingsPanel({ config, onSave, onClose }: { config: AppConfig; onSave: (c: AppConfig) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(config);
  const field = (label: string, key: keyof AppConfig, type = "text", placeholder = "") => (
    <div style={{ marginBottom: 14 }}>
      <label style={labelStyle}>{label}</label>
      <input type={type} value={draft[key]} placeholder={placeholder}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} style={inputStyle} />
    </div>
  );
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: "#111827", border: `1px solid ${C.border}`, borderRadius: 20, padding: 28, width: 460, maxWidth: "90vw" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <h2 style={{ fontFamily: "'Outfit', sans-serif", fontSize: 20, fontWeight: 700, margin: 0, color: C.text }}>⚙ Paramètres</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.muted, fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>
        <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 0, marginBottom: 18 }}>
          Laisse vide pour utiliser ~/.config/sldl/sldl.conf
        </p>
        {field("Utilisateur Soulseek", "username", "text", "mon_pseudo")}
        {field("Mot de passe Soulseek", "password", "password", "••••••••")}
        {field("Dossier musique par défaut", "output_dir", "text", "~/Music/SLDL")}
        <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "12px", borderRadius: 10, border: `1px solid ${C.border}`, background: "none", color: C.muted, fontFamily: "'Outfit', sans-serif", fontSize: 14, cursor: "pointer" }}>Annuler</button>
          <button onClick={() => { onSave(draft); onClose(); }} style={{ flex: 2, padding: "12px", borderRadius: 10, border: "none", background: `linear-gradient(135deg, ${C.cyan}, ${C.purple})`, color: "#0a0e17", fontFamily: "'Outfit', sans-serif", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Sauvegarder</button>
        </div>
      </div>
    </div>
  );
}

// ─── Setup Screen ────────────────────────────────────────────────────────────

function SetupItem({ label, icon, progress, error }: { label: string; icon: string; progress: InstallProgress | null; error: string | null }) {
  const done = progress?.step === "done";
  const idle = progress === null && !error;
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: 14, fontWeight: 600, color: done ? "#34d399" : idle ? "rgba(255,255,255,0.3)" : "#fff" }}>
          {done ? "✓ " : ""}{icon} {label}
        </span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: error ? "#f87171" : "rgba(255,255,255,0.35)" }}>
          {error ? "erreur" : progress?.message ?? (idle ? "en attente…" : "")}
        </span>
      </div>
      <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 100, height: 6, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${progress?.percent ?? 0}%`, background: error ? "#ef4444" : "linear-gradient(90deg, #22d3ee, #a78bfa)", borderRadius: 100, transition: "width 0.35s ease" }} />
      </div>
    </div>
  );
}

function SetupScreen({ needsSldl, needsFfmpeg, onDone }: { needsSldl: boolean; needsFfmpeg: boolean; onDone: () => void }) {
  const [sldlProgress, setSldlProgress] = useState<InstallProgress | null>(needsSldl ? null : { step: "done", percent: 100, message: "déjà installé" });
  const [ffmpegProgress, setFfmpegProgress] = useState<InstallProgress | null>(needsFfmpeg ? null : { step: "done", percent: 100, message: "déjà installé" });
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setError(null);
    try {
      if (needsSldl) await invoke("download_sldl");
      if (needsFfmpeg) await invoke("download_ffmpeg");
      onDone();
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    let unSldl: (() => void) | undefined;
    let unFfmpeg: (() => void) | undefined;
    listen<InstallProgress>("sldl-install-progress", (e) => setSldlProgress(e.payload)).then((f) => { unSldl = f; });
    listen<InstallProgress>("ffmpeg-install-progress", (e) => setFfmpegProgress(e.payload)).then((f) => { unFfmpeg = f; });
    run();
    return () => { unSldl?.(); unFfmpeg?.(); };
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: "#0a0e17", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, backgroundImage: "radial-gradient(ellipse at 20% 0%, rgba(34,211,238,0.07) 0%, transparent 55%), radial-gradient(ellipse at 80% 100%, rgba(139,92,246,0.05) 0%, transparent 50%)" }}>
      <div style={{ width: "100%", maxWidth: 480, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 24, padding: 36 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🎧</div>
          <h1 style={{ fontFamily: "'Outfit', sans-serif", fontSize: 26, fontWeight: 800, margin: "0 0 6px", background: "linear-gradient(135deg, #22d3ee, #a78bfa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            sldl dj toolkit
          </h1>
          <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: 14, color: "rgba(255,255,255,0.4)", margin: 0 }}>
            Installation des outils nécessaires…
          </p>
        </div>

        <SetupItem label="sldl" icon="⬇" progress={sldlProgress} error={needsSldl && error && sldlProgress?.step !== "done" ? error : null} />
        <SetupItem label="ffmpeg" icon="🎞" progress={ffmpegProgress} error={needsFfmpeg && error && ffmpegProgress?.step !== "done" ? error : null} />

        {error && (
          <div style={{ marginTop: 16, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 12, padding: "12px 16px" }}>
            <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#f87171", margin: "0 0 10px", wordBreak: "break-word" }}>{error}</p>
            <button onClick={run} style={{ padding: "7px 16px", borderRadius: 8, border: "none", background: "rgba(239,68,68,0.2)", color: "#f87171", fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Réessayer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [sldlReady, setSldlReady] = useState<boolean | null>(null);
  const [ffmpegReady, setFfmpegReady] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"csv" | "youtube">("csv");
  const [status, setStatus] = useState<AppStatus>("idle");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [headerLine, setHeaderLine] = useState("");
  const [playlistName, setPlaylistName] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [format, setFormat] = useState("flac,wav");
  const [convertToAiff, setConvertToAiff] = useState(false);
  const [outputDir, setOutputDir] = useState("");
  const [config, setConfig] = useState<AppConfig>({ username: "", password: "", output_dir: "" });
  const [logs, setLogs] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const liveRef = useRef({ convertToAiff: false, ffmpegAvailable: false, outputDir: "", playlistName: "" });

  useEffect(() => {
    const link = document.createElement("link");
    link.href = "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Outfit:wght@300;400;500;600;700;800&display=swap";
    link.rel = "stylesheet";
    document.head.appendChild(link);
    invoke<boolean>("check_sldl").then(setSldlReady);
    invoke<boolean>("check_ffmpeg").then(setFfmpegReady);
    invoke<AppConfig>("get_config").then((c) => { setConfig(c); setOutputDir(c.output_dir); });
  }, []);

  useEffect(() => {
    // Use cancelled flag to handle React Strict Mode's double-invocation:
    // cleanup may run before the async listen() Promises resolve, so we
    // immediately unlisten if the effect was already cancelled.
    let cancelled = false;
    let unLog: (() => void) | undefined;
    let unDone: (() => void) | undefined;

    async function setup() {
      const f1 = await listen<string>("sldl-log", (e) => setLogs((p) => [...p, e.payload]));
      const f2 = await listen<number>("sldl-done", (e) => {
        const code = e.payload;
        const { convertToAiff, ffmpegAvailable, outputDir, playlistName } = liveRef.current;
        if (convertToAiff && ffmpegAvailable) {
          setStatus("converting");
          invoke("convert_to_aiff", { dir: `${outputDir}/${playlistName}` })
            .then(() => { setExitCode(code); setStatus(code === 0 ? "done" : "stopped"); })
            .catch((e: unknown) => { setLogs((p) => [...p, `Erreur AIFF: ${e}`]); setExitCode(code); setStatus("done"); });
        } else {
          setExitCode(code);
          setStatus(code === 0 ? "done" : "stopped");
        }
      });
      if (cancelled) { f1(); f2(); }
      else { unLog = f1; unDone = f2; }
    }
    setup();

    return () => {
      cancelled = true;
      unLog?.(); unDone?.();
    };
  }, []);

  const handleCSVContent = (content: string, name: string) => {
    const { tracks: parsed, headerLine: hl } = parseCSV(content);
    setTracks(parsed); setHeaderLine(hl);
    setPlaylistName(name.replace(/\.csv$/i, "").replace(/_/g, " "));
    setStatus("ready");
  };

  const handlePickCSV = async () => {
    const path = await invoke<string | null>("pick_csv");
    if (!path) return;
    const content = await invoke<string>("read_text_file", { path });
    handleCSVContent(content, path.split(/[/\\]/).pop() ?? "playlist.csv");
  };

  const handlePickOutputDir = async () => {
    const path = await invoke<string | null>("pick_folder");
    if (path) setOutputDir(path);
  };

  const handleDownload = async () => {
    const args: string[] = [];
    if (mode === "csv") {
      const csv = buildSelectionCSV(headerLine, tracks);
      const tmp = await invoke<string>("write_temp_csv", { content: csv });
      args.push(tmp);
    } else {
      args.push(youtubeUrl.trim());
    }
    args.push("-p", `${outputDir}/${playlistName}`);
    args.push("--name-format", "{artist} - {title}");
    args.push("--pref-format", format);
    if (config.username) args.push("--user", config.username);
    if (config.password) args.push("--pass", config.password);
    setLogs([]); setExitCode(null); setStatus("running");
    invoke("run_sldl", { args }).catch((e: unknown) => {
      setLogs((p) => [...p, `Erreur: ${e}`]);
      setStatus("stopped");
    });
  };

  const handleStop = () => { invoke("stop_sldl").catch(console.error); };
  const handleReset = () => { setTracks([]); setHeaderLine(""); setPlaylistName(""); setYoutubeUrl(""); setLogs([]); setExitCode(null); setStatus("idle"); };
  const handleSaveConfig = async (c: AppConfig) => { setConfig(c); setOutputDir(c.output_dir); await invoke("save_config", { config: c }); };

  const ffmpegAvailable = ffmpegReady === true;

  // Keep ref current so the sldl-done listener always reads latest values
  liveRef.current = { convertToAiff, ffmpegAvailable, outputDir, playlistName };

  if (sldlReady === null || ffmpegReady === null) return null;
  if (!sldlReady || !ffmpegReady) {
    return <SetupScreen
      needsSldl={!sldlReady}
      needsFfmpeg={!ffmpegReady}
      onDone={() => { setSldlReady(true); setFfmpegReady(true); }}
    />;
  }

  const selectedCount = tracks.filter((t) => t.selected).length;
  const canDownload = status !== "running" && (mode === "csv" ? selectedCount > 0 : youtubeUrl.trim().length > 0) && playlistName.trim().length > 0 && outputDir.trim().length > 0;
  const isRunning = status === "running" || status === "converting";
  const showLogs = status === "running" || status === "converting" || status === "done" || status === "stopped";

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, padding: "28px 16px", backgroundImage: "radial-gradient(ellipse at 20% 0%, rgba(34,211,238,0.07) 0%, transparent 55%), radial-gradient(ellipse at 80% 100%, rgba(139,92,246,0.05) 0%, transparent 50%)" }}>
      <style>{`
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        @keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:5px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:3px}
        input:focus,select:focus{outline:none;border-color:#22d3ee!important}
        input,select{color-scheme:dark}
      `}</style>

      {showSettings && <SettingsPanel config={config} onSave={handleSaveConfig} onClose={() => setShowSettings(false)} />}

      <div style={{ maxWidth: 740, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28 }}>
          <div>
            <h1 style={{ fontFamily: "'Outfit', sans-serif", fontSize: 32, fontWeight: 800, margin: 0, letterSpacing: "-0.02em", background: `linear-gradient(135deg, ${C.cyan}, ${C.purple})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              sldl dj toolkit
            </h1>
            <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>
              Spotify · YouTube → Soulseek → FLAC / AIFF
            </p>
          </div>
          <button onClick={() => setShowSettings(true)} style={{ background: "rgba(255,255,255,0.05)", border: `1px solid ${C.border}`, borderRadius: 10, padding: "8px 14px", color: C.muted, fontFamily: "'JetBrains Mono', monospace", fontSize: 13, cursor: "pointer" }}>
            ⚙ Config
          </button>
        </div>

        {/* Card */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 20, padding: 26, animation: "slideUp 0.4s ease-out" }}>
          {/* Status */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <StatusBadge status={status} />
            {status !== "idle" && !isRunning && (
              <button onClick={handleReset} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>✕ Recommencer</button>
            )}
          </div>

          {/* Mode tabs */}
          {!showLogs && (
            <div style={{ display: "flex", gap: 4, marginBottom: 20, background: "rgba(0,0,0,0.3)", borderRadius: 10, padding: 4 }}>
              {([["csv", "📂 Spotify CSV"], ["youtube", "▶ YouTube"]] as const).map(([key, label]) => (
                <button key={key} onClick={() => { if (!isRunning) { setMode(key); handleReset(); } }}
                  style={{ flex: 1, padding: "9px 16px", borderRadius: 7, border: "none", background: mode === key ? "rgba(255,255,255,0.08)" : "transparent", color: mode === key ? C.text : C.muted, fontFamily: "'Outfit', sans-serif", fontSize: 14, fontWeight: mode === key ? 600 : 400, cursor: "pointer", transition: "all 0.2s" }}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* CSV Mode */}
          {mode === "csv" && !showLogs && (
            tracks.length === 0
              ? <DropZone onContent={handleCSVContent} isDragging={isDragging} setIsDragging={setIsDragging} onPickFile={handlePickCSV} />
              : <TrackList tracks={tracks} onToggle={(id) => setTracks((p) => p.map((t) => t.id === id ? { ...t, selected: !t.selected } : t))} onToggleAll={() => { const all = tracks.every((t) => t.selected); setTracks((p) => p.map((t) => ({ ...t, selected: !all }))); }} />
          )}

          {/* YouTube Mode */}
          {mode === "youtube" && !showLogs && (
            <div>
              <label style={labelStyle}>URL de la playlist YouTube</label>
              <input value={youtubeUrl} onChange={(e) => { setYoutubeUrl(e.target.value); setStatus(e.target.value.trim() ? "ready" : "idle"); }} placeholder="https://youtube.com/playlist?list=…" style={inputStyle} />
            </div>
          )}

          {/* Settings block */}
          {!showLogs && status !== "idle" && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={labelStyle}>Nom du dossier</label>
                  <input value={playlistName} onChange={(e) => setPlaylistName(e.target.value)} style={inputStyle} placeholder="Ma Playlist" />
                </div>
                <div>
                  <label style={labelStyle}>Format préféré</label>
                  <select value={format} onChange={(e) => setFormat(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
                    <option value="flac,wav">FLAC / WAV (lossless)</option>
                    <option value="mp3">MP3</option>
                    <option value="ogg">OGG</option>
                  </select>
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>Dossier de destination</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input value={outputDir} onChange={(e) => setOutputDir(e.target.value)} style={{ ...inputStyle, flex: 1 }} placeholder="~/Music/SLDL" />
                  <button onClick={handlePickOutputDir} style={{ padding: "10px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: "rgba(255,255,255,0.04)", color: C.muted, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>
                    Choisir…
                  </button>
                </div>
              </div>
              {/* AIFF toggle */}
              <div onClick={() => setConvertToAiff((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", background: convertToAiff ? "rgba(34,211,238,0.05)" : "rgba(255,255,255,0.02)", border: `1px solid ${convertToAiff && !ffmpegAvailable ? "rgba(245,158,11,0.35)" : convertToAiff ? "rgba(34,211,238,0.18)" : C.border}`, borderRadius: 10, cursor: "pointer", transition: "all 0.2s" }}>
                <div style={{ width: 34, height: 18, borderRadius: 9, background: convertToAiff ? (ffmpegAvailable ? C.cyan : "#f59e0b") : C.dim, position: "relative", flexShrink: 0, transition: "background 0.2s" }}>
                  <div style={{ width: 14, height: 14, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: convertToAiff ? 18 : 2, transition: "left 0.2s" }} />
                </div>
                <div>
                  <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: 600, color: convertToAiff ? C.text : C.muted }}>Convertir en AIFF (Pioneer DJ)</span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: convertToAiff && !ffmpegAvailable ? "#f59e0b" : "rgba(255,255,255,0.25)", display: "block", marginTop: 2 }}>
                    {convertToAiff && !ffmpegAvailable ? "⚠ ffmpeg introuvable dans le PATH — conversion désactivée" : convertToAiff ? "ffmpeg détecté ✓" : "garder le format original"}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Log terminal */}
          {showLogs && (
            <div>
              <div style={{ marginBottom: 10, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Sortie sldl</div>
              <LogTerminal logs={logs} status={status} />
              {(status === "done" || status === "stopped") && (
                <div style={{ marginTop: 14, padding: "12px 16px", borderRadius: 10, background: status === "done" ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)", border: `1px solid ${status === "done" ? "rgba(16,185,129,0.2)" : "rgba(239,68,68,0.2)"}`, fontFamily: "'Outfit', sans-serif", fontSize: 14, fontWeight: 600, color: status === "done" ? "#34d399" : "#f87171" }}>
                  {status === "done" ? `✓ Terminé — fichiers dans ${outputDir}/${playlistName}` : `⏹ Arrêté${exitCode !== null && exitCode !== 0 ? ` (code ${exitCode})` : ""}`}
                </div>
              )}
            </div>
          )}

          {/* Action button */}
          <div style={{ marginTop: 20 }}>
            {isRunning ? (
              <button onClick={handleStop} style={{ width: "100%", padding: "13px", borderRadius: 12, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.12)", color: "#f87171", fontFamily: "'Outfit', sans-serif", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
                ⏹ Arrêter le téléchargement
              </button>
            ) : showLogs ? (
              <button onClick={handleReset} style={{ width: "100%", padding: "13px", borderRadius: 12, border: `1px solid ${C.border}`, background: "rgba(255,255,255,0.04)", color: C.muted, fontFamily: "'Outfit', sans-serif", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
                ↩ Nouveau téléchargement
              </button>
            ) : (
              <button onClick={handleDownload} disabled={!canDownload} style={{ width: "100%", padding: "13px", borderRadius: 12, border: "none", background: canDownload ? `linear-gradient(135deg, ${C.cyan}, ${C.purple})` : "rgba(255,255,255,0.05)", color: canDownload ? "#0a0e17" : "rgba(255,255,255,0.2)", fontFamily: "'Outfit', sans-serif", fontSize: 15, fontWeight: 700, cursor: canDownload ? "pointer" : "not-allowed", transition: "all 0.15s", boxShadow: canDownload ? "0 4px 20px rgba(34,211,238,0.2)" : "none" }}>
                {mode === "csv"
                  ? `⬇ Télécharger${selectedCount > 0 ? ` (${selectedCount} morceaux)` : ""}`
                  : "⬇ Télécharger la playlist"}
              </button>
            )}
          </div>

          {!showLogs && (
            <p style={{ textAlign: "center", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "rgba(255,255,255,0.2)", marginTop: 10 }}>
              sldl doit être installé et dans le PATH
            </p>
          )}
        </div>

        <p style={{ textAlign: "center", fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "rgba(255,255,255,0.15)", marginTop: 20 }}>
          exportify.net · soulseek · ffmpeg
        </p>
      </div>
    </div>
  );
}
