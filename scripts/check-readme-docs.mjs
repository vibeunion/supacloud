import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, root } from './readme-diagrams.mjs';

export const documents = [
  'README.md', 'README.zh-CN.md',
  'docs/platform-operations.md', 'docs/platform-operations.zh-CN.md',
  'docs/readme-visuals.md', 'docs/translation-policy.md',
];
export const codeBlocks = text => [...text.matchAll(/^```([^\n]*)\n([\s\S]*?)^```\s*$/gm)].map(m => [m[1], m[2]]);
const prose = text => text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
export const sectionIds = text => [...text.matchAll(/<!-- section:([\w-]+) -->/g)].map(m => m[1]);
// These maintained pages use inline Markdown links, not a general CommonMark grammar.
export const links = text => [...prose(text).matchAll(/(!?)\[([^\]\n]*)\]\(([^\s)]+)\)/g)].map(m => ({image: m[1] === '!', label: m[2], target: m[3]}));
export function anchors(text) {
  const result = new Set([...prose(text).matchAll(/<a\s+id="([^"]+)"\s*>/g)].map(m => m[1]));
  const generated = new Set();
  for (const match of prose(text).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = match[1].replace(/<[^>]*>/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    let value = base;
    for (let i=1; generated.has(value); i++) value = `${base}-${i}`;
    generated.add(value); result.add(value);
  }
  return result;
}
export function validateLinks(text, file, repo, io = {exists: existsSync, read: path => readFileSync(path, 'utf8')}) {
  const errors = [];
  for (const link of links(text)) {
    if (link.image && !link.label.trim()) errors.push(`${file}: missing image alternative`);
    if (/^(?:https?:|mailto:|\/\/)/i.test(link.target)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(link.target)) { errors.push(`${file}: unsupported URL scheme`); continue; }
    try {
      const [url, fragment] = link.target.split('#');
      const destination = resolve(dirname(resolve(repo,file)), decodeURIComponent(url.split('?')[0]) || '.');
      const path = url ? destination : resolve(repo,file);
      const local = relative(repo,path);
      if (local === '..' || local.startsWith(`..${sep}`) || local.startsWith(sep)) throw new Error('link leaves repository');
      if (!io.exists(path)) throw new Error('missing local target');
      if (fragment && path.endsWith('.md') && !anchors(io.read(path)).has(decodeURIComponent(fragment))) throw new Error('missing Markdown fragment');
    } catch (error) { errors.push(`${file}: ${link.target}: ${error.message}`); }
  }
  return errors;
}
export function checkParity(english, chinese, name) {
  if (JSON.stringify(codeBlocks(english)) !== JSON.stringify(codeBlocks(chinese))) throw new Error(`${name}: code blocks differ`);
  if (name === 'README' && JSON.stringify(sectionIds(english)) !== JSON.stringify(sectionIds(chinese))) throw new Error('README: section order differs');
}
export function checkDocumentation(repo = root) {
  const read = path => readFileSync(resolve(repo,path),'utf8');
  generate(true,repo);
  checkParity(read('README.md'),read('README.zh-CN.md'),'README');
  checkParity(read('docs/platform-operations.md'),read('docs/platform-operations.zh-CN.md'),'operations');
  const errors = documents.flatMap(path => validateLinks(read(path),path,repo));
  if (errors.length) throw new Error(errors.join('\n'));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/check-readme-docs.mjs');
  checkDocumentation();
  console.log('README documentation: local links/fragments, alternatives, bilingual code and generated diagrams verified');
}
