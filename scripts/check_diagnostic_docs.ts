import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { COMPILER_DIAGNOSTIC_CODES } from "../packages/compiler/src/validate.ts";
import { TYPE_SAFETY_DIAGNOSTIC_CODES } from "../packages/compiler/src/type-safety.ts";

interface DiagnosticEntry {
  code: string;
  names: string[];
  docsUrl: string;
  registry: "compiler" | "type-safety";
}

const COUNTEREXAMPLES: Record<string, string> = {
  SC1001: `@Module({ name: "a", imports: [BModule] }) class AModule {}
@Module({ name: "b", imports: [AModule] }) class BModule {}`,
  SC1002: `@Injectable({ scope: "application" })
class AppService {
  constructor(private readonly request: RequestContext) {}
}`,
  SC1003: `@Module({ name: "ui", tags: ["type:ui"], imports: [DataModule] })
class UiModule {}
@Module({ name: "data", tags: ["type:data-access"] })
class DataModule {}`,
  SC1004: `// a.ts imports b.ts, while b.ts imports a.ts
import { BModule } from "./b";
import { AModule } from "./a";`,
  SC1005: `@Module({ name: "orphan" })
export class OrphanModule {}`,
  SC1006: `defineSupacloudConfig({ moduleBoundaryPreset: "not-a-preset" });`,
  SC1007: `const A = { provide: A_TOKEN, useExisting: B_TOKEN };
const B = { provide: B_TOKEN, useExisting: A_TOKEN };`,
  SC2001: `@Injectable()
class BillingService {
  constructor(private readonly missing: MissingService) {}
}`,
  SC2002: `@Module({ name: "billing", providers: [InvoiceService, InvoiceService] })
class BillingModule {}`,
  SC2003: `@Controller("/cases")
class CaseController {
  constructor(@Inject(DB_CLIENT) private readonly db: unknown) {}
}`,
  SC2004: `const SELF = { provide: TOKEN, useExisting: TOKEN };`,
  SC2005: `@Module({ name: "child", providers: [TOKEN] })
class ChildModule {}
// @SkipSelf() cannot resolve a token from the current module.
class Consumer { constructor(@SkipSelf() value: typeof TOKEN) {} }`,
  SC2006: `@Module({ name: "billing", exports: [PRIVATE_TOKEN] })
class BillingModule {}`,
  SC2007: `const Alias = { provide: PUBLIC_TOKEN, useExisting: MissingToken };`,
  SC2008: `const Alias = { provide: PUBLIC_TOKEN, useExisting: PUBLIC_TOKEN };`,
  SC2009: `const TOKEN = new InjectionToken<number>("TOKEN");
// No factory or provider is declared for TOKEN.`,
  SC2010: `const COUNT = new InjectionToken<number>("COUNT");
const provider = { provide: COUNT, useValue: "not a number" };`,
  SC2011: `const providers = makeEnvironmentProviders(loadProvidersAtRuntime());`,
  SC2012: `import { inject } from "@supacloud/app";
class Service { private db = inject(DB); }`,
  SC3001: `@Get("/:id") findById() {}
@Get("/health") health() {}`, 
  SC3002: `const routes = [{ path: "/old", redirectTo: "/missing" }];`,
  SC3003: `const routes = [
  { path: "/a", redirectTo: "/b" },
  { path: "/b", redirectTo: "/a" },
];`,
  SC3004: `@Route({ method: "TRACE", path: "/items", body: ItemBody })
handle() {}`, 
  SC3005: `@Controller("/items")
class ItemController {
  @Get("/:id") find(@Param("slug") slug: string) {}
}`,
  SC3006: `@Controller("/items")
class ItemController {
  @Get("/:id") find() {}
}`,
  SC3007: `@Get("/items") first() {}
@Get("/items") second() {}`,
  SC3008: `@Post("/items") create(@Body() input: unknown) {}`, 
  SC3009: `@Post("/items", { body: ItemBody }) create() {}`, 
  SC3010: `@Get("//items") list() {}`, 
  SC3011: `@Get("/items/:id/:id") get() {}`, 
  SC3012: `@Get("/files/**/tail") read() {}`, 
  SC3013: `@Get("/items") list(@Query("page-size") value: string) {}`, 
  SC3014: `@Get("/items") get(@Param("id") id: string) {}`, 
  SC3015: `@Get("/items") list(@Query({ transform: "number", default: "0" }) page: number) {}`, 
  SC3016: `@Get("/items", { body: ItemBody })
list(@Body() input: unknown) {}`, 
  SC3017: `@Get("/items") list(@Query("page") a: string, @Query("page") b: string) {}`, 
  SC3018: `@Get("/items") @Post("/items") save() {}`, 
  SC3019: `@Get("/items/{id}") get() {}`, 
  SC3020: `@Post("/items", { contract: { body: "database" } }) create() {}`, 
  SC4001: `@Command({ name: "billing.issueInvoice" })
class IssueInvoiceCommand {}`, 
  SC4002: `@Command({ name: "billing.issueInvoice", permission: "billing.issue" })
class First {}
@Command({ name: "billing.issueInvoice", permission: "billing.issue" })
class Second {}`,
  SC4003: `@Controller("/billing")
class BillingController {
  @Post("/issue", { command: MissingCommand }) issue() {}
}`,
  SC4004: `defineSupacloudConfig({
  commandCapabilities: { permission: false, transaction: false },
});
@Command({ name: "billing.issue", permission: "billing.issue", transaction: "required" })
class Issue {}`,
  SC4005: `defineSupacloudConfig({ allowRouteCommandBindings: false });
@Post("/issue", { command: IssueCommand }) issue() {}`,
  SC4006: `@Get("/items", { command: UpdateItemCommand })
read() {}`,
  SC4007: `@Job({ name: "billing.rebuild", scope: "request" })
class RebuildJob {}`,
  SC4010: `const aspects = getAspectsFromConfig();
@Command({ name: "billing.issue", aspects })
class Issue {}`,
  SC4011: `@Command({ name: "billing.issue", aspects: [notAnAspect] })
class Issue {}`,
  SC4012: `@Command({ name: "billing.issue", transaction: "sometimes" })
class Issue {}`,
  SC4013: `@Command({ name: "billing.issue", rpc: "" })
class Issue {}`,
  SC4014: `@Command({ name: "billing.issue", rpc: "billingRpc" })
class Issue {}
// commandCapabilities.rpc does not declare billingRpc.`,
  SC4015: `@Job({ name: "billing.rebuild", timeoutSec: 0 })
class RebuildJob {}`,
  SC4016: `@Job({ name: "billing.rebuild", maxAttempts: 0 })
class RebuildJob {}`,
  SC4017: `@Job({ name: "billing.rebuild", idempotency: "optional" })
class RebuildJob {}`,
  SC4018: `@Job({ name: "billing.rebuild", mode: "cron" })
class RebuildJob {}`,
  SC4019: `@Job({ name: "billing.rebuild", input: Type.Object({ id: Type.String() }) })
class RebuildJob {}`,
  SC4020: `defineSupacloudConfig({
  commandCapabilities: { requirePersistentAdapters: true, permission: true },
});
@Command({ name: "billing.issue", permission: "billing.issue" })
class Issue {}`,
  SC4021: `defineSupacloudConfig({
  commandCapabilities: { rpc: { billing: { boundary: "external", transaction: true } } },
});
@Command({ name: "billing.issue", rpc: "billing", transaction: "required" })
class Issue {}`,
  SC4022: `defineSupacloudConfig({ commandCapabilities: { permission: false } });
@Command({ name: "billing.issue", permission: "billing.issue" })
class Issue {}`,
  SC4023: `defineSupacloudConfig({ commandCapabilities: { audit: false } });
@Command({ name: "billing.issue", permission: "billing.issue", audit: "billing.issued" })
class Issue {}`,
  SC4024: `defineSupacloudConfig({ commandCapabilities: { idempotency: false } });
@Command({ name: "billing.issue", permission: "billing.issue", idempotency: "required" })
class Issue {}`,
  SC4025: `defineSupacloudConfig({ commandCapabilities: { transaction: "rpc-only" } });
@Command({ name: "billing.issue", permission: "billing.issue", transaction: "required" })
class Issue {}`,
  SC4026: `defineSupacloudConfig({ commandCapabilities: { transaction: false } });
@Command({ name: "billing.issue", permission: "billing.issue", transaction: "required" })
class Issue {}`,
  SC3021: `@Post("/items")
create(@Body() input: unknown) {}`,
  SC3022: `const ItemResponse = Type.Any();
@Get("/items", { response: ItemResponse })
list() {}`,
  SC3023: `@Post("/items", {
  body: ItemBody,
  responses: { 200: ItemResponse },
  contract: { body: "domain" },
})
create() {}`,
  SC3024: `@Get("/items", { responses: { 200: Type.Object({ id: Type.String() }) } })
list() {}`,
  SC5001: `@Injectable({ providedIn: "root" })
class UnusedService {}`,
  SC6001: `// generated/application.ts
export const unsafe: any = value;`,
  SC6002: `export function decode(input: any) {
  return input;
}`,
  SC6003: `const item = input as Item;`,
  SC6004: `const item = maybeItem!;`,
  SC6005: `let state = "draft";
state = "approved";`,
  SC6006: `// @ts-ignore
export const value: number = "wrong";`,
  SC6007: `import { sql } from "drizzle-orm";
export const rows = sql<{ id: string }>\`select id from items\`;`,
  SC6008: `import { sql } from "drizzle-orm";
const table = process.env.TABLE_NAME!;
export const query = sql.raw(table);`,
  SC6101: `defineFeatureSpec({ name: "case", states: [], transitions: {} });`,
  SC6102: `defineFeatureSpec({
  name: "case",
  states: ["draft", "approved"],
  transitions: {
    approve: { from: "draft", to: "approved" },
    approveAgain: { from: "draft", to: "approved" },
  },
});`,
  SC6103: `defineFeatureSpec({
  name: "case",
  states: ["draft"],
  transitions: { approve: { from: "draft", to: "missing" } },
});`,
  SC6104: `defineFeatureSpec({
  name: "case",
  states: ["draft", "approved"],
  transitions: { approve: { from: "draft", to: "approved", command: "MissingCommand" } },
});`,
  SC6105: `defineFeatureSpec({
  name: "case",
  states: ["draft", "approved"],
  transitions: { approve: { from: "draft", to: "approved", permission: "case.wrong" } },
});`,
  SC6106: `defineFeatureSpec({
  name: "case",
  states: ["draft", "approved"],
  transitions: { approve: { from: "draft", to: "approved", route: "POST /missing" } },
});`,
  SC6107: `defineFeatureSpec({
  name: "case",
  states: ["draft", "approved"],
  transitions: { approve: { from: "draft", to: "approved", route: "GET /cases/:id" } },
});`,
  SC6108: `defineFeatureSpec(loadFeatureSpecAtRuntime());`,
};

