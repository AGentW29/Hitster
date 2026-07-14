import NextAuth from "next-auth";
import Spotify from "next-auth/providers/spotify";

function normalizeAuthUrl(rawUrl: string | undefined) {
  if (!rawUrl) {
    return "https://hitster-alpha.vercel.app";
  }

  const cleaned = rawUrl.replace(/\/$/, "");
  return cleaned.includes("localhost") ? cleaned.replace("localhost", "127.0.0.1") : cleaned;
}

const authUrl = normalizeAuthUrl(process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "http://localhost:3000");
const redirectProxyUrl =
  process.env.AUTH_REDIRECT_PROXY_URL ?? `${authUrl}/api/auth`;
const authSecret =
  process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "dev-secret-change-me";
const spotifyClientId =
  process.env.AUTH_SPOTIFY_ID ?? process.env.SPOTIFY_CLIENT_ID ?? "";
const spotifyClientSecret =
  process.env.AUTH_SPOTIFY_SECRET ?? process.env.SPOTIFY_CLIENT_SECRET ?? "";
const isProduction = process.env.NODE_ENV === "production";

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  secret: authSecret,
  session: {
    strategy: "jwt",
  },
  cookies: {
    state: {
      name: `${isProduction ? "__Secure-" : ""}authjs.state`,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: isProduction,
      },
    },
    pkceCodeVerifier: {
      name: `${isProduction ? "__Secure-" : ""}authjs.pkce.code_verifier`,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: isProduction,
      },
    },
    callbackUrl: {
      name: `${isProduction ? "__Secure-" : ""}authjs.callback-url`,
      options: {
        sameSite: "lax",
        path: "/",
        secure: isProduction,
      },
    },
  },
  providers: [
    Spotify({
      clientId: spotifyClientId,
      clientSecret: spotifyClientSecret,
      authorization: {
        // We have to explicitly add this URL back in!
        url: "https://accounts.spotify.com/authorize", 
        params: {
          scope: "user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      // 1. Initial Sign-In
      if (account) {
        const expiresAt =
          typeof account.expires_at === "number"
            ? account.expires_at
            : typeof account.expires_at === "string"
              ? Number(account.expires_at)
              : typeof account.expires_in === "number"
                ? Math.floor(Date.now() / 1000 + account.expires_in)
                : undefined;

        return {
          ...token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token ?? token.refreshToken,
          expiresAt,
        };
      }

      // 2. Return previous token if the access token has not expired yet.
      if (typeof token.expiresAt === "number" && Date.now() < token.expiresAt * 1000) {
        return token;
      }

      // 3. Access token has expired, try to update it.
      const refreshToken = typeof token.refreshToken === "string" ? token.refreshToken : undefined;
      if (!refreshToken || !spotifyClientId || !spotifyClientSecret) {
        return { ...token, error: "RefreshAccessTokenError" };
      }

      try {
        const response = await fetch("https://accounts.spotify.com/api/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(`${spotifyClientId}:${spotifyClientSecret}`).toString("base64")}`,
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }),
        });

        const tokens = await response.json();

        if (!response.ok) throw tokens;

        return {
          ...token,
          accessToken: tokens.access_token,
          expiresAt: Math.floor(Date.now() / 1000 + tokens.expires_in),
          refreshToken: tokens.refresh_token ?? refreshToken,
        };
      } catch (error) {
        return { ...token, error: "RefreshAccessTokenError" };
      }
    },
    async session({ session, token }) {
      // Pass the access token and error state to the client/session
      (session as any).accessToken = token.accessToken;
      (session as any).error = token.error;
      return session;
    },
  },
});
