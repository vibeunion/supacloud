import * as p from "@clack/prompts";
import { HealthChecker, type HealthReport } from "./infra/health";

export async function runDoctor() {
    p.intro("\x1b[45m SupaCloud 系统巡检中心 (Doctor) \x1b[0m");

    const s = p.spinner();
    s.start("正在深度扫描基础设施状态...");

    try {
        const reports = await HealthChecker.runFullCheck();
        s.stop("巡检完成");

        const tableData = reports.map(r => {
            const statusIcon = r.status === "OK" ? "✅" : r.status === "WARN" ? "⚠️" : "❌";
            return `${statusIcon} [${r.component.padEnd(12)}] ${r.message}`;
        });

        p.note(tableData.join("\n"), "系统体检报告");

        const issues = reports.filter(r => r.status !== "OK");
        if (issues.length > 0) {
            p.log.warn(`发现 ${issues.length} 个潜在问题：`);
            issues.forEach(r => {
                p.log.step(`- \x1b[33m${r.component}\x1b[0m: ${r.recommendation || "请查看系统日志。"}`);
            });
        } else {
            p.log.success("所有系统组件运行良好，未发现异常点。");
        }

        p.outro("保持现状，祝您部署愉快！");
    } catch (error: any) {
        s.stop("巡检中途故障");
        p.log.error(`巡检工具自身崩溃: ${error.message}`);
        process.exit(1);
    }
}
