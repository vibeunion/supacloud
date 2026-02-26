import { shellService } from './shell.service';

export class SecurityService {
    /**
     * 添加防火墙规则
     */
    static async addFirewallRule(port: number, sourceIp: string): Promise<{ message: string }> {
        const { success, error } = await shellService.execute('security_manager.sh', ['add_firewall_rule', port.toString(), sourceIp]);

        if (!success) {
            console.error('Failed to add firewall rule:', error);
            throw new Error('添加防火墙规则失败');
        }

        return { message: `端口 ${port} 已对 IP ${sourceIp} 开放` };
    }

    /**
     * 移除防火墙规则
     */
    static async removeFirewallRule(port: number, sourceIp: string): Promise<{ message: string }> {
        const { success, error } = await shellService.execute('security_manager.sh', ['remove_firewall_rule', port.toString(), sourceIp]);

        if (!success) {
            console.error('Failed to remove firewall rule:', error);
            throw new Error('删除防火墙规则失败');
        }

        return { message: `已移除对 IP ${sourceIp} 的端口 ${port} 访问授权` };
    }

    /**
     * 申请并部署 SSL 证书
     */
    static async requestSsl(domain: string): Promise<{ message: string }> {
        // 证书申请是长耗时操作
        shellService.execute('security_manager.sh', ['deploy_certificate', domain]).catch(err => {
            console.error('Async SSL request failed:', err);
        });

        return { message: `已发起域名 ${domain} 的 SSL 证书申请任务，请稍后在 /etc/pigsty/cert 查看` };
    }
}
