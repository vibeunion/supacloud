import { Elysia, t, status } from "elysia";
import { getHealth, getMetrics } from '../services/monitor.service';

const ErrorResponse = t.Object({ error: t.String() });

export const monitorRoutes = new Elysia({ prefix: "/v1/monitor" })
    .get('/health', async ({ query }) => {
        if (!query.ip) return status(400, { error: 'IP is required' });
        return await getHealth(query.ip);
    }, {
        query: t.Object({ ip: t.Optional(t.String()) }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
        },
        detail: { tags: ["monitor"], summary: "Check node health" },
    })
    .get('/metrics', async ({ query }) => {
        if (!query.ip) return status(400, { error: 'IP is required' });
        return await getMetrics(query.ip);
    }, {
        query: t.Object({ ip: t.Optional(t.String()) }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
        },
        detail: { tags: ["monitor"], summary: "Get node metrics" },
    });
