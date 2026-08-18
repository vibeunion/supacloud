from __future__ import annotations

import re
from pathlib import Path

changed: set[str] = set()


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    Path(path).write_text(text, encoding="utf-8")
    changed.add(path)


def replace(path: str, old: str, new: str, expected: int = 1) -> None:
    text = read(path)
    count = text.count(old)
    if count != expected:
        raise RuntimeError(
            f"{path}: expected {expected} occurrences, found {count}: {old!r}"
        )
    write(path, text.replace(old, new))


def regex_replace(
    path: str,
    pattern: str,
    replacement: str,
    expected: int = 1,
) -> None:
    text = read(path)
    updated, count = re.subn(
        pattern,
        replacement,
        text,
        flags=re.MULTILINE | re.DOTALL,
    )
    if count != expected:
        raise RuntimeError(
            f"{path}: expected {expected} regex matches, found {count}: {pattern!r}"
        )
    write(path, updated)


IMPORT_PATTERN = re.compile(
    r"(?ms)^import\s+(?P<type>type\s+)?\{(?P<body>[^}]*)\}\s+from\s+"
    r"(?P<quote>[\"'])(?P<module>[^\"']+)(?P=quote)(?P<semi>;?)[ \t]*\n?"
)


def import_name(specifier: str) -> tuple[str, str]:
    core = specifier.strip()
    if core.startswith("type "):
        core = core[5:].strip()
    parts = re.split(r"\s+as\s+", core)
    return parts[0].strip(), parts[-1].strip()


def remove_named_imports(path: str, names: list[str]) -> None:
    text = read(path)
    targets = set(names)
    removed: set[str] = set()

    for match in reversed(list(IMPORT_PATTERN.finditer(text))):
        body = match.group("body")
        specifiers = [item.strip() for item in body.split(",") if item.strip()]
        kept: list[str] = []
        removed_here = False

        for specifier in specifiers:
            imported, local = import_name(specifier)
            matched = targets.intersection({imported, local})
            if matched:
                removed.update(matched)
                removed_here = True
            else:
                kept.append(specifier)

        if not removed_here:
            continue

        if not kept:
            replacement = ""
        else:
            type_prefix = match.group("type") or ""
            quote = match.group("quote")
            module = match.group("module")
            semi = match.group("semi")
            if "\n" in body:
                indent_match = re.search(r"\n([ \t]+)\S", body)
                indent = indent_match.group(1) if indent_match else "  "
                replacement = (
                    f"import {type_prefix}{{\n"
                    + "".join(f"{indent}{specifier},\n" for specifier in kept)
                    + f"}} from {quote}{module}{quote}{semi}\n"
                )
            else:
                replacement = (
                    f"import {type_prefix}{{ {', '.join(kept)} }} "
                    f"from {quote}{module}{quote}{semi}\n"
                )

        text = text[: match.start()] + replacement + text[match.end() :]

    if removed != targets:
        raise RuntimeError(f"{path}: import names not found: {sorted(targets - removed)}")
    write(path, text)


IMPORT_REMOVALS: dict[str, list[str]] = {
    "packages/edge-runtime/function-activation.ts": ["join"],
    "packages/edge-runtime/server-function-config.test.ts": ["readFile"],
    "packages/edge-runtime/worker-pool.ts": ["MessagePort"],
    "packages/management-api/src/cli/project.ts": ["$"],
    "packages/management-api/src/diagnostics/hash.ts": ["stableStringify"],
    "packages/management-api/src/index.ts": [
        "t",
        "authRoutes",
        "deployRoutes",
        "resolveRealtimeTenantHost",
    ],
    "packages/management-api/src/routes/pg-meta.ts": ["logger"],
    "packages/management-api/src/routes/project-services.ts": ["config"],
    "packages/management-api/src/routes/scheduled-functions.ts": ["config", "logger"],
    "packages/management-api/src/routes/sdk-proxy.ts": ["t", "getProjectDb"],
    "packages/management-api/src/services/background-function-worker.ts": ["projectService"],
    "packages/management-api/src/services/branch.service.ts": [
        "mergeProjectConfig",
        "normalizeProjectConfig",
    ],
    "packages/management-api/src/services/database.service.ts": ["shellService"],
    "packages/management-api/src/services/extension.service.ts": ["logger"],
    "packages/management-api/src/services/frontend-release-activation.ts": [
        "RELEASE_ID_PATTERN"
    ],
    "packages/management-api/src/services/frontend-release-storage.ts": [
        "FRONTEND_ACTIVE_RELEASE_SCHEMA"
    ],
    "packages/management-api/src/services/frontend-release.service.ts": [
        "FRONTEND_RELEASE_ARCHIVE_MAX_BYTES"
    ],
    "packages/management-api/src/services/gateway.service.ts": ["customGatewayRouteId"],
    "packages/management-api/src/services/project.service.ts": [
        "storageService",
        "shellService",
    ],
    "packages/management-api/src/services/realtime-bun.service.ts": ["databaseService"],
    "packages/management-api/src/services/storage.service.ts": ["shellService"],
    "packages/management-api/src/services/tenant-runtime.service.ts": [
        "PostgrestPoolReconcileError"
    ],
    "packages/management-api/src/workers/queue.worker.ts": ["TaskStatus"],
    "packages/management-api/tests/integration/sdk-parity.test.ts": ["CI_TENANT_REF"],
    "packages/management-api/tests/scripts/run-official-sdk-compliance.ts": [
        "mkdtempSync"
    ],
    "packages/management-api/tests/scripts/run-openapi-compliance.ts": [
        "getProjectDb",
        "resolveDbName",
    ],
    "packages/management-api/tests/unit/branches.routes.test.ts": ["afterEach"],
    "packages/management-api/tests/unit/database.service.test.ts": ["shellService"],
    "packages/management-api/tests/unit/log-drain-forwarder.worker.test.ts": [
        "beforeEach"
    ],
    "packages/management-api/tests/unit/project-webhooks.routes.test.ts": ["mock"],
    "packages/management-api/tests/unit/project.repository.test.ts": ["afterEach"],
    "packages/management-api/tests/unit/project.service.test.ts": ["mock", "beforeEach"],
    "packages/management-api/tests/unit/scaling.service.test.ts": ["mock"],
    "packages/management-api/tests/unit/shell.service.test.ts": ["mock", "spyOn"],
}

