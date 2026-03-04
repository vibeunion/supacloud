import { Elysia, t } from "elysia";
import { frontendService } from "../services/frontend.service";
import { FrontendFramework, FRAMEWORK_DEFAULTS } from "../types/frontend";

export const frontendRoutes = new Elysia({ prefix: "/v1/projects/:ref/frontend" })
  .get(
    "/deployments",
    async ({ params }) => {
      const deployments = await frontendService.listDeployments(params.ref);
      return { deployments };
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
    }
  )

  .get(
    "/deployments/:id",
    async ({ params, set }) => {
      const deployment = await frontendService.getDeployment(params.ref, params.id);
      if (!deployment) {
        set.status = 404;
        return { error: "Deployment not found" };
      }
      return deployment;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
    }
  )

  .post(
    "/deployments",
    async ({ params, body, set }) => {
      const deployment = await frontendService.createDeployment(params.ref, {
        name: body.name,
        framework: body.framework as FrontendFramework,
        domain: body.domain,
        custom_domains: body.custom_domains,
        build_command: body.build_command,
        output_dir: body.output_dir,
        install_command: body.install_command,
        node_version: body.node_version,
        env_vars: body.env_vars,
      });

      set.status = 201;
      return deployment;
    },
    {
      params: t.Object({
        ref: t.String(),
      }),
      body: t.Object({
        name: t.String({ minLength: 1 }),
        framework: t.String(),
        domain: t.Optional(t.String()),
        custom_domains: t.Optional(t.Array(t.String())),
        build_command: t.Optional(t.String()),
        output_dir: t.Optional(t.String()),
        install_command: t.Optional(t.String()),
        node_version: t.Optional(t.String()),
        env_vars: t.Optional(t.Record(t.String(), t.String())),
      }),
    }
  )

  .patch(
    "/deployments/:id",
    async ({ params, body, set }) => {
      const deployment = await frontendService.updateDeployment(params.ref, params.id, {
        name: body.name,
        domain: body.domain,
        custom_domains: body.custom_domains,
        build_command: body.build_command,
        output_dir: body.output_dir,
        install_command: body.install_command,
        node_version: body.node_version,
        env_vars: body.env_vars,
      });

      if (!deployment) {
        set.status = 404;
        return { error: "Deployment not found" };
      }

      return deployment;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Object({
        name: t.Optional(t.String()),
        domain: t.Optional(t.String()),
        custom_domains: t.Optional(t.Array(t.String())),
        build_command: t.Optional(t.String()),
        output_dir: t.Optional(t.String()),
        install_command: t.Optional(t.String()),
        node_version: t.Optional(t.String()),
        env_vars: t.Optional(t.Record(t.String(), t.String())),
      }),
    }
  )

  .delete(
    "/deployments/:id",
    async ({ params, set }) => {
      const success = await frontendService.deleteDeployment(params.ref, params.id);
      if (!success) {
        set.status = 404;
        return { error: "Deployment not found" };
      }
      return { message: "Deployment deleted successfully" };
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
    }
  )

  .post(
    "/deployments/:id/deploy/git",
    async ({ params, body, set }) => {
      const deployment = await frontendService.getDeployment(params.ref, params.id);
      if (!deployment) {
        set.status = 404;
        return { error: "Deployment not found" };
      }

      const result = await frontendService.deployFromGit(
        params.ref,
        params.id,
        body.git_url,
        body.branch
      );

      return result;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Object({
        git_url: t.String(),
        branch: t.Optional(t.String({ default: "main" })),
      }),
    }
  )

  .post(
    "/deployments/:id/deploy/upload",
    async ({ params, body, set }) => {
      const deployment = await frontendService.getDeployment(params.ref, params.id);
      if (!deployment) {
        set.status = 404;
        return { error: "Deployment not found" };
      }

      const tempDir = `/tmp/frontend-upload-${params.id}`;
      await Bun.write(tempDir + ".zip", body);

      const extractResult = await Bun.$`unzip -o ${tempDir}.zip -d ${tempDir}`.quiet();
      if (extractResult.exitCode !== 0) {
        return {
          success: false,
          deployment_id: params.id,
          url: "",
          build_log: "",
          error: "Failed to extract zip file",
        };
      }

      const result = await frontendService.deployFromSource(params.ref, params.id, tempDir);

      await Bun.$`rm -rf ${tempDir} ${tempDir}.zip`.quiet();

      return result;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.File(),
    }
  )

  .post(
    "/deployments/:id/redeploy",
    async ({ params, set }) => {
      const deployment = await frontendService.getDeployment(params.ref, params.id);
      if (!deployment) {
        set.status = 404;
        return { error: "Deployment not found" };
      }

      const deploymentDir = `/var/supacloud/frontends/${params.ref}/${params.id}`;
      const sourceDir = `${deploymentDir}/source`;

      const result = await frontendService.deployFromSource(params.ref, params.id, sourceDir);
      return result;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
    }
  )

  .get(
    "/deployments/:id/logs",
    async ({ params, set }) => {
      const buildLog = await frontendService.getBuildLog(params.ref, params.id);
      return { logs: buildLog };
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
    }
  )

  .put(
    "/deployments/:id/env",
    async ({ params, body, set }) => {
      const deployment = await frontendService.setEnvVars(params.ref, params.id, body.env_vars);
      if (!deployment) {
        set.status = 404;
        return { error: "Deployment not found" };
      }
      return deployment;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Object({
        env_vars: t.Record(t.String(), t.String()),
      }),
    }
  )

  .post(
    "/deployments/:id/domains",
    async ({ params, body, set }) => {
      const deployment = await frontendService.addCustomDomain(params.ref, params.id, body.domain);
      if (!deployment) {
        set.status = 404;
        return { error: "Deployment not found" };
      }
      return deployment;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Object({
        domain: t.String(),
      }),
    }
  )

  .delete(
    "/deployments/:id/domains/:domain",
    async ({ params, set }) => {
      const deployment = await frontendService.removeCustomDomain(
        params.ref,
        params.id,
        params.domain
      );
      if (!deployment) {
        set.status = 404;
        return { error: "Deployment not found" };
      }
      return deployment;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
        domain: t.String(),
      }),
    }
  )

  .get(
    "/frameworks",
    async () => {
      return {
        frameworks: Object.entries(FRAMEWORK_DEFAULTS).map(([id, config]) => ({
          id,
          name: id.charAt(0).toUpperCase() + id.slice(1).replace("js", "JS").replace("kit", "Kit"),
          defaults: config,
        })),
      };
    }
  )

  .post(
    "/deployments/:id/tokens",
    async ({ params, body, set }) => {
      const result = await frontendService.createDeployToken(params.ref, params.id, body.name);
      if (!result) {
        set.status = 404;
        return { error: "Deployment not found" };
      }
      return result;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Object({
        name: t.String({ minLength: 1 }),
      }),
    }
  )

  .get(
    "/deployments/:id/tokens",
    async ({ params, set }) => {
      const tokens = await frontendService.listDeployTokens(params.ref, params.id);
      return { tokens };
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
    }
  )

  .delete(
    "/deployments/:id/tokens/:tokenId",
    async ({ params, set }) => {
      const success = await frontendService.deleteDeployToken(params.ref, params.id, params.tokenId);
      if (!success) {
        set.status = 404;
        return { error: "Token not found" };
      }
      return { message: "Token deleted successfully" };
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
        tokenId: t.String(),
      }),
    }
  )

  .put(
    "/deployments/:id/git",
    async ({ params, body, set }) => {
      const deployment = await frontendService.setGitConfig(
        params.ref,
        params.id,
        body.git_url,
        body.branch || "main"
      );
      if (!deployment) {
        set.status = 404;
        return { error: "Deployment not found" };
      }
      return deployment;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
      body: t.Object({
        git_url: t.String(),
        branch: t.Optional(t.String({ default: "main" })),
      }),
    }
  )

  .get(
    "/deployments/:id/records",
    async ({ params, set }) => {
      const records = await frontendService.listDeploymentRecords(params.ref, params.id);
      return { records };
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
      }),
    }
  )

  .get(
    "/deployments/:id/records/:recordId",
    async ({ params, set }) => {
      const record = await frontendService.getDeploymentRecord(params.ref, params.id, params.recordId);
      if (!record) {
        set.status = 404;
        return { error: "Record not found" };
      }
      return record;
    },
    {
      params: t.Object({
        ref: t.String(),
        id: t.String(),
        recordId: t.String(),
      }),
    }
  );
