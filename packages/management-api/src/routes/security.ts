import { SecurityService } from '../services/security.service';

export const securityRoutes = (app: any) =>
    app.group('/security', (app: any) =>
        app
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
            })
    );
