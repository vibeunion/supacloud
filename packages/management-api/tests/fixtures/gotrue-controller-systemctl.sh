#!/bin/sh
printf '%s\n' "$*" >> "$TEST_SYSTEMCTL_LOG"
if [ "$1" = show ]; then
    if [ "${TEST_SYSTEMCTL_SHOW_FAIL:-0}" = 1 ]; then exit 1; fi
    if [ "$2" = "--property=ActiveState" ]; then
        printf '%s\n' "${TEST_SYSTEMCTL_ACTIVE_STATE:-inactive}"
    else
        printf '%s\n' "${TEST_SYSTEMCTL_STATE:-loaded}"
    fi
    exit 0
fi
if [ "$1" = "${TEST_SYSTEMCTL_DENY:-}" ]; then
    printf 'permission denied\n' >&2
    exit 1
fi
exit 0
