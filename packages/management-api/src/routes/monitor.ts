import { jsonResponseSchema } from "../utils/json-response-schema";
import { Elysia, t, status } from "elysia";
import { getHealth, getMetrics } from '../services/monitor.service';

const ErrorResponse = t.Object({ error: t.String() });

export const monitorRoutes = new Elysia({ prefix: "/v1/monitor" })
    .get('/health', {
        query: t.Object({ ip: t.Optional(t.String()) }),
        response: {
            200: jsonResponseSchema,
            400: ErrorResponse,
        },
        detail: { tags: ["monitor"], summary: "Check node health" },
    }, async ({ query, set }) => {
        if (!query.ip) { set.status = 400; return { error: 'IP is required' }; }
        return { ...await getHealth(query.ip) };
    })
    .get('/metrics', {
        query: t.Object({ ip: t.Optional(t.String()) }),
        response: {
            200: jsonResponseSchema,
            400: ErrorResponse,
        },
        detail: { tags: ["monitor"], summary: "Get node metrics" },
    }, async ({ query, set }) => {
        if (!query.ip) { set.status = 400; return { error: 'IP is required' }; }
        return { ...await getMetrics(query.ip) };
    });
