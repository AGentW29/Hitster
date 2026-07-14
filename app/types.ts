export type Track = { name: string; artist: string; year: string; uri: string };

export type SongResult =
  | {
      ok: true;
      track: Track;
    }
  | { ok: false; error: string };

export type ActionResult = { ok: true } | { ok: false; error: string };
