#!/usr/bin/env bash
# Mock script to simulate lib/*.sh for CI testing

SCRIPT_NAME=$(basename "$0")
echo "[MOCK] Executing $SCRIPT_NAME with args: $*"

# Always return success
exit 0
