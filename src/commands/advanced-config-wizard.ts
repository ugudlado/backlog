import * as clack from "@clack/prompts";
import type { BacklogConfig } from "../types/index.ts";

interface PromptChoice {
	title: string;
	value: string | number | boolean;
	description?: string;
	disabled?: boolean;
}

interface PromptQuestion {
	type: "confirm" | "number" | "text" | "select" | "multiselect";
	name: string;
	message: string;
	hint?: string;
	initial?: string | number | boolean;
	min?: number;
	max?: number;
	choices?: PromptChoice[];
}

interface PromptOptions {
	onCancel?: () => void;
}

export type PromptRunner = (
	question: PromptQuestion | PromptQuestion[],
	options?: PromptOptions,
) => Promise<Record<string, unknown>>;

interface WizardOptions {
	existingConfig?: BacklogConfig | null;
	cancelMessage: string;
	includeClaudePrompt?: boolean;
	promptImpl?: PromptRunner;
}

export interface AdvancedConfigWizardResult {
	config: Partial<BacklogConfig>;
	installClaudeAgent: boolean;
}

type DefinitionOfDoneAction = "add" | "remove" | "reorder" | "clear" | "done";

function handlePromptCancel(message: string) {
	clack.cancel(message);
	process.exit(1);
}

function withHint(message: string, hint?: string): string {
	return hint ? `${message} (${hint})` : message;
}

