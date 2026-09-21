import { expect, test } from "bun:test";
import { ProjectCliClient } from "../../src/cli/project-client";

test("real project CLI HTTP writes once despite an invalid success receipt", async () => {
  let writes = 0;
  let requestBody: unknown;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      writes++;
      requestBody = await request.json();
      return Response.json({ name: "Fixture", ref: "fixture", status: "COMING_UP" });
    },
  });
  try {
    const client = new ProjectCliClient({ apiUrl: server.url.href, getToken: () => "synthetic-token" });
    await expect(client.create({ name: "Fixture" })).rejects.toThrow("invalid receipt");
    expect(writes).toBe(1);
    expect(requestBody).toEqual({ name: "Fixture", credential_delivery: "response" });
  } finally { await server.stop(true); }
});

test("real project CLI HTTP refuses redirects without contacting their destination", async () => {
  let destinations = 0;
  const destination = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() { destinations++; return Response.json({}); },
  });
  const origin = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() { return Response.redirect(destination.url, 307); },
  });
  try {
    const client = new ProjectCliClient({ apiUrl: origin.url.href, getToken: () => "synthetic-token" });
    await expect(client.rotateKeys("fixture")).rejects.toThrow("invalid receipt");
    expect(destinations).toBe(0);
  } finally {
    await origin.stop(true);
    await destination.stop(true);
  }
});
