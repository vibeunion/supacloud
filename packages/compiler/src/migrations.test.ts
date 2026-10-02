1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
26
27
28
29
30
31
32
33
34
35
36
37
38
39
40
41
42
43
44
45
46
47
48
49
50
51
52
53
54
55
56
57
58
59
60
61
62
63
64
65
66
67
68
69
70
71
72
73
74
75
76
77
78
79
80
81
82
83
84
85
86
87
88
89
90
91
92
93
94
95
96
97
98
99
100
101
102
103
104
105
106
107
108
109
110
111
112
113
114
115
116
117
118
119
120
121
122
123
124
125
126
127
128
129
130
131
132
133
134
135
136
137
138
139
140
141
142
143
144
145
146
147
148
149
150
151
152
153
154
155
156
157
158
159
160
161
162
163
164
165
166
167
168
169
170
171
172
173
174
175
176
177
178
179
180
181
182
183
184
185
186
187
188
189
190
191
192
193
194
195
196
197
198
199
200
201
202
203
204
205
206
207
208
209
210
211
212
213
214
215
216
217
218
219
220
221
222
223
224
225
226
227
228
229
230
231
232
233
234
235
236
237
238
239
240
241
242
243
244
245
246
247
248
249
250
251
252
253
254
255
256
257
258
259
260
261
262
263
264
265
266
267
268
269
270
271
272
273
274
275
276
277
278
279
280
281
282
283
284
285
286
287
288
289
290
291
292
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateProject, migrateRouteResponse, SUPACLOUD_MIGRATIONS, type SupaCloudMigration } from "./migrations";
import { migrationDependencies } from "./migration-policy";


test("migrates deprecated route response schemas to an explicit 200 response map", () => {
  const source = `
const Result = {};
@Get("/items", { response: Result })
class ItemsController {}
const unrelated = { response: Result };
`;
  const result = migrateRouteResponse(source, "src/items.ts");
  expect(result.issues).toEqual([]);
  expect(result.replacements).toBe(1);
  expect(result.content).toContain('responses: { 200: Result }');
  expect(result.content).toContain("const unrelated = { response: Result }");
});


test("schema builder calls without a route-options argument remain untouched", () => {
  const source = `
const QuerySchema = Type.Transform(Type.String()).Decode(Number).Encode(String);
const single = Get("/without-options");
@Get("/items", { query: QuerySchema, response: Result })
class ItemsController {}
`;
  const result = migrateRouteResponse(source, "src/schema.ts");
  expect(result.replacements).toBe(1);
  expect(result.content).toContain("Type.Transform(Type.String()).Decode(Number).Encode(String)");
  expect(result.content).toContain('Get("/without-options")');
  expect(result.content).toContain("responses: { 200: Result }");
});


test("migrates route options resolved through a local const and defineRouteContract", () => {
  const result = migrateRouteResponse(`
const defineRouteContract = <T>(value: T): T => value;
const routeOptions = defineRouteContract({ response: Result });
@Get("/items", routeOptions)
class ItemsController {}
`, "src/items.ts");
  expect(result.issues).toEqual([]);
  expect(result.replacements).toBe(1);
  expect(result.content).toContain("const routeOptions = defineRouteContract({ responses: { 200: Result } });");
});


test("does not guess when a route already has a response map", () => {
  const result = migrateRouteResponse(
    `@Get("/items", { response: Legacy, responses: { 201: Created } }) class ItemsController {}`,
    "src/items.ts",
  );
  expect(result.changed).toBe(false);
  expect(result.issues).toMatchObject([{ code: "route-response-conflict", file: "src/items.ts", line: 1 }]);
});


test("project migration is atomic when one file needs manual conflict resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-migration-"));
  await mkdir(join(root, "src"), { recursive: true });
  const goodPath = join(root, "src/good.ts");
  const conflictPath = join(root, "src/conflict.ts");
  const good = `@Get("/good", { response: Result }) class GoodController {}`;
  const conflict = `@Get("/conflict", { response: Legacy, responses: { 201: Created } }) class ConflictController {}`;
  await writeFile(goodPath, good, "utf8");
  await writeFile(conflictPath, conflict, "utf8");


  const result = await migrateProject({ rootDir: root, write: true });
  expect(result.issues).toHaveLength(1);
  expect(result.changedFiles).toEqual([]);
  expect(await readFile(goodPath, "utf8")).toBe(good);
  expect(await readFile(conflictPath, "utf8")).toBe(conflict);
  await rm(root, { recursive: true, force: true });
});


