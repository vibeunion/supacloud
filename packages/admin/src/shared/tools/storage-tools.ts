/**
 * Storage — Compound tool (5→1)
 */
import { Type } from "@sinclair/typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { HttpTransport } from "../transports/http";

export function registerStorageTools(server: { tool: (...args: any[]) => void }, http: HttpTransport): void {
    server.tool(
        "storage",
        `S3/MinIO storage management.
Actions: status, list_buckets, list_files, upload_base64, delete_file`,
        {
            action: withDescription(stringEnum(["status", "list_buckets", "list_files", "upload_base64", "delete_file"]), "Action"),
            ref: optional(Type.String(), "Project ref (required except for 'status')"),
            bucket: optional(Type.String(), "[list_files/upload/delete] Bucket name"),
            filename: optional(Type.String(), "[upload/delete] File name/path"),
            base64_content: optional(Type.String(), "[upload_base64] Base64 encoded content"),
            mime_type: optional(Type.String(), "[upload_base64] MIME type (default: application/octet-stream)"),
        },
        async (args: any) => {
            const { action, ref, bucket, filename, base64_content, mime_type } = args;
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
