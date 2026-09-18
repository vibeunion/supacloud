import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const dockerfile = read("docker/self-host/postgres/Dockerfile");
const workflow = read(".github/workflows/publish-docker-postgres.yml");
const verifier = read("docker/self-host/postgres/verify-extensions.sh");
const publisher = read("scripts/publish-postgres-image.sh");

function withPublisher(run: (fixture: {
  publish: (args?: string[]) => { exitCode: number; stderr: string };
  git: (...args: string[]) => string;
  root: string;
  capture: string;
}) => void) {
  const temporary = mkdtempSync(join(tmpdir(), "postgres-image-"));
  const root = join(temporary, "repo");
  const bin = join(temporary, "bin");
  const capture = join(temporary, "docker-args");
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\n');
  chmodSync(join(bin, "docker"), 0o755);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    git("init", "--initial-branch=main");
    git("config", "user.email", "image-test@example.invalid");
    git("config", "user.name", "Image Contract Test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(root, "publish.sh"), publisher);
    git("add", "publish.sh");
    git("-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture");
    git("remote", "add", "origin", root);
    run({
      root, capture, git,
      publish: (args = []) => {
        const result = Bun.spawnSync(["bash", "publish.sh", ...args], {
          cwd: root,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture,
            POSTGRES_IMAGE: "example.invalid/postgres" },
        });
        return { exitCode: result.exitCode, stderr: result.stderr.toString() };
      },
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

describe("PostgreSQL image release contract", () => {
  test("packages durable independently of runtime activation on both architectures", () => {
    expect(dockerfile).not.toContain("ARG ENABLE_PG_DURABLE");
    expect(dockerfile).toContain('if [ "$TARGETARCH" = arm64 ]');
    expect(dockerfile).toContain("5bbbe46216f9cf1a20a4a14fd16eb9a5b8723656");
    expect(dockerfile).toContain("cargo-pgrx --version 0.16.1");
    expect(dockerfile).toContain("pg-durable-postgresql-18_0.2.8-1_amd64.deb");
    expect(dockerfile).toContain("090028f59b003613b150e61ccd5cdbebe70e69e65361913ad29b1f0b6af9e2bb");
    expect(read("docker/self-host/postgres/initdb/02-durable.sh")).toContain("${ENABLE_PG_DURABLE:-false}");
    expect(read("docker/self-host/docker-compose.yml")).not.toContain("args:\n        ENABLE_PG_DURABLE");
  });

  test("uses checksum-verified official GraphQL packages instead of unpinned apt selection", () => {
    expect(dockerfile).not.toContain("postgresql-18-pg-graphql");
    expect(dockerfile).toContain("pg_graphql-v1.6.2-pg18-${TARGETARCH}-linux-gnu.deb");
    expect(dockerfile).toContain("271063ea2b8f99e00458473aa3b0e6dc0f88d341b2269401dc0b55a77b23970d");
    expect(dockerfile).toContain("3c6c3e0b65a267dc2f26e5048dbf5af288ff8b0c5546c23ec2d74407c818c2ed");
    expect(dockerfile).toContain('echo "$graphql_sha  /tmp/pg_graphql.deb" | sha256sum -c -');
    expect(dockerfile).toContain('rm -f "$target"');
    expect(dockerfile).toContain('cp -L "$source" "$target"');
  });

  test("fails builds unless isolated PostgreSQL can install the exact versions", () => {
    expect(dockerfile).toContain("RUN gosu postgres bash /usr/local/bin/verify-postgres-extensions");
    expect(verifier).toContain("CREATE EXTENSION pg_durable VERSION '0.2.8'");
    expect(verifier).toContain("CREATE EXTENSION pg_graphql VERSION '1.6.2'");
    expect(verifier).toContain("default_version FROM pg_available_extensions");
    expect(verifier).toContain("ON_ERROR_STOP=1");
    expect(verifier).toContain("trap cleanup EXIT");
    expect(verifier).toContain("listen_addresses=''");
  });

  test("publishes through the same guarded multi-architecture path locally and in CI", () => {
    expect(workflow).toContain('".github/workflows/publish-docker-postgres.yml"');
    expect(workflow).toContain('"scripts/publish-postgres-image.sh"');
    expect(workflow).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(workflow).toContain("docker/setup-qemu-action@");
    expect(workflow.indexOf("Set up QEMU")).toBeLessThan(workflow.indexOf("Set up Docker Buildx"));
    expect(workflow).toContain("bash scripts/publish-postgres-image.sh");
    expect(publisher).toContain("git status --porcelain");
    expect(publisher).toContain("git ls-remote --exit-code origin refs/heads/main");
    expect(publisher).toContain('--platform linux/amd64,linux/arm64');
    expect(publisher).toContain('"$image:sha-${revision:0:7}"');
  });

  test("rejects dirty checkouts before invoking Docker", () => {
    withPublisher(({ root, capture, publish }) => {
      writeFileSync(join(root, "uncommitted"), "dirty");
      const result = publish();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("clean checkout");
      expect(existsSync(capture)).toBe(false);
    });
  });

  test("rejects commits outside remote main before invoking Docker", () => {
    withPublisher(({ git, capture, publish }) => {
      git("checkout", "-b", "candidate");
      git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "not main");
      const result = publish();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("current origin/main");
      expect(existsSync(capture)).toBe(false);
    });
  });

  test("rejects overrides that could bypass the verified build target", () => {
    withPublisher(({ capture, publish }) => {
      expect(publish(["--target", "durable-builder"]).exitCode).toBe(1);
      expect(existsSync(capture)).toBe(false);
    });
  });

  test("publishes clean main with the mandatory platform and provenance arguments", () => {
    withPublisher(({ git, capture, publish }) => {
      expect(publish().exitCode).toBe(0);
      const revision = git("rev-parse", "HEAD");
      expect(readFileSync(capture, "utf8").trim().split("\n")).toEqual([
        "buildx", "build", "--platform", "linux/amd64,linux/arm64",
        "--label", `org.opencontainers.image.revision=${revision}`,
        "--tag", `example.invalid/postgres:sha-${revision.slice(0, 7)}`,
        "--tag", "example.invalid/postgres:latest", "--push", "docker/self-host/postgres",
      ]);
    });
  });
});
