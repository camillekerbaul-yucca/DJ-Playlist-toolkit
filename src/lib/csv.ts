import type { Track } from "./types";

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur.trim()); cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Reads an Exportify (or similar) CSV into tracks. Lengths become seconds. */
export function parsePlaylistCsv(text: string): Track[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseLine(lines[0]).map((h) => h.toLowerCase());
  const col = (...names: string[]) => {
    for (const n of names) {
      const i = headers.indexOf(n.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  };
  const title = col("Track Name", "Title", "Track", "Song");
  const artist = col("Artist Name(s)", "Artist", "Artists");
  const album = col("Album Name", "Album");
  const ms = col("Track Duration (ms)", "Duration (ms)");
  const sec = col("Length", "Duration");

  const tracks: Track[] = [];
  for (const line of lines.slice(1)) {
    const f = parseLine(line);
    const get = (i: number) => (i >= 0 ? f[i] ?? "" : "");
    let length: number | null = null;
    if (ms >= 0 && get(ms)) length = Math.round(Number(get(ms)) / 1000);
    else if (sec >= 0 && get(sec)) length = Math.round(Number(get(sec)));
    if (length !== null && !Number.isFinite(length)) length = null;
    const t: Track = {
      title: get(title),
      artist: get(artist).replace(/;/g, ", "),
      album: get(album),
      length,
      url: null,
      yt_id: null,
    };
    if (t.title || t.artist) tracks.push(t);
  }
  return tracks;
}
