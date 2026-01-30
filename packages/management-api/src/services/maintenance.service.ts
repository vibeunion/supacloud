import { exec } from 'child_process';
import path from 'path';

const HA_MANAGER_PATH = path.resolve(process.cwd(), '../../scripts/lib/ha_manager.sh');

export class MaintenanceService {
    /**
     * 执行主从切换 (Switchover)
     * @param cluster 集群名
     * @param candidate 目标节点 (可选)
     */
    static async switchover(cluster: string = 'db-main', candidate?: string): Promise<{ message: string }> {
        return new Promise((resolve, reject) => {
            const cmd = `bash ${HA_MANAGER_PATH} switchover ${cluster} ${candidate || ''}`;
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    console.error('Switchover failed:', stderr);
                    return reject(new Error('主从切换指令发送失败'));
                }
                resolve({ message: '主从切换操作已下发成功' });
            });
        });
    }

    /**
     * 在线重载数据库配置
     * @param nodeIp 节点 IP
     */
    static async reloadConfig(nodeIp: string): Promise<{ message: string }> {
        return new Promise((resolve, reject) => {
            const cmd = `bash ${HA_MANAGER_PATH} reload ${nodeIp}`;
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    console.error('Reload failed:', stderr);
                    return reject(new Error('配置重载失败'));
                }
                resolve({ message: '配置重载指令已发送' });
            });
        });
    }

    /**
     * 扩容只读副本
     * @param ip 新节点 IP
     */
    static async addReplica(ip: string): Promise<{ message: string }> {
        // 扩容是极长任务，不等待完成，直接返回
        exec(`bash ${HA_MANAGER_PATH} add_replica ${ip}`);
        return { message: `已启动节点 ${ip} 的只读副本扩容任务` };
    }
}
