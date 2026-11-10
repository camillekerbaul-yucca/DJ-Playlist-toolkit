import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppConfig, IndexEntry, Playlist, RunRow, ToolStatus, Track } from "./lib/types";
import { applyIndex, applyLogLine, buildSldlArgs, joinPath, MIX_SECONDS, rowKey, sanitizeName } from "./lib/run";
import { Setup } from "./components/Setup";
import { Settings } from "./components/Settings";
import { SourceScreen } from "./components/SourceScreen";
import { TracksScreen, type RunOptions } from "./components/TracksScreen";
import { RunScreen, type Stage } from "./components/RunScreen";
import { Gear, Logo } from "./components/Icons";

type Screen = "source" | "tracks" | "run";

export default function App() {
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [config, setConfig] = useState<AppConfig>({ username: "", password: "", output_dir: "" });
  const [showSettings, setShowSettings] = useState(false);

  const [screen, setScreen] = useState<Screen>("source");
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [selected, setSelected] = useState<boolean[]>([]);
  const [options, setOptions] = useState<RunOptions>({ name: "", quality: "lossless", aiff: true, scFallback: true, outputDir: "" });

  const [rows, setRows] = useState<RunRow[]>([]);
  const [stage, setStage] = useState<Stage>("sldl");
  const [stageDetail, setStageDetail] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [runDir, setRunDir] = useState("");
  const stopped = useRef(false);
  const rowsRef = useRef<RunRow[]>([]);
  rowsRef.current = rows;

  useEffect(() => {
    invoke<ToolStatus>("check_tools").then(setTools);
    invoke<AppConfig>("get_config").then((c) => {
      setConfig(c);
      setOptions((o) => ({ ...o, outputDir: c.output_dir }));
    });
  }, []);

  // sldl output → live row statuses + detailed log
  useEffect(() => {
    let cancelled = false;
    const offs: (() => void)[] = [];
    (async () => {
      const subs = [
        await listen<string>("sldl-log", (e) => {
          setLogs((l) => [...l, e.payload]);
          setRows((r) => applyLogLine(r, e.payload));
        }),
        await listen<{ key: string; status: string; path?: string }>("fallback-progress", (e) => {
          const { key, status, path } = e.payload;
          setRows((rs) => rs.map((r) => r.key !== key ? r
            : status === "running" ? { ...r, phase: "fallback" }
            : status === "ok" ? { ...r, phase: "sc", file: path }
            : { ...r, phase: "missing" }));
        }),
        await listen<{ index: number; total: number; src: string; status: string }>("aiff-progress", (e) => {
          const { index, total, src, status } = e.payload;
          if (status === "running") setStageDetail(`${index + 1} / ${total}`);
          setRows((rs) => rs.map((r) => r.file !== src ? r
            : status === "running" ? { ...r, converting: true }
            : { ...r, converting: false, converted: status === "ok" }));
        }),
      ];
      if (cancelled) subs.forEach((f) => f()); else offs.push(...subs);
    })();
    return () => { cancelled = true; offs.forEach((f) => f()); };
  }, []);

  const loadPlaylist = (p: Playlist) => {
    setPlaylist(p);
    // DJ mixes (30 min+) are rarely what you want on Soulseek: off by default.
    setSelected(p.tracks.map((t) => (t.length ?? 0) < MIX_SECONDS));
    setOptions((o) => ({ ...o, name: p.name }));
    setScreen("tracks");
  };

  const saveConfig = async (c: AppConfig) => {
    setConfig(c);
    setOptions((o) => ({ ...o, outputDir: c.output_dir }));
    await invoke("save_config", { config: c });
  };

  const start = useCallback(async () => {
    if (!playlist) return;
    const tracks = playlist.tracks.filter((_, i) => selected[i]);
    const dir = joinPath(options.outputDir, sanitizeName(options.name));
    stopped.current = false;
    setRunDir(dir);
    setRows(tracks.map((t, i) => ({ key: rowKey(t, i), track: t, phase: "wait" })));
    setLogs([]); setRunError(null); setStageDetail(""); setStage("sldl"); setScreen("run");

    try {
      // 1. Soulseek
      const csvPath = await invoke<string>("write_track_csv", { name: options.name, tracks });
      const args = buildSldlArgs({
        csvPath, dir, source: playlist.source, quality: options.quality,
        username: config.username, password: config.password,
      });
      await invoke<number>("run_sldl", { args });
      if (stopped.current) return finishStopped();

      let entries: IndexEntry[] = [];
      try {
        entries = await invoke<IndexEntry[]>("read_sldl_index", { path: joinPath(dir, "_index.csv") });
      } catch {
        // No index means sldl stopped before downloading anything (login refused, etc.).
        throw new Error("sldl s'est arrêté sans rien télécharger. Vérifie ton compte Soulseek dans les paramètres, et le journal détaillé ci-dessous.");
      }
      // Let the last log events land so every row has its "Searching:" text.
      await new Promise((res) => setTimeout(res, 200));
      let current = applyIndex(rowsRef.current, entries);
      setRows(current);

      // 2. SoundCloud / YouTube fallback for what Soulseek did not have
      const webUrl = (t: Track) => t.url || (t.yt_id ? `https://www.youtube.com/watch?v=${t.yt_id}` : null);
      const wanted = current.filter((r) => r.phase === "notfound" && webUrl(r.track));
      const webSource = playlist.source === "soundcloud" || playlist.source === "youtube";
      if (webSource && options.scFallback && wanted.length) {
        setStage("fallback");
        const results = await invoke<{ key: string; path: string | null }[]>("web_fallback", {
          dir,
          source: playlist.source,
          items: wanted.map((r) => ({ key: r.key, url: webUrl(r.track), artist: r.track.artist, title: r.track.title })),
        });
        const byKey = new Map(results.map((x) => [x.key, x.path]));
        current = current.map((r) => byKey.has(r.key)
          ? (byKey.get(r.key) ? { ...r, phase: "sc", file: byKey.get(r.key)! } : { ...r, phase: "missing" })
          : r);
        setRows(current);
        if (stopped.current) return finishStopped();
      }
      current = current.map((r) => (r.phase === "notfound" ? { ...r, phase: "missing" } : r));
      setRows(current);

      // 3. AIFF for the CDJs
      const files = current.filter((r) => r.file && (r.phase === "found" || r.phase === "sc")).map((r) => r.file!);
      if (options.aiff && files.length) {
        setStage("aiff"); setStageDetail("");
        await invoke("convert_to_aiff", { dir, files });
        if (stopped.current) return finishStopped();
      }
      setStageDetail("");
      setStage("done");
    } catch (e) {
      if (stopped.current) return finishStopped();
      setRunError(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  }, [playlist, selected, options, config]);

  const finishStopped = () => {
    setRows((rs) => rs.map((r) => (["wait", "search", "active", "fallback"].includes(r.phase) ? { ...r, phase: "cancelled", converting: false } : r)));
    setStageDetail("");
    setStage("stopped");
  };

  const stop = () => {
    stopped.current = true;
    invoke("stop_job").catch(console.error);
  };

  const reset = () => {
    setScreen("source"); setPlaylist(null); setRows([]); setLogs([]); setRunError(null);
  };

  if (!tools) return null;
  if (!tools.sldl || !tools.ffmpeg || !tools.ytdlp) {
    return <Setup status={tools} onDone={() => setTools({ sldl: true, ffmpeg: true, ytdlp: true })} />;
  }

  const running = screen === "run" && (stage === "sldl" || stage === "fallback" || stage === "aiff");

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><Logo /> DJ Playlist toolkit</div>
        <div className="topbar-actions">
          <button className="pill" onClick={() => setShowSettings(true)} disabled={running}>
            <span className="dot" style={{ background: config.username ? "#5bd98b" : "#ffa668" }} />
            {config.username ? `Soulseek · ${config.username}` : "Compte Soulseek à renseigner"}
          </button>
          <button className="btn icon" onClick={() => setShowSettings(true)} aria-label="Paramètres" disabled={running}><Gear /></button>
        </div>
      </header>

      <main className="main" key={screen}>
        {screen === "source" && <SourceScreen onLoaded={loadPlaylist} />}
        {screen === "tracks" && playlist && (
          <TracksScreen
            playlist={playlist} selected={selected} setSelected={setSelected}
            options={options} setOptions={setOptions}
            onBack={() => setScreen("source")} onStart={start}
            needsAccount={!config.username} onOpenSettings={() => setShowSettings(true)}
          />
        )}
        {screen === "run" && (
          <RunScreen
            name={options.name} source={playlist?.source ?? "csv"} dir={runDir} rows={rows} stage={stage} stageDetail={stageDetail}
            logs={logs} error={runError} onStop={stop} onReset={reset}
            onOpen={() => invoke("open_folder", { path: runDir }).catch((e) => setRunError(String(e)))}
          />
        )}
      </main>

      {showSettings && <Settings config={config} onSave={saveConfig} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