test("unchanged project files do not fall back to context-free per-file migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-migration-unchanged-"));
  const apply = spyOn(SUPACLOUD_MIGRATIONS[0]!, "apply").mockImplementation(() => {
    throw new Error("The project migration already analyzed this file");
  });
  try {
    await writeFile(join(root, "source.ts"), 'const options = { response: {} };');
    const result = await migrateProject({ rootDir: root });
    expect(result.changedFiles).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
  } finally {
    apply.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});


test("project migration follows route contracts across files and only changes the declaration", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-migration-cross-file-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    const controllerPath = join(root, "src/controller.ts");
    const contractPath = join(root, "src/contracts.ts");
    await writeFile(controllerPath, `
import { Get } from "@supacloud/app";
import { ItemsRoute } from "./contracts";
@Get("/items", ItemsRoute)
class ItemsController {}
`, "utf8");
    await writeFile(contractPath, `
const defineRouteContract = <T>(value: T): T => value;
const Result = {};
export const ItemsRoute = defineRouteContract({ response: Result });
`, "utf8");


    const preview = await migrateProject({ rootDir: root });
    expect(preview.issues).toEqual([]);
    expect(preview.changedFiles).toEqual(["src/contracts.ts"]);
    expect(preview.files).toMatchObject([{ file: "src/contracts.ts", replacements: 1 }]);


    const applied = await migrateProject({ rootDir: root, write: true });
    expect(applied.issues).toEqual([]);
    expect(applied.changedFiles).toEqual(["src/contracts.ts"]);
    expect(await readFile(controllerPath, "utf8")).toContain("@Get(\"/items\", ItemsRoute)");
    expect(await readFile(contractPath, "utf8")).toContain("responses: { 200: Result }");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("project migration uses tsconfig path aliases when resolving shared contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-migration-paths-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { module: "ESNext", moduleResolution: "Bundler", baseUrl: ".", paths: { "@contracts/*": ["src/*"] } },
    }), "utf8");
    await writeFile(join(root, "src/controller.ts"), `
import { Get } from "@supacloud/app";
import { ItemsRoute } from "@contracts/contracts";
@Get("/items", ItemsRoute)
class ItemsController {}
`, "utf8");
    await writeFile(join(root, "src/contracts.ts"), `
export const ItemsRoute = { response: Result };
`, "utf8");


    const result = await migrateProject({ rootDir: root });
    expect(result.issues).toEqual([]);
    expect(result.changedFiles).toEqual(["src/contracts.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


async function versionedFixture() {
  const root = await mkdtemp(join(tmpdir(), "supacloud-versioned-migration-"));
  for (const [name, version] of Object.entries(migrationDependencies())) {
    const directory = join(root, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version }));
  }
  const source = '@Get("/items", { response: Result }) class ItemsController {}';
  await writeFile(join(root, "items.ts"), source);
  return { root, source, fromVersion: "0.11.0", toVersion: "0.12.0" };
}


test("versioned upgrade previews without writing, applies once and is repeatable", async () => {
  const f = await versionedFixture();
  try {
    const options = { rootDir: f.root, fromVersion: f.fromVersion, toVersion: f.toVersion };
    const preview = await migrateProject(options);
    expect(preview.issues).toEqual([]);
    expect(preview.migrations.map((migration) => migration.id)).toEqual(["route-response-to-responses"]);
    expect(preview.changedFiles).toEqual(["items.ts"]);
    expect(await readFile(join(f.root, "items.ts"), "utf8")).toBe(f.source);
    expect((await migrateProject({ ...options, write: true })).issues).toEqual([]);
    expect((await migrateProject({ ...options, write: true })).changedFiles).toEqual([]);
    expect((await migrateProject({ ...options, fromVersion: f.toVersion })).migrations).toEqual([]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test("unknown checkpoints, downgrade and mismatched installed packages block all writes", async () => {
  const f = await versionedFixture();
  try {
    for (const versions of [
      { fromVersion: "0.10.0", toVersion: "0.12.0" },
      { fromVersion: "0.12.0", toVersion: "0.11.0" },
      { fromVersion: "0.11.0" },
    ]) {
      expect((await migrateProject({ rootDir: f.root, write: true, ...versions })).issues.length).toBeGreaterThan(0);
      expect(await readFile(join(f.root, "items.ts"), "utf8")).toBe(f.source);
    }
    await writeFile(join(f.root, "node_modules/@supacloud/app/package.json"), '{"version":"99.0.0"}');
    const result = await migrateProject({
      rootDir: f.root, write: true, fromVersion: f.fromVersion, toVersion: f.toVersion,
    });
    expect(result.issues).toMatchObject([{ code: "migration-dependency-incompatible" }]);
    expect(result.changedFiles).toEqual([]);
    expect(await readFile(join(f.root, "items.ts"), "utf8")).toBe(f.source);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test("a later filesystem failure restores earlier writes and removes temporary files", async () => {
  const f = await versionedFixture();
  await writeFile(join(f.root, "z.ts"), f.source);
  const rename = fs.rename;
  const fault = spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (String(target) === join(f.root, "z.ts")) throw new Error("Injected rename failure");
    await rename(source, target);
  });
  try {
    const result = await migrateProject({ rootDir: f.root, write: true });
    expect(result.issues).toMatchObject([{ code: "migration-write-failed" }]);
    expect(result.changedFiles).toEqual([]);
    expect(await readFile(join(f.root, "items.ts"), "utf8")).toBe(f.source);
    expect(await readFile(join(f.root, "z.ts"), "utf8")).toBe(f.source);
    expect((await fs.readdir(f.root)).filter((name) => name.includes("supacloud-migrate"))).toEqual([]);
  } finally {
    fault.mockRestore();
    await rm(f.root, { recursive: true, force: true });
  }
});


test("migration order follows checkpoint edges and writes each file's final result once", async () => {
  const f = await versionedFixture();
  const originalLength = SUPACLOUD_MIGRATIONS.length;
  const step = (id: string, from: string, to: string, before: string, after: string): SupaCloudMigration => ({
    id, from, to, description: "Test-only registry edge",
    apply: (content) => ({
      changed: content.includes(before), content: content.replaceAll(before, after),
      replacements: content.includes(before) ? 1 : 0, issues: [],
    }),
  });
  SUPACLOUD_MIGRATIONS.push(
    step("third", "0.14.0", "0.15.0", "Intermediate", "Final"),
    step("second", "0.13.0", "0.14.0", "Result", "Intermediate"),
  );
  try {
    const result = await migrateProject({
      rootDir: f.root, write: true, fromVersion: "0.11.0", toVersion: "0.15.0",
    });
    expect(result.issues).toEqual([]);
    expect(result.migrations.map((migration) => migration.id)).toEqual([
      "route-response-to-responses", "http-provider-entrypoint", "second", "third",
    ]);
    expect(result.changedFiles).toEqual(["items.ts"]);
    expect(await readFile(join(f.root, "items.ts"), "utf8")).toContain("responses: { 200: Final }");
  } finally {
    SUPACLOUD_MIGRATIONS.splice(originalLength);
    await rm(f.root, { recursive: true, force: true });
  }
});


test("rollback reports residual files rather than overwriting concurrent edits", async () => {
  const f = await versionedFixture();
  await writeFile(join(f.root, "z.ts"), f.source);
  const rename = fs.rename;
  const fault = spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (String(target) === join(f.root, "z.ts")) throw new Error("Injected rename failure");
    await rename(source, target);
    if (String(target) === join(f.root, "items.ts")) await writeFile(target, "// concurrent edit");
  });
  try {
    const result = await migrateProject({ rootDir: f.root, write: true });
    expect(result.issues.map((issue) => issue.code)).toEqual(["migration-write-failed", "migration-rollback-failed"]);
    expect(result.changedFiles).toEqual(["items.ts"]);
    expect(await readFile(join(f.root, "items.ts"), "utf8")).toBe("// concurrent edit");
    expect(await readFile(join(f.root, "z.ts"), "utf8")).toBe(f.source);
  } finally {
    fault.mockRestore();
    await rm(f.root, { recursive: true, force: true });
  }
});


test("CLI rejects unsupported checkpoints with nonzero status and visible diagnostics", async () => {
  const f = await versionedFixture();
  try {
    for (const json of [false, true]) {
      const child = Bun.spawn([
        process.execPath, join(import.meta.dir, "cli.ts"), "migrate",
        "--root", f.root, "--from-version", "0.10.0", "--to-version", "0.12.0", "--write",
        ...(json ? ["--json"] : []),
      ], { stdout: "pipe", stderr: "pipe" });
      const [exit, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(exit).toBe(1);
      expect(stderr).toBe("");
      if (json) {
        const result: unknown = JSON.parse(stdout);
        expect(result).toMatchObject({ changedFiles: [], issues: [{ code: "migration-version-unsupported" }] });
      } else expect(stdout).toContain("migration-version-unsupported");
      expect(await readFile(join(f.root, "items.ts"), "utf8")).toBe(f.source);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

