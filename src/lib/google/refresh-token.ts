export type RefreshedGoogleToken = {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
};

export async function refreshGoogleAccessToken(
  refreshToken: string,
  credentials: { clientId: string; clientSecret: string }
): Promise<RefreshedGoogleToken | null> {
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    return {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      refreshToken: data.refresh_token ?? refreshToken,
    };
  } catch {
    return null;
  }
}
