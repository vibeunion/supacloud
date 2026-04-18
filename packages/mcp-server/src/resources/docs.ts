import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SQL_AND_RLS_DOCS = `
# Supabase PostgreSQL & RLS Guidelines

## General Best Practices
- Every table MUST have \`id uuid primary key default gen_random_uuid()\`.
- Every table MUST have \`created_at timestamptz default now()\`.
- Every table MUST employ Row Level Security. Run \`ALTER TABLE tablename ENABLE ROW LEVEL SECURITY;\`.

## RLS Examples
-- Allow everyone to read public posts:
CREATE POLICY "Public profiles are viewable by everyone." ON profiles FOR SELECT USING (true);

-- Allow users to update their own entries:
CREATE POLICY "Users can update own profile." ON profiles FOR UPDATE USING (auth.uid() = id);

-- Advanced: Checking custom claims or role from users table:
CREATE POLICY "Admins can delete posts" ON posts FOR DELETE USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');
`;

const AUTH_DOCS = `
# Supabase Auth Tips

- The authenticated user details are managed globally in \`auth.users\`.
- Do not add custom columns to \`auth.users\`. Instead, create a \`public.profiles\` table that references \`auth.users(id)\`.
- User ID is accessible in RLS via \`auth.uid()\`.
- JWT claims are accessible in SQL via \`auth.jwt()\`.

## Hook / Trigger Pattern
\`\`\`sql
-- Create a profile automatically when a user signs up
CREATE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, avatar_url)
  VALUES (new.id, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url');
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
\`\`\`
`;

const STORAGE_DOCS = `
# Supabase Storage

- Buckets are stored in \`storage.buckets\`.
- Files/objects are stored in \`storage.objects\`.
- All storage interactions respect RLS setup on the \`storage.objects\` table.

## RLS for Storage
\`\`\`sql
-- Allow users to upload to their own folder within an 'avatars' bucket
CREATE POLICY "Anyone can upload an avatar." ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Allow everyone to view avatars
CREATE POLICY "Avatar images are publicly accessible." ON storage.objects
FOR SELECT USING ( bucket_id = 'avatars' );
\`\`\`
`;

const EDGE_FUNCTIONS_DOCS = `
# Supabase Edge Functions (Deno)

- Edge functions run on Deno. Always use Typescript and standard Deno HTTP APIs.
- Utilize \`Deno.serve(async (req) => { ... })\` for the entry point.
- Read environment variables using \`Deno.env.get("MY_VAR")\`.

## Boilerplate
\`\`\`typescript
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  
  const authHeader = req.headers.get("Authorization")!;
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: authHeader } } }
  );
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  return new Response(JSON.stringify({ message: "Hello", userId: user.id }), {
    headers: { "Content-Type": "application/json" },
  });
});
\`\`\`
`;

const SUPACLOUD_OVERVIEW_DOCS = `
# SupaCloud Platform

- SupaCloud provides identical APIs to Supabase (Kong, PostgREST, GoTrue, Realtime, Storage).
- The Local MCP tool can be run instantly via \`npx supacloud-mcp@latest\`.
- In addition to Supabase-compatible APIs, SupaCloud provides **Frontend Hosting** and **Edge Functions** with server-side bundling.
`;

