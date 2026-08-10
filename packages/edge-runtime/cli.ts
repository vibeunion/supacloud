import packageMetadata from "./package.json";

export type EdgeRuntimeCliCommand =
  | { kind: "serve" }
  | { kind: "version"; output: string }
  | { kind: "error"; message: string };

export function edgeRuntimeVersionOutput(): string {
  return `supacloud-edge-runtime ${packageMetadata.version}`;
}

export function parseEdgeRuntimeCli(args: readonly string[]): EdgeRuntimeCliCommand {
  if (args.length === 0) return { kind: "serve" };
  if (args.length === 1 && args[0] === "--version") {
    return { kind: "version", output: edgeRuntimeVersionOutput() };
  }
  return {
    kind: "error",
    message: `Unknown argument: ${args.join(" ")}`,
  };
}

export async function runEdgeRuntimeCli(args: readonly string[]): Promise<number> {
  const command = parseEdgeRuntimeCli(args);
  if (command.kind === "version") {
    console.log(command.output);
    return 0;
  }
  if (command.kind === "error") {
    console.error(command.message);
    return 2;
  }
  await import("./server");
  return 0;
}

if (import.meta.main) {
  const exitCode = await runEdgeRuntimeCli(Bun.argv.slice(2));
  if (exitCode !== 0) process.exit(exitCode);
}