for import_path, import_names in IMPORT_REMOVALS.items():
    remove_named_imports(import_path, import_names)

replace(
    "packages/management-api/src/routes/auth-oauth-server.ts",
    "    jwt_jwks: keyMaterial.jwt_jwks,\n  }\n\n  const nextAuth",
    "    jwt_jwks: keyMaterial.jwt_jwks,\n  };\n\n  const nextAuth",
)
replace(
    "docs/examples/supabase-js-background-task-client.ts",
    "    body,\n    headers = {},\n    retries,\n    timeoutSec,\n    idempotencyKey,\n    method,",
    "    body,\n    headers = {},\n    method,",
)
replace(
    "packages/admin/src/shared/tools/project-create-env.ts",
    "    const { directoryHandle, filename, openFile, fileIdentity, operations } = cleanup;",
    "    const { directoryHandle, openFile } = cleanup;",
)
replace(
    "packages/admin/src/shared/tools/storage-tools.ts",
    "            const fmt = (data: unknown, label: string, fmtFn: (d: any) => string) => {\n"
    "                return Array.isArray(data) ? fmtFn(data) : JSON.stringify(data, null, 2);\n"
    "            };\n\n",
    "",
)
replace(
    "packages/edge-runtime/port-guard.ts",
    "  const originalCreateSocket = dgram.createSocket;\n",
    "",
)
replace(
    "packages/edge-runtime/worker-pool.test.ts",
    "for (const [key, value] of Object.entries(metrics))",
    "for (const [, value] of Object.entries(metrics))",
    expected=2,
)
replace(
    "packages/management-api/scripts/check-swagger-coverage.ts",
    "    let foundOptionsObject = false;\n    let braceDepth = 0;\n",
    "",
)
for endpoint in ("pause", "restore", "restart"):
    replace(
        "packages/management-api/src/cli/project.ts",
        f'        const result = await apiRequest("POST", `/v1/projects/${{ref}}/{endpoint}`);',
        f'        await apiRequest("POST", `/v1/projects/${{ref}}/{endpoint}`);',
    )
