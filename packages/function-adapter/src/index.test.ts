import { describe, expect, test } from "bun:test";
import { createSupaCloudHandler } from "./index";
import { createSvelteKitHandler } from "./sveltekit";

describe("function adapters", () => {
  test("marks route-aware Fetch handlers", async () => {
    const handler = createSupaCloudHandler(
      (request) => Response.json({ path: new URL(request.url).pathname }),
      "hono",
    );
    expect(handler.__supacloud).toEqual({ framework: "hono", routeAware: true });
    expect(await handler.fetch(new Request("https://edge/functions/v1/api/users"))).toEqual(
      expect.any(Response),
    );
  });

  test("bridges SvelteKit respond without listening", async () => {
    const handler = createSvelteKitHandler({
      respond: async (request) => Response.json({ path: new URL(request.url).pathname }),
    });
    expect(handler.__supacloud.framework).toBe("sveltekit-function");
    expect(await (await handler.fetch(new Request("https://edge/functions/v1/api"))).json())
      .toEqual({ path: "/functions/v1/api" });
  });
});
