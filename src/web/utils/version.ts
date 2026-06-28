// Version utility for web UI
import { apiClient } from "../lib/api.ts";

export async function getWebVersion(): Promise<string> {
	try {
		return await apiClient.fetchVersion();
	} catch {
		// If API call fails, just return empty string - UI can decide what to show
		return "";
	}
}
