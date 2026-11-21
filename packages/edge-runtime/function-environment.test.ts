import { expect, test } from "bun:test";
import { projectFunctionEnvironment } from "./function-environment";

const env = {
  APP_FA_DATABASE_URL: "scoped-app-login",
  APP_OTHER_DATABASE_URL: "another-app-login",
  DATABASE_URL: "legacy-custom-secret",
  SUPABASE_URL: "project-api",
  SUPABASE_SERVICE_ROLE_KEY: "project-server-key",
  SUPACLOUD_INTERNAL_REST_URL: "project-rest",
  SUPACLOUD_IMAGE_TRANSFORM_URL: "project-image-transform",
  JWT_SECRET: "signing-secret",
  FA_SUPAUTH_ISSUER: "central-auth",
};

test("Functions using legacy environment injection do not receive app database bindings", () => {
  const { APP_FA_DATABASE_URL, APP_OTHER_DATABASE_URL, ...legacy } = env;
  expect(projectFunctionEnvironment(env, {})).toEqual(legacy);
});

test("trusted scoped Functions can bind one database and opt into the existing project API", () => {
  const secrets = ["APP_FA_DATABASE_URL", "FA_SUPAUTH_ISSUER"];
  expect(projectFunctionEnvironment(env, { secrets })).toEqual({
    APP_FA_DATABASE_URL: env.APP_FA_DATABASE_URL,
    FA_SUPAUTH_ISSUER: env.FA_SUPAUTH_ISSUER,
  });
  expect(projectFunctionEnvironment(env, { secrets, bindings: ["project_api"] })).toEqual({
    APP_FA_DATABASE_URL: env.APP_FA_DATABASE_URL,
    FA_SUPAUTH_ISSUER: env.FA_SUPAUTH_ISSUER,
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    SUPACLOUD_INTERNAL_REST_URL: env.SUPACLOUD_INTERNAL_REST_URL,
    SUPACLOUD_IMAGE_TRANSFORM_URL: env.SUPACLOUD_IMAGE_TRANSFORM_URL,
  });
});