const ROOT = resolve(import.meta.dir, "..");
const DOCS_DIR = resolve(ROOT, "docs/errors");

function collectEntries(): DiagnosticEntry[] {
  const byCode = new Map<string, DiagnosticEntry>();
  const registries = [
    ["compiler", COMPILER_DIAGNOSTIC_CODES] as const,
    ["type-safety", TYPE_SAFETY_DIAGNOSTIC_CODES] as const,
  ];
  for (const [registry, values] of registries) {
    for (const [name, rawMetadata] of Object.entries(values)) {
      const metadata = "code" in rawMetadata
        ? rawMetadata
        : { code: rawMetadata.errorCode, docsUrl: rawMetadata.docsUrl };
      const existing = byCode.get(metadata.code);
      if (existing && existing.registry !== registry) {
        throw new Error(
          `Diagnostic code ${metadata.code} is claimed by ${existing.registry} and ${registry}; codes must have one owner.`,
        );
      }
      if (existing) {
        if (!existing.names.includes(name)) existing.names.push(name);
        if (existing.docsUrl !== metadata.docsUrl) {
          throw new Error(`Diagnostic code ${metadata.code} has inconsistent documentation URLs.`);
        }
      } else {
        byCode.set(metadata.code, {
          code: metadata.code,
          names: [name],
          docsUrl: metadata.docsUrl,
          registry,
        });
      }
    }
  }
  return [...byCode.values()].sort((left, right) => left.code.localeCompare(right.code));
}

