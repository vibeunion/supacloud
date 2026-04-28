import { Elysia, t, status } from "elysia";
import { logger } from "../utils/logger";
import { ScalingService } from "../services/scaling.service";
import { requireAdminAuth } from "../middleware/auth";

export const scalingRoutes = new Elysia({ prefix: "/v1/projects/:ref/upgrade" })
    .post("/", async ({ params, body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);

        // Since ScalingService.checkAndScale is currently designed for automatic metric-based decisions,
        // here we provide a manual upgrade trigger wrapper
        const { target_tier } = body as { target_tier: string };

        // Here we call the underlying scale method (bypassing metric restrictions for forced execution)
        // TypeScript may complain because the method is marked private, we temporarily force use any
        try {
            await ScalingService.verticalScale(params.ref, target_tier);
            return { success: true, message: `Project ${params.ref} upgrade to ${target_tier} initiated.` };
        } catch (err: unknown) {
                        return status(500, { success: false, message: (err instanceof Error ? err.message : String(err)), code: "500" });
        }
    }, {
        body: t.Object({
            target_tier: t.String()
        })
    })
    .post("/replicas", async ({ params, body, request }) => {
        const authError = await requireAdminAuth(request);
        if (authError) return status(authError.status, authError.body);

        const { replica_ip } = body as { replica_ip: string };
        try {
            await ScalingService.horizontalScale(params.ref, replica_ip);
            return { success: true, message: `Read replica addition for ${params.ref} initiated.` };
        } catch (err: unknown) {
            return status(500, { success: false, message: (err instanceof Error ? err.message : String(err)), code: "500" });
        }
    }, {
        body: t.Object({
            replica_ip: t.String()
        })
    });
