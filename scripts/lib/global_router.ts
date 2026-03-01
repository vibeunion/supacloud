// global_router.ts
// SupaCloud Global Edge Runtime Router
// Handles multi-tenant function execution via isolated Web Workers.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const workers = new Map<string, Worker>();
const FUNCTIONS_ROOT = "/home/deno/functions";
const TENANTS_DIR = "/etc/supabase/tenants";

// 读取租户的环境变量
async function loadTenantEnv(projectRef: string): Promise<Record<string, string>> {
    const envMap: Record<string, string> = {};
    try {
        const envPath = `${TENANTS_DIR}/${projectRef}.env`;
        const text = await Deno.readTextFile(envPath);
        text.split('\n').forEach(line => {
            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) {
                envMap[match[1].trim()] = match[2].trim();
            }
        });
    } catch (e) {
        console.error(`[Router] Could not load env for ${projectRef}: ${e.message}`);
    }
    return envMap;
}

// 调度 Worker
async function dispatchToWorker(projectRef: string, req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathParts = url.pathname.split('/');

    let functionName = '';
    if (url.pathname.startsWith('/functions/v1/')) {
        functionName = pathParts[3];
    } else {
        functionName = pathParts[pathParts.length - 1];
    }

    if (!functionName || functionName === 'health' || functionName === '') {
        return new Response(JSON.stringify({ status: 'ok', router: 'global' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const workerKey = `${projectRef}_${functionName}`;
    const funcPath = `${FUNCTIONS_ROOT}/${projectRef}/${functionName}.ts`;

    // 1. 检查代码是否存在
    try {
        const stat = await Deno.stat(funcPath);
        if (!stat.isFile) throw new Error();
    } catch {
        return new Response(JSON.stringify({ error: `Function ${functionName} not found for ${projectRef}` }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 2. 获取或创建 Worker
    let worker = workers.get(workerKey);
    if (!worker) {
        console.log(`[Router] Spawning new Web Worker for ${workerKey}`);
        const envMap = await loadTenantEnv(projectRef);

        worker = new Worker(new URL("./worker_runner.ts", import.meta.url).href, {
            type: "module",
            deno: {
                permissions: {
                    net: true,
                    read: true,
                    env: false // 硬隔离：禁止直接读取宿主机环境变量
                }
            }
        } as any);

        // 发送环境变量上下文给 Worker
        worker.postMessage({ type: 'INIT_ENV', env: envMap, funcPath });
        workers.set(workerKey, worker);

        // 监听意外退出 (简单清理)
        worker.onerror = (e) => {
            console.error(`[Router] Worker ${workerKey} crashed:`, e);
            workers.delete(workerKey);
        };
    }

    // 3. 将请求通过消息传递给 Worker (由于 Request 对象不能跨线程传输，我们需要序列化)
    // 此处我们需要一个基于 MessageChannel 的异步调用包装
    return await new Promise(async (resolve, reject) => {
        const channel = new MessageChannel();
        let timeoutId: number;

        channel.port1.onmessage = (e) => {
            clearTimeout(timeoutId);
            const { status, headers, body } = e.data;
            resolve(new Response(body, { status, headers: new Headers(headers) }));
        };

        // 解析请求体
        let reqBody = null;
        if (req.body) {
            try { reqBody = await req.clone().arrayBuffer(); } catch (e) { }
        }

        const reqHeaders: Record<string, string> = {};
        req.headers.forEach((v, k) => reqHeaders[k] = v);

        worker!.postMessage({
            type: 'HANDLE_REQUEST',
            req: {
                url: req.url,
                method: req.method,
                headers: reqHeaders,
                body: reqBody
            },
            port: channel.port2
        }, [channel.port2]);

        // 超时控制 (20秒)
        timeoutId = setTimeout(() => {
            resolve(new Response("Gateway Timeout", { status: 504 }));
        }, 20000);
    });
}

// 主入口
serve(async (req) => {
    const projectRef = req.headers.get("x-project-ref");

    if (!projectRef) {
        return new Response("Missing x-project-ref header", { status: 400 });
    }

    try {
        return await dispatchToWorker(projectRef, req);
    } catch (err: any) {
        console.error(`[Router] Error serving request:`, err);
        return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}, { port: 9000 });
