import { describe, test, expect, mock } from "bun:test";

// Mock logger to prevent side effects
mock.module("../../src/utils/logger", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import {
  buildStartupMessage,
  buildPasswordMessage,
  buildQuery,
  computeMd5Password,
  parseNotification,
  parseMessages,
} from "../../src/lib/pg-listen";

describe("pg-listen Wire Protocol", () => {
  describe("buildStartupMessage", () => {
    test("should produce correct binary format", () => {
      const msg = buildStartupMessage("postgres", "mydb");
      // First 4 bytes = total length (Int32BE)
      const len = msg.readInt32BE(0);
      expect(len).toBe(msg.length);
      // Bytes 4-7 = protocol version 3.0 = 196608
      const version = msg.readInt32BE(4);
      expect(version).toBe(196608);
      // Rest should contain user\0postgres\0database\0mydb\0
      const paramsStr = msg.subarray(8).toString("utf-8");
      expect(paramsStr).toContain("user\0postgres\0");
      expect(paramsStr).toContain("database\0mydb\0");
      expect(paramsStr).toContain("application_name\0supacloud-listener\0");
      // Must end with double null
      expect(msg[msg.length - 1]).toBe(0);
    });

    test("should include custom application name", () => {
      const msg = buildStartupMessage("user", "db", "my-app");
      const paramsStr = msg.subarray(8).toString("utf-8");
      expect(paramsStr).toContain("application_name\0my-app\0");
    });
  });

  describe("buildPasswordMessage", () => {
    test("should produce correct binary format", () => {
      const msg = buildPasswordMessage("secret123");
      // First byte = 'p' (0x70)
      expect(msg[0]).toBe(0x70);
      // Bytes 1-4 = length (Int32BE) including self but not type byte
      const bodyLen = msg.readInt32BE(1);
      expect(bodyLen).toBe(msg.length - 1);
      // Payload = password + null terminator
      const payload = msg.subarray(5).toString("utf-8");
      expect(payload).toBe("secret123\0");
    });
  });

  describe("buildQuery", () => {
    test("should produce correct Query message", () => {
      const msg = buildQuery("LISTEN task_pending; LISTEN task_completed;");
      // First byte = 'Q' (0x51)
      expect(msg[0]).toBe(0x51);
      // Length field
      const bodyLen = msg.readInt32BE(1);
      expect(bodyLen).toBe(msg.length - 1);
      // SQL content + null terminator
      const sql = msg.subarray(5).toString("utf-8");
      expect(sql).toBe("LISTEN task_pending; LISTEN task_completed;\0");
    });

    test("should handle empty query", () => {
      const msg = buildQuery("");
      expect(msg[0]).toBe(0x51);
      const sql = msg.subarray(5).toString("utf-8");
      expect(sql).toBe("\0");
    });
  });

  describe("computeMd5Password", () => {
    test("should compute md5(md5(password+user)+salt)", () => {
      const salt = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const result = computeMd5Password("postgres", "password", salt);
      // Result should start with "md5"
      expect(result.startsWith("md5")).toBe(true);
      // Should be md5 + 32 hex chars = 35 chars total
      expect(result.length).toBe(35);
    });

    test("should produce consistent results", () => {
      const salt = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
      const r1 = computeMd5Password("user", "pass", salt);
      const r2 = computeMd5Password("user", "pass", salt);
      expect(r1).toBe(r2);
    });

    test("should differ with different salts", () => {
      const salt1 = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const salt2 = Buffer.from([0x05, 0x06, 0x07, 0x08]);
      const r1 = computeMd5Password("user", "pass", salt1);
      const r2 = computeMd5Password("user", "pass", salt2);
      expect(r1).not.toBe(r2);
    });
  });

  describe("parseNotification", () => {
    test("should parse valid NotificationResponse body", () => {
      // Body: pid(4) + channel\0 + payload\0
      const pid = 12345;
      const channel = "task_pending";
      const payload = '{"id":"abc","task_type":"provision_db"}';
      const channelBuf = Buffer.from(channel + "\0", "utf-8");
      const payloadBuf = Buffer.from(payload + "\0", "utf-8");
      const body = Buffer.alloc(4 + channelBuf.length + payloadBuf.length);
      body.writeInt32BE(pid, 0);
      channelBuf.copy(body, 4);
      payloadBuf.copy(body, 4 + channelBuf.length);

      const result = parseNotification(body);
      expect(result).not.toBeNull();
      expect(result!.pid).toBe(12345);
      expect(result!.channel).toBe("task_pending");
      expect(result!.payload).toBe('{"id":"abc","task_type":"provision_db"}');
    });

    test("should return null for too-short body", () => {
      const body = Buffer.from([0x00, 0x00, 0x00]);
      expect(parseNotification(body)).toBeNull();
    });

    test("should return null if channel null terminator missing", () => {
      const body = Buffer.alloc(10, 0x41); // No null bytes after pid
      body.writeInt32BE(1, 0);
      expect(parseNotification(body)).toBeNull();
    });

    test("should handle empty payload", () => {
      const channel = "test";
      const channelBuf = Buffer.from(channel + "\0", "utf-8");
      const payloadBuf = Buffer.from("\0", "utf-8");
      const body = Buffer.alloc(4 + channelBuf.length + payloadBuf.length);
      body.writeInt32BE(99, 0);
      channelBuf.copy(body, 4);
      payloadBuf.copy(body, 4 + channelBuf.length);

      const result = parseNotification(body);
      expect(result).not.toBeNull();
      expect(result!.channel).toBe("test");
      expect(result!.payload).toBe("");
    });
  });

  describe("parseMessages", () => {
    test("should parse a single complete message", () => {
      // Type='Z' (ReadyForQuery), body length=5 (4+1), body=1 byte ('I')
      const msg = Buffer.alloc(6);
      msg[0] = 0x5a; // 'Z'
      msg.writeInt32BE(5, 1); // length = 5 (includes self)
      msg[5] = 0x49; // 'I' (idle)

      const [messages, remaining] = parseMessages(msg);
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("Z");
      expect(messages[0].body.length).toBe(1);
      expect(messages[0].body[0]).toBe(0x49);
      expect(remaining.length).toBe(0);
    });

    test("should parse multiple messages", () => {
      // Two ReadyForQuery messages
      const msg1 = Buffer.alloc(6);
      msg1[0] = 0x5a;
      msg1.writeInt32BE(5, 1);
      msg1[5] = 0x49;

      const msg2 = Buffer.alloc(6);
      msg2[0] = 0x5a;
      msg2.writeInt32BE(5, 1);
      msg2[5] = 0x54; // 'T' (in transaction)

      const combined = Buffer.concat([msg1, msg2]);
      const [messages, remaining] = parseMessages(combined);
      expect(messages.length).toBe(2);
      expect(messages[0].body[0]).toBe(0x49);
      expect(messages[1].body[0]).toBe(0x54);
      expect(remaining.length).toBe(0);
    });

    test("should handle partial message (not enough data)", () => {
      // Only send 3 bytes of a 6-byte message
      const partial = Buffer.alloc(3);
      partial[0] = 0x5a;
      partial.writeInt16BE(0, 1); // incomplete length

      const [messages, remaining] = parseMessages(partial);
      expect(messages.length).toBe(0);
      expect(remaining.length).toBe(3);
    });

    test("should handle complete + partial message", () => {
      // Complete 6-byte message + 3 bytes of another
      const complete = Buffer.alloc(6);
      complete[0] = 0x5a;
      complete.writeInt32BE(5, 1);
      complete[5] = 0x49;

      const partial = Buffer.alloc(3);
      partial[0] = 0x43; // 'C'
      partial[1] = 0x00;
      partial[2] = 0x00;

      const combined = Buffer.concat([complete, partial]);
      const [messages, remaining] = parseMessages(combined);
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("Z");
      expect(remaining.length).toBe(3);
    });

    test("should return empty array for empty buffer", () => {
      const [messages, remaining] = parseMessages(Buffer.alloc(0));
      expect(messages.length).toBe(0);
      expect(remaining.length).toBe(0);
    });

    test("should handle message with declared length exceeding buffer", () => {
      // Type + length says 100 bytes, but buffer only has 10
      const buf = Buffer.alloc(10);
      buf[0] = 0x52; // 'R'
      buf.writeInt32BE(100, 1); // declares 100 bytes body

      const [messages, remaining] = parseMessages(buf);
      expect(messages.length).toBe(0);
      expect(remaining.length).toBe(10);
    });
  });
});
