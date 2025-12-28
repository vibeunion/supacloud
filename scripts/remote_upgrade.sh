#!/bin/bash
SERVER="root@139.155.77.203"
echo ">>> Connecting to SupaCloud Server ($SERVER)..."
echo ">>> Executing 'supacloud upgrade'..."

ssh -t $SERVER "source /etc/profile; supacloud upgrade"
