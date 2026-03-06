import fs from 'node:fs';
import path from 'node:path';

const packagesDir = process.cwd();

/**
 * 修复 libpg-query 的 WASM 加载
 */
function patchLibPgQuery() {
    console.log('🔧 Patching libpg-query for inline WASM...');
    
    // 找到 WASM 文件并转为 Base64
    const wasmPath = path.resolve(packagesDir, 'node_modules/libpg-query/wasm/libpg-query.wasm');
    if (!fs.existsSync(wasmPath)) {
        console.error('❌ Could not find libpg-query.wasm');
        return;
    }
    const wasmBase64 = fs.readFileSync(wasmPath).toString('base64');
    
    // 找到 JS 胶水代码
    const jsPath = path.resolve(packagesDir, 'node_modules/libpg-query/wasm/libpg-query.js');
    let content = fs.readFileSync(jsPath, 'utf8');
    
    // 注入拦截逻辑：如果是请求 .wasm，直接返回 Base64 转出的 Buffer
    // 查找 readBinary 的定义并修改
    const searchStr = 'readBinary=filename=>{filename=isFileURI(filename)?new URL(filename):filename;var ret=fs.readFileSync(filename);return ret};';
    const patchStr = `var __WASM_DATA__ = "${wasmBase64}";
    readBinary=filename=>{
        if (filename.endsWith('.wasm')) return Buffer.from(__WASM_DATA__, "base64");
        filename=isFileURI(filename)?new URL(filename):filename;
        var ret=fs.readFileSync(filename);
        return ret
    };`;
    
    if (content.includes(searchStr)) {
        content = content.replace(searchStr, patchStr);
        fs.writeFileSync(jsPath, content);
        console.log('✅ libpg-query patched.');
    } else {
        console.warn('⚠️ Could not find readBinary pattern in libpg-query.js. Maybe already patched?');
    }
}

/**
 * 修复 pg-format 的保留字静态目录加载
 */
function patchPgFormat() {
    console.log('🔧 Patching pg-format for inline reserved.js...');
    
    const reservedPath = path.resolve(packagesDir, 'node_modules/pg-format/lib/reserved.js');
    const indexPath = path.resolve(packagesDir, 'node_modules/pg-format/lib/index.js');
    
    if (!fs.existsSync(reservedPath) || !fs.existsSync(indexPath)) {
        console.error('❌ Could not find pg-format files');
        return;
    }
    
    // 读取 reserved.js 内容（它是 CommonJS 格式：module.exports = { ... };）
    let reservedContent = fs.readFileSync(reservedPath, 'utf8');
    // 去掉 module.exports = 部分，只保留对象体
    const jsonBody = reservedContent.replace(/module\.exports\s*=\s*/, '').trim();
    
    let indexContent = fs.readFileSync(indexPath, 'utf8');
    const searchStr = "var reservedMap = require(__dirname + '/reserved.js');";
    const patchStr = `var reservedMap = ${jsonBody};`;
    
    if (indexContent.includes(searchStr)) {
        indexContent = indexContent.replace(searchStr, patchStr);
        fs.writeFileSync(indexPath, indexContent);
        console.log('✅ pg-format patched.');
    } else {
        console.warn('⚠️ Could not find reservedMap require in pg-format index.js.');
    }
}

patchLibPgQuery();
patchPgFormat();
console.log('🏁 All dependencies patched for single-binary bundling.');
