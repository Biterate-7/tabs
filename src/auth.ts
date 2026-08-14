import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { refreshGoogleAccessToken } from "@/lib/google/refresh-token";

const DRIVE_METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
const REFRESH_SKEW_MS = 60_000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          scope: `openid email profile ${DRIVE_METADATA_SCOPE}`,
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at ? account.expires_at * 1000 : 0;
        token.error = undefined;
        return token;
      }

      if (typeof token.expiresAt === "number" && Date.now() < token.expiresAt - REFRESH_SKEW_MS) {
        return token;
      }

      if (typeof token.refreshToken !== "string") {
        return { ...token, error: "RefreshAccessTokenError" };
      }

      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return { ...token, error: "RefreshAccessTokenError" };
      }

      const refreshed = await refreshGoogleAccessToken(token.refreshToken, { clientId, clientSecret });
      if (!refreshed) {
        return { ...token, error: "RefreshAccessTokenError" };
      }

      return {
        ...token,
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
        refreshToken: refreshed.refreshToken,
        error: undefined,
      };
    },
    async session({ session, token }) {
      // Deliberately do NOT attach accessToken/refreshToken here. Auth.js
      // reuses this callback's return value for both the server-only
      // auth() helper AND the public GET /api/auth/session endpoint that
      // next-auth/react's useSession() polls from the browser — anything
      // added to `session` here is sent to client-side JS. The Drive
      // metadata Route Handler (Task 8) reads the access token separately
      // via getToken() from next-auth/jwt, which decodes the encrypted
      // session cookie server-side without touching this callback.
      session.error = token.error === "RefreshAccessTokenError" ? "RefreshAccessTokenError" : undefined;
      return session;
    },
  },
});
