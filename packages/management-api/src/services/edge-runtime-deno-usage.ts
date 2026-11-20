/**
 * Deploy-time guard for the removed Deno compatibility layer.
 *
 * Function sources are scanned before they are written or bundled. A source
 * that still calls `Deno.serve()` / `Deno.env` / `import "https://deno.land/..."`
 * used to load and then fail on the first request, far from the author's edit.
 * Rejecting it at deploy time keeps the failure where the fix is obvious.
 */

type SourceMaskOptions = {
  /** Mask string and template literals as well as comments. */
  maskStrings: boolean;
};

const MASKABLE_MODES = {
  lineComment: "lineComment",
  blockComment: "blockComment",
  single: "single",
  double: "double",
  template: "template",
} as const;

type ScanMode = "code" | (typeof MASKABLE_MODES)[keyof typeof MASKABLE_MODES];

/**
 * Replace comments (and, optionally, string and template literals) with spaces
 * while keeping line breaks and offsets stable. Text inside `${...}` stays code.
 * This is deliberately a lexer, not a parser: function sources may be
 * TypeScript, which `acorn` cannot read, and a syntax error must not disable
 * the guard.
 */
function maskedSource(code: string, options: SourceMaskOptions): string {
  const masked: string[] = new Array(code.length);
  const interpolationDepths: number[] = [];
  let mode: ScanMode = "code";

  const keep = (index: number, value: string) => {
    masked[index] = value;
  };
  const mask = (index: number) => {
    keep(index, code.charAt(index) === "\n" ? "\n" : " ");
  };
  const keepOrMask = (index: number, shouldMask: boolean) => {
    if (shouldMask) mask(index);
    else keep(index, code.charAt(index));
  };

  for (let index = 0; index < code.length; index += 1) {
    const character = code.charAt(index);
    const next = code.charAt(index + 1);
    const maskStrings = options.maskStrings;

    if (mode === "lineComment") {
      if (character === "\n") mode = "code";
      keepOrMask(index, true);
      continue;
    }
    if (mode === "blockComment") {
      if (character === "*" && next === "/") {
        keep(index, " ");
        keep(index + 1, " ");
        index += 1;
        mode = "code";
        continue;
      }
      keepOrMask(index, true);
      continue;
    }
    if (mode === "single" || mode === "double" || mode === "template") {
      if (character === "\\") {
        keepOrMask(index, maskStrings);
        keepOrMask(index + 1, maskStrings);
        index += 1;
        continue;
      }
      if (
        (mode === "single" && character === "'")
        || (mode === "double" && character === '"')
        || (mode === "template" && character === "`")
      ) {
        keepOrMask(index, maskStrings);
        mode = "code";
        continue;
      }
      if (mode === "template" && character === "$" && next === "{") {
        keepOrMask(index, maskStrings);
        keepOrMask(index + 1, maskStrings);
        interpolationDepths.push(0);
        index += 1;
        mode = "code";
        continue;
      }
      keepOrMask(index, maskStrings);
      continue;
    }

    if (character === "/" && next === "/") {
      keep(index, " ");
      keep(index + 1, " ");
      index += 1;
      mode = "lineComment";
      continue;
    }
    if (character === "/" && next === "*") {
      keep(index, " ");
      keep(index + 1, " ");
      index += 1;
      mode = "blockComment";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      if (maskStrings) keep(index, " ");
      else keep(index, character);
      mode = character === "'" ? "single" : character === '"' ? "double" : "template";
      continue;
    }
    if (interpolationDepths.length > 0) {
      const depthIndex = interpolationDepths.length - 1;
      const depth = interpolationDepths[depthIndex] ?? 0;
      if (character === "{") {
        interpolationDepths[depthIndex] = depth + 1;
      } else if (character === "}") {
        if (depth === 0) {
          interpolationDepths.pop();
          if (maskStrings) keep(index, " ");
          else keep(index, character);
          mode = "template";
          continue;
        }
        interpolationDepths[depthIndex] = depth - 1;
      }
    }
    keep(index, character);
  }
  return masked.join("");
}

