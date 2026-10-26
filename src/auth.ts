// Spotify login with PKCE — works on a static site, no server or secret needed.
// Same Spotify app (client id) as the original Krom FM; this address is added
// to its Redirect URIs. This version asks for more permissions than the earlier
// ones (writing a private playlist to keep his records, and playing a song in
// the browser), so it keeps its own login rather than sharing theirs.

export const CLIENT_ID = "6ec3c6f59ec14dcca495a904a268a67f";
export const REDIRECT_URI = window.location.origin + import.meta.env.BASE_URL;
const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private", // the "Krom FM data" playlist that holds his records
  "streaming", // playing a song in the browser (record over the next song)
  "user-read-email",
  "user-read-private"
].join(" ");

const K = {
  token: "djraf6_access_token", // shared with /djraf6/: already logged in there, no new redirect address needed
  expires: "djraf6_token_expires_at",
  refresh: "djraf6_refresh_token",
  verifier: "djraf6_code_verifier"
};

function randomString(len: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}

async function challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function login(): Promise<void> {
  const verifier = randomString(64);
  localStorage.setItem(K.verifier, verifier);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: await challenge(verifier)
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

function save(data: { access_token: string; expires_in?: number; refresh_token?: string }) {
  localStorage.setItem(K.token, data.access_token);
  localStorage.setItem(K.expires, String(Date.now() + (data.expires_in ?? 3600) * 1000));
  if (data.refresh_token) localStorage.setItem(K.refresh, data.refresh_token);
}

async function tokenRequest(body: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...body })
    });
    const data = await res.json();
    if (data.access_token) {
      save(data);
      return true;
    }
  } catch { /* network */ }
  return false;
}

// Called once on load: finishes the login if Spotify just sent us back here.
export async function handleRedirect(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return;
  await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: localStorage.getItem(K.verifier) ?? ""
  });
  window.history.replaceState({}, document.title, import.meta.env.BASE_URL);
}

export function isLoggedIn(): boolean {
  return !!localStorage.getItem(K.token);
}

let refreshing: Promise<boolean> | null = null;
export function refresh(): Promise<boolean> {
  const rt = localStorage.getItem(K.refresh);
  if (!rt) return Promise.resolve(false);
  refreshing ??= tokenRequest({ grant_type: "refresh_token", refresh_token: rt }).finally(() => { refreshing = null; });
  return refreshing;
}

export async function getToken(): Promise<string | null> {
  const token = localStorage.getItem(K.token);
  if (!token) return null;
  const expires = Number(localStorage.getItem(K.expires) ?? 0);
  if (Date.now() > expires - 60000 && !(await refresh())) return null;
  return localStorage.getItem(K.token);
}

export function logout(): void {
  Object.values(K).forEach(k => localStorage.removeItem(k));
}
