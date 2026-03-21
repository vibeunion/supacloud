import { shellService } from './shell.service';
import { logger } from "../utils/logger";

/**
 * Add firewall rule
 */
export async function addFirewallRule(port: number, sourceIp: string): Promise<{ message: string }> {
  const { success, error } = await shellService.execute('security_manager.sh', ['add_firewall_rule', port.toString(), sourceIp]);

  if (!success) {
    logger.error('Failed to add firewall rule:', error);
    throw new Error('Failed to add firewall rule');
  }

  return { message: `Port ${port} opened for IP ${sourceIp}` };
}

/**
 * Remove firewall rule
 */
export async function removeFirewallRule(port: number, sourceIp: string): Promise<{ message: string }> {
  const { success, error } = await shellService.execute('security_manager.sh', ['remove_firewall_rule', port.toString(), sourceIp]);

  if (!success) {
    logger.error('Failed to remove firewall rule:', error);
    throw new Error('Failed to remove firewall rule');
  }

  return { message: `Port ${port} access removed for IP ${sourceIp}` };
}

/**
 * Request and deploy SSL certificate
 */
export async function requestSsl(domain: string): Promise<{ message: string }> {
  // Certificate request is a long-running operation
  shellService.execute('security_manager.sh', ['deploy_certificate', domain]).catch(err => {
    logger.error('Async SSL request failed:', err);
  });

  return { message: `SSL certificate request for domain ${domain} initiated, please check /etc/pigsty/cert later` };
}
