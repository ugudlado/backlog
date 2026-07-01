import type { CallToolResult } from "../types.ts";

/**
 * Base MCP error class for all MCP-related errors
 */
export class BacklogToolError extends Error {
	constructor(
		message: string,
		public code: string,
		public details?: unknown,
	) {
		super(message);
		this.name = "BacklogToolError";
	}
}

/**
 * Validation error for input validation failures
 */
export class McpValidationError extends BacklogToolError {
	constructor(message: string, validationError?: unknown) {
		super(message, "VALIDATION_ERROR", validationError);
	}
}

/**
 * Formats MCP errors into standardized tool responses
 */
function buildErrorResult(code: string, message: string, details?: unknown): CallToolResult {
	const includeDetails = !!process.env.DEBUG;
	const structured = details !== undefined ? { code, details } : { code };
	return {
		content: [
			{
				type: "text",
				text: formatErrorMarkdown(code, message, details, includeDetails),
			},
		],
		isError: true,
		structuredContent: structured,
	};
}

export function handleBacklogToolError(error: unknown): CallToolResult {
	if (error instanceof BacklogToolError) {
		return buildErrorResult(error.code, error.message, error.details);
	}

	console.error("Unexpected MCP error:", error);

	return {
		content: [
			{
				type: "text",
				text: formatErrorMarkdown("INTERNAL_ERROR", "An unexpected error occurred", error, !!process.env.DEBUG),
			},
		],
		isError: true,
		structuredContent: {
			code: "INTERNAL_ERROR",
			details: error,
		},
	};
}

/**
 * Format error messages in markdown for consistent MCP error responses
 */
function formatErrorMarkdown(code: string, message: string, details?: unknown, includeDetails = false): string {
	// Include details only when explicitly requested (e.g., debug mode)
	if (includeDetails && details) {
		let result = `${code}: ${message}`;

		const detailsText = typeof details === "string" ? details : JSON.stringify(details, null, 2);
		result += `\n  ${detailsText}`;

		return result;
	}

	return message;
}
