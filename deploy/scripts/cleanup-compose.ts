#!/usr/bin/env bun
/**
 * cleanup-compose.ts
 * 清理 docker-compose.yml 中的 analytics/logflare/vector 服务
 * 用法: bun run cleanup-compose.ts <compose-file> [mode]
 * mode: "off" (移除全部) | "postgres" (保留 logflare/vector，调整配置)
 */

import { parse, stringify } from "yaml";

const file = Bun.argv[2];
const mode = Bun.argv[3] || "off";

if (!file) {
  console.error("Usage: bun run cleanup-compose.ts <compose-file> [mode]");
  process.exit(1);
}

try {
  const content = await Bun.file(file).text();
  const data = parse(content) as any;

  if (!data.services) {
    console.log("No services found, skipping.");
    process.exit(0);
  }

  // 要移除的服务列表
  const toRemove = mode === "off"
    ? ["analytics", "logflare", "vector"]
    : ["analytics"]; // postgres 模式只移除 analytics

  // 1. 移除服务定义
  for (const svc of toRemove) {
    if (data.services[svc]) {
      delete data.services[svc];
      console.log(`Removed service: ${svc}`);
    }
  }

  // 2. 清理其他服务中的 depends_on 引用
  for (const [name, conf] of Object.entries(data.services) as [string, any][]) {
    if (!conf.depends_on) continue;

    if (Array.isArray(conf.depends_on)) {
      // 短语法: depends_on: [svc1, svc2]
      const filtered = conf.depends_on.filter((d: string) => !toRemove.includes(d));
      if (filtered.length === 0) {
        delete conf.depends_on;
      } else if (filtered.length !== conf.depends_on.length) {
        conf.depends_on = filtered;
      }
    } else if (typeof conf.depends_on === "object") {
      // 长语法: depends_on: { svc1: { condition: ... } }
      for (const svc of toRemove) {
        if (svc in conf.depends_on) {
          delete conf.depends_on[svc];
        }
      }
      if (Object.keys(conf.depends_on).length === 0) {
        delete conf.depends_on;
      }
    }
  }

  // 3. postgres 模式下调整 Logflare URL
  if (mode === "postgres") {
    for (const [name, conf] of Object.entries(data.services) as [string, any][]) {
      if (conf.environment) {
        // 处理数组格式的环境变量
        if (Array.isArray(conf.environment)) {
          conf.environment = conf.environment.map((env: string) => {
            if (env.includes("LOGFLARE_URL") && env.includes("analytics")) {
              return env.replace(/analytics:\d+/, "supabase-db:5432");
            }
            return env;
          });
        } else {
          // 处理对象格式的环境变量
          for (const [key, val] of Object.entries(conf.environment)) {
            if (key === "LOGFLARE_URL" && typeof val === "string" && val.includes("analytics")) {
              conf.environment[key] = val.replace(/analytics:\d+/, "supabase-db:5432");
            }
          }
        }
      }
    }
  }

  // 写回文件
  await Bun.write(file, stringify(data, { lineWidth: 0 }));
  console.log(`Cleaned up: ${file}`);

} catch (e) {
  console.error(`Error processing ${file}:`, e);
  process.exit(1);
}
