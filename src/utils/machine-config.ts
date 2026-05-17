/**
 * Machine config compatibility shim.
 *
 * The `globalStore` machine-config field was removed by the
 * workspace-resolution-simplification change. The machine `config.yml` now
 * holds only `current: <name>` (read via `workspace-store.ts`), and the new
 * resolver reads files fresh every call — there is no cache to clear.
 *
 * `clearMachineConfigCache()` is kept as a no-op so the many test
 * setup/teardown sites that call it keep working without churn.
 */
export function clearMachineConfigCache(): void {
	// No-op: the per-repo workspace resolver is cache-free.
}
