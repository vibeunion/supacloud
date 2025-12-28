$Server = "root@139.155.77.203"
Write-Host ">>> Connecting to SupaCloud Server ($Server)..."
Write-Host ">>> Forcing Update via Install Script (CN Proxy)..."

ssh -t $Server "export SUPACLOUD_CN=1; curl -fsSL https://mirror.ghproxy.com/https://raw.githubusercontent.com/zuohuadong/supacloud/main/scripts/install.sh | bash -s cn"
