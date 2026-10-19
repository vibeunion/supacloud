const timeout = process.platform === "win32" ? 60_000 : 20_000
const result = Bun.spawnSync(["bun", "test", `--timeout=${timeout}`, ...Bun.argv.slice(2)], {
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(result.exitCode ?? 1)
