import type { JsonSchema } from "../../validation/validators.ts";

export const workspaceListSchema: JsonSchema = {
	type: "object",
	properties: {},
	additionalProperties: false,
};

export const workspaceSwitchSchema: JsonSchema = {
	type: "object",
	required: ["id"],
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 200,
		},
	},
	additionalProperties: false,
};