function displayName(name: string): string {
  return name.replaceAll("-", " ");
}

function cause(entry: DiagnosticEntry): string {
  const names = entry.names.map(displayName).join(", ");
  return `The compiler emitted this diagnostic for ${names}. The declaration or generated contract violates a statically checkable SupaCloud rule.`;
}

function fix(entry: DiagnosticEntry): string {
  const names = entry.names.join("` or `");
  if (entry.code === "SC2012") return "Use typed constructor parameters with explicit @Inject(TOKEN) when needed. Recompile to generate direct constructor calls; runtime inject(), container creation and injection contexts are not supported in compiled applications.";
  if (entry.code === "SC6007") return "Use parameterized `sql<unknown>` and validate returned rows through `executeDecodedSql` with an application-owned schema decoder. A SQL result generic is not runtime validation.";
  if (entry.code === "SC6008") return "Interpolate values with parameterized `sql` templates. Use Drizzle table/column references for identifiers, and reserve `sql.raw` for reviewed string literals in migrations.";
  if (entry.registry === "type-safety") return `Replace the unsafe type escape reported by \`${names}\` with an explicit type, \`unknown\` plus narrowing, or a constrained generic.`;
  if (entry.code.startsWith("SC1")) return `Inspect the module graph and change the dependency or scope declaration that triggered \`${names}\`. Keep dependencies one-way and make the smallest shared contract explicit.`;
  if (entry.code.startsWith("SC2")) return `Correct the provider or token declaration associated with \`${names}\`. Prefer a named provider, an explicit module export, and a boundary owned by the consuming layer.`;
  if (entry.code.startsWith("SC3")) return `Correct the route path, parameter binding, schema, or redirect associated with \`${names}\`. Keep request and response contracts explicit and status-specific.`;
  if (entry.code.startsWith("SC4")) return `Correct the command, job, or aspect declaration associated with \`${names}\`. Declare permission, persistence, idempotency, and execution order instead of relying on runtime inference.`;
  if (entry.code.startsWith("SC5")) return `Remove the unused root provider or make its ownership explicit. Generated output should contain only reachable providers.`;
  if (entry.code.startsWith("SC6")) return `Make the feature state machine and its transitions agree. Use declared states, commands, routes, and governance metadata as the single source of truth.`;
  if (entry.code.startsWith("SC7")) return `Replace the unsafe type escape reported by \`${names}\` with an explicit type, \`unknown\` plus narrowing, or a constrained generic.`;
  return `Follow the diagnostic suggestion for \`${names}\` and add a focused regression fixture before updating the snapshot.`;
}

