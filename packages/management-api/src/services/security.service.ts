import { shellService } from './shell.service';
import { logger } from "../utils/logger";
import { isIP } from "node:net";

function assertSafePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid port");
  }
}

function assertSafeIpOrCidr(sourceIp: string): void {
  const [ip, prefix] = sourceIp.split("/");
  if (!isIP(ip)) throw new Error("Invalid IP address");
  if (prefix !== undefined) {
    const bits = Number(prefix);
    if (!/^\d{1,3}$/.test(prefix) || (isIP(ip) === 4 ? bits < 0 || bits > 32 : bits < 0 || bits > 128)) {
      throw new Error("Invalid CIDR prefix");
    }
  }
}

function assertSafeDomain(domain: string): void {
  if (domain.length > 253 || domain.includes("..") || !/^(?=.{1,253}$)(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$/.test(domain)) {
    throw new Error("Invalid domain");
  }
}

/**
 * Add firewall rule
 */
export async function addFirewallRule(port: number, sourceIp: string): Promise<{ message: string }> {
  assertSafePort(port);
  assertSafeIpOrCidr(sourceIp);
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
  assertSafePort(port);
  assertSafeIpOrCidr(sourceIp);
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
  assertSafeDomain(domain);
  // Certificate request is a long-running operation
  shellService.execute('security_manager.sh', ['deploy_certificate', domain]).catch(err => {
    logger.error('Async SSL request failed:', err);
  });

  return { message: `SSL certificate request for domain ${domain} initiated, please check /etc/pigsty/cert later` };
}
