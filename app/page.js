import { auth, signIn, signOut } from "../auth"; // Adjust path if necessary
import Dashboard from "./Dashboard";

const playlistTrackCache = new Map();
const playlistQueueCache = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getTrackFromPlaylistEntry(entry) {
  return entry?.item ?? entry?.track ?? entry;
}

function shuffle(items) {
  const nextItems = [...items];

  for (let index = nextItems.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [nextItems[index], nextItems[swapIndex]] = [nextItems[swapIndex], nextItems[index]];
  }

  return nextItems;
}

// Unique per user + playlist. Falls back to the END of the token
// (the start of Spotify tokens is often identical between users).
function getCacheKey(session, token) {
  const playlistId = process.env.SPOTIFY_PLAYLIST_ID;
  const userPart = session?.user?.id ?? session?.user?.email ?? token.slice(-24);
  return `${playlistId}:${userPart}`;
}

async function loadPlayableTracks(token, cacheKey) {
  const playlistId = process.env.SPOTIFY_PLAYLIST_ID;
  if (!playlistId) {
    throw new Error("No playlist configured. Set SPOTIFY_PLAYLIST_ID in your .env.local.");
  }

  const cached = playlistTrackCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let allTracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100&market=from_token`;

  while (url) {
    const tracksRes = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });

    if (tracksRes.status === 429) {
      const retryAfter = tracksRes.headers.get("Retry-After");
      throw new Error(
        `Spotify is rate-limiting this app right now${retryAfter ? ` — try again in ~${retryAfter}s` : ""}.`
      );
    }

    if (!tracksRes.ok) {
      if (tracksRes.status === 403 || tracksRes.status === 401) {
        throw new Error("Spotify session expired or permissions changed. Please sign out and sign in again.");
      }
      if (tracksRes.status === 404) {
        throw new Error("Playlist not found. Check SPOTIFY_PLAYLIST_ID.");
      }
      throw new Error(`Could not load the playlist (status ${tracksRes.status}).`);
    }

    const data = await tracksRes.json();
    allTracks = allTracks.concat((data.items || []).map(getTrackFromPlaylistEntry).filter(Boolean));
    url = data.next;
  }

  const playableTracks = allTracks.filter(
    (track) =>
      track?.type === "track" &&
      track.is_local !== true &&
      track.is_playable !== false &&
      typeof track.uri === "string" &&
      track.uri.length > 0
  );
  playlistTrackCache.set(cacheKey, playableTracks);
  return playableTracks;
}

async function getQueueForToken(token, cacheKey) {
  const tracks = await loadPlayableTracks(token, cacheKey);
  const cachedQueue = playlistQueueCache.get(cacheKey);

  if (!cachedQueue || cachedQueue.length < 10 || cachedQueue.length > tracks.length) {
    const queue = shuffle(tracks).slice(0, Math.min(12, tracks.length));
    playlistQueueCache.set(cacheKey, queue);
    return queue;
  }

  return cachedQueue;
}

// Picks a device, wakes it up (transfer playback) if needed, then plays on it explicitly.
async function startPlayback(token, uri) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const devRes = await fetch("https://api.spotify.com/v1/me/player/devices", {
    headers,
    cache: "no-store",
  });

  if (devRes.status === 401) {
    return { ok: false, error: "Spotify session expired. Please sign out and sign in again." };
  }
  if (devRes.status === 429) {
    return { ok: false, error: "Spotify is rate-limiting this app. Wait a bit and try again." };
  }

  const { devices = [] } = devRes.ok ? await devRes.json() : {};
  const device = devices.find((d) => d.is_active) ?? devices.find((d) => !d.is_restricted);

  if (!device) {
    return {
      ok: false,
      error:
        "No Spotify device found. Open Spotify on your phone or PC, play anything for a second, then try again.",
    };
  }

  // Wake up / activate the device if it isn't the active one
  if (!device.is_active) {
    await fetch("https://api.spotify.com/v1/me/player", {
      method: "PUT",
      headers,
      body: JSON.stringify({ device_ids: [device.id], play: false }),
    });
    await sleep(600);
  }

  const res = await fetch(
    `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(device.id)}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({ uris: [uri] }),
    }
  );

  const body = await res.text();
  console.log("Spotify play:", res.status, device.name, body); // check your server terminal

  if (res.status === 204) return { ok: true };
  if (res.status === 429) return { ok: false, error: "Spotify is rate-limiting this app. Wait a bit and try again." };
  if (res.status === 401) return { ok: false, error: "Spotify session expired. Please sign out and sign in again." };
  if (res.status === 403) {
    return { ok: false, error: "Spotify denied playback (Premium required, or missing scopes)." };
  }
  if (res.status === 404) return { ok: false, error: "No active Spotify device found." };
  return { ok: false, error: `Playback didn't start (status ${res.status}). ${body}` };
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

  async function playRandomSong() {
    "use server";

    const currentSession = await auth();
    const token = currentSession?.accessToken;
    if (!token) {
      return { ok: false, error: "No access token found. Please sign in again." };
    }

    try {
      const cacheKey = getCacheKey(currentSession, token);
      const queue = await getQueueForToken(token, cacheKey);
      if (!queue.length) {
        return { ok: false, error: "No playable tracks were found in this playlist." };
      }

      const randomIndex = Math.floor(Math.random() * queue.length);
      const [selectedTrack, ...remaining] = queue.splice(randomIndex, 1);
      playlistQueueCache.set(cacheKey, remaining.length ? remaining : []);

      if (!selectedTrack || !selectedTrack.uri) {
        return { ok: false, error: "No playable tracks were found in this playlist." };
      }

      const result = await startPlayback(token, selectedTrack.uri);
      if (!result.ok) return result;

      return {
        ok: true,
        track: {
          name: selectedTrack.name.split("-")[0].split("(")[0].trim(),
          artist: selectedTrack.artists?.[0]?.name ?? "Unknown artist",
          year: selectedTrack.album?.release_date ? selectedTrack.album.release_date.slice(0, 4) : "----",
          uri: selectedTrack.uri,
        },
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
        playRandomSong={playRandomSong}
        pausePlayback={pausePlayback}
        resumePlayback={resumePlayback}
      />
    </div>
  );
}
