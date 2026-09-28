import { expect, test } from "bun:test";
import ts from "../../packages/compiler/node_modules/@typescript/typescript6";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { STARTER_REVIEW_DELIVERY_HOST } from "../../packages/cli/src/shared/tools/app-starter-postgres";
import { STARTER_ATTACHMENT_DELIVERY_WORKER } from "../../packages/cli/src/shared/tools/app-starter-attachment-worker";
import { startStarterPostgres } from "./starter-postgres";

const bin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;

// Execute the shipped connection expression, without importing application adapters
// or rebuilding the starter/compiler. AST selection fails if the source contract moves.
function extract(source: string): string {
  const ast = ts.createSourceFile("host.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const helpers = ast.statements.filter(ts.isFunctionDeclaration)
    .filter(node => ["required", "databaseConnection"].includes(node.name?.text ?? ""));
  if (helpers.some(node => node.name?.text === "databaseConnection")) {
    return helpers.map(node => node.getText(ast)).join("\n") + "\nconst connection = databaseConnection();";
  }
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "requireReferenceRevision");
  if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body) throw new Error("Missing shipped connection");
  const statements: string[] = [];
  for (const statement of fn.body.statements) {
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations
      .some(declaration => declaration.name.getText(ast) === "pool")) return statements.join("\n");
    statements.push(statement.getText(ast));
  }
  throw new Error("Missing shipped pool");
}

test.skipIf(!bin)("shipped HTTP/worker/upgrade connection expressions override ambient management settings", async () => {
  const pg = await startStarterPostgres(bin!);
  const directory = await mkdtemp(join(tmpdir(), "starter-connection-"));
  try {
    await pg.exec("CREATE DATABASE starter_connection_target");
    const fixture = await readFile(new URL("../fixtures/starter-delivery-compatibility.fixture", import.meta.url), "utf8");
    const ast = ts.createSourceFile("fixture.ts", fixture, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let upgrade: string | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isArrayLiteralExpression(node) && node.elements.length === 2
        && ts.isStringLiteral(node.elements[0]!) && node.elements[0].text === "src/reference-revision.ts"
        && ts.isNoSubstitutionTemplateLiteral(node.elements[1]!)) upgrade = node.elements[1].text;
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(upgrade).toBeDefined();
    const base = await pg.withConnection(async url => url);
    const target = new URL(base);
    target.pathname = "/starter_connection_target";
    const tlsDowngrades: string[] = [];
    for (const [name, source] of [
      ["http", STARTER_REVIEW_DELIVERY_HOST], ["worker", STARTER_ATTACHMENT_DELIVERY_WORKER], ["upgrade", upgrade!],
    ]) {
      const path = join(directory, `${name}.ts`);
      await writeFile(path, `import { SQL } from "bun";
const signal = new AbortController().signal;
${extract(source!)}
// Simulate management configuration loading between options capture and pool construction.
process.env.DATABASE_URL = process.env.PROBE_MANAGEMENT_URL;
const pool = new SQL({...connection,max:1,connectionTimeout:2});
try {
  const rows = await pool.unsafe("SELECT current_database() AS database,current_user AS role");
  console.log(JSON.stringify(rows[0]));
} finally { await pool.close({timeout:1}); }
`);
      for (const requireTls of [false, true]) {
        const connectionUrl = new URL(target);
        if (requireTls) connectionUrl.searchParams.set("sslmode", "require");
        const child = Bun.spawn([process.execPath, "--no-env-file", path], {
          env: { PATH: "/usr/bin:/bin", DATABASE_URL: connectionUrl.href, PROBE_MANAGEMENT_URL: base,
            PGDATABASE: "postgres", DATABASE_NAME: "postgres", PGUSER: "wrong_management",
            DATABASE_USER: "wrong_management", PGHOST: "127.0.0.2", PGPORT: "1", PGPASSWORD: "wrong",
            POSTGRES_URL: base },
          stdout: "pipe", stderr: "pipe",
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
        try {
          const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(),
            new Response(child.stderr).text()]);
          if (requireTls) {
            if (code === 0 || output !== "") tlsDowngrades.push(name!);
          } else {
            expect(code).toBe(0);
            expect(JSON.parse(output)).toEqual({ database: "starter_connection_target", role: "starter_test" });
          }
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null) child.kill("SIGKILL");
          await child.exited;
        }
      }
    }
    expect(tlsDowngrades, "sslmode=require must survive management environment replacement").toEqual([]);
  } finally {
    await pg.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
