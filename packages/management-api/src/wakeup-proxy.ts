import { $ } from "bun";
import { Elysia } from "elysia";
import { TenantManager } from "./infra/tenant";

export const wakeupProxy = new Elysia({ prefix: "/_proxy" });

// 租户进程的活动计时器记录：ProjectRef -> 最后活跃时间戳
const activityTimers = new Map<string, number>();
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15分钟无请求则回收进程

/**
 * 启动租户底层服务 (如果未运行)
 * @param ref 租户 ID
 */
async function ensureTenantRunning(ref: string) {
    // 简单检测：如果我们在内网能连通对应端口，或者依靠 systemctl is-active，但 systemctl is-active 最准确。
    // 为了性能，我们先记录它最后活跃时间。如果刚才刚唤醒过，直接放行 (假定运行中)。
    const lastActive = activityTimers.get(ref);
    const now = Date.now();

    if (lastActive && (now - lastActive < IDLE_TIMEOUT_MS)) {
        // 刷新活跃时间
        activityTimers.set(ref, now);
        return;
    }

    // 否则，进入冷启动流程 (即便程序在跑，再 start 一次也没坏处)
    console.log(`[WakeupProxy] Cold starting tenant processes for ${ref}...`);
    try {
        // 调用我们刚刚用 TS 重建的 Tenant 控制器，确保二进制可用并重启目标服务
        await TenantManager.restartRuntime(ref);

        // 给一点时间让进程绑定端口 (PostgREST 和 GoTrue 启动通常在 50-100ms)
        await Bun.sleep(150);

        // 记录首次唤醒时间
        activityTimers.set(ref, Date.now());
    } catch (error) {
        console.error(`[WakeupProxy] Error waking up tenant ${ref}:`, error);
    }
}

/**
 * 定时垃圾回收器 (Garbage Collector)
 * 每 5 分钟扫描一次，清理超过 IDLE_TIMEOUT_MS 未活跃的租户
 */
setInterval(async () => {
    const now = Date.now();
    for (const [ref, lastActive] of activityTimers.entries()) {
        if (now - lastActive > IDLE_TIMEOUT_MS) {
            console.log(`[WakeupProxy] Tenant ${ref} has been idle for 15 minutes. Scaling to ZERO...`);
            try {
                // 回收内存，调用最新的 TS 生态控制器
                await TenantManager.stopRuntime(ref);
            } catch (e) {
                console.error(`[WakeupProxy] Failed to scale-down tenant ${ref}:`, e);
            }
            // 从监控列表移除
            activityTimers.delete(ref);
        }
    }
}, 5 * 60 * 1000);

/**
 * 反向代理处理器
 */
async function handleProxy(req: Request, type: "pgrst" | "gotrue", ref: string, portParams: string): Promise<Response> {
    await ensureTenantRunning(ref);

    // 重新拼装内部请求 URL
    const url = new URL(req.url);
    const targetPort = parseInt(portParams, 10);
    if (isNaN(targetPort)) {
        return new Response("Invalid tenant port mapping", { status: 502 });
    }

    url.hostname = "127.0.0.1";
    url.port = targetPort.toString();
    // 剥离拦截器前缀: /_proxy/pgrst/<ref>/<port>/rest/v1/...
    const prefixToStrip = `/_proxy/${type}/${ref}/${targetPort}`;
    if (url.pathname.startsWith(prefixToStrip)) {
        url.pathname = url.pathname.substring(prefixToStrip.length) || "/";
    }

    // 克隆原始请求头，但不带 Host (防 SSRF 干扰)
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.set("x-forwarded-for", "127.0.0.1");

    // 代理转发 (Bun native fetch)
    try {
        const proxyRes = await fetch(url.toString(), {
            method: req.method,
            headers: headers,
            body: req.body,
            // 允许转发除了 GET/HEAD 之外的 Body (Bun extension)
            // @ts-ignore: Bun specific extension to RequestInit
            duplex: "half",
            redirect: "manual"
        } as RequestInit);

        // 原封不动送回响应
        const responseHeaders = new Headers(proxyRes.headers);
        return new Response(proxyRes.body, {
            status: proxyRes.status,
            statusText: proxyRes.statusText,
            headers: responseHeaders,
        });

    } catch (e: any) {
        console.error(`[WakeupProxy] Error proxying to ${type} (Tenant: ${ref}):`, e.message);
        return new Response(`Bad Gateway or Tenant Timeout: ${e.message}`, { status: 502 });
    }
}

// ================= 路由绑定 =================

// 匹配: /_proxy/pgrst/项目ID/端口号/真正的API路径
wakeupProxy.all("/pgrst/:ref/:port/*", ({ request, params }) => {
    return handleProxy(request, "pgrst", params.ref, params.port);
});

wakeupProxy.all("/gotrue/:ref/:port/*", ({ request, params }) => {
    return handleProxy(request, "gotrue", params.ref, params.port);
});