function reproduction(entry: DiagnosticEntry): string {
  return `Place the example below in a focused compiler fixture and assert that \`${entry.code}\` is reported with a file location. The fixture must fail before the fix and pass after it.`;
}

function counterexample(entry: DiagnosticEntry): string {
  const example = COUNTEREXAMPLES[entry.code];
  if (!example) throw new Error(`Missing counterexample for diagnostic code ${entry.code}`);
  return `// Expected diagnostic: ${entry.code}\n${example}`;
}

function renderPage(entry: DiagnosticEntry): string {
  return `<!-- Generated by scripts/check_diagnostic_docs.ts. Edit the generator when changing this contract. -->
# ${entry.code}: ${entry.names[0]}

## Meaning

${cause(entry)}

## Fix

${fix(entry)}

## Reproduction

${reproduction(entry)}

## Failing Example

\`\`\`ts
${counterexample(entry)}
\`\`\`

## Registry

- Diagnostic names: ${entry.names.map((name) => `\`${name}\``).join(", ")}
- Owner: \`${entry.registry}\`
- Documentation URL: ${entry.docsUrl}
`;
}

function renderIndex(entries: DiagnosticEntry[]): string {
  const rows = entries.map((entry) =>
    `| [${entry.code}](${entry.code}.md) | ${entry.names.map((name) => `\`${name}\``).join(", ")} | ${entry.registry} |`,
  );
  const fence = "```";
  return `# Compiler Diagnostic Codes

Every public compiler diagnostic has a stable code, an actionable page, and a
negative fixture requirement. Codes are owned by exactly one registry; aliases
may share a page only when they describe the same rule family.

Run the gate with:

${fence}sh
bun run check:diagnostic-docs
${fence}

To intentionally regenerate the generated pages after a reviewed diagnostic
contract change:

${fence}sh
bun scripts/check_diagnostic_docs.ts --write
${fence}

| Code | Diagnostic names | Owner |
| --- | --- | --- |
${rows.join("\n")}
`;
}

async function main(): Promise<void> {
  const entries = collectEntries();
  for (const entry of entries) counterexample(entry);
  const write = process.argv.includes("--write");
  const missing: string[] = [];
  const invalid: string[] = [];

  if (write) await mkdir(DOCS_DIR, { recursive: true });
  for (const entry of entries) {
    const path = join(DOCS_DIR, `${entry.code}.md`);
    const expected = renderPage(entry);
    if (write) {
      await writeFile(path, expected, "utf8");
      continue;
    }
    try {
      const content = await readFile(path, "utf8");
      if (content !== expected) invalid.push(`${entry.code}: page is stale; run bun scripts/check_diagnostic_docs.ts --write`);
    } catch {
      missing.push(entry.code);
    }
  }

  const indexPath = join(DOCS_DIR, "README.md");
  if (write) {
    await writeFile(indexPath, renderIndex(entries), "utf8");
    console.log(`updated ${entries.length} diagnostic pages in ${DOCS_DIR}`);
    return;
  }
  try {
    const index = await readFile(indexPath, "utf8");
    if (index !== renderIndex(entries)) invalid.push("README.md: index is stale; run bun scripts/check_diagnostic_docs.ts --write");
  } catch {
    missing.push("README.md");
  }
  if (missing.length > 0 || invalid.length > 0) {
    throw new Error([
      "Diagnostic documentation gate failed.",
      ...(missing.length > 0 ? [`Missing: ${missing.join(", ")}`] : []),
      ...invalid.map((item) => `Invalid: ${item}`),
      "Run: bun scripts/check_diagnostic_docs.ts --write",
    ].join("\n"));
  }
  console.log(`ok: ${entries.length} diagnostic codes documented`);
}

if (import.meta.main) await main();
