import { invoke } from "@tauri-apps/api/core";
import type { Playlist, Quality } from "../lib/types";
import { formatLength, formatTotal, MIX_SECONDS } from "../lib/run";
import { SOURCES } from "./SourceScreen";
import { DownloadIcon } from "./Icons";

export interface RunOptions {
  name: string;
  quality: Quality;
  aiff: boolean;
  scFallback: boolean;
  outputDir: string;
}

export function TracksScreen({ playlist, selected, setSelected, options, setOptions, onBack, onStart, needsAccount, onOpenSettings }: {
  playlist: Playlist;
  selected: boolean[];
  setSelected: (s: boolean[]) => void;
  options: RunOptions;
  setOptions: (o: RunOptions) => void;
  onBack: () => void;
  onStart: () => void;
  needsAccount: boolean;
  onOpenSettings: () => void;
}) {
  const src = SOURCES[playlist.source];
  const count = selected.filter(Boolean).length;
  const total = playlist.tracks.reduce((a, t, i) => a + (selected[i] ? t.length ?? 0 : 0), 0);
  const allOn = count === playlist.tracks.length;
  const canStart = count > 0 && options.name.trim().length > 0 && options.outputDir.trim().length > 0;
  const set = (patch: Partial<RunOptions>) => setOptions({ ...options, ...patch });

  const pickFolder = async () => {
    const dir = await invoke<string | null>("pick_folder");
    if (dir) set({ outputDir: dir });
  };

  return (
    <section className="stack gap-24">
      <div className="row gap-18">
        <div className="cover" style={{ background: src.color }}>{src.short}</div>
        <div className="stack gap-6" style={{ flex: "1 1 300px", minWidth: 0 }}>
          <label className="label" htmlFor="pname">Nom du dossier</label>
          <input id="pname" className="input title" value={options.name} onChange={(e) => set({ name: e.target.value })} />
          <span className="small" style={{ fontSize: 13 }}>
            {src.label} · {playlist.tracks.length} morceaux · {formatTotal(total)} sélectionnés
          </span>
        </div>
        <button className="btn" onClick={onBack}>Changer de lien</button>
      </div>

      {playlist.truncated && (
        <p className="notice warn">Lien Spotify : seuls les 100 premiers morceaux sont lus. Pour une playlist plus longue, exporte-la en CSV sur exportify.net et dépose le fichier.</p>
      )}

      <div className="split">
        <div className="list">
          <div className="list-head">
            <span className="small" style={{ fontSize: 13 }}>{count} sur {playlist.tracks.length} sélectionnés</span>
            <button className="link" style={{ textDecoration: "none" }} onClick={() => setSelected(playlist.tracks.map(() => !allOn))}>
              {allOn ? "Tout désélectionner" : "Tout sélectionner"}
            </button>
          </div>
          <div className="list-body">
            {playlist.tracks.map((t, i) => (
              <label key={i} className={`track${selected[i] ? "" : " off"}`}>
                <input type="checkbox" checked={selected[i]} onChange={() => setSelected(selected.map((v, j) => (j === i ? !v : v)))} />
                <span className="mono" style={{ color: "var(--faint)" }}>{String(i + 1).padStart(2, "0")}</span>
                <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <span className="name ellipsis">
                    {t.title}
                    {(t.length ?? 0) >= MIX_SECONDS && <span className="tag">mix</span>}
                  </span>
                  <span className="small ellipsis">{t.artist}</span>
                </span>
                <span className="mono" style={{ color: "var(--faint)" }}>{formatLength(t.length)}</span>
              </label>
            ))}
          </div>
        </div>

        <aside className="panel">
          <div className="stack gap-8">
            <span className="label" id="quality-label">Qualité recherchée</span>
            <div className="segmented" role="group" aria-labelledby="quality-label">
              <button type="button" aria-pressed={options.quality === "lossless"} onClick={() => set({ quality: "lossless" })}>FLAC / WAV</button>
              <button type="button" aria-pressed={options.quality === "mp3"} onClick={() => set({ quality: "mp3" })}>MP3 320</button>
            </div>
            <span className="small">
              {options.quality === "lossless" ? "MP3 320 accepté seulement si aucun fichier lossless n'existe." : "Uniquement des MP3 à 320 kbps."}
            </span>
          </div>

          <label className="check">
            <input type="checkbox" checked={options.aiff} onChange={() => set({ aiff: !options.aiff })} />
            <span className="stack" style={{ gap: 3 }}>
              <span style={{ fontWeight: 500 }}>Convertir en AIFF Pioneer</span>
              <span className="small">16-bit · 44,1 kHz, avec titre, artiste et pochette. Lu par toutes les CDJ et par rekordbox. Les MP3 restent en MP3.</span>
            </span>
          </label>

          {playlist.source === "soundcloud" && (
            <label className="check">
              <input type="checkbox" checked={options.scFallback} onChange={() => set({ scFallback: !options.scFallback })} />
              <span className="stack" style={{ gap: 3 }}>
                <span style={{ fontWeight: 500 }}>Secours SoundCloud</span>
                <span className="small">Si un morceau est introuvable sur Soulseek, le prendre sur SoundCloud (160 kbps, fichier marqué « (SC) »).</span>
              </span>
            </label>
          )}

          <div className="stack gap-8">
            <span className="label">Destination</span>
            <div className="row gap-8" style={{ flexWrap: "nowrap" }}>
              <span className="mono ellipsis" style={{ flex: 1, color: "var(--text-2)" }}>{options.outputDir}</span>
              <button className="btn" style={{ height: 34 }} onClick={pickFolder}>Changer</button>
            </div>
          </div>

          {needsAccount && (
            <p className="notice warn" style={{ fontSize: 12 }}>
              Aucun compte Soulseek enregistré.{" "}
              <button className="link" style={{ padding: 0, fontSize: 12 }} onClick={onOpenSettings}>Le renseigner</button>
            </p>
          )}

          <button className="btn primary big" disabled={!canStart} onClick={onStart}>
            <DownloadIcon /> Télécharger {count} morceau{count > 1 ? "x" : ""}
          </button>
        </aside>
      </div>
    </section>
  );
}
