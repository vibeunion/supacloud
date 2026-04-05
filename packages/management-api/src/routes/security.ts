import { Elysia, t } from "elysia";
import { addFirewallRule, removeFirewallRule, requestSsl } from '../services/security.service';

export const securityRoutes = new Elysia({ prefix: "/v1/security" })
    .post('/firewall/allow', async ({ body }) => {
        const { port, ip } = body;
        return await addFirewallRule(port, ip);
    }, {
        body: t.Object({ port: t.Number(), ip: t.String() })
    })
    .post('/firewall/deny', async ({ body }) => {
        const { port, ip } = body;
        return await removeFirewallRule(port, ip);
    }, {
        body: t.Object({ port: t.Number(), ip: t.String() })
    })
    .post('/ssl/request', async ({ body }) => {
        const { domain } = body;
        return await requestSsl(domain);
    }, {
        body: t.Object({ domain: t.String() })
    });
