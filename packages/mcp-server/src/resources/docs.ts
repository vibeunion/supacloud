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
}
