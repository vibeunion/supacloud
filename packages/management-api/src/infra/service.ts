/**
 * Service Infrastructure Management
 * 
 * Handles low-level service operations and process management
 */

import { $ } from 'bun'
import { logger } from "../utils/logger";




export interface ServiceInfo {
  name: string
  status: 'running' | 'stopped' | 'failed' | 'unknown'
  pid?: number
  port?: number
  uptime?: number
  memoryUsage?: number
}

export interface ServiceConfig {
  name: string
  command: string
  env?: Record<string, string>
  cwd?: string
  autoRestart?: boolean
  maxRestarts?: number
}

/**
 * Service Manager
 * Manages system services and processes
 */
export class ServiceManager {
  private services: Map<string, ServiceConfig> = new Map()

  /**
   * Static helper to register a systemd service (Linux only)
   */
  static async register(name: string, description: string, execPath: string, args: string[] = []) {
    if (process.platform !== 'linux') {
      logger.warn(`Skip service registration on ${process.platform}`)
      return
    }

    const serviceContent = `[Unit]
Description=${description}
After=network.target

[Service]
ExecStart=${execPath} ${args.join(' ')}
Restart=always
User=root
EnvironmentFile=-/etc/supabase/management-api.env

[Install]
WantedBy=multi-user.target
`
    const serviceFile = `/etc/systemd/system/${name}.service`

    try {
      await $`echo "${serviceContent}" | sudo tee ${serviceFile} > /dev/null`.nothrow()
      await $`sudo systemctl daemon-reload`.nothrow()
      await $`sudo systemctl enable ${name}`.nothrow()
      await $`sudo systemctl start ${name}`.nothrow()
      logger.info(`Systemd service registered and started: ${name}`)
    } catch (err: unknown) {
      logger.error(`Failed to register systemd service ${name}`, { error: err instanceof Error ? (err as Error).message : String(err) })
      throw err
    }
  }


  /**
   * Register a new service
   */
  registerService(config: ServiceConfig): void {
    this.services.set(config.name, config)
    logger.info(`Service registered: ${config.name}`)
  }

  /**
   * Get service status by name
   */
  async getServiceStatus(serviceName: string): Promise<ServiceInfo> {
    try {
      const stdout = await $`systemctl is-active ${serviceName}`.text()
      const status = stdout.trim()

      return {
        name: serviceName,
        status: status === 'active' ? 'running' : 'stopped'
      }
    } catch (err: unknown) {
      logger.warn("[InfraService] Systemd service status check failed", { error: err });
      // Check if process exists via pgrep
      try {
        const stdout = await $`pgrep -f ${serviceName}`.text()
        const pid = parseInt(stdout.trim(), 10)
        return {
          name: serviceName,
          status: 'running',
          pid
        }
      } catch (err: unknown) {
        logger.warn("[InfraService] Failed to parse systemd service output", { error: err });
        return {
          name: serviceName,
          status: 'stopped'
        }
      }
    }
  }

  /**
   * Start a service
   */
  async startService(serviceName: string): Promise<boolean> {
    try {
      await $`systemctl start ${serviceName}`
      logger.info(`Service started: ${serviceName}`)
      return true
    } catch (error: unknown) {
      logger.error(`Failed to start service ${serviceName}`, { error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  /**
   * Stop a service
   */
  async stopService(serviceName: string): Promise<boolean> {
    try {
      await $`systemctl stop ${serviceName}`
      logger.info(`Service stopped: ${serviceName}`)
      return true
    } catch (error: unknown) {
      logger.error(`Failed to stop service ${serviceName}`, { error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  /**
   * Restart a service
   */
  async restartService(serviceName: string): Promise<boolean> {
    try {
      await $`systemctl restart ${serviceName}`
      logger.info(`Service restarted: ${serviceName}`)
      return true
    } catch (error: unknown) {
      logger.error(`Failed to restart service ${serviceName}`, { error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  /**
   * Get all registered services status
   */
  async getAllServicesStatus(): Promise<ServiceInfo[]> {
    const statuses: ServiceInfo[] = []

    for (const [name] of this.services) {
      const status = await this.getServiceStatus(name)
      statuses.push(status)
    }

    return statuses
  }

  /**
   * Check service health by HTTP endpoint
   */
  async checkServiceHealth(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      })
      return response.ok
    } catch (e: unknown) { logger.debug("[infra/service] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }
    return false;
  }
}

// Export singleton instance
export const serviceManager = new ServiceManager()
