#!/bin/sh
if [ "$1" = "validate" ]; then
  exit 0
fi

echo "duplicate ID rejected during caddy run" >&2
exit 1
