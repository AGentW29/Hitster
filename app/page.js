import { auth, signIn, signOut } from "../auth"; // Adjust path if necessary
import Dashboard from "./Dashboard";

function normalizeTrack(track) {
  if (!track?.uri) return null;

  return {
    uri: track.uri,
    name: track.name || "Unknown track",
    artist: track.artists?.[0]?.name || "Unknown artist",
    year: track.album?.release_date ? track.album.release_date.slice(0, 4) : "----",
  };
}

async function loadPlaylistQueue() {
  "use server";

  const currentSession = await auth();
  const token = currentSession?.accessToken;
  if (!token) {
    return { ok: false, error: "No access token found. Please sign in again." };
  }

  const playlistId = process.env.SPOTIFY_PLAYLIST_ID;
  if (!playlistId) {
    return { ok: false, error: "No playlist configured. Set SPOTIFY_PLAYLIST_ID in your .env.local." };
  }

  try {
    const fields = encodeURIComponent("items(track(uri,name,artists(name),album(name,release_date))),next");
    let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100&fields=${fields}`;
    const playlistTracks = [];

    while (url) {
      const tracksRes = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      if (tracksRes.status === 429) {
        const retryAfter = tracksRes.headers.get("Retry-After");
        return {
          ok: false,
          error: `Spotify is rate-limiting this app right now${retryAfter ? ` — try again in ~${retryAfter}s` : ""}.`,
        };
      }

      if (!tracksRes.ok) {
        if (tracksRes.status === 403 || tracksRes.status === 401) {
          return {
            ok: false,
            error: "Spotify session expired or permissions changed. Please sign out and sign in again.",
          };
        }
        if (tracksRes.status === 404) {
          return { ok: false, error: "Playlist not found. Check SPOTIFY_PLAYLIST_ID." };
        }
        return { ok: false, error: `Could not load the playlist (status ${tracksRes.status}).` };
      }

      const data = await tracksRes.json();
      for (const entry of data.items || []) {
        const normalized = normalizeTrack(entry?.track ?? entry);
        if (normalized) {
          playlistTracks.push(normalized);
        }
      }
      url = data.next;
    }

    if (playlistTracks.length === 0) {
      return { ok: false, error: "No playable tracks were found in this playlist." };
    }

    return { ok: true, tracks: playlistTracks };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Something went wrong talking to Spotify.",
    };
  }
}

export default async function Home() {
  const session = await auth();

  if (!session) {
    return (
      <main style={{ padding: "2rem", fontFamily: "sans-serif", textAlign: "center" }}>
        <h1>Hitster online</h1>
        <form
          action={async () => {
            "use server";
            await signIn("spotify", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            style={{
              padding: "10px 24px",
              background: "#1DB954",
              color: "white",
              border: "none",
              borderRadius: "999px",
              fontSize: "1rem",
              cursor: "pointer",
            }}
          >
            Log in with Spotify
          </button>
        </form>
      </main>
    );
  }

  async function playRandomSong(trackInfo) {
    "use server";

    const currentSession = await auth();
    const token = currentSession?.accessToken;
    if (!token) {
      return { ok: false, error: "No access token found. Please sign in again." };
    }

    try {
      let selectedTrack = trackInfo;

      if (!selectedTrack || !selectedTrack.uri) {
        const playlistResult = await loadPlaylistQueue();
        if (!playlistResult.ok) {
          return playlistResult;
        }

        const randomIndex = Math.floor(Math.random() * playlistResult.tracks.length);
        selectedTrack = playlistResult.tracks[randomIndex];
      }

      const playRes = await fetch("https://api.spotify.com/v1/me/player/play", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ uris: [selectedTrack.uri] }),
      });

      if (!playRes.ok) {
        if (playRes.status === 429) {
          return { ok: false, error: "Spotify is rate-limiting this app right now. Please wait a bit and try again." };
        }
        if (playRes.status === 401 || playRes.status === 403) {
          return {
            ok: false,
            error: "Spotify session expired or permissions changed. Please sign out and sign in again.",
          };
        }
        if (playRes.status === 404) {
          return { ok: false, error: "No active Spotify device found. Open Spotify on a device, then try again." };
        }
        return { ok: false, error: "Spotify refused to start playback." };
      }

      return {
        ok: true,
        track: selectedTrack,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Something went wrong talking to Spotify.",
      };
    }
  }

  async function pausePlayback() {
    "use server";
    const currentSession = await auth();
    const token = currentSession?.accessToken;
    if (!token) return { ok: false, error: "No access token found." };

    const res = await fetch("https://api.spotify.com/v1/me/player/pause", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok && res.status !== 204) {
      if (res.status === 404) {
        return { ok: false, error: "No active Spotify device found." };
      }
      return { ok: false, error: "Failed to pause playback." };
    }
    return { ok: true };
  }

  async function resumePlayback() {
    "use server";
    const currentSession = await auth();
    const token = currentSession?.accessToken;
    if (!token) return { ok: false, error: "No access token found." };

    const res = await fetch("https://api.spotify.com/v1/me/player/play", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok && res.status !== 204) {
      if (res.status === 404) {
        return { ok: false, error: "No active Spotify device found." };
      }
      return { ok: false, error: "Failed to resume playback." };
    }
    return { ok: true };
  }

  return (
    <div style={{ minHeight: "100vh", padding: "1rem 1rem 2rem" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.75rem" }}>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            style={{
              padding: "0.7rem 1rem",
              borderRadius: "999px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: "rgba(255,255,255,0.08)",
              color: "#f4f6fb",
              cursor: "pointer",
            }}
          >
            Log out
          </button>
        </form>
      </div>
      <Dashboard
        loadPlaylistQueue={loadPlaylistQueue}
        playRandomSong={playRandomSong}
        pausePlayback={pausePlayback}
        resumePlayback={resumePlayback}
      />
    </div>
  );
}
