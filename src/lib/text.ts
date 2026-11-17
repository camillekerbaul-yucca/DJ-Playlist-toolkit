import type { Track } from "./types";

export type LineOrder = "title-artist" | "artist-title";

// Tracklists copied from the web often carry "01.", "12)", "[00:12:30]" or "1:02:15" in front.
const LEADING_NOISE = /^\s*(?:[[(]?\d{1,2}(?::\d{2}){1,2}[\])]?\s*[-–—|]?\s*|\d{1,3}\s*[.)]\s+|#\d{1,3}\s+)+/;
const SEPARATORS = [" - ", " – ", " — ", "\t"];

/** Splits on the first separator that is not inside brackets ("A (B - C) - D"). */
function splitPair(line: string): [string, string] | null {
  for (const sep of SEPARATORS) {
    let depth = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (depth === 0 && line.startsWith(sep, i)) {
        const a = line.slice(0, i).trim();
        const b = line.slice(i + sep.length).trim();
        if (a && b) return [a, b];
      }
    }
  }
  return null;
}

/** One track per line: "Title - Artist" or "Artist - Title". Blank lines are skipped. */
export function parseTextPlaylist(text: string, order: LineOrder): Track[] {
  const tracks: Track[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(LEADING_NOISE, "").trim();
    if (!line) continue;
    const pair = splitPair(line);
    let artist = "";
    let title = line;
    if (pair) [title, artist] = order === "title-artist" ? pair : [pair[1], pair[0]];
    tracks.push({ title, artist, album: "", length: null, url: null, yt_id: null });
  }
  return tracks;
}
