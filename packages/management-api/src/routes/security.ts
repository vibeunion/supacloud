import { Elysia } from "elysia";
import { SecurityService } from '../services/security.service';

export const securityRoutes = new Elysia({ prefix: "/v1/security" })
    .post('/firewall/allow', async ({ body }: any) => {
        const { port, ip } = body as { port: number; ip: string };
        return await SecurityService.addFirewallRule(port, ip);
    })
    .post('/firewall/deny', async ({ body }: any) => {
        const { port, ip } = body as { port: number; ip: string };
        return await SecurityService.removeFirewallRule(port, ip);
    })
    .post('/ssl/request', async ({ body }: any) => {
        const { domain } = body as { domain: string };
        return await SecurityService.requestSsl(domain);
    });
