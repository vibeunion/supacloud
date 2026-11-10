#!/usr/bin/env python3
"""Project private installation input into the capabilities of each service."""
from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path


def render(config_dir: Path) -> None:
    spec = importlib.util.spec_from_file_location("init_env", Path(__file__).with_name("init-env.py"))
    if spec is None or spec.loader is None:
        raise RuntimeError("Environment writer is unavailable")
    writer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(writer)
    source = config_dir / "supacloud.env"
    values: dict[str, str] = {}
    for line in source.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value
    projections = {
        "postgres": {
            key: value for key, value in values.items()
            if key in {"POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "TZ", "PGTZ"}
            or key.startswith(("ENABLE_", "PGSODIUM_", "VAULT_", "FERRETDB_"))
        },
        "gotrue": {
            key: value for key, value in values.items()
            if key.startswith("GOTRUE_") or key == "API_EXTERNAL_URL"
        },
        "postgrest": {key: value for key, value in values.items() if key.startswith("PGRST_")},
        "pgredis-runtime": {
            key: value for key, value in values.items() if key.startswith("PGREDIS_RUNTIME_")
        },
        "edge-runtime": {
            key: value for key, value in values.items()
            if key in {"NODE_ENV", "MANAGEMENT_API_URL", "MASTER_TOKEN", "EDGE_RUNTIME_MASTER_KEY",
                       "EDGE_FUNCTIONS_DIR", "TENANTS_DIR"}
            or key.startswith(("EDGE_RUNTIME_", "EDGE_MAX_", "PGREDIS_RUNTIME_"))
        },
        "caddy": {},
        "victorialogs": {},
        "management-api": {
            key: value for key, value in values.items()
            if not key.startswith(("PGSODIUM_", "VAULT_", "FERRETDB_", "GOTRUE_", "PGRST_", "ENABLE_"))
        },
    }
    projections["edge-runtime"]["PORT"] = "9005"
    projections["management-api"]["PORT"] = "9090"
    for service, environment in projections.items():
        destination = config_dir / f"{service}.env"
        if destination.is_symlink():
            raise ValueError(f"Refusing symlink environment file: {destination}")
        writer.write_private_env(destination, "".join(f"{key}={value}\n" for key, value in sorted(environment.items())))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config_dir", type=Path)
    render(parser.parse_args().config_dir)
