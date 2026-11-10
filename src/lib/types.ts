export type Source = "spotify" | "soundcloud" | "youtube" | "csv";

/** Mirrors `sources::Track` in Rust. `length` is in seconds. */
export interface Track {
  artist: string;
  title: string;
  album: string;
  length: number | null;
  url: string | null;
  yt_id: string | null;
}

export interface Playlist {
  name: string;
  source: Source;
  tracks: Track[];
  truncated: boolean;
}

export interface AppConfig {
  username: string;
  password: string;
  output_dir: string;
}

export interface ToolStatus {
  sldl: boolean;
  ffmpeg: boolean;
  ytdlp: boolean;
}

export interface InstallProgress {
  step: "fetching" | "downloading" | "extracting" | "done";
  percent: number;
  message: string;
}

export interface IndexEntry {
  filepath: string;
  artist: string;
  title: string;
  state: number;
  failure_reason: number;
}

export type Quality = "lossless" | "mp3";

/** Where one track stands during a run. */
export type RowPhase =
  | "wait"          // not reached yet
  | "search"        // sldl is searching Soulseek
  | "active"        // found, downloading (or queued)
  | "found"         // on disk, from Soulseek
  | "notfound"      // not on Soulseek, SoundCloud fallback may still come
  | "fallback"      // downloading from SoundCloud
  | "sc"            // on disk, from SoundCloud
  | "missing"       // nowhere
  | "cancelled";

export interface RunRow {
  key: string;
  track: Track;
  phase: RowPhase;
  /** What sldl printed in its "Searching:" line, to match later lines. */
  searchText?: string;
  file?: string;
  converting?: boolean;
  converted?: boolean;
}