function lineAt(code: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (code.charAt(cursor) === "\n") line += 1;
  }
  return line;
}

export type DenoRuntimeUsage = {
  api: string;
  line: number;
  guidance: string;
};

const DENO_API_RULES: ReadonlyArray<{
  pattern: RegExp;
  api: string;
  guidance: string;
}> = [
  {
    pattern: /\bDeno\s*\.\s*serve\b/g,
    api: "Deno.serve()",
    guidance: "export a default handler instead: `export default (request, ctx) => new Response(...)`",
  },
  {
    pattern: /\bDeno\s*\.\s*env\b/g,
    api: "Deno.env",
    guidance: "read secrets from the handler's second argument (`ctx.env`) or from `process.env`",
  },
  {
    pattern: new RegExp(
      String.raw`\bDeno\s*\.\s*(?:readTextFile|readTextFileSync|readFile|readFileSync|`
      + String.raw`writeTextFile|writeTextFileSync|writeFile|writeFileSync|stat|statSync|lstat|`
      + String.raw`readDir|readDirSync|mkdir|mkdirSync|remove|removeSync|rename|copyFile|open|`
      + String.raw`create|chmod|chown|truncate)\b`,
      "g",
    ),
    api: "Deno file APIs",
    guidance: "use `Bun.file()` or `node:fs/promises`; tenant filesystem access stays project-scoped",
  },
  {
    pattern: new RegExp(
      String.raw`\bDeno\s*\.\s*(?:Command|run|spawn|openKv|listen|connect|upgradeWebSocket|exit|`
      + String.raw`close|cwd|chdir|pid|args|hostname|networkInterfaces|build|version|permissions|`
      + String.raw`inspect|errors)\b`,
      "g",
    ),
    api: "Deno runtime APIs",
    guidance: "use the Bun/Node equivalents; subprocess execution is blocked for tenant functions",
  },
];

// Module specifiers are strings, so this pattern runs against comment-free code
// instead of the fully masked source. It requires an import keyword, which keeps
// prose in a doc comment from tripping the guard.
const DENO_MODULE_IMPORT_RULE = {
  pattern: new RegExp(
    String.raw`\b(?:import|from|require)\s*\(?\s*["'](?:https?:\/\/deno\.land\/[^"'\n]*|jsr:[^"'\n]*)["']`,
    "g",
  ),
  api: "Deno/JSR module imports",
  guidance: "install the dependency and import it from npm (`npm:package@version`)",
};

export function findDenoRuntimeUsage(code: string): DenoRuntimeUsage[] {
  const codeOnly = maskedSource(code, { maskStrings: true });
  const commentFree = maskedSource(code, { maskStrings: false });
  const usage = new Map<string, DenoRuntimeUsage>();

  const record = (api: string, guidance: string, index: number) => {
    const line = lineAt(codeOnly, index);
    usage.set(`${line}:${api}`, { api, line, guidance });
  };

  for (const rule of DENO_API_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of codeOnly.matchAll(rule.pattern)) {
      record(rule.api, rule.guidance, match.index ?? 0);
    }
  }

  DENO_MODULE_IMPORT_RULE.pattern.lastIndex = 0;
  for (const match of commentFree.matchAll(DENO_MODULE_IMPORT_RULE.pattern)) {
    record(DENO_MODULE_IMPORT_RULE.api, DENO_MODULE_IMPORT_RULE.guidance, match.index ?? 0);
  }

  return [...usage.values()].sort((left, right) => left.line - right.line || left.api.localeCompare(right.api));
}

export function denoRuntimeUsageError(code: string): string | undefined {
  const usage = findDenoRuntimeUsage(code);
  if (usage.length === 0) return undefined;
  const details = usage
    .map((entry) => `- line ${entry.line}: ${entry.api} — ${entry.guidance}`)
    .join("\n");
  return [
    "Edge functions no longer run the Deno compatibility layer, so this source cannot be deployed:",
    details,
    "See docs/edge-runtime-guide.md#function-contract.",
  ].join("\n");
}