import { Elysia } from "elysia";
import { addFirewallRule, removeFirewallRule, requestSsl } from '../services/security.service';

export const securityRoutes = new Elysia({ prefix: "/v1/security" })
    .post('/firewall/allow', async ({ body }) => {
        const { port, ip } = body as { port: number; ip: string };
        return await addFirewallRule(port, ip);
    })
    .post('/firewall/deny', async ({ body }) => {
        const { port, ip } = body as { port: number; ip: string };
        return await removeFirewallRule(port, ip);
    })
    .post('/ssl/request', async ({ body }) => {
        const { domain } = body as { domain: string };
        return await requestSsl(domain);
    });
