import { Elysia, t } from "elysia";
import { ScalingService } from "../services/scaling.service";

export const scalingRoutes = new Elysia({ prefix: "/v1/projects/:ref/upgrade" })
    .post("/", async ({ params, body, set }: any) => {
        // 由于 ScalingService.checkAndScale 目前设计为基于自动指标判断，
        // 这里做一个手动的升级触发封装
        const { target_tier } = body as { target_tier: string };

        // 此处我们调用 underlying scale 方法（绕过了指标限制强制执行）
        // TypeScript 可能会报错因为方法被标记为 private，我们暂且强制使用 any
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
