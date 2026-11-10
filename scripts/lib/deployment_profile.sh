#!/usr/bin/env bash

# Resolve the deployment and database provider without probing or implicitly
# adopting an arbitrary PostgreSQL instance. The current native installer still
# owns the Pigsty path; Podman is a separate single-node provider.

supacloud_validate_database_url() {
    local database_url="${1:-}"
    [[ -n "$database_url" ]] || {
        printf 'SUPACLOUD_DATABASE_URL is required for the external profile\n' >&2
        return 1
    }
    [[ "$database_url" != *$'\n'* && "$database_url" != *$'\r'* ]] || {
        printf 'SUPACLOUD_DATABASE_URL must be a single-line PostgreSQL URL\n' >&2
        return 1
    }
    [[ "$database_url" =~ ^postgres(ql)?://[^[:space:]]+$ ]] || {
        printf 'SUPACLOUD_DATABASE_URL must use postgres:// or postgresql://\n' >&2
        return 1
    }
}

supacloud_resolve_deployment_profile() {
    local requested="${SUPACLOUD_DEPLOYMENT_PROFILE:-}"
    local database_url="${SUPACLOUD_DATABASE_URL:-}"
    local use_pigsty="${SUPACLOUD_USE_PIGSTY:-}"

    # New installs default to the self-contained Podman provider. An existing
    # Pigsty checkout remains on Pigsty, and an explicit database URL selects
    # the external provider. A database process discovered on a host is never
    # adopted implicitly.
    if [[ -z "$requested" ]]; then
        if [[ -n "$database_url" ]]; then
            requested="external"
        elif [[ "$use_pigsty" == "true" || ( -z "$use_pigsty" && -f "${PIGSTY_PATH:-${HOME:-/root}/pigsty}/bootstrap" ) ]]; then
            requested="pigsty"
        else
            requested="podman"
        fi
    fi

    case "$requested" in
        pigsty)
            if [[ -n "$database_url" ]]; then
                printf 'SUPACLOUD_DATABASE_URL cannot be combined with the pigsty profile; use external instead\n' >&2
                return 1
            fi
            SUPACLOUD_DATABASE_PROVIDER="pigsty"
            ;;
        solo)
            if [[ -n "$database_url" ]]; then
                printf 'SUPACLOUD_DATABASE_URL cannot be combined with the solo profile; use external instead\n' >&2
                return 1
            fi
            # `solo` is the canonical single-node profile. Its supported
            # provider is Podman+Quadlet until a native systemd provider is
            # separately accepted; it never falls through to Pigsty.
            SUPACLOUD_DATABASE_PROVIDER="podman-single-node"
            ;;
        podman)
            if [[ -n "$database_url" ]]; then
                printf 'SUPACLOUD_DATABASE_URL cannot be combined with the podman profile; use external instead\n' >&2
                return 1
            fi
            SUPACLOUD_DATABASE_PROVIDER="podman-single-node"
            ;;
        cluster)
            if [[ -n "$database_url" ]]; then
                printf 'SUPACLOUD_DATABASE_URL must be configured through the cluster secret/provider for the cluster profile\n' >&2
                return 1
            fi
            SUPACLOUD_DATABASE_PROVIDER="cluster-external"
            ;;
        docker)
            printf 'The docker deployment profile is no longer supported; use --profile podman, --profile external, or --profile pigsty\n' >&2
            return 1
            ;;
        external)
            supacloud_validate_database_url "$database_url" || return 1
            SUPACLOUD_DATABASE_PROVIDER="external-postgres"
            ;;
        *)
            printf 'SUPACLOUD_DEPLOYMENT_PROFILE must be one of: pigsty, solo, podman, external, cluster\n' >&2
            return 1
            ;;
    esac

    SUPACLOUD_DEPLOYMENT_PROFILE="$requested"
    export SUPACLOUD_DEPLOYMENT_PROFILE SUPACLOUD_DATABASE_PROVIDER
}

# The legacy install path is deliberately fail-closed for profiles whose
# provider implementation is not yet wired. This prevents a requested solo or
# external deployment from silently running the Pigsty installer.
supacloud_require_pigsty_install_path() {
    case "${SUPACLOUD_DATABASE_PROVIDER:-}" in
        pigsty)
            return 0
            ;;
        external-postgres)
            printf 'The external profile resolved to external-postgres, but the current installer path does not bind an external database yet. Use the external provider once it is available, or select --profile pigsty.\n' >&2
            return 1
            ;;
        podman-single-node)
            printf 'The podman profile is recognized, but the Podman single-node provider is not wired into the native installer yet. Use the documented Podman deployment entrypoint or select --profile pigsty.\n' >&2
            return 1
            ;;
        cluster-external)
            printf 'The cluster profile requires a Kubernetes/OpenShift control plane and an accepted external database/storage provider; the native installer refuses to emulate a cluster with Podman. See docs/podman-cluster-migration.md.\n' >&2
            return 1
            ;;
        docker-compose)
            printf 'The Docker Compose provider is not supported by the native installer; use --profile podman instead.\n' >&2
            return 1
            ;;
        *)
            printf 'Deployment profile must be resolved before installation\n' >&2
            return 1
            ;;
    esac
}
