import React, { useState } from "react";
import { apiClient } from "../lib/api";

interface EmptyRegistryScreenProps {
	onWorkspaceAdded: () => Promise<void> | void;
}

const EmptyRegistryScreen: React.FC<EmptyRegistryScreenProps> = ({ onWorkspaceAdded }) => {
	const [path, setPath] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const trimmed = path.trim();
		if (!trimmed) {
			setError("Enter an absolute path to a directory that already contains a Backlog.md project (a `backlog/` folder).");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const updated = await apiClient.addWorkspace(trimmed);
			if (updated.addedId) {
				await apiClient.setCurrentWorkspace(updated.addedId);
			}
			setPath("");
			await onWorkspaceAdded();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not add workspace");
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
						Backlog.md tracks projects in a machine-wide registry. Add an existing project below, or run one of these
						commands in a terminal:
					</p>
					<ul className="text-sm text-gray-600 dark:text-gray-300 space-y-1 pl-4 list-disc">
						<li>
							<code className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded">backlog init</code>{" "}
							inside a project directory
						</li>
						<li>
							<code className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded">
								backlog workspace add &lt;path&gt;
							</code>{" "}
							for an existing project
						</li>
					</ul>
				</header>

				<form onSubmit={handleSubmit} className="space-y-3">
					<label htmlFor="empty-registry-path" className="block text-sm font-medium text-gray-700 dark:text-gray-200">
						Absolute path to a project that contains a <code>backlog/</code> folder
					</label>
					<input
						id="empty-registry-path"
						type="text"
						value={path}
						onChange={(e) => setPath(e.target.value)}
						placeholder="/Users/you/code/your-project"
						className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
						disabled={busy}
						autoFocus
					/>
					{error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
					<button
						type="submit"
						disabled={busy || !path.trim()}
						className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
					>
						{busy ? "Adding…" : "Add project"}
					</button>
				</form>
			</div>
		</div>
	);
};

export default EmptyRegistryScreen;
