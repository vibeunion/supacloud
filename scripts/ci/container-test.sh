#!/bin/bash
set -ex
echo "[CI] 容器内部执行环境已就绪: $(cat /etc/os-release | grep PRETTY_NAME)"

export DEBIAN_FRONTEND=noninteractive
# 关键：在容器内必须禁用 hosts/dns 修改（由于挂载限制）、内核模块加载（由于权限限制）以及节点调优与时间同步（无 service 管理权限）
# 核心补丁现在由 supacloud TS 逻辑自动注入，无需手动指定 -e 参数
# export SUPACLOUD_ANSIBLE_ARGS="-e node_write_etc_hosts=false -e node_dns_method=none -e node_tune=none -e node_kernel_modules=[] -e chrony_enabled=false -vv"
ln -fs /usr/share/zoneinfo/UTC /etc/localtime

# 1. 安装基础依赖
if command -v apt-get >/dev/null; then
    apt-get update -qq
    apt-get install -y -qq curl wget sudo kmod iproute2 openssh-server openssh-client ansible
elif command -v dnf >/dev/null; then
    dnf install -y -q --allowerasing epel-release
    dnf install -y -q --allowerasing curl wget sudo kmod iproute openssh-server openssh-clients ansible
elif command -v yum >/dev/null; then
    yum install -y -q --allowerasing epel-release
    yum install -y -q --allowerasing curl wget sudo kmod iproute openssh-server openssh-clients ansible
fi

# 2. 模拟系统环境 (模拟 systemd 以通过 Ansible 检查)
mkdir -p /etc/supabase /run/sshd /root/.ssh
ssh-keygen -A
if [ ! -f /root/.ssh/id_rsa ]; then
    ssh-keygen -t rsa -N "" -f /root/.ssh/id_rsa
fi
cat /root/.ssh/id_rsa.pub >> /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys
echo "StrictHostKeyChecking no" >> /root/.ssh/config

# 彻底清理可能存在的安全限制 (尤其针对 Rocky/RHEL 镜像)
rm -rf /etc/ssh/sshd_config.d/*
sed -i 's/^#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
sed -i 's/^#PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
echo "PermitRootLogin yes" >> /etc/ssh/sshd_config
echo "PubkeyAuthentication yes" >> /etc/ssh/sshd_config

# 启动 SSHD
/usr/sbin/sshd

# 自测连通性
echo "[CI] 正在自测 SSH 连通性..."
ssh -o BatchMode=yes -o ConnectTimeout=5 127.0.0.1 "echo SSH OK" || { echo "[ERROR] SSH 自检失败"; exit 1; }

# 核心劫持：将 /usr/local/bin 置于首位，用于拦截 systemctl 报错
export PATH="/usr/local/bin:$PATH"

for cmd in systemctl hostnamectl timedatectl sysctl modprobe apparmor_status udevadm; do
    case "$cmd" in
        systemctl)
            cat <<'INNEREOF' > /usr/local/bin/systemctl
#!/bin/bash
# 定向劫持 Chrony 请求，防止容器内无权限报错；其他请求尝试透传
REAL_SYSTEMCTL=$(which -a systemctl | grep -v "/usr/local/bin/systemctl" | head -n 1)
args="$@"

if [[ "$args" == *"chrony"* ]]; then
    echo "[MOCK] Intecepted systemctl $args for chrony/chronyd -> Success"
    exit 0
fi

if [ -n "$REAL_SYSTEMCTL" ]; then
    exec "$REAL_SYSTEMCTL" "$@"
else
    # 回退逻辑：如果系统内没装真实 systemctl (比如极简镜像)
    if [[ "$args" == *"is-active"* || "$args" == *"is-enabled"* || "$args" == *"status"* ]]; then
        exit 0
    fi
    exit 0
fi
INNEREOF
            ;;
        hostnamectl)
            cat <<'INNEREOF' > /usr/local/bin/hostnamectl
#!/bin/bash
echo "Static hostname: localhost"; echo "Icon name: computer-vm"; echo "Chassis: vm"; echo "Operating System: Linux"
INNEREOF
            ;;
        timedatectl)
            cat <<'INNEREOF' > /usr/local/bin/timedatectl
#!/bin/bash
echo "Local time: $(date)"; echo "Time zone: UTC (UTC, +0000)"
INNEREOF
            ;;
        sysctl|modprobe|udevadm)
            cat <<'INNEREOF' > "/usr/local/bin/$cmd"
#!/bin/bash
echo "Simulating $cmd $@"
exit 0
INNEREOF
            ;;
        apparmor_status)
            cat <<'INNEREOF' > /usr/local/bin/apparmor_status
#!/bin/bash
echo "apparmor module is not loaded."
exit 0
INNEREOF
            ;;
    esac
    chmod +x "/usr/local/bin/$cmd"
done

# 启动 SSHD (Ansible 需要)
/usr/sbin/sshd

# 3. 运行安装测试
CDIR="/root/supacloud"
cp $CDIR/packages/management-api/supacloud-linux-amd64 /usr/local/bin/supacloud
chmod +x /usr/local/bin/supacloud

# --- 故障诊断函数 ---
on_failure() {
    echo "===================================================="
    echo "[CRITICAL ERROR] 检测到部署失败！正在提取诊断日志..."
    echo "===================================================="
    echo "[SSHD STATUS]"
    ps aux | grep sshd || true
    echo "[PG_HBA.CONF]"
    find /var/lib/pgsql -name pg_hba.conf -exec cat {} + || echo "pg_hba.conf not found"
    echo "[SYSTEM LOGS (LAST 50)]"
    tail -n 50 /var/log/syslog || tail -n 50 /var/log/messages || true
}
trap on_failure ERR

echo '[CI] 开始跨发行版容器集成测试...'
/usr/local/bin/supacloud install --yes --ip 127.0.0.1 --domain api.local.nip.io --password ci-test-pass

# 4. 自动化冒烟测试 (Smoke Test)
echo '[CI] 开始冒烟测试 (Smoke Test)...'
max_retry=5
retry_count=0
until curl -s -f http://127.0.0.1:8080/health || [ $retry_count -eq $max_retry ]; do
    echo "等待 Management API 就绪 (5s)..."
    sleep 5
    ((retry_count++))
done

if [ $retry_count -eq $max_retry ]; then
    echo "[ERROR] 冒烟测试失败: Management API 响应超时"
    on_failure
    exit 1
fi

echo "[SUCCESS] 冒烟测试通过: Management API 已上线"
