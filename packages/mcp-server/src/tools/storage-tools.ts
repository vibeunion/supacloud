/**
 * Storage Tools - S3 bucket and file management
 * Maps to Management API: /v1/storage/*
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpTransport } from "../transports/http";

export function registerStorageTools(server: McpServer, http: HttpTransport): void {
    server.tool(
        "get_storage_status",
        "Get S3/MinIO storage backend status",
        {},
        async () => {
            const res = await http.get("/v1/storage/status");
            return {
                content: [{
                    type: "text",
                    text: res.ok ? JSON.stringify(res.data, null, 2) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "list_storage_buckets",
        "List all storage buckets for a project",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/storage/${ref}/buckets`);
            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatBuckets(res.data) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "list_storage_files",
        "List files in a storage bucket",
        {
            ref: z.string().describe("Project ref"),
            bucket: z.string().describe("Bucket name"),
        },
        async ({ ref, bucket }) => {
            const res = await http.get(`/v1/storage/${ref}/buckets/${bucket}/files`);
            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatFiles(res.data) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );

    server.tool(
        "delete_storage_file",
        "Delete a file from a storage bucket",
        {
            ref: z.string().describe("Project ref"),
            bucket: z.string().describe("Bucket name"),
            filename: z.string().describe("File name to delete"),
        },
        async ({ ref, bucket, filename }) => {
            const res = await http.delete(`/v1/storage/${ref}/buckets/${bucket}/files/${filename}`);
            return {
                content: [{
                    type: "text",
                    text: res.ok
                        ? `✅ File ${filename} deleted from ${bucket}`
                        : `❌ Deletion failed (${res.status})`,
                }],
            };
        }
    );
    server.tool(
        "upload_base64_file",
        "Upload a test file payload to a storage bucket using Base64 encoding",
        {
            ref: z.string().describe("Project ref"),
            bucket: z.string().describe("Bucket name"),
            filename: z.string().describe("Target filename/path"),
            base64_content: z.string().describe("Base64 encoded file content"),
            mime_type: z.string().default("application/octet-stream").describe("MIME type"),
        },
        async ({ ref, bucket, filename, base64_content, mime_type }) => {
            try {
                // Decode base64 to buffer to inject into FormData
                const buffer = Buffer.from(base64_content, "base64");
                const blob = new Blob([buffer], { type: mime_type });
                
                const formData = new FormData();
                formData.append("file", blob, filename);

                const res = await http.postMultipart(`/v1/storage/${ref}/buckets/${bucket}/upload`, formData);
                
                return {
                    content: [{
                        type: "text",
                        text: res.ok
                            ? `✅ File ${filename} successfully uploaded to ${bucket}`
                            : `❌ Upload failed (${res.status}): ${JSON.stringify(res.data)}`,
                    }],
                };
            } catch (err: any) {
                return {
                    content: [{
                        type: "text",
                        text: `❌ Error uploading file: ${err.message}`,
                    }],
                };
            }
        }
    );
}

function formatBuckets(data: unknown): string {
    if (!Array.isArray(data)) return JSON.stringify(data, null, 2);
    if (data.length === 0) return "No storage buckets found.";
    let output = `📦 Storage Buckets (${data.length}):\n\n`;
    for (const b of data) {
        const bucket = b as { name?: string; public?: boolean; created_at?: string };
        const pub = bucket.public ? "🔓 public" : "🔒 private";
        output += `  - ${bucket.name || "unknown"} (${pub})\n`;
    }
    return output;
}

function formatFiles(data: unknown): string {
    if (!Array.isArray(data)) return JSON.stringify(data, null, 2);
    if (data.length === 0) return "No files in bucket.";
    let output = `📁 Files (${data.length}):\n\n`;
    for (const f of data) {
        const file = f as { name?: string; size?: number; created_at?: string };
        const size = file.size ? `${(file.size / 1024).toFixed(1)}KB` : "?";
        output += `  - ${file.name || "unknown"} (${size})\n`;
    }
    return output;
}
