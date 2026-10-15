/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 NightShadess24 */

// The MyAnimeList login: tokens from the OAuth sign-in (settings), kept in the
// app's secure storage and renewed with the refresh token before they expire.

export const API = "https://api.myanimelist.net/v2";
export const AUTHORIZE_URL = "https://myanimelist.net/v1/oauth2/authorize";
export const TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";
// Paperback's MyAnimeList app (the one its 0.8 tracker signs in with)
export const CLIENT_ID = "004e72f9c4d8f5e6e8737d320246c0e3";
export const REDIRECT_URI = "paperback://malAuth";

const TOKEN_KEY = "mal-token";
const USER_KEY = "mal-user";
const DAY = 24 * 60 * 60;

export interface Token {
  access: string;
  refresh?: string;
  /** seconds since 1970 */
  expires: number;
}

export interface User {
  id?: number;
  name?: string;
  picture?: string;
}

const now = () => Math.floor(Date.now() / 1000);

export function getToken(): Token | undefined {
  const token = Application.getSecureState(TOKEN_KEY) as Token | null | undefined;
  return token && typeof token.access === "string" ? token : undefined;
}

export function setToken(token: Token | undefined): void {
  Application.setSecureState(token ?? null, TOKEN_KEY);
}

export function getUser(): User | undefined {
  return (Application.getState(USER_KEY) as User | null | undefined) ?? undefined;
}

export function setUser(user: User | undefined): void {
  Application.setState(user ?? null, USER_KEY);
}

export const isLoggedIn = () => getToken() !== undefined;

const isJwt = (value: string | undefined) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(value ?? "");

/** When a JWT expires (seconds since 1970), if it says. */
function expiryOf(jwt: string): number | undefined {
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Application.base64Decode(part + "=".repeat((4 - (part.length % 4)) % 4));
    const payload = JSON.parse(
      typeof decoded === "string" ? decoded : Application.arrayBufferToUTF8String(decoded),
    ) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

/** Tokens from the sign-in. The access token is the JWT one, whichever order they come in. */
export function tokensFromLogin(first: string, second: string): Token {
  const [access, refresh] = isJwt(first) || !isJwt(second) ? [first, second] : [second, first];
  return { access, refresh: refresh || undefined, expires: expiryOf(access) ?? now() + 30 * DAY };
}

function formBody(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

async function renew(token: Token): Promise<Token | undefined> {
  if (!token.refresh) return token;
  const [response, data] = await Application.scheduleRequest({
    url: TOKEN_URL,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({
      grant_type: "refresh_token",
      refresh_token: token.refresh,
      client_id: CLIENT_ID,
    }),
  });
  if (response.status === 400 || response.status === 401) {
    // The sign-in was revoked or ran out: sign in again in the settings.
    setToken(undefined);
    setUser(undefined);
    return undefined;
  }
  if (response.status >= 400) return token;
  const json = JSON.parse(Application.arrayBufferToUTF8String(data)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) return token;
  const renewed: Token = {
    access: json.access_token,
    refresh: json.refresh_token ?? token.refresh,
    expires: json.expires_in
      ? now() + json.expires_in
      : (expiryOf(json.access_token) ?? now() + 30 * DAY),
  };
  setToken(renewed);
  return renewed;
}

/** A current access token (renewed if it runs out within a day), or undefined when signed out. */
export async function accessToken(): Promise<string | undefined> {
  let token = getToken();
  if (token && token.expires - DAY < now()) token = await renew(token);
  return token?.access;
}

export { formBody };
