/**
 * Service Infrastructure Management
 * 
 * Handles low-level service operations and process management
 */

import { $ } from 'bun'

const logger = {
  info: (...args: any[]) => console.log('[INFO]', ...args),
  warn: (...args: any[]) => console.warn('[WARN]', ...args),
  error: (...args: any[]) => console.error('[ERROR]', ...args),
}


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
EnvironmentFile=/opt/supacloud/config.env

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
    } catch (err) {
      logger.error(`Failed to register systemd service ${name}:`, err)
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
    } catch {
      // Check if process exists via pgrep
      try {
        const stdout = await $`pgrep -f ${serviceName}`.text()
        const pid = parseInt(stdout.trim(), 10)
        return {
          name: serviceName,
          status: 'running',
          pid
        }
      } catch {
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
    } catch (error) {
      logger.error(`Failed to start service ${serviceName}:`, error)
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
    } catch (error) {
      logger.error(`Failed to stop service ${serviceName}:`, error)
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
    } catch (error) {
      logger.error(`Failed to restart service ${serviceName}:`, error)
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
    } catch {
      return false
    }
  }
}

// Export singleton instance
export const serviceManager = new ServiceManager()
