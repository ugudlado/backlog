import { useState } from "react";
import { setToken } from "../lib/auth.ts";

// Shown when no valid token is stored. Validates the typed token against the
// server (a cheap authed GET) before saving it and reloading into the app.
export function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
	const [value, setValue] = useState("");
	const [error, setError] = useState("");
	const [checking, setChecking] = useState(false);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		const token = value.trim();
		if (!token) return;
		setChecking(true);
		setError("");
		try {
			const res = await fetch("/api/config", { headers: { Authorization: `Bearer ${token}` } });
			if (res.status === 401) {
				setError("Invalid token.");
				return;
			}
			if (!res.ok) {
				setError(`Server error (${res.status}). Try again.`);
				return;
			}
			setToken(token);
			onAuthenticated();
		} catch {
			setError("Could not reach the server.");
		} finally {
			setChecking(false);
		}
	};

	return (
		<div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: 16 }}>
			<form
				onSubmit={submit}
				style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 320 }}
			>
				<h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Backlog.md</h1>
				<label htmlFor="token" style={{ fontSize: 13 }}>
					Access token
				</label>
				<input
					id="token"
					type="password"
					autoFocus
					value={value}
					onChange={(e) => setValue(e.target.value)}
					placeholder="Paste your token"
					style={{ padding: "8px 10px", border: "1px solid #ccc", borderRadius: 6, fontSize: 14 }}
				/>
				{error && <div style={{ color: "#c00", fontSize: 13 }}>{error}</div>}
				<button
					type="submit"
					disabled={checking || !value.trim()}
					style={{ padding: "8px 10px", borderRadius: 6, fontSize: 14, cursor: "pointer" }}
				>
					{checking ? "Checking…" : "Continue"}
				</button>
			</form>
		</div>
	);
}
