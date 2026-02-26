import { Elysia } from "elysia";

export const userRoutes = new Elysia({ prefix: "/v1" })
    .get("/profile", async () => {
        // 模拟 Supabase 官方 profile 响应
        return {
            id: "00000000-0000-0000-0000-000000000000",
            primary_email: "admin@supacloud.local",
            username: "admin",
            first_name: "Supa",
            last_name: "Cloud",
            mobile: null,
            is_alpha_user: true,
        };
    })
    .get("/me", async () => {
        return {
            id: "00000000-0000-0000-0000-000000000000",
            email: "admin@supacloud.local",
        };
    });
