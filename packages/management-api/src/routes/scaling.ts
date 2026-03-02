import { Elysia, t } from "elysia";
import { ScalingService } from "../services/scaling.service";

export const scalingRoutes = new Elysia({ prefix: "/v1/projects/:ref/upgrade" })
    .post("/", async ({ params, body, set }: any) => {
        // Since ScalingService.checkAndScale is currently designed for automatic metric-based decisions,
        // here we provide a manual upgrade trigger wrapper
        const { target_tier } = body as { target_tier: string };

        // Here we call the underlying scale method (bypassing metric restrictions for forced execution)
        // TypeScript may complain because the method is marked private, we temporarily force use any
        try {
            await (ScalingService as any).verticalScale(params.ref, target_tier);
            return { success: true, message: `Project ${params.ref} upgrade to ${target_tier} initiated.` };
        } catch (err: any) {
            set.status = 500;
            return { success: false, error: err.message };
        }
    }, {
        body: t.Object({
            target_tier: t.String()
        })
    })
    .post("/replicas", async ({ params, body, set }: any) => {
        const { replica_ip } = body as { replica_ip: string };
        try {
            await (ScalingService as any).horizontalScale(params.ref, replica_ip);
            return { success: true, message: `Read replica addition for ${params.ref} initiated.` };
        } catch (err: any) {
            set.status = 500;
            return { success: false, error: err.message };
        }
    }, {
        body: t.Object({
            replica_ip: t.String()
        })
    });
