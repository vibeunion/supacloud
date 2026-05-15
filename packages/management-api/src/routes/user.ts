import { Elysia } from "elysia";

export const userRoutes = new Elysia({ prefix: "/v1" })
    .get("/profile", async () => {
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
    }, { detail: { tags: ["user"], summary: "Get user profile" } })
    .get("/me", async () => {
        return {
            id: "00000000-0000-0000-0000-000000000000",
            email: "admin@supacloud.local",
        };
    }, { detail: { tags: ["user"], summary: "Get current user" } });
