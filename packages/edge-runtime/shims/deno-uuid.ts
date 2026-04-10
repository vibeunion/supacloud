// Deno uuid/mod.ts shim
// Maps Deno's UUID generations to Node/Bun's crypto

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export function generate() {
  return crypto.randomUUID();
}

export const v1 = {
  generate: () => crypto.randomUUID() // fallback
};

export const v4 = {
  generate: () => crypto.randomUUID(),
  validate: (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
};

export const v5 = {
  generate: () => crypto.randomUUID() // fallback
};
