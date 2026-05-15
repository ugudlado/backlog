import * as clack from "@clack/prompts";

export type StoreMode = "global" | "local";

export interface StoreModeOptions {
	globalFlag: boolean;
	localFlag: boolean;
	globalStoreConfigured: boolean;
	isReInitialization: boolean;
	/** Override clack.select — used in tests. */
	selectFn?: (opts: {
		message: string;
		initialValue: string;
		options: { label: string; value: string; hint?: string }[];
	}) => Promise<string | symbol>;
	/** The globalStore path hint shown in the prompt. */
	globalStoreHint?: string;
}

/**
 * Resolves the store mode (global vs local) for `backlog init`.
 *
 * Returns:
 *  - `"global"` — use the configured globalStore slot.
 *  - `"local"` — force local `backlog/` in the repo.
 *  - `undefined` — no globalStore, behave as before (local by default).
 *  - `null` — user cancelled the prompt; caller should abort.
 */
export async function resolveStoreMode(opts: StoreModeOptions): Promise<StoreMode | undefined | null> {
	const { globalFlag, localFlag, globalStoreConfigured, isReInitialization, globalStoreHint } = opts;
	const select = opts.selectFn ?? clack.select;

	if (globalFlag) return "global";
	if (localFlag) return "local";

	if (!isReInitialization && globalStoreConfigured) {
		const choice = await select({
			message: "Where should this project's backlog be stored?",
			initialValue: "global",
			options: [
				{
					label: "Global store (recommended)",
					value: "global",
					hint: globalStoreHint ?? "",
				},
				{
					label: "Local (backlog/ in this repo)",
					value: "local",
					hint: "Commit backlog/ alongside your code",
				},
			],
		});

		if (clack.isCancel(choice)) return null;
		return choice as StoreMode;
	}

	return undefined;
}
