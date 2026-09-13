/**
 * Storage — Compound tool (5→1)
 */
import * as fs from "node:fs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { HttpTransport } from "../transports/http";

const DEFAULT_UPLOAD_TIMEOUT_MS = 36 * 60_000;
const openAsBlob = (fs as { openAsBlob?: (path: string, options?: { type?: string }) => Promise<Blob> }).openAsBlob;

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    const formatted = index === 0 ? String(value) : (value >= 100 ? value.toFixed(0) : value.toFixed(1));
    return `${formatted} ${units[index]}`;
}

export function registerStorageTools(server: { tool: (...args: any[]) => void }, http: HttpTransport): void {
    server.tool(
        "storage",
        `S3/MinIO storage management.
Actions: status, list_buckets, list_files, upload_base64, delete_file, upload, upload_file`,
        {
            action: withDescription(stringEnum(["status", "list_buckets", "list_files", "upload_base64", "delete_file", "upload", "upload_file"]), "Action"),
            ref: optional(Type.String(), "Project ref (required except for 'status')"),
            bucket: optional(Type.String(), "[list_files/upload/upload_file/upload_base64/delete] Bucket name"),
            filename: optional(Type.String(), "[upload/upload_file/upload_base64/delete] File name/path"),
            file_path: optional(Type.String(), "[upload/upload_file] Local file path to upload"),
            file: optional(Type.String(), "[upload/upload_file] Alias for file_path"),
            path: optional(Type.String(), "[upload/upload_file] Alias for file_path"),
            timeout_ms: optional(Type.Integer({ minimum: 1, maximum: 36 * 60_000 }), "[upload/upload_file] Request timeout in milliseconds (default: 2160000 ms / 36 min)"),
            base64_content: optional(Type.String(), "[upload_base64] Base64 encoded content"),
            mime_type: optional(Type.String(), "[upload_base64/upload/upload_file] MIME type (default: application/octet-stream)"),
        },
        async (args: any) => {
            const { action, ref, bucket, filename, file_path, file, path, timeout_ms, base64_content, mime_type } = args;
            const need = (f: string, v: any) => { if (!v) throw new Error(`'${f}' required for '${action}'`); };
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
                case "upload":
                case "upload_file": {
                    need("ref", ref); need("bucket", bucket);
                    const rawFilePath = file_path ?? file ?? path;
                    if (!rawFilePath || typeof rawFilePath !== "string" || !rawFilePath.trim()) {
                        throw new Error(`'file_path' (or '--file') required for '${action}'`);
                    }
                    const resolvedFilePath = resolve(process.cwd(), rawFilePath.trim());
                    if (!existsSync(resolvedFilePath)) {
                        throw new Error(`File not found: ${resolvedFilePath}`);
                    }
                    const stat = statSync(resolvedFilePath);
                    if (!stat.isFile()) {
                        throw new Error(`Path is not a regular file: ${resolvedFilePath}`);
                    }
                    const uploadFilename = typeof filename === "string" && filename.trim()
                        ? filename.trim()
                        : basename(resolvedFilePath);
                    const mime = typeof mime_type === "string" && mime_type.trim()
                        ? mime_type.trim()
                        : "application/octet-stream";
                    let effectiveTimeout = DEFAULT_UPLOAD_TIMEOUT_MS;
                    if (timeout_ms !== undefined) {
                        const parsed = typeof timeout_ms === "number"
                            ? timeout_ms
                            : (typeof timeout_ms === "string" && /^\d+$/.test(timeout_ms) ? Number(timeout_ms) : NaN);
                        if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > DEFAULT_UPLOAD_TIMEOUT_MS) {
                            throw new Error(`'timeout_ms' must be a positive integer up to ${DEFAULT_UPLOAD_TIMEOUT_MS} ms`);
                        }
                        effectiveTimeout = parsed;
                    }
                    try {
                        const blob = typeof openAsBlob === "function"
                            ? await openAsBlob(resolvedFilePath, { type: mime })
                            : new Blob([readFileSync(resolvedFilePath)], { type: mime });
                        const formData = new FormData();
                        formData.append("file", blob, uploadFilename);
                        formData.append("path", uploadFilename);
                        const res = await http.postMultipart(
                            `/v1/storage/${ref}/buckets/${bucket}/upload`,
                            formData,
                            { timeoutMs: effectiveTimeout },
                        );
                        const errMessage = (res.data as { message?: string; error?: string })?.message
                            || (res.data as { message?: string; error?: string })?.error;
                        text = res.ok
                            ? `✅ File ${uploadFilename} (${formatBytes(stat.size)}) uploaded to ${bucket}`
                            : `❌ Upload failed (${res.status}${errMessage ? `: ${errMessage}` : ""})`;
                    } catch (e: any) {
                        text = `❌ Error: ${e.message}`;
                    }
                    break;
                }
                default: text = `❌ Unknown action: ${action}`;
            }
            return { content: [{ type: "text" as const, text }] };
        }
    );
}
