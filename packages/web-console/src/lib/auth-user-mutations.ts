import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { apiClient, ensureMutationSucceeded } from "./api";
import {
  authUserRoutePrefix, createAuthUserPath, inviteAuthUserPath,
  createAuthUserSchema, inviteAuthUserSchema, authUserResultSchema,
  type AuthUserResult,
} from "./generated/auth-user-mutations";

// Forms explicitly opt into writable fields; never infer them from user records.
const createFormSchema = Type.Object({
  ...Type.Required(Type.Pick(createAuthUserSchema, ["email", "password"])).properties,
  email_confirm: createAuthUserSchema.properties.email_confirm,
}, { additionalProperties: false });
const inviteFormSchema = Type.Object({
  ...Type.Pick(inviteAuthUserSchema, ["email"]).properties,
}, { additionalProperties: false });
export type CreateAuthUserInput = Static<typeof createFormSchema>;
export type InviteAuthUserInput = Static<typeof inviteFormSchema>;

export function createAuthUserClient(
  projectRef: string,
  request: typeof apiClient = apiClient,
) {
  if (!projectRef || !/^[A-Za-z0-9_-]+$/.test(projectRef)) throw new Error("Invalid project reference");
  const base = authUserRoutePrefix.replace(":ref", encodeURIComponent(projectRef));

  async function send<S extends TSchema>(
    path: string, schema: S, input: Static<S>, fallback: string, signal?: AbortSignal,
  ): Promise<AuthUserResult> {
    signal?.throwIfAborted();
    if (!Value.Check(schema, input)) throw new Error("Invalid auth user input");
    const response = await request(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    let result: AuthUserResult | undefined;
    await ensureMutationSucceeded(response, fallback, value => {
      if (!Value.Check(authUserResultSchema, value)) throw new Error("Invalid auth user response");
      result = value;
    }, { signal });
    if (!result) throw new Error(fallback);
    return result;
  }

  return {
    create: (input: CreateAuthUserInput, signal?: AbortSignal) =>
      send(createAuthUserPath, createFormSchema, input, "新建用户失败", signal),
    invite: (input: InviteAuthUserInput, signal?: AbortSignal) =>
      send(inviteAuthUserPath, inviteFormSchema, input, "邀请用户失败", signal),
  };
}
