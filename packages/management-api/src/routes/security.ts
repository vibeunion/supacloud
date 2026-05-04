import { Elysia, t, status } from "elysia";
import { addFirewallRule, removeFirewallRule, requestSsl } from '../services/security.service';
import { requireAdminAuth } from '../middleware/auth';
import { isIP } from "node:net";

async function adminOnly(request: Request) {
    const authError = await requireAdminAuth(request);
    if (authError) return status(authError.status, authError.body);
}

function isValidPort(port: number): boolean {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isValidIpOrCidr(value: string): boolean {
    const [ip, prefix] = value.split("/");
    if (!isIP(ip)) return false;
    if (prefix === undefined) return true;
    if (!/^\d{1,3}$/.test(prefix)) return false;
    const bits = Number(prefix);
    return isIP(ip) === 4 ? bits >= 0 && bits <= 32 : bits >= 0 && bits <= 128;
}

function isValidHostname(value: string): boolean {
    if (value.length > 253 || value.includes("..")) return false;
    return /^(?=.{1,253}$)(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$/.test(value);
}

export const securityRoutes = new Elysia({ prefix: "/v1/security" })
    .post('/firewall/allow', async ({ body, request }) => {
        const denied = await adminOnly(request);
        if (denied) return denied;
        const { port, ip } = body;
        if (!isValidPort(port) || !isValidIpOrCidr(ip)) {
            return status(400, { error: "Invalid firewall rule input" });
        }
        return await addFirewallRule(port, ip);
    }, {
        body: t.Object({ port: t.Number(), ip: t.String() })
    })
    .post('/firewall/deny', async ({ body, request }) => {
        const denied = await adminOnly(request);
        if (denied) return denied;
        const { port, ip } = body;
        if (!isValidPort(port) || !isValidIpOrCidr(ip)) {
            return status(400, { error: "Invalid firewall rule input" });
        }
        return await removeFirewallRule(port, ip);
    }, {
        body: t.Object({ port: t.Number(), ip: t.String() })
    })
    .post('/ssl/request', async ({ body, request }) => {
        const denied = await adminOnly(request);
        if (denied) return denied;
        const { domain } = body;
        if (!isValidHostname(domain)) {
            return status(400, { error: "Invalid domain" });
        }
        return await requestSsl(domain);
    }, {
        body: t.Object({ domain: t.String() })
    });
