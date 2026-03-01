import { readdir, readFile, stat } from "fs/promises";
import { join, extname } from "path";
import { writeFileSync } from "fs";

// @ts-ignore
const BUILD_DIR = join(import.meta.dirname, "../../web-console/build");
// @ts-ignore
const OUT_FILE = join(import.meta.dirname, "../src/assets.gen.ts");

const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".txt": "text/plain",
    ".map": "application/json",
};

async function walkDir(dir: string, fileList: string[] = []) {
    const files = await readdir(dir);
    for (const file of files) {
        const filePath = join(dir, file);
        const fileStat = await stat(filePath);
        if (fileStat.isDirectory()) {
            await walkDir(filePath, fileList);
        } else {
            fileList.push(filePath);
        }
    }
    return fileList;
}

async function packAssets() {
    console.log(`[PackAssets] Scanning directory: ${BUILD_DIR}`);

    try {
        await stat(BUILD_DIR);
    } catch (e) {
        console.error(`[PackAssetsError] Build directory not found! Run 'bun run build' in web-console first.`);
        process.exit(1);
    }

    const files = await walkDir(BUILD_DIR);

    let tsContent = `// AUTO-GENERATED FILE. DO NOT EDIT.\n`;
    tsContent += `// This file bundles the web-console SPA into memory for single-binary compilation.\n\n`;
    tsContent += `export const ASSETS: Record<string, { content: Uint8Array; contentType: string }> = {\n`;

    for (const filePath of files) {
        // 相对路由路径 (以 / 开头)
        let routePath = filePath.replace(BUILD_DIR, "").replace(/\\/g, "/");
        if (!routePath.startsWith("/")) routePath = "/" + routePath;

        const fileContent = await readFile(filePath);
        const ext = extname(filePath).toLowerCase();
        const contentType = mimeTypes[ext] || "application/octet-stream";

        // 转换成 Base64 编码保存，由接收端运行时解码为 Uint8Array
        const base64Content = fileContent.toString("base64");

        tsContent += `  "${routePath}": {\n`;
        tsContent += `    contentType: "${contentType}",\n`;
        tsContent += `    content: Buffer.from("${base64Content}", "base64")\n`;
        tsContent += `  },\n`;

        console.log(`Packed: ${routePath} (${(fileContent.length / 1024).toFixed(2)} KB)`);
    }

    tsContent += `};\n`;

    writeFileSync(OUT_FILE, tsContent);
    console.log(`[PackAssets] Successfully generated ${OUT_FILE}`);
}

packAssets().catch(console.error);
