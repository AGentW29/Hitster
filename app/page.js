import { auth, signIn, signOut } from "../auth"; // Adjust path if necessary
import Dashboard from "./Dashboard";

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

  async function playRandomSong() {
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
    // Spotify paginates at 100 tracks per request. Most playlists fit in one call,
    // but if yours is bigger than 100 tracks, paginate here to get them all.
    let allTracks = [];
    let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100`;

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
      allTracks = allTracks.concat(data.items || []);
      url = data.next; // Spotify gives you the next page URL directly, or null when done
    }

    const playableTracks = allTracks.filter((entry) => entry?.item?.uri);

    if (playableTracks.length === 0) {
      return { ok: false, error: "No playable tracks were found in this playlist." };
    }

    const randomTrack = playableTracks[Math.floor(Math.random() * playableTracks.length)].item;

    const playRes = await fetch("https://api.spotify.com/v1/me/player/play", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uris: [randomTrack.uri] }),
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
      track: {
        name: randomTrack.name.split("-")[0].split("(")[0].trim(),
        artist: randomTrack.artists[0].name,
        year: randomTrack.album?.release_date ? randomTrack.album.release_date.slice(0, 4) : "----",
        uri: randomTrack.uri,
      },
    };
  } catch (error) {
    return { ok: false, error: "Something went wrong talking to Spotify." };
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
        playRandomSong={playRandomSong}
        pausePlayback={pausePlayback}
        resumePlayback={resumePlayback}
      />
    </div>
  );
}
