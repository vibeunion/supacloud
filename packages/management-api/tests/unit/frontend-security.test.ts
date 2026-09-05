import { describe, expect, test } from "bun:test";
import {
  normalizeFrontendCertificateDomain,
  normalizeFrontendCustomDomain,
  normalizeFrontendEnvVars,
  sanitizeFrontendGitUrl,
  toFrontendDeploymentResponse,
} from "../../src/utils/frontend-security";

describe("frontend security boundaries", () => {
  test("keeps normal project build variables available while reserving host controls", () => {
    expect(normalizeFrontendEnvVars({
      SUPABASE_URL: "https://project.example.com",
      SUPABASE_ANON_KEY: "public-key",
      VITE_API_BASE: "/api",
    })).toEqual({
      SUPABASE_URL: "https://project.example.com",
      SUPABASE_ANON_KEY: "public-key",
      VITE_API_BASE: "/api",
    });

    expect(() => normalizeFrontendEnvVars({ SUPACLOUD_MASTER_TOKEN: "secret" })).toThrow(
      "Reserved frontend environment variable",
    );
    expect(() => normalizeFrontendEnvVars({ NODE_OPTIONS: "--require ./hook.js" })).toThrow(
      "Reserved frontend environment variable",
    );
  });

  test("normalizes domains at the management boundary and preserves certificate wildcards", () => {
    expect(normalizeFrontendCustomDomain(" HTTPS://WWW.Example.COM./ ")).toBe("www.example.com");
    expect(normalizeFrontendCertificateDomain("*.Example.COM.")).toBe("*.example.com");
    expect(() => normalizeFrontendCustomDomain("example.com/path")).toThrow("Invalid custom domain");
    expect(() => normalizeFrontendCertificateDomain("https://example.com/path")).toThrow(
      "Invalid certificate domain",
    );
  });

  test("does not expose deployment logs or secret values in deployment responses", () => {
    const response = toFrontendDeploymentResponse({
      id: "deploy123",
      project_ref: "project123",
      name: "site",
      framework: "static",
      domain: "site.example.com",
      custom_domains: [],
      build_command: "npm run build",
      output_dir: "dist",
      install_command: "npm install",
      node_version: "20",
      env_vars: { NPM_TOKEN_VALUE: "secret-value" },
      status: "success",
      created_at: "2026-09-04T00:00:00.000Z",
      updated_at: "2026-09-04T00:00:00.000Z",
      deployment_url: "https://site.example.com",
      build_log: "token=secret-value",
      deploy_tokens: [{
        id: "token123",
        name: "ci",
        token: "raw-token",
        created_at: "2026-09-04T00:00:00.000Z",
      }],
    });

    expect(response).not.toHaveProperty("build_log");
    expect(response.env_vars).toEqual({ NPM_TOKEN_VALUE: "********" });
    expect(response.deploy_tokens).toEqual([{
      id: "token123",
      name: "ci",
      created_at: "2026-09-04T00:00:00.000Z",
      last_used_at: undefined,
    }]);
  });

  test("preserves repository usability without exposing embedded Git credentials", () => {
    expect(sanitizeFrontendGitUrl("https://build-user:build-secret@git.example.com/org/repo.git"))
      .toBe("https://git.example.com/org/repo.git");
    const response = toFrontendDeploymentResponse({
      id: "deploy123",
      project_ref: "project123",
      name: "site",
      framework: "static",
      domain: "site.example.com",
      custom_domains: [],
      build_command: "",
      output_dir: ".",
      install_command: "",
      node_version: "20",
      env_vars: {},
      status: "pending",
      created_at: "2026-09-04T00:00:00.000Z",
      updated_at: "2026-09-04T00:00:00.000Z",
      deployment_url: "https://site.example.com",
      git_url: "https://build-user:build-secret@git.example.com/org/repo.git",
    });
    expect(response.git_url).toBe("https://git.example.com/org/repo.git");
  });
});
