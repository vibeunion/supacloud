import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { assetDir, escapeXml, generate, locales, names, renderDiagram, root, validateLabels } from './readme-diagrams.mjs';
import { anchors, checkParity, codeBlocks, links, sectionIds, validateLinks } from './check-readme-docs.mjs';

const read = file => readFileSync(resolve(root,file),'utf8');
const labels = JSON.parse(read(`${assetDir}/labels.json`));
const clone = () => structuredClone(labels);

test('all six checked-in SVGs match deterministic generation', () => generate(true));
test('translated figures keep identical geometry and accessible text', () => {
  const geometry = svg => svg.replace(/(<(?:title|desc|text)\b[^>]*>)[\s\S]*?(<\/(?:title|desc|text)>)/g,'$1$2').replace(/xml:lang="[^"]+"/g,'xml:lang="locale"');
  for (const name of names) {
    const pair = locales.map(locale => renderDiagram(name,locale,labels));
    assert.equal(geometry(pair[0]),geometry(pair[1]));
    for (const svg of pair) {
      assert.match(svg,/role="img" aria-labelledby="title description"/);
      assert.match(svg,/<title id="title">[^<]+<\/title>/);
      assert.match(svg,/<desc id="description">[^<]+<\/desc>/);
      assert.doesNotMatch(svg,/<(?:script|image|foreignObject)\b|@font-face|(?:xlink:)?href=/i);
    }
  }
});
test('labels cannot introduce active SVG markup', () => {
  assert.equal(escapeXml('<script>&"\''),'&lt;script&gt;&amp;&quot;&apos;');
  const changed = clone(); changed.en.overview.title = '<script>alert("x")</script>';
  const svg = renderDiagram('overview','en',changed);
  assert.doesNotMatch(svg,/<script>/); assert.match(svg,/&lt;script&gt;/);
});
test('missing translations and non-text labels fail validation', () => {
  const missing = clone(); delete missing['zh-CN'].overview.note;
  assert.throws(() => validateLabels(missing),/mismatch/);
  const invalid = clone(); invalid.en.overview.cards[0][0] = '';
  assert.throws(() => validateLabels(invalid),/non-empty/);
  const wrong = clone(); wrong.en.overview.cards.pop();
  assert.throws(() => validateLabels(wrong));
  assert.throws(() => renderDiagram('unknown','en',labels),/Unknown/);
});
test('check mode rejects stale assets without rewriting them', () => {
  const repo = mkdtempSync(resolve(tmpdir(),'supacloud-readme-'));
  try {
    mkdirSync(resolve(repo,assetDir),{recursive:true});
    writeFileSync(resolve(repo,assetDir,'labels.json'),JSON.stringify(labels));
    generate(false,repo); generate(true,repo);
    const path = resolve(repo,assetDir,'overview.en.svg'); writeFileSync(path,'stale');
    assert.throws(() => generate(true,repo),/Stale diagram/);
    assert.equal(readFileSync(path,'utf8'),'stale');
  } finally { rmSync(repo,{recursive:true,force:true}); }
});
test('homepage and operations commands remain identical across languages', () => {
  checkParity(read('README.md'),read('README.zh-CN.md'),'README');
  checkParity(read('docs/platform-operations.md'),read('docs/platform-operations.zh-CN.md'),'operations');
  assert.deepEqual(sectionIds(read('README.md')),['goals','choose','start','architecture','compatibility','docs','license']);
  assert.equal(codeBlocks(read('README.md')).length,4);
  assert.throws(() => checkParity('```sh\na\n```','```sh\nb\n```','fixture'),/differ/);
  assert.throws(() => checkParity('<!-- section:a -->','<!-- section:b -->','README'),/order/);
});
test('homepages use three localized figures with meaningful alternatives', () => {
  for (const [file,locale] of [['README.md','en'],['README.zh-CN.md','zh-CN']]) {
    const text = read(file), images = links(text).filter(l => l.image);
    assert.deepEqual(images.map(l => l.target),names.map(n => `${assetDir}/${n}.${locale}.svg`));
    assert.ok(images.every(l => l.label.length > 20));
    assert.match(text,/\[English\]\(README.md\) \| \[简体中文\]\(README.zh-CN.md\) \| \[Español\]\(README.es-ES.md\)/);
  }
});
test('heading fragments support Chinese, explicit aliases and duplicates', () => {
  const values = anchors('# Hello World\n## 中文标题\n## Same\n## Same\n<a id="legacy"></a>\n```md\n# hidden\n```');
  for (const a of ['hello-world','中文标题','same','same-1','legacy']) assert.ok(values.has(a));
  assert.equal(values.has('hidden'),false);
});
test('local link checks reject missing paths, fragments, escapes and empty alternatives', () => {
  const repo = mkdtempSync(resolve(tmpdir(),'supacloud-links-'));
  try {
    writeFileSync(resolve(repo,'README.md'),'# Title\n## 中文');
    writeFileSync(resolve(repo,'other.md'),'# Other');
    const good='[x](other.md#other) [y](#%E4%B8%AD%E6%96%87) [web](https://example.com)\n```sh\n[ignored](absent.md)\n```';
    assert.deepEqual(validateLinks(good,'README.md',repo),[]);
    assert.equal(validateLinks('[x](gone.md)','README.md',repo).length,1);
    assert.equal(validateLinks('[x](other.md#missing)','README.md',repo).length,1);
    assert.equal(validateLinks('[x](../outside.md)','README.md',repo).length,1);
    assert.equal(validateLinks('![](other.md)','README.md',repo).length,1);
    assert.equal(validateLinks('[x](%ZZ.md)','README.md',repo).length,1);
  } finally { rmSync(repo,{recursive:true,force:true}); }
});
test('Spanish synchronization is explicitly tracked instead of claimed complete', () => {
  const text = read('docs/translation-policy.md');
  assert.match(text,/synchronization is explicitly pending/);
  assert.match(text,/https:\/\/github.com\/vibeunion\/supacloud\/issues\/1504/);
});
