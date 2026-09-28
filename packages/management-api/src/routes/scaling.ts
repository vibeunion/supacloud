import { Elysia, t, status } from "elysia";
import { ScalingService } from "../services/scaling.service";
import { requireAdminAuth } from "../middleware/auth";

export const scalingRoutes = new Elysia({ prefix: "/v1/projects/:ref" })
    .get("/scaling", {
        detail: { tags: ["scaling"], summary: "Get project scaling state" },
    }, async ({ params, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);
        const state = await ScalingService.getScalingState(params.ref);
        if (!state) return status(404, { success: false, message: "Project not found", code: "404" });
        return {
            success: true,
            tiers: ScalingService.listComputeTiers(),
            ...state,
        };
    })
    .post("/scaling/compute", {
        body: t.Object({
            target_tier: t.String()
        }),
        detail: { tags: ["scaling"], summary: "Upgrade project compute tier" },
    }, async ({ params, body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);

        const { target_tier } = body as { target_tier: string };

        try {
            await ScalingService.verticalScale(params.ref, target_tier);
            return { success: true, message: `Project ${params.ref} upgrade to ${target_tier} initiated.` };
        } catch (err: unknown) {
            return status(500, { success: false, message: (err instanceof Error ? err.message : String(err)), code: "500" });
        }
    })
    .post("/scaling", {
        body: t.Object({
            target_tier: t.String()
        }),
        detail: { tags: ["scaling"], summary: "Upgrade project compute tier" },
    }, async ({ params, body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);

        const { target_tier } = body as { target_tier: string };

        try {
            await ScalingService.verticalScale(params.ref, target_tier);
            return { success: true, message: `Project ${params.ref} upgrade to ${target_tier} initiated.` };
        } catch (err: unknown) {
            return status(500, { success: false, message: (err instanceof Error ? err.message : String(err)), code: "500" });
        }
    })
    .post("/upgrade", {
        body: t.Object({
            target_tier: t.String()
        }),
        detail: { tags: ["scaling"], summary: "Upgrade project compute tier" },
    }, async ({ params, body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);

        const { target_tier } = body as { target_tier: string };

        try {
            await ScalingService.verticalScale(params.ref, target_tier);
            return { success: true, message: `Project ${params.ref} upgrade to ${target_tier} initiated.` };
        } catch (err: unknown) {
            return status(500, { success: false, message: (err instanceof Error ? err.message : String(err)), code: "500" });
        }
    })
    .post("/scaling/replicas", {
        body: t.Object({
            replica_ip: t.String(),
            region: t.Optional(t.String()),
        }),
        detail: { tags: ["scaling"], summary: "Add a read replica to project" },
    }, async ({ params, body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);

        const { replica_ip, region } = body as { replica_ip: string; region?: string };
        try {
            const replica = await ScalingService.horizontalScale(params.ref, replica_ip, region || "local");
            return { success: true, message: `Read replica addition for ${params.ref} initiated.`, replica };
        } catch (err: unknown) {
            return status(500, { success: false, message: (err instanceof Error ? err.message : String(err)), code: "500" });
        }
    })
    .post("/upgrade/replicas", {
        body: t.Object({
            replica_ip: t.String(),
            region: t.Optional(t.String()),
        }),
        detail: { tags: ["scaling"], summary: "Add a read replica to project" },
    }, async ({ params, body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);

        const { replica_ip, region } = body as { replica_ip: string; region?: string };
        try {
            const replica = await ScalingService.horizontalScale(params.ref, replica_ip, region || "local");
            return { success: true, message: `Read replica addition for ${params.ref} initiated.`, replica };
        } catch (err: unknown) {
            return status(500, { success: false, message: (err instanceof Error ? err.message : String(err)), code: "500" });
        }
    });
