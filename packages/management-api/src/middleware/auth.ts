import { config } from "../config";
import { sql as metaSql } from "../db";
import { verifyMcpToken } from "../mcp/token";

async function verifyProjectJwt(token: string): Promise<{ role: string; ref: string } | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const header = JSON.parse(atob(parts[0]));
    if (header.alg !== "HS256") return null;

    const payload = JSON.parse(atob(parts[1]));
    if (!payload.sub || !payload.iss) return null;

    const issMatch = payload.iss.match(/supabase\.co|supacloud/);
    if (!issMatch && !payload.role) return null;

    const refFromIss = payload.iss.split(".")[0]?.replace("https://", "") || payload.ref;
    if (!refFromIss) return null;

    const [project] = await metaSql`
      SELECT ref, jwt_secret FROM projects
      WHERE ref = ${refFromIss} AND status = 'active'
      LIMIT 1
    `;
    if (!project?.jwt_secret) return null;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(project.jwt_secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sigBuf = Buffer.from(parts[2], "base64url");
    const data = encoder.encode(`${parts[0]}.${parts[1]}`);
    const valid = await crypto.subtle.verify("HMAC", key, sigBuf, data);
    if (!valid) return null;

    if (payload.exp && payload.exp < Date.now() / 1000) return null;

    return { role: payload.role || "authenticated", ref: refFromIss };
  } catch {
    return null;
  }
}

export async function checkAuth(request: Request): Promise<{ status: number; body: { error: string } } | undefined> {
  const authorization = request.headers.get("authorization");

  if (!authorization) {
    return { status: 401, body: { error: "Missing Authorization header" } };
  }

  if (!authorization.startsWith("Bearer ")) {
    return { status: 401, body: { error: "Invalid Authorization format" } };
  }

  const token = authorization.slice(7);

  if (token === config.masterToken) {
    return undefined;
  }

  try {
    const parts = token.split(".");
    if (parts.length === 2) {
      const [payloadB64, sigHex] = parts;
      const payload = JSON.parse(atob(payloadB64));
      if (payload.exp > Date.now()) {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", encoder.encode(config.masterToken), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(payload)));
        const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
        const sigBuf = Buffer.from(sigHex, 'hex');
        const expBuf = Buffer.from(expected, 'hex');
        if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
           return undefined;
        }
      }
    }
  } catch { }

  const mcpPayload = await verifyMcpToken(token);
  let role = mcpPayload?.role;
  let ref = mcpPayload?.ref;

  if (!mcpPayload && token.includes(".")) {
    const [project] = await metaSql`
      SELECT ref FROM projects
      WHERE service_role_key = ${token}
        AND status = 'active'
      LIMIT 1
    `;
    if (project) {
      role = "project";
      ref = project.ref as string;
    }

    if (!role) {
      const jwtResult = await verifyProjectJwt(token);
      if (jwtResult) {
        role = jwtResult.role === "service_role" ? "project" : "project";
        ref = jwtResult.ref;
      }
    }
  }

  if (role === "admin") {
    return undefined;
  }

  if (role === "project" && ref) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`/v1/projects/${ref}`)) {
      return { status: 403, body: { error: `Token scoped strictly to project ${ref}, cannot access ${url.pathname}` } };
    }
    return undefined;
  }

  return { status: 401, body: { error: "Invalid token" } };
}
