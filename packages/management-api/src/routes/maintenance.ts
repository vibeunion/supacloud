import { Elysia, t, status } from "elysia";
import { switchover, reloadConfig, addReplica } from '../services/maintenance.service';
import { requireAdminAuth } from '../middleware/auth';

const ErrorResponse = t.Object({ error: t.String() });

export const maintenanceRoutes = new Elysia({ prefix: "/v1/maintenance" })
    .post('/switchover', async ({ body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);
        return await switchover(body.cluster, body.candidate);
    }, {
        body: t.Object({
            cluster: t.Optional(t.String()),
            candidate: t.Optional(t.String()),
        }),
        response: { 200: t.Any() },
    })
    .post('/reload', async ({ body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);
        if (!body.ip) return status(400, { error: 'Node IP is required' });
        return await reloadConfig(body.ip);
    }, {
        body: t.Object({ ip: t.Optional(t.String()) }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
        },
    })
    .post('/replicas', async ({ body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);
        if (!body.ip) return status(400, { error: 'Replica IP is required' });
        return await addReplica(body.ip);
    }, {
        body: t.Object({ ip: t.Optional(t.String()) }),
        response: {
            200: t.Any(),
            400: ErrorResponse,
        },
    });
