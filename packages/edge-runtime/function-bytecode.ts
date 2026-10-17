import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readFunctionFile } from "./trusted-function-files";
import { init as initModuleLexer, parse as parseModuleImports } from "es-module-lexer";
import { functionBytecodeMode, type FunctionBytecodeMode, type FunctionBytecodeArtifact } from "./function-bytecode-contract";

type CacheRequest = {
  functionPath: string;
  projectRoot: string;
  artifactSha256?: string;
  bytecode?: FunctionBytecodeMode;
};

const BUILD_ID = JSON.stringify({
  schema: 2, macros: false, bun: Bun.version, revision: Bun.revision,
  platform: process.platform, arch: process.arch, format: "cjs", env: "disable",
});
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;
const SHA256 = /^[a-f0-9]{64}$/;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Host-only derived cache. Never import this module into a tenant Worker:
 * builds must run before tenant environment injection and API restrictions.
 */
export class FunctionBytecodeCache {
  private entries = new Map<string, FunctionBytecodeArtifact>();
  private pending = new Map<string, Promise<FunctionBytecodeArtifact>>();
  private directories = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private bytes = 0;
  private closed = false;
  readonly metrics = { builds: 0, hits: 0, fallbacks: 0, failures: 0, build_ms: 0 };

  private key(request: CacheRequest): string {
    return JSON.stringify([resolve(request.projectRoot), resolve(request.functionPath), request.artifactSha256, BUILD_ID]);
  }

  /** Request handling only looks up a prepared artifact; it never builds. */
  lookup(request: CacheRequest): FunctionBytecodeArtifact | undefined {
    const mode = functionBytecodeMode(request.bytecode);
    if (mode === "off") return undefined;
    const artifact = this.closed ? undefined : this.entries.get(this.key(request));
    if (artifact) {
      this.metrics.hits++;
      return artifact;
    }
    if (mode === "required") throw new Error("Required Function bytecode is not prepared; preheat this runtime first");
    this.metrics.fallbacks++;
    return undefined;
  }

  /** Called only by the host preheat control path. JS remains the release authority. */
  async prepare(request: CacheRequest): Promise<FunctionBytecodeArtifact | undefined> {
    const mode = functionBytecodeMode(request.bytecode);
    if (mode === "off") return undefined;
    try {
      if (this.closed) throw new Error("Function bytecode cache is closed");
      const key = this.key(request);
      const cached = this.entries.get(key);
      if (cached) {
        this.metrics.hits++;
        return cached;
      }
      let pending = this.pending.get(key);
      if (!pending) {
        if (this.entries.size + this.pending.size >= MAX_CACHE_ENTRIES) {
          throw new Error("Function bytecode cache entry budget exhausted");
        }
        pending = this.tail.then(() => this.build(request));
        this.tail = pending.catch(() => undefined);
        this.pending.set(key, pending);
      }
      try {
        const artifact = await pending;
        this.entries.set(key, artifact);
        return artifact;
      } finally {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      }
    } catch {
      this.metrics.failures++;
      if (mode === "required") {
        throw new Error("Required Function bytecode preparation failed");
      }
      this.metrics.fallbacks++;
      return undefined;
    }
  }

  private async build(request: CacheRequest): Promise<FunctionBytecodeArtifact> {
    const start = performance.now();
    if (!request.artifactSha256 || !SHA256.test(request.artifactSha256)) {
      throw new Error("Function bytecode requires an attested source");
    }
    const relativePath = relative(resolve(request.projectRoot), resolve(request.functionPath));
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error("Function bytecode source must be inside its project");
    }
    const source = await readFunctionFile(request.functionPath, MAX_SOURCE_BYTES);
    if (source.sha256 !== request.artifactSha256 || source.bytes.length > MAX_SOURCE_BYTES) {
      throw new Error("Function bytecode source digest or size is invalid");
    }
    const text = source.bytes.toString("utf8");
    await initModuleLexer();
    const [moduleImports] = parseModuleImports(text);
    // Parsing/scanning never evaluates tenant code. Do not transform source here:
    // Bun transforms may execute macro imports before sandbox restrictions apply.
    const imports = new Bun.Transpiler({ loader: "js" }).scanImports(text);
    if (moduleImports.some(entry => entry.type === "dynamic" && entry.specifier === undefined)
      || imports.some(entry => !entry.path.startsWith("node:") && !entry.path.startsWith("bun:"))) {
      throw new Error("Function bytecode requires a self-contained bundle");
    }
    // Decode escaped identifiers without invoking a compiler transform. The lexer
    // recognizes import.meta even with comments around the member access.
    const decoded = text.replace(/\\u\{([a-f0-9]+)\}|\\u([a-f0-9]{4})/gi,
      (_match, codePoint: string | undefined, codeUnit: string | undefined) =>
        String.fromCodePoint(parseInt(codePoint ?? codeUnit!, 16)));
    if (moduleImports.some(entry => entry.type === "import-meta")
      || /\b__(?:dirname|filename)\b/.test(decoded)) {
      throw new Error("Path-sensitive Function bytecode is not supported");
    }
    if (this.bytes >= MAX_CACHE_BYTES) throw new Error("Function bytecode cache byte budget exhausted");
    // Random, private, per-process directories: never reuse a tenant-supplied .jsc.
    const directory = await mkdtemp(join(resolve(request.projectRoot), ".supacloud-bytecode-"));
    this.directories.add(directory);
    try {
      const input = join(directory, "source.js");
      await writeFile(input, source.bytes, { mode: 0o600, flag: "wx" });
      const buildDirectory = join(directory, "build");
      // Bun 1.4 supports this option, but its shipped BuildConfig types omit it.
      const buildOptions: Parameters<typeof Bun.build>[0] & { macros: false } = {
        macros: false,
        entrypoints: [input], outdir: buildDirectory, naming: "index.js",
        target: "bun", format: "cjs", bytecode: true, env: "disable",
        packages: "external",
      };
      const result = await Bun.build(buildOptions);
      if (!result.success) throw new Error("Function bytecode build failed");
      const js = result.outputs.find(output => output.kind === "entry-point");
      const jsc = result.outputs.find(output => output.kind === "bytecode");
      if (!js || !jsc) throw new Error("Function bytecode build did not produce a pair");
      const jsBytes = new Uint8Array(await js.arrayBuffer());
      const jscBytes = new Uint8Array(await jsc.arrayBuffer());
      const size = jsBytes.length + jscBytes.length;
      if (size === 0 || this.bytes + size > MAX_CACHE_BYTES) {
        throw new Error("Function bytecode cache byte budget exhausted");
      }
      const output = join(directory, "index.js");
      await writeFile(output, jsBytes, { mode: 0o400, flag: "wx" });
      await writeFile(`${output}.jsc`, jscBytes, { mode: 0o400, flag: "wx" });
      await rm(input);
      await rm(buildDirectory, { recursive: true, force: true });
      await chmod(directory, 0o500);
      this.bytes += size;
      this.metrics.builds++;
      return Object.freeze({
        sourceSha256: source.sha256, path: output,
        sha256: hash(jsBytes), bytecodeSha256: hash(jscBytes),
      });
    } catch (error) {
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
      this.directories.delete(directory);
      throw error;
    } finally {
      this.metrics.build_ms += performance.now() - start;
    }
  }

  /** Call after both Worker pools have drained. */
  async dispose(): Promise<void> {
    this.closed = true;
    await this.tail;
    for (const directory of this.directories) {
      try {
        await chmod(directory, 0o700);
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    this.directories.clear();
    this.entries.clear();
  }
}

export const functionBytecodeCache = new FunctionBytecodeCache();
