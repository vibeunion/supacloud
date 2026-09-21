import os from "node:os";

interface CpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}
export interface SystemInfoSnapshot {
  cpus: readonly CpuTimes[];
  totalMemory: number;
  freeMemory: number;
  uptime: number;
  processUptime: number;
  version: string;
  platform: string;
  arch: string;
  hostname: string;
}
export interface SystemInfoResponse {
  cpu: string;
  memory: string;
  uptime: string;
  version: string;
  cores: number;
  platform: string;
  arch: string;
  hostname: string;
  processUptime: number;
}
function invalid(): never { throw new Error("Invalid system information snapshot"); }
function counter(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : invalid();
}
function seconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) return invalid();
  return counter(Math.floor(value));
}
function text(value: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) ? value : invalid();
}

export function formatSystemInfo(snapshot: SystemInfoSnapshot): SystemInfoResponse {
  if (snapshot.cpus.length === 0) return invalid();
  let idleShare = 0;
  for (const cpu of snapshot.cpus) {
    const total = counter(cpu.user) + counter(cpu.nice) + counter(cpu.sys) + counter(cpu.idle) + counter(cpu.irq);
    if (!Number.isSafeInteger(total) || total <= 0) return invalid();
    idleShare += cpu.idle / total;
  }
  const totalMemory = counter(snapshot.totalMemory);
  const freeMemory = counter(snapshot.freeMemory);
  if (totalMemory === 0 || freeMemory > totalMemory) return invalid();
  const uptime = seconds(snapshot.uptime);
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const version = text(snapshot.version);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) return invalid();
  return {
    cpu: `${((1 - idleShare / snapshot.cpus.length) * 100).toFixed(1)}%`,
    memory: `${((totalMemory - freeMemory) / 1024 / 1024).toFixed(0)} / ${(totalMemory / 1024 / 1024).toFixed(0)} MB`,
    uptime: days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`,
    version, cores: snapshot.cpus.length, platform: text(snapshot.platform), arch: text(snapshot.arch),
    hostname: text(snapshot.hostname), processUptime: seconds(snapshot.processUptime),
  };
}

export async function collectSystemInfo(): Promise<SystemInfoResponse> {
  const pkg = await import("../../package.json");
  return formatSystemInfo({
    cpus: os.cpus().map(cpu => cpu.times), totalMemory: os.totalmem(), freeMemory: os.freemem(),
    uptime: os.uptime(), processUptime: process.uptime(), version: pkg.version,
    platform: os.platform(), arch: os.arch(), hostname: os.hostname(),
  });
}
