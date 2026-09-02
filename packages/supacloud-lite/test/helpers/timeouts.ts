/**
 * Windows CI runners boot PGlite (WASM) and spawn CLI subprocesses noticeably
 * slower than Linux/macOS. Apply a uniform multiplier to per-test budgets so
 * slow-but-correct runs don't fail Required Checks.
 */
export function testTimeout(ms: number): number {
  return process.platform === 'win32' ? ms * 3 : ms
}
