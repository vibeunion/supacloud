import { spawnSync } from "node:child_process";

type Check = {
  name: string;
  args: string[];
};

const checks: Check[] = [
  { name: "architecture", args: ["run", "check:architecture"] },
  { name: "type-safety", args: ["run", "check:type-safety"] },
  { name: "business-invariants", args: ["run", "check:invariants"] },
  { name: "public-api", args: ["run", "scripts/check_public_api.ts"] },
];

let failed = false;
for (const check of checks) {
  console.log(`\n[vibecoding:${check.name}]`);
  const result = spawnSync("bun", check.args, {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  if (result.error || result.status !== 0) {
    failed = true;
    console.error(`[vibecoding:${check.name}] failed`);
    break;
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("\n✔ Vibe Coding architecture and contract gates passed.");
}
