import * as p from "@clack/prompts";
import { NodeManager } from "./infra/node";

/**
 * 运行集群节点管理器 CLI
 */
export async function runNodeManager() {
    p.intro("SupaCloud 集群节点管理 (Nodes)");

    const action = await p.select({
        message: "请选择操作:",
        options: [
            { value: "list", label: "查看所有节点", hint: "展示集群拓扑" },
            { value: "add", label: "添加新节点", hint: "扩容集群 (需 SSH 密码)" },
            { value: "ping", label: "检测节点状态", hint: "在线状态拨测" },
            { value: "back", label: "返回" },
        ],
    });

    if (action === "back" || p.isCancel(action)) return;

    if (action === "list") {
        const nodes = await NodeManager.listNodes();
        if (nodes.length === 0) {
            p.log.warn("当前集群中没有任何节点。");
        } else {
            console.table(nodes);
        }
    }

    if (action === "add") {
        const settings = await p.group(
            {
                ip: () => p.text({
                    message: "节点 IP 地址",
                    placeholder: "10.0.0.2",
                    validate: (v) => v ? undefined : "必填",
                }),
                user: () => p.text({
                    message: "SSH 用户名",
                    initialValue: "root",
                }),
                pass: () => p.password({
                    message: "SSH 密码 (仅用于分发密钥，不会保存)",
                }),
                role: () => p.select({
                    message: "节点角色",
                    options: [
                        { value: "pg", label: "数据节点 (PostgreSQL/Patroni)" },
                        { value: "app", label: "应用节点 (Tenant Runtime)" },
                        { value: "lb", label: "负载均衡 (Angie/Keepalived)" },
                    ],
                }),
            },
            {
                onCancel: () => {
                    p.cancel("已取消添加。");
                    process.exit(0);
                },
            }
        );

        const s = p.spinner();
        s.start(`正在配置节点 ${settings.ip} 的互信与连接...`);
        try {
            const node = await NodeManager.addNode(
                settings.ip,
                settings.user,
                settings.pass,
                settings.role as any
            );
            s.stop("节点添加成功");
            p.log.success(`已成功将 ${node.hostname} (${node.ip}) 加入集群。`);
        } catch (e: any) {
            s.stop("添加失败");
            p.log.error(e.message);
        }
    }

    if (action === "ping") {
        const s = p.spinner();
        s.start("正在拨测集群节点...");
        await NodeManager.pingAll();
        s.stop("检测完成");
        const nodes = await NodeManager.listNodes();
        console.table(nodes);
    }

    // 循环
    await runNodeManager();
}