function normalizeDefinitionOfDoneItems(items: string[] | undefined): string[] {
	return (items ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
}

function renderDefinitionOfDonePreview(items: string[]): string {
	if (items.length === 0) {
		return "Current defaults:\n  (none)";
	}
	return `Current defaults:\n${items.map((item, index) => `  ${index + 1}. ${item}`).join("\n")}`;
}

async function runSinglePrompt(question: PromptQuestion, options?: PromptOptions): Promise<Record<string, unknown>> {
	const onCancel = options?.onCancel;
	const message = withHint(question.message, question.hint);

	if (question.type === "confirm") {
		const result = await clack.confirm({
			message,
			initialValue: Boolean(question.initial ?? false),
		});
		if (clack.isCancel(result)) {
			onCancel?.();
			return {};
		}
		return { [question.name]: result };
	}

	if (question.type === "text") {
		const initialText = typeof question.initial === "string" ? question.initial : undefined;
		const result = await clack.text({
			message,
			initialValue: initialText,
		});
		if (clack.isCancel(result)) {
			onCancel?.();
			return {};
		}
		const normalized = String(result ?? "").trim();
		return { [question.name]: normalized };
	}

	if (question.type === "number") {
		const initialNumber = typeof question.initial === "number" ? question.initial : undefined;
		const result = await clack.text({
			message,
			initialValue: initialNumber !== undefined ? String(initialNumber) : undefined,
			validate: (value) => {
				const normalized = String(value ?? "").trim();
				if (!normalized) {
					// Allow Enter to keep the existing configured value when an initial value exists.
					if (initialNumber !== undefined) {
						return undefined;
					}
					return "Value is required.";
				}
				const parsed = Number(normalized);
				if (!Number.isFinite(parsed)) {
					return "Please enter a valid number.";
				}
				if (question.min !== undefined && parsed < question.min) {
					return `Value must be at least ${question.min}.`;
				}
				if (question.max !== undefined && parsed > question.max) {
					return `Value must be at most ${question.max}.`;
				}
				return undefined;
			},
		});
		if (clack.isCancel(result)) {
			onCancel?.();
			return {};
		}
		const normalized = String(result ?? "").trim();
		if (!normalized && initialNumber !== undefined) {
			return { [question.name]: initialNumber };
		}
		const parsed = Number(normalized);
		return { [question.name]: Number.isFinite(parsed) ? parsed : undefined };
	}

	if (question.type === "select") {
		const result = await clack.select({
			message,
			initialValue: question.initial,
			options: (question.choices ?? []).map((choice) => ({
				label: choice.title,
				value: choice.value,
				hint: choice.description,
				disabled: choice.disabled,
			})),
		});
		if (clack.isCancel(result)) {
			onCancel?.();
			return {};
		}
		return { [question.name]: result };
	}

	if (question.type === "multiselect") {
		const result = await clack.multiselect({
			message,
			required: false,
			options: (question.choices ?? []).map((choice) => ({
				label: choice.title,
				value: choice.value,
				hint: choice.description,
				disabled: choice.disabled,
			})),
		});
		if (clack.isCancel(result)) {
			onCancel?.();
			return {};
		}
		return { [question.name]: Array.isArray(result) ? result : [] };
	}

	return {};
}

const clackPromptRunner: PromptRunner = async (question, options) => {
	if (Array.isArray(question)) {
		const merged: Record<string, unknown> = {};
		let cancelled = false;
		for (const single of question) {
			const singleResult = await runSinglePrompt(single, {
				onCancel: () => {
					cancelled = true;
					options?.onCancel?.();
				},
			});
			Object.assign(merged, singleResult);
			if (cancelled) {
				break;
			}
		}
		return merged;
	}
	return runSinglePrompt(question, options);
};

export async function runAdvancedConfigWizard({
	existingConfig,
	cancelMessage,
	includeClaudePrompt = false,
	promptImpl = clackPromptRunner,
}: WizardOptions): Promise<AdvancedConfigWizardResult> {
	const onCancel = () => handlePromptCancel(cancelMessage);
	const config = existingConfig ?? null;

	let defaultPort = config?.defaultPort ?? 6420;
	let autoOpenBrowser = config?.autoOpenBrowser ?? true;
	let definitionOfDone = normalizeDefinitionOfDoneItems(config?.definitionOfDone);
	let installClaudeAgent = false;

	while (true) {
		const preview = renderDefinitionOfDonePreview(definitionOfDone);
		const definitionOfDonePrompt = await promptImpl(
			{
				type: "select",
				name: "definitionOfDoneAction",
				message: `Edit Definition of Done defaults\n\n${preview}\n\nChoose an action:`,
				initial: definitionOfDone.length > 0 ? "done" : "add",
				choices: [
					{
						title: "Add item",
						value: "add",
						description: "Append a new checklist item",
					},
					{
						title: "Remove item by index",
						value: "remove",
						description: "Delete one item from the list",
						disabled: definitionOfDone.length === 0,
					},
					{
						title: "Reorder items",
						value: "reorder",
						description: "Move an item to a different position",
						disabled: definitionOfDone.length < 2,
					},
					{
						title: "Clear all items",
						value: "clear",
						description: "Remove every default checklist item",
						disabled: definitionOfDone.length === 0,
					},
					{
						title: "Done",
						value: "done",
						description: "Keep these Definition of Done defaults",
					},
				],
			},
			{ onCancel },
		);

		const action = String(definitionOfDonePrompt.definitionOfDoneAction ?? "done") as DefinitionOfDoneAction;
		if (action === "done") {
			break;
		}

		if (action === "add") {
			let goBackToDefinitionOfDoneMenu = false;
			const addPrompt = await promptImpl(
				{
					type: "text",
					name: "definitionOfDoneItem",
					message: "New Definition of Done item:",
					hint: "Item is trimmed; empty input is ignored",
				},
				{
					onCancel: () => {
						goBackToDefinitionOfDoneMenu = true;
					},
				},
			);

			if (goBackToDefinitionOfDoneMenu) {
				continue;
			}

			const item = String(addPrompt.definitionOfDoneItem ?? "").trim();
			if (item.length > 0) {
				definitionOfDone = [...definitionOfDone, item];
			}
			continue;
		}

		if (action === "remove") {
			let goBackToDefinitionOfDoneMenu = false;
			const removePrompt = await promptImpl(
				{
					type: "number",
					name: "removeDefinitionOfDoneIndex",
					message: "Remove which item number?",
					hint: `Enter a value between 1 and ${definitionOfDone.length}`,
					initial: definitionOfDone.length,
					min: 1,
					max: definitionOfDone.length,
				},
				{
					onCancel: () => {
						goBackToDefinitionOfDoneMenu = true;
					},
				},
			);

			if (goBackToDefinitionOfDoneMenu) {
				continue;
			}

			const index = Number(removePrompt.removeDefinitionOfDoneIndex);
			if (Number.isInteger(index) && index >= 1 && index <= definitionOfDone.length) {
				definitionOfDone = definitionOfDone.filter((_, itemIndex) => itemIndex !== index - 1);
			}
			continue;
		}

		if (action === "reorder") {
			let goBackToDefinitionOfDoneMenu = false;
			const reorderPrompt = await promptImpl(
				[
					{
						type: "number",
						name: "moveFromIndex",
						message: "Move which item number?",
						hint: `Enter a value between 1 and ${definitionOfDone.length}`,
						initial: definitionOfDone.length,
						min: 1,
						max: definitionOfDone.length,
					},
					{
						type: "number",
						name: "moveToIndex",
						message: "Move to which position?",
						hint: `Enter a value between 1 and ${definitionOfDone.length}`,
						initial: 1,
						min: 1,
						max: definitionOfDone.length,
					},
				],
				{
					onCancel: () => {
						goBackToDefinitionOfDoneMenu = true;
					},
				},
			);

			if (goBackToDefinitionOfDoneMenu) {
				continue;
			}

			const fromIndex = Number(reorderPrompt.moveFromIndex);
			const toIndex = Number(reorderPrompt.moveToIndex);
			if (
				Number.isInteger(fromIndex) &&
				Number.isInteger(toIndex) &&
				fromIndex >= 1 &&
				fromIndex <= definitionOfDone.length &&
				toIndex >= 1 &&
				toIndex <= definitionOfDone.length &&
				fromIndex !== toIndex
			) {
				const reordered = [...definitionOfDone];
				const [moved] = reordered.splice(fromIndex - 1, 1);
				if (moved !== undefined) {
					reordered.splice(toIndex - 1, 0, moved);
					definitionOfDone = reordered;
				}
			}
			continue;
		}

		if (action === "clear") {
			let goBackToDefinitionOfDoneMenu = false;
			const clearPrompt = await promptImpl(
				{
					type: "confirm",
					name: "confirmClearDefinitionOfDone",
					message: "Clear all Definition of Done defaults?",
					initial: false,
				},
				{
					onCancel: () => {
						goBackToDefinitionOfDoneMenu = true;
					},
				},
			);

			if (goBackToDefinitionOfDoneMenu) {
				continue;
			}

			if (clearPrompt.confirmClearDefinitionOfDone) {
				definitionOfDone = [];
			}
		}
	}

	while (true) {
		const webUIPrompt = await promptImpl(
			{
				type: "confirm",
				name: "configureWebUI",
				message: "Configure web UI settings now?",
				hint: "Port and browser auto-open",
				initial: false,
			},
			{ onCancel },
		);

		if (!webUIPrompt.configureWebUI) {
			break;
		}

		let goBackToWebUIPrompt = false;
		const webUIValues = await promptImpl(
			[
				{
					type: "number",
					name: "defaultPort",
					message: "Default web UI port:",
					hint: "Port number for the web interface (1-65535)",
					initial: defaultPort,
					min: 1,
					max: 65535,
				},
				{
					type: "confirm",
					name: "autoOpenBrowser",
					message: "Automatically open browser when starting web UI?",
					hint: "When enabled, 'backlog web' opens your browser",
					initial: autoOpenBrowser,
				},
			],
			{
				onCancel: () => {
					goBackToWebUIPrompt = true;
				},
			},
		);

		if (goBackToWebUIPrompt) {
			continue;
		}

		if (typeof webUIValues?.defaultPort === "number" && !Number.isNaN(webUIValues.defaultPort)) {
			defaultPort = webUIValues.defaultPort;
		}
		autoOpenBrowser = Boolean(webUIValues?.autoOpenBrowser ?? autoOpenBrowser);
		break;
	}

	if (includeClaudePrompt) {
		const claudePrompt = await promptImpl(
			{
				type: "confirm",
				name: "installClaudeAgent",
				message: "Install Claude Code Backlog.md agent?",
				hint: "Adds configuration under .claude/agents/",
				initial: false,
			},
			{ onCancel },
		);
		installClaudeAgent = Boolean(claudePrompt?.installClaudeAgent);
	}

	return {
		config: {
			definitionOfDone,
			defaultPort,
			autoOpenBrowser,
		},
		installClaudeAgent,
	};
}
