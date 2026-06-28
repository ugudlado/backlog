// Single source of truth for the web UI's API token.
// Stored in localStorage; attached as a Bearer header (HTTP) or ?token= param (WebSocket).
const KEY = "backlog_token";

export function getToken(): string {
	try {
		return localStorage.getItem(KEY) ?? "";
	} catch {
		return "";
	}
}

export function setToken(token: string): void {
	try {
		localStorage.setItem(KEY, token);
	} catch {
		// localStorage unavailable (private mode / disabled) — token won't persist.
	}
}

export function clearToken(): void {
	try {
		localStorage.removeItem(KEY);
	} catch {
		// no-op
	}
}
