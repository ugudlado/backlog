/**
 * Global test setup — preloaded by bunfig.toml before every test file.
 *
 * Redirects BACKLOG_MACHINE_CONFIG_DIR to an isolated temp dir so no test can
 * read the developer's ~/.config/backlog/config.yml (including backlog_url).
 * Tests that need a specific layout use setupMachineConfig() from ./isolation.ts.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearMachineConfigCache } from "../utils/machine-config.ts";

const machineConfigDir = mkdtempSync(join(tmpdir(), "backlog-test-machine-config-"));
mkdirSync(machineConfigDir, { recursive: true });
writeFileSync(join(machineConfigDir, "config.yml"), "# isolated test machine config\n");

process.env.BACKLOG_MACHINE_CONFIG_DIR = machineConfigDir;
delete process.env.BACKLOG_URL;
delete process.env.BACKLOG_TOKEN;
clearMachineConfigCache();
