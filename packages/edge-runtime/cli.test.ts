import { describe, expect, test } from "bun:test";
import packageMetadata from "./package.json";
import { edgeRuntimeVersionOutput, parseEdgeRuntimeCli } from "./cli";

describe("edge runtime CLI", () => {
  test("starts the service only when no command-line arguments are present", () => {
    expect(parseEdgeRuntimeCli([])).toEqual({ kind: "serve" });
  });

  test("reports the package version without selecting the server command", () => {
    expect(parseEdgeRuntimeCli(["--version"])).toEqual({
      kind: "version",
      output: `supacloud-edge-runtime ${packageMetadata.version}`,
    });
    expect(edgeRuntimeVersionOutput()).toContain(packageMetadata.version);
  });

  test("rejects unknown and mixed arguments", () => {
    expect(parseEdgeRuntimeCli(["--unknown"])).toEqual({
      kind: "error",
      message: "Unknown argument: --unknown",
    });
    expect(parseEdgeRuntimeCli(["--version", "--unknown"]).kind).toBe("error");
  });
});
