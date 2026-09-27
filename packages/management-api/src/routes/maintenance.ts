import { jsonResponseSchema } from "../utils/json-response-schema";
import { Elysia, t, status } from "elysia";
import { switchover, reloadConfig, addReplica } from '../services/maintenance.service';
import { requireAdminAuth } from '../middleware/auth';

const ErrorResponse = t.Object({ error: t.String() });

export const maintenanceRoutes = new Elysia({ prefix: "/v1/maintenance" })
    .post('/switchover', {
        body: t.Object({
            cluster: t.Optional(t.String()),
            candidate: t.Optional(t.String()),
        }),
        response: { 200: jsonResponseSchema },
        detail: { tags: ["maintenance"], summary: "Perform database switchover" },
    }, async ({ body, request, set }) => {
        const authError = await requireAdminAuth(request);
        if (authError) { set.status = authError.status; return authError.body; }
        return await switchover(body.cluster, body.candidate);
    })
    .post('/reload', {
        body: t.Object({ ip: t.Optional(t.String()) }),
        response: {
            200: jsonResponseSchema,
            400: ErrorResponse,
        },
        detail: { tags: ["maintenance"], summary: "Reload node configuration" },
    }, async ({ body, request, set }) => {
        const authError = await requireAdminAuth(request);
        if (authError) { set.status = authError.status; return authError.body; }
        if (!body.ip) return status(400, { error: 'Node IP is required' });
        return await reloadConfig(body.ip);
    })
    .post('/replicas', {
        body: t.Object({ ip: t.Optional(t.String()) }),
        response: {
            200: jsonResponseSchema,
            400: ErrorResponse,
        },
        detail: { tags: ["maintenance"], summary: "Add a read replica" },
    }, async ({ body, request, set }) => {
        const authError = await requireAdminAuth(request);
        if (authError) { set.status = authError.status; return authError.body; }
        if (!body.ip) return status(400, { error: 'Replica IP is required' });
        return await addReplica(body.ip);
    });
