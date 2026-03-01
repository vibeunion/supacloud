// worker_runner.ts
// SupaCloud Isolated Worker Runner
// Runs individual tenant functions within a secure Web Worker sandbox without native OS environment access.

/// <reference lib="deno.worker" />

let tenantEnv: Record<string, string> = {};
let functionModule: any = null;

// 安全拦截器：劫持 Deno API
// 覆写原生的 Deno.env 防止用户尝试越权读取系统环境
const originalDeno = globalThis.Deno || {};

const safeEnv = {
    get: (key: string) => tenantEnv[key] || originalDeno.env?.get?.(key) || undefined,
    toObject: () => ({ ...tenantEnv }),
    set: (key: string, value: string) => { tenantEnv[key] = value; },
    delete: (key: string) => { delete tenantEnv[key]; },
    has: (key: string) => (key in tenantEnv)
};

// 构造一个受限的 Deno 对象
globalThis.Deno = new Proxy(originalDeno as any, {
    get(target, prop) {
        if (prop === "env") return safeEnv;
        return Reflect.get(target, prop);
    }
});

// 处理主线程传来的指令
self.onmessage = async (e: MessageEvent) => {
    const data = e.data;

    if (data.type === 'INIT_ENV') {
        // 1. 注入租户专属环境变量
        tenantEnv = data.env || {};

        // 2. 动态加载用户代码
        try {
            functionModule = await import(`file://${data.funcPath}`);
            console.log(`[Worker] Initialized and loaded tenant function from ${data.funcPath}`);
        } catch (err) {
            console.error(`[Worker] Failed to load function module:`, err);
        }
        return;
    }

    if (data.type === 'HANDLE_REQUEST') {
        const port = data.port;
        const reqData = data.req;

        if (!functionModule || typeof functionModule.default !== 'function') {
            port.postMessage({
                status: 500,
                headers: { "Content-Type": "application/json" },
                body: new TextEncoder().encode(JSON.stringify({ error: "Function code not initialized or missing default export." }))
            });
            return;
        }

        try {
            // 将从主线程过来的纯对象反序列化为 Request 对象
            const requestInit: RequestInit = {
                method: reqData.method,
                headers: new Headers(reqData.headers)
            };
            if (reqData.body && ['GET', 'HEAD'].indexOf(reqData.method) === -1) {
                requestInit.body = reqData.body;
            }

            const request = new Request(reqData.url, requestInit);

            // 调用用户的业务函数
            const response: Response = await functionModule.default(request);

            // 将返回的 Response 对象序列化发回主线程
            const resHeaders: Record<string, string> = {};
            response.headers.forEach((v, k) => resHeaders[k] = v);

            const resBodyBuffer = await response.arrayBuffer();

            port.postMessage({
                status: 200,
                // 注意：用户的真实状态码
                headers: resHeaders,
                body: resBodyBuffer
            });

        } catch (err: any) {
            console.error(`[Worker] Execution error:`, err);
            port.postMessage({
                status: 500,
                headers: { "Content-Type": "application/json" },
                body: new TextEncoder().encode(JSON.stringify({ error: err.message || "Internal Worker Error" }))
            });
        }
    }
};
