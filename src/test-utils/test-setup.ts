/**
 * Global test setup — preloaded by bunfig.toml before every test file.
 *
 * Redirects BACKLOG_MACHINE_CONFIG_DIR away from ~/.config/backlog so no test
 * can accidentally touch the real workspace registry. Tests that need a specific
 * layout use setupMachineConfig() from ./isolation.ts, which overrides this.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.BACKLOG_MACHINE_CONFIG_DIR) {
	process.env.BACKLOG_MACHINE_CONFIG_DIR = join(tmpdir(), "backlog-test-machine-config");
}
