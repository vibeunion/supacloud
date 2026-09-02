import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseRuntimeSourceIdentity,
  readRuntimeSourceIdentity,
  resolveRuntimeSourceIdentity,
} from "./runtime-source-identity";

const packageMetadata = JSON.parse(
  readFileSync(path.resolve(import.meta.dir, "package.json"), "utf8"),
) as { name: string; version: string };
const sourceSha256 = "a".repeat(64);
const temporaryDirectories: string[] = [];

function makeIdentityDirectory(version = packageMetadata.version): {
  directory: string;
  identityFile: string;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "supacloud-edge-identity-"));
  temporaryDirectories.push(directory);
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({
    name: packageMetadata.name,
    version,
  }));
  const identityFile = path.join(directory, ".supacloud-source-identity.json");
  writeFileSync(identityFile, JSON.stringify({
    schemaVersion: 1,
    packageName: packageMetadata.name,
    packageVersion: version,
    sourceSha256,
  }));
  return { directory, identityFile };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Edge Runtime source identity", () => {
  test("reads an exact stable package and source digest", () => {
    const { identityFile } = makeIdentityDirectory();
    expect(readRuntimeSourceIdentity(identityFile)).toEqual({
      packageVersion: packageMetadata.version,
      sourceSha256,
    });
    expect(resolveRuntimeSourceIdentity({
      SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_FILE: identityFile,
    })).toEqual({
      packageVersion: packageMetadata.version,
      sourceSha256,
    });
  });

  test("rejects malformed, extra, prerelease, and mismatched package identities", () => {
    const base = {
      schemaVersion: 1,
      packageName: packageMetadata.name,
      packageVersion: packageMetadata.version,
      sourceSha256,
    };
    expect(() => parseRuntimeSourceIdentity({ ...base, extra: true })).toThrow("fields are invalid");
    expect(() => parseRuntimeSourceIdentity({
      ...base,
      packageVersion: `${packageMetadata.version}-beta.1`,
    })).toThrow("version is invalid");
    expect(() => parseRuntimeSourceIdentity({
      ...base,
      sourceSha256: "A".repeat(64),
    })).toThrow("digest is invalid");

    const { identityFile } = makeIdentityDirectory("9.9.9");
    writeFileSync(path.join(path.dirname(identityFile), "package.json"), JSON.stringify({
      name: packageMetadata.name,
      version: packageMetadata.version,
    }));
    expect(() => readRuntimeSourceIdentity(identityFile)).toThrow("does not match");
  });

  test("requires an absolute explicit identity path", () => {
    expect(() => resolveRuntimeSourceIdentity({
      SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_FILE: "relative/identity.json",
    })).toThrow("must be absolute");
  });

  test("compiled mode reports only the version embedded in the executable", () => {
    const { identityFile } = makeIdentityDirectory();
    expect(resolveRuntimeSourceIdentity({
      SUPACLOUD_EDGE_RUNTIME_IDENTITY_MODE: "compiled",
      SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_FILE: identityFile,
    })).toEqual({
      packageVersion: packageMetadata.version,
      sourceSha256: null,
    });
  });

  test("rejects an unknown runtime identity mode", () => {
    expect(() => resolveRuntimeSourceIdentity({
      SUPACLOUD_EDGE_RUNTIME_IDENTITY_MODE: "binary-ish",
    })).toThrow("identity mode is invalid");
  });
});
