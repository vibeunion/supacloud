import { expect, mock, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { createHmac, pbkdf2Sync } from "node:crypto";

mock.module("../../src/utils/logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

import {
  buildScramSha256Proof, buildStartupMessage, createPgListener, parseConnectionUrl,
  parseMessages, parseNotification, verifyScramServerFinal,
} from "../../src/lib/pg-listen";

function frame(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(type.charCodeAt(0), 0);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

function auth(method: number, body = Buffer.alloc(0)): Buffer {
  const code = Buffer.alloc(4);
  code.writeInt32BE(method);
  return frame("R", Buffer.concat([code, body]));
}

function notification(channel = "jobs", payload = "fixture"): Buffer {
  return frame("A", Buffer.concat([Buffer.alloc(4), Buffer.from(`${channel}\0${payload}\0`)]));
}

const ready = frame("Z", Buffer.from("I"));
const accepted = Buffer.concat([auth(0), ready]);
const subscribed = Buffer.concat([frame("C", Buffer.from("LISTEN\0")), ready]);

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture event");
    await Bun.sleep(5);
  }
}

async function withServer(
  receive: (socket: Socket, type: string, body: Buffer) => void,
  run: (port: number) => Promise<void>,
) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let startup = true;
    let buffer = Buffer.alloc(0);
    socket.on("data", (data) => {
      if (typeof data === "string") throw new Error("Expected binary fixture data");
      buffer = Buffer.concat([buffer, data]);
      if (startup) {
        if (buffer.length < 4) return;
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) return;
        const body = buffer.subarray(4, length);
        buffer = buffer.subarray(length);
        startup = false;
        receive(socket, "startup", body);
      }
      const [messages, remaining] = parseMessages(buffer);
      buffer = Buffer.from(remaining);
      for (const message of messages) receive(socket, message.type, message.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP fixture address");
    await run(address.port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function options(port: number) {
  return {
    url: `postgresql://fixture:synthetic@127.0.0.1:${port}/fixture`,
    channels: ["jobs"],
    onNotification() {},
    keepaliveIntervalMs: 0,
    reconnectDelay: 10,
  };
}

test.each([-1, 0, 3, 1_048_577])("rejects invalid frame length %i", (length) => {
  const header = Buffer.alloc(5);
  header.writeUInt8(0x52);
  header.writeInt32BE(length, 1);
  expect(() => parseMessages(header)).toThrow("message length");
});

test("rejects malformed notification strings and trailing bytes", () => {
  expect(parseNotification(Buffer.concat([Buffer.alloc(4), Buffer.from("\0payload\0")]))).toBeNull();
  expect(parseNotification(Buffer.concat([Buffer.alloc(4), Buffer.from("jobs\0payload\0extra")]))).toBeNull();
  expect(parseNotification(Buffer.concat([Buffer.alloc(4), Buffer.from([0xff, 0, 0])]))).toBeNull();
  expect(() => buildStartupMessage("user\0admin", "db")).toThrow("NUL");
});

test("decodes URL credentials and supports IPv6 and default ports", () => {
  expect(parseConnectionUrl("postgres://u%40r:p%3Aa%40s@[::1]/my%20db?sslmode=disable")).toEqual({
    hostname: "::1", username: "u@r", password: "p:a@s", database: "my db", port: 5432,
  });
});

test.each([
  "not-postgres://u:secret@localhost/db", "postgres://u:secret@localhost:0/db",
  "postgres://u:secret@localhost/db?sslmode=require", "postgres://u:secret@localhost/",
  "postgres://u:secret@localhost/db%00x", "postgres://u:secret%ZZ@localhost/db",
])("rejects invalid URL without exposing credentials: %s", (url) => {
  expect(() => parseConnectionUrl(url)).toThrow("Invalid or unsupported PostgreSQL listener URL");
  try {
    parseConnectionUrl(url);
  } catch (error) {
    expect(String(error)).not.toContain("secret");
  }
});

test.each([
  "r=other,s=c2FsdA==,i=4096", "r=client,s=c2FsdA==,i=4096",
  "r=clientserver,s=!!!,i=4096", "r=clientserver,s=c2FsdB==,i=4096",
  "r=clientserver,s=c2FsdA==,i=0", "r=clientserver,s=c2FsdA==,i=1000001",
  "r=clientserver,s=c2FsdA==,i=1junk", "r=clientserver,s=c2FsdA==,i=1e3",
  "r=clientserver,s=c2FsdA==,i=4096,i=4096", "m=required,r=clientserver,s=c2FsdA==,i=4096",
])("rejects malformed SCRAM challenge %s", (challenge) => {
  expect(() => buildScramSha256Proof("synthetic", challenge, "n=,r=client")).toThrow("SCRAM");
});

test("checks server signature, including duplicate attributes and remote rejection", () => {
  const proof = buildScramSha256Proof("synthetic", "r=clientserver,s=c2FsdA==,i=4096", "n=,r=client");
  const signature = proof.serverSignature.toString("base64");
  expect(() => verifyScramServerFinal(`v=${signature}`, proof.serverSignature)).not.toThrow();
  for (const final of [`v=${signature},v=${signature}`, `e=invalid-proof,v=${signature}`,
    `v=${Buffer.alloc(32).toString("base64")}`, "v=AA==", "v=!!!"]) {
    expect(() => verifyScramServerFinal(final, proof.serverSignature)).toThrow("SCRAM");
  }
});

test.each([
  ["premature ready", ready],
  ["truncated auth", frame("R", Buffer.alloc(2))],
  ["short MD5 salt", auth(5, Buffer.alloc(3))],
  ["missing SASL mechanism", auth(10, Buffer.from("SCRAM-SHA-256-PLUS\0\0"))],
  ["unterminated SASL mechanism", auth(10, Buffer.from("SCRAM-SHA-256\0"))],
  ["premature SCRAM continuation", auth(11, Buffer.from("r=x,s=c2FsdA==,i=4096"))],
  ["premature SCRAM final", auth(12, Buffer.from("v=AA=="))],
  ["authentication bypass", Buffer.concat([auth(10, Buffer.from("SCRAM-SHA-256\0\0")), accepted])],
  ["notification before authentication", notification()],
  ["duplicate authentication", Buffer.concat([auth(0), auth(0)])],
] as const)("closes on %s without issuing LISTEN or reconnecting", async (_name, response) => {
  let connects = 0;
  let disconnected = false;
  let queries = 0;
  await withServer((socket, type) => {
    if (type === "startup") {
      connects++;
      socket.on("close", () => { disconnected = true; });
      socket.write(response);
    }
    if (type === "Q") queries++;
  }, async (port) => {
    const listener = createPgListener(options(port));
    try {
      await until(() => disconnected);
      await Bun.sleep(30);
      expect(queries).toBe(0);
      expect(connects).toBe(1);
    } finally {
      listener.close();
    }
  });
});

test("handles fragmented replies, quotes channels and releases the actual socket", async () => {
  let query = "";
  let disconnected = false;
  const channel = 'jobs"; SELECT 42; --';
  const received: string[] = [];
  await withServer((socket, type, body) => {
    if (type === "startup") {
      socket.on("close", () => { disconnected = true; });
      socket.write(accepted.subarray(0, 3));
      setImmediate(() => socket.write(accepted.subarray(3)));
    } else if (type === "Q") {
      query = body.toString();
      socket.write(Buffer.concat([subscribed, notification(channel)]));
    }
  }, async (port) => {
    const listener = createPgListener({
      ...options(port), channels: [channel],
      onNotification(name, payload) { received.push(`${name}:${payload}`); },
    });
    try {
      await until(() => received.length === 1);
      expect(query).toBe('LISTEN "jobs""; SELECT 42; --";\0');
      expect(received).toEqual([`${channel}:fixture`]);
      listener.close();
      await until(() => disconnected);
    } finally {
      listener.close();
    }
  });
});

test.each(["verified", "forged", "omitted"] as const)("SCRAM %s server proof gates subscriptions", async (mode) => {
  let disconnected = false;
  let subscribedCount = 0;
  let firstBare = "";
  let serverFirst = "";
  let phase = 0;
  await withServer((socket, type, body) => {
    if (type === "startup") {
      socket.on("close", () => { disconnected = true; });
      socket.write(auth(10, Buffer.from("SCRAM-SHA-256\0\0")));
    } else if (type === "p" && phase++ === 0) {
      firstBare = body.toString().match(/n,,(n=,r=.+)$/)?.[1] ?? "";
      const nonce = firstBare.match(/r=(.+)$/)?.[1];
      if (!nonce) throw new Error("Missing fixture nonce");
      serverFirst = `r=${nonce}server,s=c2FsdA==,i=4096`;
      socket.write(auth(11, Buffer.from(serverFirst)));
    } else if (type === "p") {
      const finalWithoutProof = body.toString().split(",p=")[0];
      if (!finalWithoutProof) throw new Error("Missing fixture proof");
      const salted = pbkdf2Sync("synthetic", Buffer.from("salt"), 4096, 32, "sha256");
      const key = createHmac("sha256", salted).update("Server Key").digest();
      const signature = createHmac("sha256", key).update(`${firstBare},${serverFirst},${finalWithoutProof}`).digest();
      if (mode === "forged") signature.fill(0);
      const final = mode === "omitted" ? Buffer.alloc(0)
        : auth(12, Buffer.from(`v=${signature.toString("base64")}`));
      socket.write(Buffer.concat([final, accepted]));
    } else if (type === "Q") {
      subscribedCount++;
      socket.write(subscribed);
    }
  }, async (port) => {
    const listener = createPgListener(options(port));
    try {
      await until(() => mode === "verified" ? subscribedCount === 1 : disconnected);
      expect(subscribedCount).toBe(mode === "verified" ? 1 : 0);
    } finally {
      listener.close();
    }
  });
});

test("reconnects after transport loss and resubscribes", async () => {
  let connects = 0;
  let queries = 0;
  await withServer((socket, type) => {
    if (type === "startup") {
      connects++;
      socket.write(accepted);
    } else if (type === "Q") {
      queries++;
      socket.write(subscribed);
      if (queries === 1) setTimeout(() => socket.destroy(), 10);
    }
  }, async (port) => {
    const listener = createPgListener(options(port));
    try {
      await until(() => queries === 2);
      expect(connects).toBe(2);
    } finally {
      listener.close();
    }
  });
});

test("bounds an unresponsive handshake and cancels retries on close", async () => {
  let connects = 0;
  await withServer((_socket, type) => {
    if (type === "startup") connects++;
  }, async (port) => {
    const listener = createPgListener({ ...options(port), connectionTimeoutMs: 20 });
    try {
      await until(() => connects >= 2);
      listener.close();
      const count = connects;
      await Bun.sleep(60);
      expect(connects).toBe(count);
    } finally {
      listener.close();
    }
  });
});

test("close during connection setup prevents startup and reconnect", async () => {
  let startupCount = 0;
  await withServer((_socket, type) => {
    if (type === "startup") startupCount++;
  }, async (port) => {
    const listener = createPgListener(options(port));
    listener.close();
    await Bun.sleep(40);
    expect(startupCount).toBe(0);
  });
});