replace("packages/management-api/src/doctor.ts", 'import os from "node:os";\n', "")
replace(
    "packages/management-api/src/doctor.ts",
    '            const testRef = `smoke-test-${Math.random().toString(36).substring(7)}`;\n\n',
    "",
)
replace(
    "packages/management-api/src/routes/auth.ts",
    "      const updatedSettings = await projectService.updateProjectSettings(params.ref, {",
    "      await projectService.updateProjectSettings(params.ref, {",
)
replace(
    "packages/management-api/src/routes/project-config.ts",
    "            const currentSaml =\n"
    "              (currentAuth.saml as Record<string, unknown>) || {};\n",
    "",
)
replace(
    "packages/management-api/src/routes/sdk-proxy.ts",
    "    const authHeaders: Record<string, string> = {};\n",
    "",
)
replace(
    "packages/management-api/src/services/edge-function.service.ts",
    "async function readFunctionConfig(ref: string, slug: string): Promise<EdgeFunctionConfig> {\n"
    "  return (await readFunctionManifestState(ref, slug)).config;\n"
    "}\n\n",
    "",
)
replace(
    "packages/management-api/src/services/shell.service.ts",
    "    // Parse database connection info from DATABASE_URL\n"
    "    const dbUrl = config.databaseUrl;\n"
    "    const dbUrlMatch = dbUrl.match(/postgresql:\\/\\/([^:]+):([^@]+)@([^:]+):(\\d+)\\//);\n\n",
    "",
)
replace(
    "packages/management-api/src/services/tenant-runtime.service.ts",
    "            const res = await fetch(`${config.s3Endpoint}/minio/health/live`, {",
    "            await fetch(`${config.s3Endpoint}/minio/health/live`, {",
)
replace(
    "packages/management-api/tests/unit/frontend-release-archive.test.ts",
    "    view.writeUInt32LE(entries[1].dataEnd, central + 42);",
    "    view.writeUInt32LE(entries[1].dataEnd, secondCentral + 42);",
)
replace(
    "packages/management-api/tests/unit/gateway.service.test.ts",
    '        const loadsAfterCreate = calls.filter((c) => c.method === "POST" && c.url.endsWith("/load")).length;\n\n'
    "        // Now disable - should clean up",
    '        const loadsAfterCreate = calls.filter((c) => c.method === "POST" && c.url.endsWith("/load")).length;\n'
    "        expect(loadsAfterCreate).toBeGreaterThan(0);\n\n"
    "        // Now disable - should clean up",
)
replace(
    "packages/management-api/tests/unit/grafana.routes.test.ts",
    "const app = new Elysia().use(grafanaProxyRoutes);\n",
    "",
)
replace(
    "packages/management-api/tests/unit/log-drain-forwarder.worker.test.ts",
    "// Mock the DB module\n"
    "const sqlFn = mock(() => Promise.resolve([]));\n"
    'const { sql: sqlMock } = await import("../../src/db") as { sql: unknown } as { sql: ReturnType<typeof mock> };\n'
    "// We can't easily mock the static import, so we'll test the exported functions\n"
    "// by verifying they don't throw and handle the no-projects case gracefully.\n\n",
    "// Exercise the exported lifecycle without replacing the worker's static DB import.\n\n",
)
replace(
    "packages/management-api/tests/unit/logical-backup.service.test.ts",
    "  LogicalBackupContractError,\n",
    "",
)
regex_replace(
    "packages/management-api/tests/unit/project.service.test.ts",
    r'\n// Mock 依赖\n.*?\n(?=describe\("ProjectService",)',
    "\n",
)
replace(
    "packages/supacloud-lite/src/runtime/auth/password.ts",
    "const ITERATIONS = 100_000\n\n",
    "",
)
replace(
    "packages/supacloud-lite/src/runtime/storage/image-transform-cache.ts",
    "      if (this.inFlight.get(key) === transform) this.inFlight.delete(key)",
    "      this.inFlight.delete(key)",
)
replace(
    "packages/web-console/src/lib/api.ts",
    "    if (studioSessionRefreshPromise === refreshPromise) {\n"
    "      studioSessionRefreshPromise = null;\n"
    "    }",
    "    studioSessionRefreshPromise = null;",
)
replace(
    "packages/management-api/src/routes/storage.ts",
    "return status(502, { message: 'Image transform failed: ${errText}', code: '502' });",
    "return status(502, { message: `Image transform failed: ${errText}`, code: '502' });",
)

schema_path = "packages/management-api/tests/unit/supabase-schema.test.ts"
schema_text = read(schema_path)
helper_anchor = (
    'function readRepoFile(relativePath: string): string {\n'
    '  return readFileSync(resolve(import.meta.dir, "../..", relativePath), "utf8");\n'
    '}\n'
)
helper = (
    helper_anchor
    + '\nfunction sqlModuleInterpolation(name: keyof typeof SQL_MODULES): string {\n'
    + '  return `\\${SQL_MODULES["${name}"]}`;\n'
    + '}\n'
)
if schema_text.count(helper_anchor) != 1:
    raise RuntimeError(f"{schema_path}: helper anchor changed")
schema_text = schema_text.replace(helper_anchor, helper, 1)
interpolation_pattern = re.compile(r"'\$\{SQL_MODULES\[\"([^\"]+)\"\]\}'")
schema_text, interpolation_count = interpolation_pattern.subn(
    lambda match: f'sqlModuleInterpolation("{match.group(1)}")',
    schema_text,
)
if interpolation_count != 12:
    raise RuntimeError(
        f"{schema_path}: expected 12 literal interpolation assertions, "
        f"found {interpolation_count}"
    )
write(schema_path, schema_text)

print(f"Updated {len(changed)} files")
for path in sorted(changed):
    print(path)
