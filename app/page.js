import { auth, signIn, signOut } from "../auth"; // Adjust path if necessary
import Dashboard from "./Dashboard";

const playlistTrackCache = new Map();
const playlistQueueCache = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getTrackFromPlaylistEntry(entry) {
  return entry?.item ?? entry?.track ?? entry;
}

function getSpotifyError(status, body, action) {
  if (status === 401) {
    return "Spotify session expired. Please sign out and sign in again.";
  }
  if (status === 403) {
    return "Spotify denied playback. A Premium account and playback permissions are required.";
  }
  if (status === 404) {
    return "No Spotify playback device was found. Open Spotify on a device and try again.";
  }
  if (status === 429) {
    return "Spotify is rate-limiting this app. Wait a bit and try again.";
  }

  let message = "";
  try {
    const details = JSON.parse(body);
    message = details.error?.message ?? details.error_description ?? "";
  } catch {
    message = body;
  }

  return `${action} failed (status ${status})${message ? `: ${message}` : "."}`;
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

async function startPlayback(token, uri) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const devicesRes = await fetch("https://api.spotify.com/v1/me/player/devices", {
    headers,
    cache: "no-store",
  });

  if (!devicesRes.ok) {
    return { ok: false, error: getSpotifyError(devicesRes.status, await devicesRes.text(), "Could not load Spotify devices") };
  }

  const { devices = [] } = await devicesRes.json();
  const device = devices.find((item) => item.is_active && !item.is_restricted)
    ?? devices.find((item) => !item.is_restricted);

  if (!device?.id) {
    return {
      ok: false,
      error: "No available Spotify device. Open the Spotify app or web player, sign in, then try again.",
    };
  }

  if (!device.is_active) {
    const transferRes = await fetch("https://api.spotify.com/v1/me/player", {
      method: "PUT",
      headers,
      body: JSON.stringify({ device_ids: [device.id], play: false }),
    });

    if (!transferRes.ok) {
      return {
        ok: false,
        error: getSpotifyError(transferRes.status, await transferRes.text(), "Could not activate the Spotify device"),
      };
    }

    let active = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(300);
      const currentDevicesRes = await fetch("https://api.spotify.com/v1/me/player/devices", {
        headers,
        cache: "no-store",
      });

      if (!currentDevicesRes.ok) {
        return {
          ok: false,
          error: getSpotifyError(currentDevicesRes.status, await currentDevicesRes.text(), "Could not check Spotify devices"),
        };
      }

      const { devices: currentDevices = [] } = await currentDevicesRes.json();
      if (currentDevices.some((item) => item.id === device.id && item.is_active)) {
        active = true;
        break;
      }
    }

    if (!active) {
      return {
        ok: false,
        error: `Spotify did not activate "${device.name}". Open Spotify on that device and try again.`,
      };
    }
  }

  const playRes = await fetch(
    `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(device.id)}`,
    {
    method: "PUT",
    headers,
    body: JSON.stringify({ uris: [uri] }),
    }
  );

  if (!playRes.ok) {
    return {
      ok: false,
      error: getSpotifyError(playRes.status, await playRes.text(), "Spotify could not start playback"),
    };
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(300);
    const stateRes = await fetch("https://api.spotify.com/v1/me/player", {
      headers,
      cache: "no-store",
    });

    if (stateRes.status === 204) continue;
    if (!stateRes.ok) {
      return {
        ok: false,
        error: getSpotifyError(stateRes.status, await stateRes.text(), "Could not verify Spotify playback"),
      };
    }

    const state = await stateRes.json();
    if ((state.item?.uri === uri || state.item?.linked_from?.uri === uri) && state.is_playing) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    error: `Spotify accepted the request but "${device.name}" is not reporting the selected song as playing. Check that device's volume and playback state.`,
  };
}

async function setPlaybackState(token, action) {
  const endpoint = action === "pause" ? "pause" : "play";
  try {
    const res = await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok) return { ok: true };
    return { ok: false, error: getSpotifyError(res.status, await res.text(), `Spotify could not ${action}`) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : `Could not ${action} Spotify playback.`,
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
      const selectedTrack = queue[randomIndex];

      if (!selectedTrack || !selectedTrack.uri) {
        return { ok: false, error: "No playable tracks were found in this playlist." };
      }

      const result = await startPlayback(token, selectedTrack.uri);
      if (!result.ok) return result;

      const remaining = queue.filter((_, index) => index !== randomIndex);
      playlistQueueCache.set(cacheKey, remaining);

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
    return setPlaybackState(token, "pause");
  }

  async function resumePlayback() {
    "use server";
    const currentSession = await auth();
    const token = currentSession?.accessToken;
    if (!token) return { ok: false, error: "No access token found." };
    return setPlaybackState(token, "resume");
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
