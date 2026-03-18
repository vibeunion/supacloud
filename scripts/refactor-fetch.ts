import { readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

const targetDir = "packages/web-console/src/routes";

function replaceFetch(content: string, filePath: string): string {
  // If no fetch is used, skip
  if (!/\bfetch\s*\(/.test(content)) return content;
  
  // Skip the api.ts itself and server-side files that might not need it, 
  // actually plus page.server.ts might need it but wait, page.server.ts uses API_URL.
  
  let newContent = content.replace(/\bfetch\s*\(/g, "apiClient(");

  // Add import if not present
  if (!newContent.includes('import { apiClient }') && !newContent.includes('import {apiClient}')) {
    // Determine relative path depth
    const parts = filePath.replace(/\\/g, "/").split("src/routes/")[1].split("/");
    const depth = parts.length - 1;
    const prefix = depth === 0 ? "." : Array(depth).fill("..").join("/");
    // We can also just use the $lib alias which SvelteKit supports!
    const importStmt = `import { apiClient } from "$lib/api";\n`;

    // Find script tag
    if (newContent.includes("<script context=\"module\">")) {
      newContent = newContent.replace("<script context=\"module\">", `<script context="module">\n  ${importStmt}`);
    } else if (newContent.includes("<script lang=\"ts\">")) {
      newContent = newContent.replace("<script lang=\"ts\">", `<script lang="ts">\n  ${importStmt}`);
    } else if (newContent.includes("<script>")) {
      newContent = newContent.replace("<script>", `<script>\n  ${importStmt}`);
    } else if (filePath.endsWith(".ts")) {
      newContent = `${importStmt}${newContent}`;
    }
  }

  return newContent;
}

async function walk(dir: string) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath);
    } else if (fullPath.endsWith(".svelte") || fullPath.endsWith(".ts")) {
      const content = await readFile(fullPath, "utf-8");
      const updated = replaceFetch(content, fullPath);
      if (updated !== content) {
        await writeFile(fullPath, updated);
        console.log(`Updated ${fullPath}`);
      }
    }
  }
}

walk(targetDir).catch(console.error);
