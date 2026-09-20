// API base URL for the sidecar server (used in static export mode)
// Exported as let so Tauri runtime can update it after port discovery
//
// Runtime override: a page can define `window.__REXADB_API_BASE__` BEFORE this
// module loads (the Docker gateway injects such a script) to point API calls
// at another base. The empty string means same-origin — used when a single
// port serves both the static export and proxies /api to the sidecar.
declare global {
  interface Window {
    __REXADB_API_BASE__?: string;
  }
}
const runtimeBase =
  typeof window !== "undefined" && typeof window.__REXADB_API_BASE__ === "string"
    ? window.__REXADB_API_BASE__
    : null;
export let API_BASE = runtimeBase !== null ? runtimeBase : `http://127.0.0.1:3867`;

/** Call once at app startup to discover actual sidecar port from Tauri */
export async function initApiBase(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const url = await invoke<string>('get_api_base_url');
    if (url) API_BASE = url;
  } catch {
    // not running inside Tauri; keep default
  }
}

// Wrapper that routes API calls through the Express sidecar instead of same-origin.
// Use this instead of raw fetch("/api/...") so calls work in static export AND dev mode.
export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const resolved = url.startsWith("http") ? url : `${API_BASE}${url}`;
  return fetch(resolved, init);
}
