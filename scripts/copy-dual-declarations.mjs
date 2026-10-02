import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
async function copyDeclarations(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await copyDeclarations(path);
    else if (entry.name.endsWith('.d.ts')) {
      const source = await readFile(path, 'utf8');
      for (const [suffix, extension] of [['.d.mts', '.mjs'], ['.d.cts', '.cjs']]) {
        const content = source.replace(/(['"])(\.{1,2}\/[^'"\n]+?)\.js\1/g, (_, q, spec) => `${q}${spec}${extension}${q}`);
        await writeFile(path.slice(0, -5) + suffix, content);
      }
      await unlink(path);
    }
  }
}
await copyDeclarations(process.argv[2] ?? 'dist');
