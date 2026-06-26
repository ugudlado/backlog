import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient, type ProjectsResponse } from "../lib/api";

function pathBasename(p: string): string {
	const parts = p.split(/[/\\]/).filter(Boolean);
	return parts[parts.length - 1] ?? p;
}

export interface ProjectSwitcherProps {
	onProjectSwitched: () => Promise<void>;
}

const ProjectSwitcher: React.FC<ProjectSwitcherProps> = ({ onProjectSwitched }) => {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [data, setData] = useState<ProjectsResponse | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// Full-screen overlay shown from the moment a switch is initiated until the
	// page reloads onto the new project (covers the otherwise blank gap).
	const [switching, setSwitching] = useState(false);
	const [addPath, setAddPath] = useState("");
	const [switchAfterAdd, setSwitchAfterAdd] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	const load = useCallback(async () => {
		try {
			setLoadError(null);
			setData(await apiClient.fetchProjects());
		} catch (e) {
			setLoadError(e instanceof Error ? e.message : "Failed to load projects");
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		if (open) {
			void load();
		}
	}, [open, load]);

	useEffect(() => {
		if (!open) {
			return;
		}
		const onDoc = (ev: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [open]);

	const sortedProjects = useMemo(
		() => (data ? [...data.projects].sort((a, b) => a.path.localeCompare(b.path)) : []),
		[data],
	);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) {
			return sortedProjects;
		}
		return sortedProjects.filter((w) => {
			const base = pathBasename(w.path).toLowerCase();
			return w.path.toLowerCase().includes(q) || base.includes(q);
		});
	}, [sortedProjects, query]);

	const currentProject = useMemo(
		() => data?.projects.find((w) => w.id === data.currentId) ?? null,
		[data],
	);
	const summaryLabel = currentProject ? pathBasename(currentProject.path) : "Select project";

	const handlePick = async (id: string) => {
		try {
			setBusy(true);
			setSwitching(true);
			setActionError(null);
			await apiClient.setCurrentProject(id);
			setOpen(false);
			setQuery("");
			await onProjectSwitched();
			await load();
		} catch (e) {
			setSwitching(false);
			setActionError(e instanceof Error ? e.message : "Could not switch project");
		} finally {
			setBusy(false);
		}
	};

	const handleRemove = async (id: string, displayName: string) => {
		if (!window.confirm(`Remove "${displayName}" from the registry?\n\nThe project files on disk are not deleted.`)) {
			return;
		}
		try {
			setBusy(true);
			setActionError(null);
			setData(await apiClient.deleteProject(id));
		} catch (e) {
			setActionError(e instanceof Error ? e.message : "Could not remove project");
		} finally {
			setBusy(false);
		}
	};

	const handleCreateProject = async () => {
		const trimmed = addPath.trim();
		if (!trimmed) {
			setActionError("Enter a project name.");
			return;
		}
		try {
			setBusy(true);
			setActionError(null);
			const updated = await apiClient.createProject(trimmed);
			setAddPath("");
			setData(updated);
			if (switchAfterAdd && updated.addedId) {
				setSwitching(true);
				await apiClient.setCurrentProject(updated.addedId);
				setOpen(false);
				setQuery("");
				await onProjectSwitched();
				await load();
			}
		} catch (e) {
			setSwitching(false);
			setActionError(e instanceof Error ? e.message : "Could not create project");
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			{switching && (
				<div
					className="fixed inset-0 z-[100] flex items-center justify-center bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm"
					role="status"
					aria-live="polite"
				>
					<div className="flex flex-col items-center gap-3">
						<div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600 dark:border-gray-600 dark:border-t-blue-400" />
						<div className="text-lg text-gray-600 dark:text-gray-300">Switching project…</div>
					</div>
				</div>
			)}
			<div className="relative" ref={rootRef}>
				<button
				type="button"
				disabled={busy}
				onClick={() => setOpen((o) => !o)}
				className="flex items-center gap-2 max-w-[14rem] sm:max-w-xs rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 px-3 py-1.5 text-left text-sm text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
				aria-expanded={open}
				aria-haspopup="listbox"
			>
				<span className="truncate font-medium">{summaryLabel}</span>
				<span className="text-gray-400 shrink-0" aria-hidden>
					▾
				</span>
			</button>
			{open && (
				<div className="absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 shadow-lg">
					<div className="p-2 border-b border-gray-100 dark:border-gray-800">
						<input
							type="search"
							placeholder="Search projects…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							className="w-full rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100"
						/>
					</div>
					{(loadError || actionError) && (
						<div className="px-3 py-2 text-xs text-red-600 dark:text-red-400 border-b border-gray-100 dark:border-gray-800">
							{loadError ?? actionError}
						</div>
					)}
					<ul className="max-h-56 overflow-y-auto py-1" role="listbox" aria-label="Projects">
						{filtered.length === 0 ? (
							<li className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">No matches.</li>
						) : (
							filtered.map((w) => {
								const active = w.id === data?.currentId;
								return (
									<li
										key={w.id}
										className={`group flex items-stretch ${active ? "bg-blue-50/80 dark:bg-blue-900/20" : "hover:bg-gray-100 dark:hover:bg-gray-800"}`}
									>
										<button
											type="button"
											disabled={busy || active}
											onClick={() => void handlePick(w.id)}
											className="flex min-w-0 flex-1 items-center px-3 py-2 text-left text-sm disabled:opacity-50"
										>
											<span className="font-medium text-gray-900 dark:text-gray-100 truncate w-full">
												{pathBasename(w.path)}
												{active ? " · current" : ""}
											</span>
										</button>
										{!active && (
											<button
												type="button"
												disabled={busy}
												onClick={() => void handleRemove(w.id, pathBasename(w.path))}
												title="Remove from registry"
												aria-label={`Remove ${pathBasename(w.path)} from registry`}
												className="shrink-0 px-2 text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
											>
												×
											</button>
										)}
									</li>
								);
							})
						)}
					</ul>
					<div className="border-t border-gray-100 dark:border-gray-800 p-2 space-y-2">
						<div className="flex gap-1">
							<input
								type="text"
								placeholder="New project name"
								value={addPath}
								onChange={(e) => setAddPath(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") void handleCreateProject();
								}}
								className="min-w-0 flex-1 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs text-gray-900 dark:text-gray-100"
							/>
							<button
								type="button"
								disabled={busy || !addPath.trim()}
								onClick={() => void handleCreateProject()}
								className="shrink-0 rounded-md border border-gray-300 dark:border-gray-600 px-2 py-1 text-xs font-medium text-gray-800 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
							>
								Create
							</button>
						</div>
						<label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
							<input
								type="checkbox"
								checked={switchAfterAdd}
								onChange={(e) => setSwitchAfterAdd(e.target.checked)}
								className="rounded border-gray-300 dark:border-gray-600"
							/>
							Switch to new project after create
						</label>
					</div>
				</div>
			)}
			</div>
		</>
	);
};

export default ProjectSwitcher;
