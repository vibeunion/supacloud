import { exec } from 'child_process';
import path from 'path';

const SECURITY_MANAGER_PATH = path.resolve(process.cwd(), '../../scripts/lib/security_manager.sh');

export class SecurityService {
    /**
     * 添加防火墙规则
     */
    static async addFirewallRule(port: number, sourceIp: string): Promise<{ message: string }> {
        return new Promise((resolve, reject) => {
            const cmd = `bash ${SECURITY_MANAGER_PATH} add_firewall_rule ${port} ${sourceIp}`;
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    console.error('Failed to add firewall rule:', stderr);
                    return reject(new Error('添加防火墙规则失败'));
                }
                resolve({ message: `端口 ${port} 已对 IP ${sourceIp} 开放` });
            });
        });
    }

    /**
     * 移除防火墙规则
     */
    static async removeFirewallRule(port: number, sourceIp: string): Promise<{ message: string }> {
        return new Promise((resolve, reject) => {
            const cmd = `bash ${SECURITY_MANAGER_PATH} remove_firewall_rule ${port} ${sourceIp}`;
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    console.error('Failed to remove firewall rule:', stderr);
                    return reject(new Error('删除防火墙规则失败'));
                }
                resolve({ message: `已移除对 IP ${sourceIp} 的端口 ${port} 访问授权` });
            });
        });
    }

    /**
     * 申请并部署 SSL 证书
     */
    static async requestSsl(domain: string): Promise<{ message: string }> {
        // 证书申请是长耗时操作
        exec(`bash ${SECURITY_MANAGER_PATH} deploy_certificate ${domain}`);
        return { message: `已发起域名 ${domain} 的 SSL 证书申请任务，请稍后在 /etc/pigsty/cert 查看` };
    }
}
