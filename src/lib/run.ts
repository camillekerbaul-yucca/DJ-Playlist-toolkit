import type { IndexEntry, Quality, RunRow, Source, Track } from "./types";

/** Same rules as `sanitize_filename` in Rust, for the playlist folder name. */
export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/[. ]+$/, "");
  return cleaned.slice(0, 120) || "playlist";
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

export function formatLength(sec: number | null): string {
  if (sec === null) return "";
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, "0")}`;
}

export function formatTotal(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}

/** Tracks this long are DJ mixes, not tracks: unselected by default. */
export const MIX_SECONDS = 30 * 60;

export function buildSldlArgs(opts: {
  csvPath: string;
  dir: string;
  source: Source;
  quality: Quality;
  username: string;
  password: string;
}): string[] {
  const args = [
    opts.csvPath,
    "-p", opts.dir,
    // Name files after the playlist entry, not the (often missing) tags of the file found.
    "--name-format", "{sartist( - )stitle|artist( - )title|filename}",
    "--index-path", joinPath(opts.dir, "_index.csv"),
  ];
  if (opts.quality === "lossless") {
    // Lossless first; a 320 kbps MP3 is accepted when no lossless file exists.
    args.push("--format", "flac,wav,aiff,mp3", "--pref-format", "flac,wav,aiff", "--min-bitrate", "320");
  } else {
    args.push("--format", "mp3", "--pref-format", "mp3", "--min-bitrate", "320");
  }
  if (opts.source === "youtube") args.push("--yt-parse", "--yt-id-col", "YT Id");
  // On SoundCloud the "artist" is often just the uploader (a label, a blog…).
  if (opts.source === "soundcloud") args.push("--artist-maybe-wrong");
  if (opts.username) args.push("--user", opts.username);
  if (opts.password) args.push("--pass", opts.password);
  return args;
}

const FAILED = /^(Not found|All downloads failed|Out of download retries|Failed):\s*(.+)$/;

/**
 * Updates rows from one line of sldl output. sldl searches in list order, so the
 * n-th "Searching:" line is the n-th row; later lines quote the same text.
 */
export function applyLogLine(rows: RunRow[], line: string): RunRow[] {
  const searching = /^Searching:\s*(.+)$/.exec(line);
  if (searching) {
    // A second search for the same track (e.g. without the artist) is not a new row.
    if (rows.some((r) => r.searchText === searching[1])) return rows;
    const i = rows.findIndex((r) => r.phase === "wait");
    if (i < 0) return rows;
    return rows.map((r, j) => {
      if (j === i) return { ...r, phase: "search", searchText: searching[1] };
      if (r.phase === "search") return { ...r, phase: "active" };
      return r;
    });
  }
  const failed = FAILED.exec(line);
  if (failed) {
    const text = failed[2].trim();
    return rows.map((r) =>
      r.searchText === text && (r.phase === "search" || r.phase === "active") ? { ...r, phase: "notfound" } : r,
    );
  }
  return rows;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/** Final per-track result from sldl's index file. */
export function applyIndex(rows: RunRow[], entries: IndexEntry[]): RunRow[] {
  const used = new Set<number>();
  const matchFor = (r: RunRow) => {
    const tries: ((e: IndexEntry) => boolean)[] = [
      (e) => !!r.searchText && r.searchText.startsWith(e.artist ? `${e.artist} - ${e.title}` : e.title),
      (e) => norm(e.artist) === norm(r.track.artist) && norm(e.title) === norm(r.track.title),
      (e) => norm(e.title) === norm(r.track.title),
    ];
    for (const ok of tries) {
      const i = entries.findIndex((e, k) => !used.has(k) && ok(e));
      if (i >= 0) { used.add(i); return entries[i]; }
    }
    return undefined;
  };
  return rows.map((r) => {
    if (r.phase === "cancelled") return r;
    const e = matchFor(r);
    const downloaded = e && (e.state === 1 || e.state === 3) && e.filepath;
    if (downloaded) return { ...r, phase: "found", file: e.filepath };
    return { ...r, phase: "notfound" };
  });
}

export function extOf(path?: string): string {
  return (path?.split(".").pop() ?? "").toLowerCase();
}

export function rowKey(t: Track, i: number): string {
  return `${i}:${t.artist}:${t.title}`;
}
