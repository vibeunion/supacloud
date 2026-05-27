#!/bin/bash
# Shared helpers for Docker entrypoint init scripts.
# Source this file: . /docker-entrypoint-initdb.d/00-common.sh

truthy() {
  case "${1,,}" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}