const FRONTEND_HOSTING_DOCS = `
# Frontend Hosting (Static Sites & SSR)

SupaCloud includes a built-in frontend hosting platform similar to Vercel/Netlify. It supports static sites, SPAs, and SSR frameworks.

## Supported Frameworks

| Framework   | Build Command     | Output Dir  | Type   |
|-------------|-------------------|-------------|--------|
| static      | _(none)_          | \`.\`         | Static |
| react       | \`npm run build\`   | \`build\`     | SPA    |
| vue         | \`npm run build\`   | \`dist\`      | SPA    |
| svelte      | \`npm run build\`   | \`build\`     | SPA    |
| sveltekit   | \`npm run build\`   | \`build\`     | SSR    |
| nextjs      | \`npm run build\`   | \`.next\`     | SSR    |
| nuxt        | \`npm run build\`   | \`.output\`   | SSR    |
| astro       | \`npm run build\`   | \`dist\`      | Static |

## Deployment Flow

1. **Create a deployment** — register a site with its framework and optional custom domain
2. **Deploy** — push code via Git URL or file upload; the server installs dependencies, builds, and configures Angie routing
3. **Access** — your site is live at the configured domain with auto-HTTPS

## MCP Workflow Example

\\\`\\\`\\\`
# 1. Create a deployment
create_frontend_deployment(ref="abc123", name="my-app", framework="react", domain="app.example.com")

# 2. Deploy from Git
deploy_frontend_git(ref="abc123", id="<deployment_id>", git_url="https://github.com/user/repo.git")

# 3. Or deploy from a local zip bundle
deploy_frontend_upload(ref="abc123", id="<deployment_id>", zip_path="./dist/site.zip")

# 4. Check build logs if something went wrong
get_frontend_build_logs(ref="abc123", id="<deployment_id>")

# 5. Add a custom domain
add_frontend_domain(ref="abc123", id="<deployment_id>", domain="www.example.com")

# 6. Set build-time environment variables
set_frontend_env(ref="abc123", id="<deployment_id>", env_vars={ VITE_API_URL: "https://api.example.com" })

# 7. Re-deploy after env change
redeploy_frontend(ref="abc123", id="<deployment_id>")
\\\`\\\`\\\`

## Architecture

\\\`\\\`\\\`
Browser → Angie (HTTPS + auto-cert) → Static files on disk / SSR process
\\\`\\\`\\\`

- **Static sites**: Angie serves files directly from the build output directory
- **SSR apps**: Angie reverse-proxies to a managed Node/Bun process
- **Custom domains**: Auto-configured with ACME (Let's Encrypt) certificates
- **SPA fallback**: \`try_files $uri $uri/ /index.html\` for client-side routing

## REST API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET    | \`/v1/projects/:ref/frontend/deployments\`          | List deployments |
| POST   | \`/v1/projects/:ref/frontend/deployments\`          | Create deployment |
| GET    | \`/v1/projects/:ref/frontend/deployments/:id\`      | Get deployment details |
| PATCH  | \`/v1/projects/:ref/frontend/deployments/:id\`      | Update deployment config |
| DELETE | \`/v1/projects/:ref/frontend/deployments/:id\`      | Delete deployment |
| POST   | \`/v1/projects/:ref/frontend/deployments/:id/deploy/git\` | Deploy from Git |
| POST   | \`/v1/projects/:ref/frontend/deployments/:id/deploy/upload\` | Deploy from zip upload |
| POST   | \`/v1/projects/:ref/frontend/deployments/:id/redeploy\` | Re-build from cached source |
| GET    | \`/v1/projects/:ref/frontend/deployments/:id/logs\` | Get build logs |
| PUT    | \`/v1/projects/:ref/frontend/deployments/:id/env\`  | Set env vars |
| POST   | \`/v1/projects/:ref/frontend/deployments/:id/domains\` | Add custom domain |
| DELETE | \`/v1/projects/:ref/frontend/deployments/:id/domains/:domain\` | Remove custom domain |
| GET    | \`/v1/projects/:ref/frontend/frameworks\`           | List supported frameworks |
`;

export function registerDocsResources(server: McpServer) {
    server.resource(
        "docs://supabase/sql",
        "Supabase SQL & RLS Specs",
        async (uri) => ({
            contents: [{ uri: uri.href, text: SQL_AND_RLS_DOCS, mimeType: "text/markdown" }]
        })
    );

    server.resource(
        "docs://supabase/auth",
        "Supabase Auth & Triggers",
        async (uri) => ({
            contents: [{ uri: uri.href, text: AUTH_DOCS, mimeType: "text/markdown" }]
        })
    );

    server.resource(
        "docs://supabase/storage",
        "Supabase Storage Policies",
        async (uri) => ({
            contents: [{ uri: uri.href, text: STORAGE_DOCS, mimeType: "text/markdown" }]
        })
    );

    server.resource(
        "docs://supabase/functions",
        "Supabase Deno Edge Functions",
        async (uri) => ({
            contents: [{ uri: uri.href, text: EDGE_FUNCTIONS_DOCS, mimeType: "text/markdown" }]
        })
    );

    server.resource(
        "docs://supacloud/overview",
        "SupaCloud Specific Patterns",
        async (uri) => ({
            contents: [{ uri: uri.href, text: SUPACLOUD_OVERVIEW_DOCS, mimeType: "text/markdown" }]
        })
    );

    server.resource(
        "docs://supacloud/frontend-hosting",
        "Frontend Hosting — Static Sites & SSR Deployment",
        async (uri) => ({
            contents: [{ uri: uri.href, text: FRONTEND_HOSTING_DOCS, mimeType: "text/markdown" }]
        })
    );
}
