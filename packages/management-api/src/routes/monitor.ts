import { Elysia } from "elysia";
import { MonitorService } from '../services/monitor.service';

export const monitorRoutes = new Elysia({ prefix: "/v1/monitor" })
    .get('/health', async ({ query }: any) => {
        const ip = query.ip;
        if (!ip) throw new Error('IP is required');
        return await MonitorService.getHealth(ip);
    })
    .get('/metrics', async ({ query }: any) => {
        const ip = query.ip;
        if (!ip) throw new Error('IP is required');
        return await MonitorService.getMetrics(ip);
    });
