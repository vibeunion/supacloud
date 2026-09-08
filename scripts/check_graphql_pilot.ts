import { strict as assert } from "node:assert";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileProject, checkProject } from "../packages/compiler/src/compile";
import { pullGraphqlSchema } from "../packages/compiler/src/graphql-schema";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(repo, "scripts/fixtures/graphql-orders");
const output = join(repo, "output/graphql-pilot");
const work = await mkdtemp(join(tmpdir(), "supacloud-graphql-pilot-"));
const runId = randomUUID().replaceAll("-", "").slice(0, 12);
const network = `supacloud-graphql-${runId}`;
const pg = `${network}-pg`;
const rest = `${network}-rest`;
const password = randomBytes(24).toString("hex");
const secret = randomBytes(32).toString("hex");
const keepServing = process.argv.includes("--serve");
const evidence: Record<string, unknown> = { scope: "isolated-local-synthetic-data", runId };
let pgCreated = false;
let restCreated = false;
let networkCreated = false;
let server: ReturnType<typeof Bun.serve> | undefined;

async function command(args: string[], input?: string, env?: Record<string, string | undefined>, expectedCode = 0, cwd = repo): Promise<string> {
  const child = Bun.spawn(args, {
    cwd, env: { ...process.env, ...env },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 180_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (code !== expectedCode) throw new Error(`${args[0]} returned ${code}: ${stderr.replaceAll(password, "[redacted]").replaceAll(secret, "[redacted]")}`);
    return stdout.trim();
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
}
async function sql(statement: string): Promise<string> {
  return command(["docker", "exec", "-i", pg, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "graphql_pilot"], statement);
}
async function waitFor(label: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* Container startup is asynchronous. */ }
    await Bun.sleep(200);
  }
  throw new Error(`${label} did not become ready within 30 seconds`);
}
function token(tenant?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    role: "authenticated", tenant_id: tenant, sub: "00000000-0000-0000-0000-000000000001",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}
async function cleanup(): Promise<void> {
  const failures: unknown[] = [];
  for (const clean of [
    async () => { await server?.stop(true); },
    async () => { if (restCreated) await command(["docker", "rm", "-f", rest]); },
    async () => { if (pgCreated) await command(["docker", "rm", "-f", pg]); },
    async () => { if (networkCreated) await command(["docker", "network", "rm", network]); },
    async () => { await rm(work, { recursive: true, force: true }); },
  ]) {
    try { await clean(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Pilot cleanup failed");
}

try {
  await mkdir(output, { recursive: true });
  await command(["docker", "image", "inspect", "supacloud-graphql-test:pg18"]);
  await command(["docker", "network", "create", network]);
  networkCreated = true;
  await command(["docker", "run", "-d", "--name", pg, "--network", network,
    "--label", `supacloud.graphql-pilot=${runId}`, "--tmpfs", "/var/lib/postgresql:rw,size=512m",
    "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB=graphql_pilot",
    "supacloud-graphql-test:pg18"], undefined, { POSTGRES_PASSWORD: password });
  pgCreated = true;
  await waitFor("PostgreSQL", async () => (await sql("SELECT 1;")) === "1");
  await sql(`CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD '${password}';`);
  await sql(await readFile(join(fixture, "schema.sql"), "utf8"));
  evidence.database = JSON.parse(await sql(`SELECT json_build_object(
    'postgres', current_setting('server_version'), 'pg_graphql', extversion,
    'orders', (SELECT count(*) FROM orders), 'items', (SELECT count(*) FROM order_items),
    'deliveries', (SELECT count(*) FROM deliveries)) FROM pg_extension WHERE extname = 'pg_graphql';`));
  await command(["docker", "run", "-d", "--name", rest, "--network", network,
    "--label", `supacloud.graphql-pilot=${runId}`, "-p", "127.0.0.1::3000",
    "-e", "PGRST_DB_URI", "-e", "PGRST_JWT_SECRET", "-e", "PGRST_DB_SCHEMAS=public,graphql_public",
    "-e", "PGRST_DB_ANON_ROLE=anon", "-e", "PGRST_DB_EXTRA_SEARCH_PATH=public",
    "-e", "PGRST_DB_POOL=4", "-e", "PGRST_DB_MAX_ROWS=100",
    "postgrest/postgrest:v16.2"], undefined, {
      PGRST_DB_URI: `postgres://authenticator:${password}@${pg}:5432/graphql_pilot`,
      PGRST_JWT_SECRET: secret,
    });
  restCreated = true;
  const mapping = await command(["docker", "port", rest, "3000/tcp"]);
  const restUrl = `http://${mapping}`;
  await waitFor("PostgREST", async () => (await fetch(restUrl)).ok);
  const tokenA = token("tenant-a");
  const tokenB = token("tenant-b");
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/graphql/v1" || url.pathname.startsWith("/rest/v1/")) {
        const headers = new Headers();
        for (const name of ["authorization", "content-type", "accept"]) {
          const value = request.headers.get(name);
          if (value) headers.set(name, value);
        }
        const graphql = url.pathname === "/graphql/v1";
        if (graphql) {
          headers.set("Accept-Profile", "graphql_public");
          headers.set("Content-Profile", "graphql_public");
        }
        return fetch(restUrl + (graphql ? "/rpc/graphql" : url.pathname.slice("/rest/v1".length)) + url.search, {
          method: request.method, headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
          redirect: "error",
        });
      }
      if (url.pathname === "/session") {
        return Response.json({ accessToken: url.searchParams.get("tenant") === "b" ? tokenB : tokenA }, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      if (url.pathname === "/client.js") return new Response(Bun.file(join(work, "browser/client.js")), { headers: { "Content-Type": "text/javascript" } });
      if (url.pathname === "/refresh.svg") return new Response(Bun.file(join(fixture, "refresh.svg")));
      if (url.pathname === "/") return new Response(Bun.file(join(fixture, "index.html")));
      return new Response("Not found", { status: 404 });
    },
  });
  const url = server.url.origin;
  const schemaPath = join(work, "schema.graphql");
  const roleSchema = { url, output: schemaPath, publishableKey: "synthetic-public", accessToken: tokenA };
  await pullGraphqlSchema(roleSchema);
  const authenticatedSchema = await readFile(schemaPath, "utf8");
  assert.ok(authenticatedSchema.includes("ordersCollection"));
  assert.ok(!authenticatedSchema.includes("internalMarginCents"));
  assert.ok(!authenticatedSchema.includes("insertIntoOrdersCollection"));
  const anonymousPath = join(work, "anonymous.graphql");
  await pullGraphqlSchema({ url, output: anonymousPath, publishableKey: "synthetic-public" });
  assert.ok(!(await readFile(anonymousPath, "utf8")).includes("ordersCollection"));
  evidence.roleSchemas = { anonymousCannotSeeOrders: true, authenticatedCannotSeePrivateColumnsOrMutations: true };
  await mkdir(join(work, "src"), { recursive: true });
  await cp(join(fixture, "order.graphql"), join(work, "src/order.graphql"));
  const options = { rootDir: join(work, "src"), outDir: join(work, "generated"), graphql: { schema: schemaPath, typedDocuments: true } };
  await writeFile(join(work, "supacloud.config.mjs"), `export default ${JSON.stringify({ root: "src", graphql: { schema: schemaPath, typedDocuments: true } })};\n`);
  const compiled = await compileProject(options);
  assert.deepEqual(compiled.diagnostics, []);
  assert.ok((await checkProject(options)).upToDate);
  const client = await import(pathToFileURL(join(work, "generated/graphql.ts")).href);
  const queries = client.createGraphqlClient({ url, publishableKey: "synthetic-public", getAccessToken: () => tokenA });
  const document = await readFile(join(work, "src/order.graphql"), "utf8");
  async function graphql(query: string, variables: Record<string, unknown> = {}, accessToken?: string) {
    return fetch(url + "/graphql/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ query, variables }),
    });
  }
  const own = await queries.OrderDetail({ id: 1 });
  assert.equal(own.ordersCollection.edges[0].node.customer.name, "Northwind Devices");
  assert.equal(own.ordersCollection.edges[0].node.items.edges.length, 10);
  assert.equal(own.ordersCollection.edges[0].node.deliveries.edges.length, 2);
  assert.equal((await queries.OrderDetail({ id: 1001 })).ordersCollection.edges.length, 0);
  const other = client.createGraphqlClient({ url, getAccessToken: () => tokenB });
  assert.equal((await other.OrderDetail({ id: 1 })).ordersCollection.edges.length, 0);
  assert.equal((await other.OrderDetail({ id: 1001 })).ordersCollection.edges[0].node.customer.name, "Contoso Robotics");
  assert.equal((await queries.OrderDetail({ id: 90001 })).ordersCollection.edges[0].node.customer, null);
  assert.ok((await (await graphql(document, { id: 1 })).json()).errors);
  assert.equal((await graphql(document, { id: 1 }, tokenA.slice(0, -4) + "xxxx")).status, 401);
  assert.equal((await (await graphql(document, { id: 1 }, token())).json()).data.ordersCollection.edges.length, 0);
  const originalData = await sql("SELECT md5(string_agg(o::text, '' ORDER BY id)) FROM orders o;");
  for (const query of [
    'mutation { updateOrdersCollection(set: {status: "approved"}, filter: {id: {eq: 1}}) { affectedCount } }',
    'mutation { deleteFromOrdersCollection(filter: {id: {eq: 1}}) { affectedCount } }',
    'mutation { insertIntoOrdersCollection(objects: [{id: 99999}]) { affectedCount } }',
  ]) assert.ok((await (await graphql(query, {}, tokenA)).json()).errors);
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const response = await fetch(url + "/rest/v1/orders?id=eq.1", {
      method, headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
      body: method === "DELETE" ? undefined : JSON.stringify({ status: "approved" }),
    });
    assert.ok(response.status === 401 || response.status === 403, `${method}: ${response.status}`);
  }
  assert.equal(await sql("SELECT md5(string_agg(o::text, '' ORDER BY id)) FROM orders o;"), originalData);
  evidence.isolation = { anonymousDenied: true, invalidJwtDenied: true, missingTenantReturnsNoRows: true, crossTenantDeniedBothWays: true, nestedRlsEnforced: true, graphqlAndRestWritesDenied: true, rowsUnchanged: true };
  console.log("GraphQL pilot: real JWT, grants, nested RLS and direct-write denial passed");

  const originalArtifact = await readFile(join(work, "generated/graphql.ts"), "utf8");
  assert.ok((await pullGraphqlSchema({ ...roleSchema, check: true })).upToDate);
  await sql("ALTER TABLE orders RENAME COLUMN number TO reference;");
  assert.equal((await pullGraphqlSchema({ ...roleSchema, check: true })).upToDate, false);
  const cliCheck = JSON.parse(await command([process.execPath, "--no-env-file",
    join(repo, "packages/compiler/src/cli.ts"), "graphql-schema", "--url", url,
    "--token-env", "GRAPHQL_PILOT_TOKEN", "--check", "--json"], undefined,
    { GRAPHQL_PILOT_TOKEN: tokenA }, 1, work));
  assert.equal(cliCheck.ok, false);
  assert.equal(cliCheck.written, false);
  assert.equal(await readFile(schemaPath, "utf8"), authenticatedSchema);
  await pullGraphqlSchema(roleSchema);
  const broken = await compileProject(options);
  assert.ok(broken.diagnostics.some((diagnostic) => diagnostic.code === "graphql-validation"));
  assert.deepEqual(broken.written, []);
  assert.equal(await readFile(join(work, "generated/graphql.ts"), "utf8"), originalArtifact);
  await sql("ALTER TABLE orders RENAME COLUMN reference TO number;");
  await pullGraphqlSchema(roleSchema);
  assert.deepEqual((await compileProject(options)).diagnostics, []);
  evidence.migration = { driftDetectedWithoutWriting: true, refreshedSchemaRejectsOldQuery: true, workingArtifactsPreserved: true };

  const restPath = "/rest/v1/orders?id=eq.1&select=id,number,status,total_cents,customer:customers(id,name,email),items:order_items(id,sku,description,quantity,unit_price_cents),deliveries(id,carrier,tracking,status)";
  const restResult = await (await fetch(url + restPath, { headers: { Authorization: `Bearer ${tokenA}` } })).json();
  const orderNode = own.ordersCollection.edges[0].node;
  const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;
  restResult[0].items.sort(byId);
  restResult[0].deliveries.sort(byId);
  assert.deepEqual(restResult, [{
    id: orderNode.id, number: orderNode.number, status: orderNode.status,
    total_cents: orderNode.totalCents, customer: orderNode.customer,
    items: orderNode.items.edges.map(({ node }: { node: { id: number; sku: string; description: string; quantity: number; unitPriceCents: number } }) => ({
      id: node.id, sku: node.sku, description: node.description, quantity: node.quantity,
      unit_price_cents: node.unitPriceCents,
    })).sort(byId),
    deliveries: orderNode.deliveries.edges.map(({ node }: { node: { id: number; carrier: string; tracking: string; status: string } }) => node).sort(byId),
  }]);
  evidence.resultEquivalence = { allSelectedFieldsCompared: true, relationshipOrderingNormalized: true };
  const graphqlTimes: number[] = [];
  const restTimes: number[] = [];
  for (let n = 0; n < 35; n++) {
    for (const mode of n % 2 ? ["rest", "graphql"] : ["graphql", "rest"]) {
      const start = performance.now();
      if (mode === "graphql") await queries.OrderDetail({ id: 1 });
      else {
        const response = await fetch(url + restPath, { headers: { Authorization: `Bearer ${tokenA}` } });
        assert.ok(response.ok);
        await response.json();
      }
      if (n >= 5) (mode === "graphql" ? graphqlTimes : restTimes).push(performance.now() - start);
    }
  }
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { samples: sorted.length, p50Ms: sorted[Math.floor(sorted.length * 0.5)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
  };
  const performanceResult = { graphql: stats(graphqlTimes), embeddedRest: stats(restTimes), localBudgetMs: 500, requestsPerDetail: { graphql: 1, embeddedRest: 1 } };
  assert.ok(performanceResult.graphql.p95Ms! < 500, "GraphQL exceeds the local 500ms p95 smoke budget");
  evidence.performance = performanceResult;
  evidence.codeReduction = { bespokeBackendEndpoints: 0, handwrittenQueryFiles: 1, frontendCallsPerDetail: 1, comparison: "Embedded REST also needs one request; no measured developer-time saving is claimed." };
  await sql(`COMMENT ON SCHEMA public IS '@graphql({"inflect_names":true,"introspection":false,"max_rows":100})';`);
  await assert.rejects(pullGraphqlSchema({ ...roleSchema, check: true }), /schema export failed/);
  assert.equal((await queries.OrderDetail({ id: 1 })).ordersCollection.edges[0].node.id, 1);
  evidence.productionIntrospection = { disabledExportFails: true, authorizedDataQueryStillWorks: true };

  await cp(join(fixture, "client.ts"), join(work, "src/client.ts"));
  await command([join(repo, "packages/compiler/node_modules/.bin/tsc"), "--noEmit", "--strict",
    "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", "--skipLibCheck",
    join(work, "src/client.ts")]);
  const bundle = await Bun.build({ entrypoints: [join(work, "src/client.ts")], outdir: join(work, "browser"), target: "browser" });
  assert.ok(bundle.success, String(bundle.logs));
  evidence.frontend = { strictTypecheck: true, browserBundle: true };
  await writeFile(join(output, "report.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, report: join(output, "report.json"), ...performanceResult }, null, 2));
  if (keepServing) {
    console.log(`Order pilot: ${url}`);
    await new Promise<void>((done) => {
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
  }
} finally {
  await cleanup();
}
