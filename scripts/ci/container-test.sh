#!/bin/bash
set -ex
echo "[CI] 容器内部执行环境已就绪: $(cat /etc/os-release | grep PRETTY_NAME)"

export DEBIAN_FRONTEND=noninteractive
# 关键：在容器内必须禁用 hosts/dns 修改（由于挂载限制）、内核模块加载（由于权限限制）以及节点调优与时间同步（无 service 管理权限）
export SUPACLOUD_ANSIBLE_ARGS="-e node_write_etc_hosts=false -e node_dns_method=none -e node_tune=none -e node_kernel_modules=[] -e chrony_enabled=false -vv"
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
echo "PermitRootLogin yes" >> /etc/ssh/sshd_config
echo "PubkeyAuthentication yes" >> /etc/ssh/sshd_config
/usr/sbin/sshd

for cmd in systemctl hostnamectl timedatectl sysctl modprobe apparmor_status udevadm; do
    case "$cmd" in
        systemctl)
            cat <<'INNEREOF' > /usr/local/bin/systemctl
#!/bin/bash
arg="$@"
if [[ "$arg" == *"is-active"* || "$arg" == *"is-enabled"* || "$arg" == *"status"* ]]; then
    exit 0
fi
[ "$1" = "daemon-reload" ] && exit 0
echo "Simulating systemctl $@"
exit 0
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
CDIR="/workspace"
cp $CDIR/packages/management-api/supacloud-linux-amd64 /usr/local/bin/supacloud
chmod +x /usr/local/bin/supacloud

echo '[CI] 开始跨发行版容器集成测试...'
/usr/local/bin/supacloud install --yes --ip 127.0.0.1 --domain api.local.nip.io --password ci-test-pass
