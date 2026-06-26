import React, { useState } from "react";
import { apiClient } from "../lib/api";

interface EmptyRegistryScreenProps {
	onWorkspaceAdded: () => Promise<void> | void;
}

const EmptyRegistryScreen: React.FC<EmptyRegistryScreenProps> = ({ onWorkspaceAdded }) => {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) {
			setError("Enter a project name.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const updated = await apiClient.createProject(trimmed);
			if (updated.addedId) {
				await apiClient.setCurrentWorkspace(updated.addedId);
			}
			setName("");
			await onWorkspaceAdded();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not create project");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900 px-4">
			<div className="w-full max-w-xl bg-white dark:bg-gray-800 rounded-lg shadow-md p-8 space-y-6">
				<header className="space-y-2">
					<h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">No Backlog.md projects yet</h1>
					<p className="text-sm text-gray-600 dark:text-gray-300">
						Create a project below — its tasks are stored in the configured global store. You can also run{" "}
						<code className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded">
							backlog init &lt;name&gt;
						</code>{" "}
						in a terminal.
					</p>
				</header>

				<form onSubmit={handleSubmit} className="space-y-3">
					<label htmlFor="empty-registry-name" className="block text-sm font-medium text-gray-700 dark:text-gray-200">
						Project name
					</label>
					<input
						id="empty-registry-name"
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="My Project"
						className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
						disabled={busy}
						autoFocus
					/>
					{error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
					<button
						type="submit"
						disabled={busy || !name.trim()}
						className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
					>
						{busy ? "Creating…" : "Create project"}
					</button>
				</form>
			</div>
		</div>
	);
};

export default EmptyRegistryScreen;
