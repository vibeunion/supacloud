import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { syncPlan, applySyncPlan } from './sync.mjs';
import { readWorkspace } from './model.mjs';
import { taskPlan } from './tasks.mjs';
import { verificationTargets } from './verification.mjs';

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'supacloud-completion-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const put = (file, data) => {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    writeFileSync(resolve(root, file), typeof data === 'string' ? data : JSON.stringify(data));
  };
  return { root, put };
}
test('sync checks and plans are read-only; apply is idempotent and scoped', (t) => {
  const {root, put} = fixture(t); put('out/a.json', 'old'); put('user.ts', 'user');
  const outputs = [{ file: 'out/a.json', content: 'new', summary: ['changed API'] }];
  const plan = syncPlan(root, outputs);
  assert.equal(plan.clean, false); assert.equal(readFileSync(resolve(root, 'out/a.json'), 'utf8'), 'old');
  assert.equal(applySyncPlan(root, plan, outputs).clean, true);
  assert.deepEqual(applySyncPlan(root, syncPlan(root, outputs), outputs).applied, []);
  assert.equal(readFileSync(resolve(root, 'user.ts'), 'utf8'), 'user');
});
test('sync rejects changed generator inputs, edited destinations, and extra destinations', (t) => {
  const {root, put} = fixture(t); put('a', 'old');
  const outputs = [{file: 'a', content: 'new'}], plan = syncPlan(root, outputs);
  assert.throws(() => applySyncPlan(root, plan, [{file: 'a', content: 'another'}]), /Stale/);
  put('a', 'user edit'); assert.throws(() => applySyncPlan(root, plan, outputs), /Stale/);
  put('a', 'old'); plan.changes.push({...plan.changes[0],file:'user.ts'});
  assert.throws(() => applySyncPlan(root, plan, outputs), /Stale/);
  assert.equal(readFileSync(resolve(root, 'a'), 'utf8'), 'old');
});
test('sync rejects invalid plans, duplicate generators and escaping output roots', (t) => {
  const {root} = fixture(t);
  assert.throws(() => applySyncPlan(root, {}, []), /Invalid/);
  assert.throws(() => syncPlan(root, [{file:'a',content:'x'},{file:'a',content:'y'}]), /Duplicate/);
  assert.throws(() => syncPlan(root, [{file:'../escape',content:'x'}]), /escapes/);
});
test('sync refuses file and directory symlinks, including dangling links', (t) => {
  const {root, put} = fixture(t); put('outside/keep', 'user');
  symlinkSync(resolve(root, 'missing'), resolve(root, 'dangling'));
  assert.throws(() => syncPlan(root,[{file:'dangling',content:'x'}]), /Symlink/);
  symlinkSync(resolve(root,'outside'),resolve(root,'link'),'junction');
  assert.throws(() => syncPlan(root,[{file:'link/keep',content:'x'}]), /Symlink/);
  assert.equal(readFileSync(resolve(root,'outside/keep'),'utf8'),'user');
});
test('sync rolls back already written outputs after a later I/O failure', (t) => {
  const {root, put} = fixture(t); put('a','old-a');put('b','old-b');
  const outputs=[{file:'a',content:'new-a'},{file:'b',content:'new-b'}];
  let calls=0;
  assert.throws(() => applySyncPlan(root,syncPlan(root,outputs),outputs,{replace:(a,b)=>{
    if(++calls===2) throw new Error('injected failure'); renameSync(a,b);
  }}),/injected failure/);
  assert.equal(readFileSync(resolve(root,'a'),'utf8'),'old-a');
  assert.equal(readFileSync(resolve(root,'b'),'utf8'),'old-b');
  assert.deepEqual(readdirSync(root).sort(),['a','b']);
});
test('sync does not undo an external edit during rollback', (t) => {
  const {root, put} = fixture(t); put('a','old-a');put('b','old-b');
  const outputs=[{file:'a',content:'new-a'},{file:'b',content:'new-b'}]; let calls=0;
  assert.throws(()=>applySyncPlan(root,syncPlan(root,outputs),outputs,{replace:(a,b)=>{
    if(++calls===2){put('a','concurrent user');throw new Error('I/O');} renameSync(a,b);
  }}),/requires inspection: a/);
  assert.equal(readFileSync(resolve(root,'a'),'utf8'),'concurrent user');
});
test('sync supports creating missing owned outputs without touching unrelated files', (t) => {
  const {root} = fixture(t); const outputs=[{file:'owned.json',content:'{}\n'}];
  const plan=syncPlan(root,outputs); assert.equal(plan.changes[0].before,null);
  assert.deepEqual(applySyncPlan(root,plan,outputs).applied,['owned.json']);
});

