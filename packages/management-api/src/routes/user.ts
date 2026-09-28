import { Elysia } from "elysia";

export const userRoutes = new Elysia({ prefix: "/v1" })
    .get("/profile", { detail: { tags: ["user"], summary: "Get user profile" } }, async () => {
        // Simulate Supabase official profile response
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
    .get("/me", { detail: { tags: ["user"], summary: "Get current user" } }, async () => {
        return {
            id: "00000000-0000-0000-0000-000000000000",
            email: "admin@supacloud.local",
        };
    });
