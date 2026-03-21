import { shellService } from './shell.service';
import { logger } from "../utils/logger";

/**
 * Execute primary-replica switchover
 * @param cluster Cluster name
 * @param candidate Target node (optional)
 */
export async function switchover(cluster: string = 'db-main', candidate?: string): Promise<{ message: string }> {
  const { success, error } = await shellService.execute('ha_manager.sh', ['switchover', cluster, candidate || '']);

  if (!success) {
    logger.error('Switchover failed:', error);
    throw new Error('Switchover command failed to send');
  }

  return { message: 'Switchover operation sent successfully' };
}

/**
 * Online reload database config
 * @param nodeIp Node IP
 */
export async function reloadConfig(nodeIp: string): Promise<{ message: string }> {
  const { success, error } = await shellService.execute('ha_manager.sh', ['reload', nodeIp]);

  if (!success) {
    logger.error('Reload failed:', error);
    throw new Error('Config reload failed');
  }

  return { message: 'Config reload command sent' };
}

/**
 * Scale out read replica
 * @param ip New node IP
 */
export async function addReplica(ip: string): Promise<{ message: string }> {
  // Scaling is a very long task, don't wait for completion, return immediately
  shellService.execute('ha_manager.sh', ['add_replica', ip]).catch(err => {
    logger.error('Async add_replica task failed:', err);
  });

  return { message: `Read replica expansion task started for node ${ip}` };
}
