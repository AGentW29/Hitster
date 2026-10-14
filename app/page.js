import { auth, signIn, signOut } from "../auth"; // Adjust path if necessary
import Dashboard from "./Dashboard";

const PLAYLIST_CACHE_TTL_MS = 5 * 60 * 1000;
const PRELOAD_QUEUE_SIZE = 12;
const REFILL_THRESHOLD = 4;

const playlistTrackCache = new Map();
const playlistQueueCache = new Map();

function shuffle(items) {
  const nextItems = [...items];

  for (let index = nextItems.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [nextItems[index], nextItems[swapIndex]] = [nextItems[swapIndex], nextItems[index]];
  }

  return nextItems;
}

function getPlaylistCacheKey(token, playlistId) {
  return `${playlistId}:${token.slice(0, 16)}`;
}

async function loadPlayableTracks(token) {
  const playlistId = process.env.SPOTIFY_PLAYLIST_ID;
  if (!playlistId) {
    throw new Error("No playlist configured. Set SPOTIFY_PLAYLIST_ID in your .env.local.");
  }

  const cacheKey = getPlaylistCacheKey(token, playlistId);
  const cached = playlistTrackCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.tracks;
  }

  const minimalTrackFields = "items(track(name,uri,artists(name),album(name,release_date)))";
  let allTracks = [];
  let nextUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100&fields=${encodeURIComponent(minimalTrackFields)}`;

  while (nextUrl) {
    const tracksRes = await fetch(nextUrl, {
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
    allTracks = allTracks.concat((data.items || []).map((entry) => entry?.track).filter(Boolean));
    nextUrl = data.next;
  }

  const playableTracks = allTracks.filter((track) => track?.uri);
  playlistTrackCache.set(cacheKey, {
    tracks: playableTracks,
    expiresAt: now + PLAYLIST_CACHE_TTL_MS,
  });

  return playableTracks;
}

async function getPlaylistQueueState(token) {
  const playlistId = process.env.SPOTIFY_PLAYLIST_ID;
  if (!playlistId) {
    throw new Error("No playlist configured. Set SPOTIFY_PLAYLIST_ID in your .env.local.");
  }

  const cacheKey = getPlaylistCacheKey(token, playlistId);
  const tracks = await loadPlayableTracks(token);
  let queueState = playlistQueueCache.get(cacheKey);

  if (!queueState || queueState.tracks.length !== tracks.length) {
    queueState = {
      tracks,
      queue: [],
    };
    playlistQueueCache.set(cacheKey, queueState);
  }

  if (queueState.queue.length < REFILL_THRESHOLD) {
    const freshTracks = shuffle(
      tracks.filter((track) => !queueState.queue.some((queuedTrack) => queuedTrack.uri === track.uri))
    );

    queueState.queue.push(...freshTracks.slice(0, PRELOAD_QUEUE_SIZE - queueState.queue.length));
  }

  return queueState;
}

async function warmPlaylistQueue(token) {
  if (!token) {
    return 0;
  }

  try {
    const queueState = await getPlaylistQueueState(token);
    return queueState.queue.length;
  } catch {
    return 0;
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

  await warmPlaylistQueue(session.accessToken);

  async function playRandomSong() {
    "use server";

    const currentSession = await auth();
    const token = currentSession?.accessToken;
    if (!token) {
      return { ok: false, error: "No access token found. Please sign in again." };
    }

    try {
      const queueState = await getPlaylistQueueState(token);

      if (!queueState.queue.length) {
        return { ok: false, error: "No playable tracks were found in this playlist." };
      }

      const randomIndex = Math.floor(Math.random() * queueState.queue.length);
      const [randomTrack] = queueState.queue.splice(randomIndex, 1);

      if (queueState.queue.length <= REFILL_THRESHOLD) {
        const freshQueue = shuffle(
          queueState.tracks.filter(
            (track) => !queueState.queue.some((queuedTrack) => queuedTrack.uri === track.uri)
          )
        );
        queueState.queue.push(...freshQueue.slice(0, PRELOAD_QUEUE_SIZE - queueState.queue.length));
      }

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
          name: randomTrack.name,
          artist: randomTrack.artists?.[0]?.name ?? "Unknown artist",
          year: randomTrack.album?.release_date ? randomTrack.album.release_date.slice(0, 4) : "----",
          uri: randomTrack.uri,
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
