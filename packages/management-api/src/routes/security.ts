import { Elysia, t, status } from "elysia";
import { addFirewallRule, removeFirewallRule, requestSsl } from '../services/security.service';
import { requireAdminAuth } from '../middleware/auth';

async function adminOnly(request: Request) {
    const authError = await requireAdminAuth(request);
    if (authError) return status(authError.status, authError.body);
}

export const securityRoutes = new Elysia({ prefix: "/v1/security" })
    .post('/firewall/allow', async ({ body, request }) => {
        const denied = await adminOnly(request);
        if (denied) return denied;
        const { port, ip } = body;
        return await addFirewallRule(port, ip);
    }, {
        body: t.Object({ port: t.Number(), ip: t.String() })
    })
    .post('/firewall/deny', async ({ body, request }) => {
        const denied = await adminOnly(request);
        if (denied) return denied;
        const { port, ip } = body;
        return await removeFirewallRule(port, ip);
    }, {
        body: t.Object({ port: t.Number(), ip: t.String() })
    })
    .post('/ssl/request', async ({ body, request }) => {
        const denied = await adminOnly(request);
        if (denied) return denied;
        const { domain } = body;
        return await requestSsl(domain);
    }, {
        body: t.Object({ domain: t.String() })
    });
