// Makes sure the phone is always running the latest deploy. The build gives
// every JS/CSS file a unique name, and version.json (fetched with the cache
// switched off) tells an already-open copy of the app that a newer build exists.
// Checked on load and whenever the app comes back to the foreground — a
// home-screen app on Android resumes without reloading — but never mid-show.

declare const __BUILD_ID__: string;
export const BUILD_ID = __BUILD_ID__;

export async function checkForUpdate(isBusy: () => boolean): Promise<void> {
  if (import.meta.env.DEV) return;
  if (new URLSearchParams(location.search).has("code")) return; // finishing Spotify login
  if (isBusy()) return;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.json`, { cache: "no-store" });
    if (!res.ok) return;
    const { build } = await res.json();
    if (build && build !== BUILD_ID && !isBusy()) {
      const url = new URL(location.href);
      url.searchParams.set("v", build);
      location.replace(url.toString());
    }
  } catch { /* offline — keep running what we have */ }
}

export function watchForUpdates(isBusy: () => boolean): void {
  void checkForUpdate(isBusy);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForUpdate(isBusy);
  });
}
