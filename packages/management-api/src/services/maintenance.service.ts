import { shellService } from './shell.service';

export class MaintenanceService {
    /**
     * 执行主从切换 (Switchover)
     * @param cluster 集群名
     * @param candidate 目标节点 (可选)
     */
    static async switchover(cluster: string = 'db-main', candidate?: string): Promise<{ message: string }> {
        const { success, error } = await shellService.execute('ha_manager.sh', ['switchover', cluster, candidate || '']);

        if (!success) {
            console.error('Switchover failed:', error);
            throw new Error('主从切换指令发送失败');
        }

        return { message: '主从切换操作已下发成功' };
    }

    /**
     * 在线重载数据库配置
     * @param nodeIp 节点 IP
     */
    static async reloadConfig(nodeIp: string): Promise<{ message: string }> {
        const { success, error } = await shellService.execute('ha_manager.sh', ['reload', nodeIp]);

        if (!success) {
            console.error('Reload failed:', error);
            throw new Error('配置重载失败');
        }

        return { message: '配置重载指令已发送' };
    }

    /**
     * 扩容只读副本
     * @param ip 新节点 IP
     */
    static async addReplica(ip: string): Promise<{ message: string }> {
        // 扩容是极长任务，不等待完成，直接返回
        shellService.execute('ha_manager.sh', ['add_replica', ip]).catch(err => {
            console.error('Async add_replica task failed:', err);
        });

        return { message: `已启动节点 ${ip} 的只读副本扩容任务` };
    }
}
