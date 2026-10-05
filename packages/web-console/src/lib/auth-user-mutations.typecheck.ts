import { createAuthUserClient } from "./auth-user-mutations";

const client = createAuthUserClient("project-a");
const result: Promise<{ id: string; email?: string | null }> = client.create({
  email: "user@example.test", password: "secret", email_confirm: true,
});
void result;
// @ts-expect-error Create form requires a password.
client.create({ email: "user@example.test" });
// @ts-expect-error Confirmation is a boolean.
client.create({ email: "user@example.test", password: "secret", email_confirm: "true" });
// @ts-expect-error Forms cannot set administrative metadata.
client.invite({ email: "user@example.test", app_metadata: { role: "admin" } });
// @ts-expect-error Results are bound to the route, not caller-selected types.
const wrong: Promise<{ id: number }> = client.invite({ email: "user@example.test" });
void wrong;
