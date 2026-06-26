import type { ScreenInterface } from "neo-neo-bblessed";
import { type GlobalStoreProject, scanGlobalStoreProjects } from "../utils/global-store-scan.ts";
import { openSingleSelectFilterPopup } from "./components/filter-popup.ts";

/**
 * Prompt the user to switch to another global-store project from inside a TUI.
 *
 * Returns the chosen project, or null when the user cancels or there is nothing
 * to switch to (zero or one global-store project). Mirrors the web
 * ProjectSwitcher: only global-store projects are switchable.
 */
export async function pickProject(screen: ScreenInterface): Promise<GlobalStoreProject | null> {
	const projects = await scanGlobalStoreProjects();
	if (projects.length <= 1) return null;

	const choices = projects.map((project) => ({ label: project.name, value: project.id }));
	const selectedId = await openSingleSelectFilterPopup({
		screen,
		title: "Switch Project",
		choices,
		selectedValue: "",
		helpText: " {cyan-fg}[↑↓]{/} Navigate | {cyan-fg}[Enter]{/} Switch | {cyan-fg}[Esc]{/} Cancel",
	});
	if (!selectedId) return null;
	return projects.find((project) => project.id === selectedId) ?? null;
}
