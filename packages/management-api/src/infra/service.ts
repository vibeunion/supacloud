import { $ } from "bun";
import os from "node:os";

export class ServiceManager {
    static async register(name: string, description: string, execPath: string, args: string[] = []) {
        const platform = os.platform();
        const fullExec = `${execPath} ${args.join(" ")}`.trim();

        if (platform === "linux") {
            await this.registerLinux(name, description, fullExec);
        } else if (platform === "darwin") {
            await this.registerMac(name, description, fullExec);
        } else {
            throw new Error(`暂不支持在 ${platform} 上自动注册服务。`);
        }
    }

    private static async registerLinux(name: string, description: string, execPath: string) {
        console.log(`[ServiceManager] 正在 Linux (Systemd) 下注册服务: ${name}`);
        const unitFile = `
[Unit]
Description=${description}
After=network.target

[Service]
Type=simple
ExecStart=${execPath}
Restart=always
RestartSec=10
StandardOutput=null
StandardError=journal

[Install]
WantedBy=multi-user.target
`.trim();

        const servicePath = `/etc/systemd/system/${name}.service`;
        const tempPath = `/tmp/${name}.service.tmp`;
        await Bun.write(tempPath, unitFile);

        await $`sudo mv ${tempPath} ${servicePath}`.nothrow();
        await $`sudo chown root:root ${servicePath}`.nothrow();
        await $`sudo chmod 644 ${servicePath}`.nothrow();

        await $`sudo systemctl daemon-reload`.nothrow();
        await $`sudo systemctl enable ${name}`.nothrow();
        await $`sudo systemctl restart ${name}`.nothrow();
        console.log(`[ServiceManager] 服务 ${name} 已在 Systemd 注册并启动。`);
    }

    private static async registerMac(name: string, description: string, execPath: string) {
        console.log(`[ServiceManager] 正在 macOS (Launchd) 下注册服务: ${name}`);
        const label = `com.supacloud.${name}`;
        const plist = `
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        ${execPath.split(" ").map(arg => `<string>${arg}</string>`).join("\n        ")}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/${name}.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/${name}.err</string>
</dict>
</plist>
`.trim();

        const plistPath = `${os.homedir()}/Library/LaunchAgents/${label}.plist`;
        await Bun.write(plistPath, plist);

        await $`launchctl unload ${plistPath}`.nothrow();
        await $`launchctl load ${plistPath}`.nothrow();
        console.log(`[ServiceManager] 服务 ${name} 已在 Launchd 注册并启动。`);
    }
}
