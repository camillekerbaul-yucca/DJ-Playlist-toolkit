import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { InstallProgress, ToolStatus } from "../lib/types";
import { Logo } from "./Icons";

const TOOLS = [
  { id: "sldl", label: "sldl", hint: "client Soulseek" },
  { id: "ffmpeg", label: "ffmpeg", hint: "conversion AIFF" },
  { id: "ytdlp", label: "yt-dlp", hint: "listes YouTube et secours SoundCloud" },
] as const;

type ToolId = (typeof TOOLS)[number]["id"];

/** First launch (or a missing tool): downloads sldl, ffmpeg and yt-dlp. */
export function Setup({ status, onDone }: { status: ToolStatus; onDone: () => void }) {
  const initial = (id: ToolId): InstallProgress | null =>
    status[id] ? { step: "done", percent: 100, message: "déjà installé" } : null;
  const [progress, setProgress] = useState<Record<ToolId, InstallProgress | null>>({
    sldl: initial("sldl"), ffmpeg: initial("ffmpeg"), ytdlp: initial("ytdlp"),
  });
  const [error, setError] = useState<{ tool: ToolId; message: string } | null>(null);

  const run = useCallback(async () => {
    setError(null);
    for (const t of TOOLS) {
      if (status[t.id]) continue;
      try {
        await invoke("install_tool", { tool: t.id });
      } catch (e) {
        setError({ tool: t.id, message: String(e) });
        return;
      }
    }
    onDone();
  }, [status, onDone]);

  useEffect(() => {
    let cancelled = false;
    const offs: (() => void)[] = [];
    (async () => {
      for (const t of TOOLS) {
        const off = await listen<InstallProgress>(`${t.id}-install-progress`, (e) =>
          setProgress((p) => ({ ...p, [t.id]: e.payload })),
        );
        if (cancelled) off(); else offs.push(off);
      }
      if (!cancelled) run();
    })();
    return () => { cancelled = true; offs.forEach((f) => f()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="stack gap-10">
          <div className="brand"><Logo /> DJ Playlist toolkit</div>
          <p className="lead">Installation des outils nécessaires, une seule fois.</p>
        </div>
        {TOOLS.map((t) => {
          const p = progress[t.id];
          const failed = error?.tool === t.id;
          return (
            <div key={t.id} className="stack gap-8">
              <div className="row gap-8" style={{ justifyContent: "space-between" }}>
                <span style={{ fontWeight: 600, color: p?.step === "done" ? "var(--accent)" : "var(--text)" }}>
                  {t.label} <span className="small" style={{ fontWeight: 400 }}>· {t.hint}</span>
                </span>
                <span className="small" style={{ color: failed ? "var(--bad)" : undefined }}>
                  {failed ? "erreur" : p?.message ?? "en attente…"}
                </span>
              </div>
              <div className="bar"><div style={{ width: `${p?.percent ?? 0}%`, background: failed ? "var(--bad)" : undefined }} /></div>
            </div>
          );
        })}
        {error && (
          <div className="notice error stack gap-10">
            <span style={{ wordBreak: "break-word" }}>{error.message}</span>
            <button className="btn" onClick={run} style={{ alignSelf: "flex-start" }}>Réessayer</button>
          </div>
        )}
      </div>
    </div>
  );
}
