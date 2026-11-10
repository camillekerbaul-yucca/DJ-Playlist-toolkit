import { useEffect, useRef } from "react";
import type { RunRow } from "../lib/types";
import { extOf } from "../lib/run";
import { CheckCircle } from "./Icons";

export type Stage = "sldl" | "fallback" | "aiff" | "done" | "stopped" | "error";

function statusOf(r: RunRow): { label: string; cls: string } {
  if (r.converting) return { label: "Conversion AIFF…", cls: "live" };
  switch (r.phase) {
    case "wait": return { label: "En attente", cls: "" };
    case "search": return { label: "Recherche Soulseek…", cls: "live" };
    case "active": return { label: "Téléchargement…", cls: "dl" };
    case "notfound": return { label: "Pas sur Soulseek", cls: "bad" };
    case "fallback": return { label: "SoundCloud…", cls: "dl" };
    case "missing": return { label: "Introuvable", cls: "bad" };
    case "cancelled": return { label: "Annulé", cls: "" };
    case "sc": return { label: r.converted ? "AIFF · depuis SC 160k" : "SoundCloud 160k", cls: "sc" };
    case "found": {
      const ext = extOf(r.file);
      if (r.converted) return { label: `AIFF ✓ · depuis ${ext.toUpperCase()}`, cls: "ok" };
      if (ext === "mp3") return { label: "MP3 320 · Soulseek", cls: "ok" };
      return { label: `${ext.toUpperCase()} · Soulseek`, cls: "ok" };
    }
  }
}

export function RunScreen({ name, dir, rows, stage, stageDetail, logs, error, onStop, onOpen, onReset }: {
  name: string;
  dir: string;
  rows: RunRow[];
  stage: Stage;
  stageDetail: string;
  logs: string[];
  error: string | null;
  onStop: () => void;
  onOpen: () => void;
  onReset: () => void;
}) {
  const running = stage === "sldl" || stage === "fallback" || stage === "aiff";
  const settled = (r: RunRow) => ["found", "sc", "missing", "cancelled"].includes(r.phase) || (r.phase === "notfound" && stage !== "sldl");
  // While sldl runs, downloads are only known from its "Succeeded" lines.
  const succeeded = logs.filter((l) => /^Succeeded/.test(l)).length;
  const done = stage === "sldl"
    ? Math.min(rows.length, succeeded + rows.filter((r) => r.phase === "notfound").length)
    : rows.filter(settled).length;
  const lossless = rows.filter((r) => r.phase === "found" && extOf(r.file) !== "mp3").length;
  const mp3 = rows.filter((r) => r.phase === "found" && extOf(r.file) === "mp3").length;
  const sc = rows.filter((r) => r.phase === "sc").length;
  const missing = rows.filter((r) => r.phase === "missing" || (r.phase === "notfound" && stage !== "sldl" && stage !== "fallback")).length;
  const ready = lossless + mp3 + sc;
  const converted = rows.filter((r) => r.converted).length;
  const pct = stage === "done" ? 100 : rows.length ? Math.round((done / rows.length) * 100) : 0;

  const logEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { logEnd.current?.scrollIntoView({ block: "nearest" }); }, [logs.length]);

  const stageLabel: Record<Stage, string> = {
    sldl: "Recherche et téléchargement sur Soulseek…",
    fallback: "Récupération sur SoundCloud des morceaux manquants…",
    aiff: "Conversion AIFF…",
    done: "Terminé",
    stopped: "Arrêté",
    error: "Erreur",
  };

  return (
    <section className="stack gap-24">
      <div className="row gap-18" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div className="stack gap-6">
          <span className="small" style={{ fontSize: 13 }}>{stageLabel[stage]}{stageDetail && ` ${stageDetail}`}</span>
          <h1 className="h2">{name}</h1>
        </div>
        {running && <button className="btn danger" onClick={onStop}>Arrêter</button>}
      </div>

      <div className="stack gap-10">
        <div className="bar"><div style={{ width: `${pct}%` }} /></div>
        <div className="row" style={{ gap: "8px 18px", fontSize: 13, color: "var(--muted)" }}>
          <span>{done} / {rows.length} traités</span>
          {lossless > 0 && <span style={{ color: "var(--accent)" }}>{lossless} lossless</span>}
          {mp3 > 0 && <span style={{ color: "var(--accent)" }}>{mp3} MP3 320</span>}
          {sc > 0 && <span style={{ color: "var(--sc)" }}>{sc} depuis SoundCloud</span>}
          {missing > 0 && <span style={{ color: "var(--bad)" }}>{missing} introuvable{missing > 1 ? "s" : ""}</span>}
          {converted > 0 && <span>{converted} converti{converted > 1 ? "s" : ""} en AIFF</span>}
        </div>
      </div>

      {error && <p className="notice error">{error}</p>}

      {(stage === "done" || stage === "stopped" || stage === "error") && (
        <div className={`done-card${stage === "done" ? "" : " stopped"}`}>
          {stage === "done" && <CheckCircle />}
          <div className="stack" style={{ flex: "1 1 260px", gap: 3, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>
              {ready} morceau{ready > 1 ? "x" : ""} prêt{ready > 1 ? "s" : ""}{stage === "stopped" ? " avant l'arrêt" : ""}
            </span>
            <span className="mono ellipsis" style={{ color: "var(--text-2)" }}>{dir}</span>
          </div>
          <button className="btn primary" style={{ height: 42 }} onClick={onOpen}>Ouvrir le dossier</button>
          <button className="btn ghost" style={{ height: 42 }} onClick={onReset}>Nouvelle playlist</button>
        </div>
      )}

      <div className="list">
        {rows.map((r, i) => {
          const s = statusOf(r);
          const dim = r.phase === "missing" || r.phase === "cancelled";
          return (
            <div key={r.key} className="run-row">
              <span className="mono" style={{ color: "var(--faint)" }}>{String(i + 1).padStart(2, "0")}</span>
              <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                <span className="ellipsis" style={{ fontWeight: 500, color: dim ? "var(--muted)" : undefined }}>{r.track.title}</span>
                <span className="small ellipsis">{r.track.artist}</span>
              </span>
              <span className={`status ${s.cls}`}>{s.label}</span>
            </div>
          );
        })}
      </div>

      <details className="log">
        <summary>Journal détaillé ({logs.length} lignes)</summary>
        <div className="log-box">
          {logs.join("\n")}
          <div ref={logEnd} />
        </div>
      </details>
    </section>
  );
}
