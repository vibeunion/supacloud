/**
 * Storage — Compound tool (5→1)
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpTransport } from "../transports/http";

export function registerStorageTools(server: McpServer, http: HttpTransport): void {
    server.tool(
        "storage",
        `S3/MinIO storage management.
Actions: status, list_buckets, list_files, upload_base64, delete_file`,
        {
            action: z.enum(["status", "list_buckets", "list_files", "upload_base64", "delete_file"]).describe("Action"),
            ref: z.string().optional().describe("Project ref (required except for 'status')"),
            bucket: z.string().optional().describe("[list_files/upload/delete] Bucket name"),
            filename: z.string().optional().describe("[upload/delete] File name/path"),
            base64_content: z.string().optional().describe("[upload_base64] Base64 encoded content"),
            mime_type: z.string().optional().describe("[upload_base64] MIME type (default: application/octet-stream)"),
        },
        async ({ action, ref, bucket, filename, base64_content, mime_type }) => {
            const need = (f: string, v: any) => { if (!v) throw new Error(`'${f}' required for '${action}'`); };
            const fmt = (data: unknown, label: string, fmtFn: (d: any) => string) => {
                return Array.isArray(data) ? fmtFn(data) : JSON.stringify(data, null, 2);
            };

            let text: string;
            switch (action) {
                case "status":
                    text = JSON.stringify((await http.get("/v1/storage/status")).data, null, 2);
                    break;
                case "list_buckets": {
                    need("ref", ref);
                    const res = await http.get(`/v1/storage/${ref}/buckets`);
                    if (!res.ok) { text = `❌ Failed (${res.status})`; break; }
                    const buckets = res.data as any[];
                    if (!Array.isArray(buckets) || !buckets.length) { text = "No buckets found."; break; }
                    text = `📦 Buckets (${buckets.length}):\n` + buckets.map((b: any) => `  - ${b.name} (${b.public ? "🔓 public" : "🔒 private"})`).join("\n");
                    break;
                }
                case "list_files": {
                    need("ref", ref); need("bucket", bucket);
                    const res = await http.get(`/v1/storage/${ref}/buckets/${bucket}/files`);
                    if (!res.ok) { text = `❌ Failed (${res.status})`; break; }
                    const files = res.data as any[];
                    if (!Array.isArray(files) || !files.length) { text = "No files."; break; }
                    text = `📁 Files (${files.length}):\n` + files.map((f: any) => `  - ${f.name} (${f.size ? (f.size / 1024).toFixed(1) + "KB" : "?"})`).join("\n");
                    break;
                }
                case "upload_base64": {
                    need("ref", ref); need("bucket", bucket); need("filename", filename); need("base64_content", base64_content);
                    try {
                        const buffer = Buffer.from(base64_content!, "base64");
                        const blob = new Blob([buffer], { type: mime_type || "application/octet-stream" });
                        const formData = new FormData();
                        formData.append("file", blob, filename!);
                        const res = await http.postMultipart(`/v1/storage/${ref}/buckets/${bucket}/upload`, formData);
                        text = res.ok ? `✅ File ${filename} uploaded to ${bucket}` : `❌ Upload failed (${res.status})`;
                    } catch (e: any) { text = `❌ Error: ${e.message}`; }
                    break;
                }
                case "delete_file":
                    need("ref", ref); need("bucket", bucket); need("filename", filename);
                    text = (await http.delete(`/v1/storage/${ref}/buckets/${bucket}/files/${filename}`)).ok
                        ? `✅ File ${filename} deleted` : `❌ Failed`;
                    break;
                default: text = `❌ Unknown action: ${action}`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );
}