test('package tasks run through Bun and do not keep a result cache', () => {
  const workspace=readWorkspace(resolve(import.meta.dirname,'../..'));
  for(const project of Object.values(workspace.projects)) {
    const targets=taskPlan(workspace,project);
    assert.deepEqual(targets['repo-install'].command,['bun','install','--force','--ignore-scripts','--frozen-lockfile']);
    assert.equal('cache' in targets['repo-install'],false);
    assert.equal('cache' in targets['repo-prepare'],false);
    assert.equal('repo-cache-guard' in targets,false);
    if(targets['repo-test']) assert.deepEqual(targets['repo-test'].command,['bun','run','test']);
    if(targets['repo-build']) {
      assert.deepEqual(targets['repo-build'].command,['bun','run','build']);
      assert.equal(targets['repo-build'].dependsOn[0].target,'repo-install');
    }
  }
});
test('verification-only dependency targets preserve the old extra build contracts', () => {
  const w=readWorkspace(resolve(import.meta.dirname,'../..'));
  const find=(alias)=>Object.values(w.projects).find(p=>p.root===`packages/${alias}`);
  assert.deepEqual(verificationTargets(w,find('db')).slice(1).map(x=>x.projects[0]),['@supacloud/commands','@supacloud/compiler']);
  assert.equal(verificationTargets(w,find('compiler'))[1].projects[0],'@supacloud/contracts');
  assert.equal(verificationTargets(w,find('supacloud-lite'))[1].projects[0],'@supacloud/js');
  assert.equal(verificationTargets(w,find('elysia'))[1].projects[0],'@supacloud/js');
  assert.ok(!taskPlan(w,find('db'))['repo-build'].dependsOn.some(x=>x.target==='repo-verify-prepare'));
});
test('compiler lifecycle rebuilds cannot overlap shared-output consumers', () => {
  const workspace=readWorkspace(resolve(import.meta.dirname,'../..'));
  const compiler=workspace.projects['@supacloud/compiler'];
  const targets=taskPlan(workspace,compiler);
  for(const script of ['build','typecheck']) {
    assert.equal(compiler.scripts[`pre${script}`],'bun run prepare:db');
    assert.equal(targets[`repo-${script}`].exclusive,true);
    assert.deepEqual(targets[`repo-${script}`].command,['bun','run',script]);
  }
  assert.ok(targets['repo-install'].dependsOn.some(dep=>dep.projects.includes('@supacloud/contracts')));
  assert.ok(targets['repo-install'].dependsOn.some(dep=>dep.projects.includes('@supacloud/db')));
  assert.notEqual(taskPlan(workspace,workspace.projects['@supacloud/js'])['repo-build'].exclusive,true);
});
test('all legacy consumer preparation closures preserve their previous artifact prerequisites', () => {
  const w=readWorkspace(resolve(import.meta.dirname,'../..'));
  const original={
    'supacloud-js':['compiler','contracts','db','delivery','query'], 'supacloud-lite':['contracts','supacloud-js','commands','delivery','compiler','db','app','elysia','query'],
    app:['contracts'],compiler:['contracts','db','delivery','query'],db:['contracts','commands','delivery','compiler','db'],
    commands:['contracts'],'app-svelte':['contracts'],elysia:['contracts','commands','delivery','compiler','db','app','supacloud-js','query'],
  };
  const find=alias=>Object.values(w.projects).find(p=>p.root===`packages/${alias}`);
  // @supacloud/db verification builds @supacloud/compiler because db tests import compiler source
  // helpers. @supacloud/compiler now depends on @supacloud/db, so verifying db installs db
  // transitively. This reviewed coupling is intentional until those helpers move to a shared package.
  const selfInstallAllowed=new Set(['db']);
  for(const [consumer,expected] of Object.entries(original)){
    const visited=new Set(), built=new Set();
    const visit=(name,target)=>{
      const id=`${name}:${target}`; if(visited.has(id))return;visited.add(id);
      const config=taskPlan(w,w.projects[name])[target];assert.ok(config,`Missing target: ${id}`);
      if(target==='repo-build')built.add(w.projects[name].root.split('/').at(-1));
      for(const dep of config.dependsOn??[])for(const project of dep.projects??[name])visit(project,dep.target);
    };
    visit(find(consumer).name,'repo-verify-prepare');
    assert.deepEqual([...built].sort(),expected.sort(),consumer);
    assert.ok(selfInstallAllowed.has(consumer)||!visited.has(`${find(consumer).name}:repo-install`),`${consumer} must not install itself`);
  }
});
test('sync refuses destination edits made after plan validation but before staging', (t) => {
  const {root,put}=fixture(t);put('a','old');const entry={file:'a',content:'new'};
  const outputs=[entry],plan=syncPlan(root,outputs);
  outputs[Symbol.iterator]=function*(){put('a','concurrent edit');yield entry;};
  assert.throws(()=>applySyncPlan(root,plan,outputs),/Concurrent edit/);
  assert.equal(readFileSync(resolve(root,'a'),'utf8'),'concurrent edit');
});
test('workspace context preserves source and verification relations without changing runtime graph', async () => {
  const {contextReport}=await import('./context.mjs');
  const w=readWorkspace(resolve(import.meta.dirname,'../..'));
  const r=contextReport(w,{diagnostics:[],notes:[],edges:[]},{files:['packages/compiler/src/index.ts']});
  assert.ok(r.affected.projects.some(p=>p.name==='@supacloud/db'));
  assert.ok(!r.graph.edges.some(e=>e.source==='@supacloud/db' && e.target==='@supacloud/compiler'));
  assert.equal(r.affected.safeToSkip,false);
  assert.ok(r.caches.every((entry)=>entry.build===false && entry.remote===false));
  const uncertain=contextReport(w,{diagnostics:[],notes:[{code:'WS_DYNAMIC_IMPORT'}],edges:[]},{files:['packages/contracts/src/index.ts']});
  assert.equal(uncertain.affected.full,true);
  const source=contextReport(w,{diagnostics:[],notes:[],edges:[{source:'@supacloud/js',target:'@supacloud/db'}]},{files:['packages/db/src/index.ts']});
  assert.ok(source.affected.projects.some(p=>p.name==='@supacloud/js'));
});
