$Server = "root@139.155.77.203"
Write-Host ">>> Connecting to SupaCloud Server ($Server)..."
Write-Host ">>> Executing 'supacloud upgrade'..."

ssh -t $Server "source /etc/profile; supacloud upgrade"
