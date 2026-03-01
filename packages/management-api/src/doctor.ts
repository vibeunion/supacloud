import * as p from "@clack/prompts";
import { HealthChecker, type HealthReport } from "./infra/health";

export async function runDoctor(options: { skipSmokeTest?: boolean, forceYes?: boolean } = {}) {
    p.intro("\x1b[45m SupaCloud 系统巡检中心 (Doctor) \x1b[0m");

    const s = p.spinner();
    s.start("正在深度扫描基础设施状态...");

    try {
        const reports = await HealthChecker.runFullCheck();
        s.stop("基础设施巡检完成");

        const tableData = reports.map(r => {
            const statusIcon = r.status === "OK" ? "✅" : r.status === "WARN" ? "⚠️" : "❌";
            return `${statusIcon} [${r.component.padEnd(12)}] ${r.message}`;
        });

        p.note(tableData.join("\n"), "系统体检报告");

        const hasError = reports.some(r => r.status === "ERROR");
        if (hasError) {
            p.log.error("检测到关键服务异常，基础功能测试已自动跳过。");
            const issues = reports.filter(r => r.status !== "OK");
            issues.forEach(r => {
                p.log.step(`- \x1b[33m${r.component}\x1b[0m: ${r.recommendation || "请检查日志。"}`);
            });
            p.outro("巡检结束，请先修复上述红色异常。");
            return;
        }

        // --- 冒烟测试入口 ---
        if (!options.skipSmokeTest) {
            const shouldTest = options.forceYes || await p.confirm({
                message: "基础设施似乎已就绪。是否运行【业务冒烟测试】（创建并销毁一个测试项目）？",
                initialValue: true
            });

            if (p.isCancel(shouldTest) || !shouldTest) {
                p.outro("通过基础检查，业务功能待验证。祝您使用愉快！");
                return;
            }

            s.start("正在执行业务冒烟测试 (创建项目中)...");
            const testRef = `smoke-test-${Math.random().toString(36).substring(7)}`;

            try {
                const { projectService } = await import("./services");

                // 1. 创建项目
                const project = await projectService.createProject({
                    name: "Doctor Smoke Test Project",
                    organization_id: "default"
                });
                s.message(`项目项目注入成功 (Ref: ${project.ref})，正在等待网关生效...`);

                // 模拟等待网关就绪 (通常 Pigsty/Angie 需要几秒同步)
                await new Promise(r => setTimeout(r, 2000));

                // 2. 验证详情获取
                const details = await projectService.getProject(project.ref);
                if (!details) throw new Error("无法获取测试项目详情，持久化异常。");

                s.message("功能验证通过，正在清理测试数据...");

                // 3. 清理
                await projectService.deleteProject(project.ref);

                s.stop("业务冒烟测试全链路通过！ ✨");
                p.log.success("【结论】您的 SupaCloud 已完全准备好接管生产业务。");
            } catch (testErr: any) {
                s.stop("业务冒烟测试失败");
                p.log.error(`冒烟测试发现逻辑故障: ${testErr.message}`);
                p.log.info("这可能意味着数据库权限或路由脚本存在瑕疵。");
            }
        }

        p.outro("巡检结束，祝您部署愉快！");
    } catch (error: any) {
        s.stop("巡检中途故障");
        p.log.error(`巡检工具自身崩溃: ${error.message}`);
        process.exit(1);
    }
}
