import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "../lib/types";
import { CloseIcon } from "./Icons";

export function Settings({ config, onSave, onClose }: {
  config: AppConfig;
  onSave: (c: AppConfig) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(config);
  const pickFolder = async () => {
    const dir = await invoke<string | null>("pick_folder");
    if (dir) setDraft((d) => ({ ...d, output_dir: dir }));
  };
  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 id="settings-title" style={{ margin: 0, font: "600 20px var(--display)" }}>Paramètres</h2>
          <button className="btn icon ghost" style={{ border: "none" }} onClick={onClose} aria-label="Fermer"><CloseIcon /></button>
        </div>
        <div className="stack gap-6">
          <label className="label" htmlFor="slsk-user">Pseudo Soulseek</label>
          <input id="slsk-user" className="input" value={draft.username} placeholder="ton_pseudo" autoComplete="off"
            onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
        </div>
        <div className="stack gap-6">
          <label className="label" htmlFor="slsk-pass">Mot de passe Soulseek</label>
          <input id="slsk-pass" className="input" type="password" value={draft.password} placeholder="••••••••"
            onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
          <span className="small">Pas de compte ? Un pseudo et un mot de passe inventés suffisent : Soulseek le crée à la première connexion.</span>
        </div>
        <div className="stack gap-6">
          <span className="label">Dossier musique</span>
          <div className="row gap-8" style={{ flexWrap: "nowrap" }}>
            <span className="mono ellipsis" style={{ flex: 1, color: "var(--text-2)" }}>{draft.output_dir}</span>
            <button className="btn" onClick={pickFolder}>Changer</button>
          </div>
        </div>
        <p className="small" style={{ margin: 0 }}>sldl, ffmpeg et yt-dlp sont installés automatiquement.</p>
        <button className="btn primary big" onClick={() => { onSave(draft); onClose(); }}>Enregistrer</button>
      </div>
    </div>
  );
}
