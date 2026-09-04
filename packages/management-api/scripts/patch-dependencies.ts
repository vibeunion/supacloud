import fs from 'node:fs';
import path from 'node:path';

const packagesDir = process.cwd();

/**
 * Patches libpg-query WASM loading for inline single-binary execution
 */
function patchLibPgQuery() {
    console.log('🔧 Patching libpg-query for inline WASM...');
    
    // Locate WASM file and convert to Base64
    const wasmPath = path.resolve(packagesDir, 'node_modules/libpg-query/wasm/libpg-query.wasm');
    if (!fs.existsSync(wasmPath)) {
        console.error('❌ Could not find libpg-query.wasm');
        return;
    }
    const wasmBase64 = fs.readFileSync(wasmPath).toString('base64');
    
    // Locate JS glue code
    const jsPath = path.resolve(packagesDir, 'node_modules/libpg-query/wasm/libpg-query.js');
    let content = fs.readFileSync(jsPath, 'utf8');
    
    // Inject interception logic: if requesting .wasm, return Buffer converted from Base64
    // Find readBinary definition and patch it
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
 * Patches pg-format static directory loading for reserved words
 */
function patchPgFormat() {
    console.log('🔧 Patching pg-format for inline reserved.js...');
    
    const reservedPath = path.resolve(packagesDir, 'node_modules/pg-format/lib/reserved.js');
    const indexPath = path.resolve(packagesDir, 'node_modules/pg-format/lib/index.js');
    
    if (!fs.existsSync(reservedPath) || !fs.existsSync(indexPath)) {
        console.error('❌ Could not find pg-format files');
        return;
    }
    
    // Read reserved.js content (CommonJS format: module.exports = { ... };)
    let reservedContent = fs.readFileSync(reservedPath, 'utf8');
    // Strip module.exports = to retain object body only
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
