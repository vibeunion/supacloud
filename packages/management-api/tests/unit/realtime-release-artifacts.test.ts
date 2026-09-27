import { expect, test } from "bun:test";
import {
  ContainerRealtimeTenantSchemaRpc,
  OFFICIAL_REALTIME_IMAGE_DIGEST,
  type CommandRunner,
} from "../../src/services/realtime-tenant-schema-reconcile.service";

const run: CommandRunner = async (argv, options) => {
  const child = Bun.spawn([...argv], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: options?.stdin ? new Blob([options.stdin]) : "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

// Opt in after pulling the pinned image; no database or existing container is used.
test.skipIf(process.env.SUPACLOUD_TEST_REALTIME_ARTIFACTS !== "1")(
  "official Realtime image matches all reconciliation schema and profile trust roots",
  async () => {
    const container = `supacloud-realtime-assets-${crypto.randomUUID()}`;
    const started = await run([
      "docker", "run", "--detach", "--rm", "--pull=never", "--network=none",
      "--name", container, "--entrypoint", "sleep",
      `public.ecr.aws/supabase/realtime@${OFFICIAL_REALTIME_IMAGE_DIGEST}`, "120",
    ]);
    expect(started.exitCode, started.stderr).toBe(0);
    try {
      const identity = await run(["docker", "exec", container, "id", "-u"]);
      expect(identity.exitCode, identity.stderr).toBe(0);
      expect(identity.stdout.trim()).not.toBe("0");
      const rpc = new ContainerRealtimeTenantSchemaRpc(run, {
        runtime: "docker",
        container,
        resolveTarget: async () => { throw new Error("artifact check must not access a database"); },
      });
      const artifact = await rpc.walColumnRepairArtifact();
      expect(artifact.schemaFiles).toHaveLength(22);
      expect(artifact.schemaTreeSha256).toBe(
        "89cae15f960cb164424ebdee2d8e29b5276f72438c87aaa91c442104ef822984",
      );
      expect(artifact.profileSha256).toBe(
        "b1109c7cfa7132351e8bd2a6cffbff5e60c01dcd9b54f9e2103a7de5b1e540a3",
      );
    } finally {
      const removed = await run(["docker", "rm", "--force", container]);
      expect(removed.exitCode, removed.stderr).toBe(0);
    }
  },
  60_000,
);
