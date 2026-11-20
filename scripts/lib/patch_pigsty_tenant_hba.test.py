#!/usr/bin/env python3
"""Regression: mismatched authenticator_/role_ must not be admitted to another supa_ database."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from patch_pigsty_tenant_hba import decide_hba, preserve_native_access, render_inventory


INVENTORY = """\
all:
  vars:
    pg_hba_rules:
      - { user: dbuser_monitor, db: all, addr: localhost, auth: pwd, order: 350, title: monitor }
      - { user: all, db: all, addr: 127.0.0.1/32, auth: pwd, order: 800, title: later loopback admit }
"""

LEGACY = """\
all:
  vars:
    pg_hba_rules:
      - { user: '/^authenticator_[a-z0-9-]+$/', db: '/^supa_[a-z0-9-]+$/', addr: 127.0.0.1/32, auth: pwd, order: 40, title: 'SupaCloud tenant authenticator loopback' }
      - { user: all, db: all, addr: 127.0.0.1/32, auth: pwd, order: 800, title: later loopback admit }
"""

PIGSTY_46 = """\
all:
  vars:
    pg_users:
      - { name: supabase_etl_admin ,replication: true ,bypassrls: true ,roles: [ pg_read_all_data, dbrole_readonly ]}
      - { name: supabase_read_only_user ,bypassrls: true ,roles: [ pg_read_all_data, dbrole_readonly ]}
    pg_hba_rules: # supabase hba rules, require access from docker network
      - { user: all ,db: postgres  ,addr: 172.16.0.0/12 ,auth: pwd ,title: 'allow access from local docker networks' ,order: 50 }
      - { user: all ,db: _supabase ,addr: 172.16.0.0/12 ,auth: pwd ,title: 'allow internal access from local docker networks' ,order: 50 }
      - { user: custom, db: postgres, addr: 172.16.0.0/12, auth: pwd, title: operator rule, order: 75 }
"""

PAIRED = {
    "authenticator_aaa": {"supa_aaa"},
    "role_aaa": {"supa_aaa"},
    "authenticator_bbb": {"supa_bbb"},
    "role_bbb": {"supa_bbb"},
}


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def check_native_access(previous: str) -> None:
    native = preserve_native_access(PIGSTY_46)
    if native is None or native.count("addr: 172.17.0.0/16") != 2:
        fail("native access did not narrow both upstream Docker-network defaults")
    if "supabase_etl_admin ,replication: true ,bypassrls: false" not in native:
        fail("native access did not preserve NOBYPASSRLS for the ETL role")
    if "supabase_read_only_user ,bypassrls: true" not in native or native.count("172.16.0.0/12") != 1:
        fail("native access unexpectedly changed unrelated role or HBA settings")
    for database in ("postgres", "_supabase"):
        if decide_hba(native, "dbuser", database, {}, "172.20.0.1") != "no-match":
            fail(f"native access widened the stock login rule for {database}")
        if decide_hba(native, "dbuser", database, {}, "172.17.0.1") != "allow":
            fail(f"native access lost the stock 4.5 rule for {database}")
    if "samerole" in native or preserve_native_access(native) is not None:
        fail("fresh native inventory added tenant rules or was not idempotent")
    if preserve_native_access(PIGSTY_46, LEGACY) != native:
        fail("upgrade treated a legacy unpaired rule as proof of tenant pairing")

    upgraded = preserve_native_access(PIGSTY_46, previous)
    if upgraded is None or decide_hba(upgraded, "role_bbb", "supa_aaa", PAIRED) != "reject":
        fail("upgrade lost the previously configured tenant reject rule")
    if decide_hba(upgraded, "role_bbb", "supa_bbb", PAIRED) != "allow":
        fail("upgrade lost the previously configured tenant allow rule")
    if preserve_native_access(upgraded, previous) is not None:
        fail("native upgrade inventory was not idempotent")


def main() -> None:
    unpaired = decide_hba(LEGACY, "authenticator_aaa", "supa_bbb", PAIRED)
    if unpaired != "allow":
        fail(f"oracle no longer treats an unpaired regex as an admit: {unpaired}")

    rendered = render_inventory(INVENTORY)
    if rendered is None:
        fail("inventory patch produced no rules")
    if "/^supa_" in rendered:
        fail("rendered HBA still contains an unpaired supa_ database regex")
    if rendered.count("db: samerole") != 2:
        fail("rendered HBA does not pair authenticator_ and role_ with samerole")
    if "auth: reject" not in rendered:
        fail("rendered HBA does not reject unpaired tenant logins")

    mismatch_cases = (
        ("authenticator_aaa", "supa_bbb"),
        ("role_aaa", "supa_bbb"),
        ("authenticator_bbb", "supa_aaa"),
        ("role_bbb", "supa_aaa"),
    )
    for user, database in mismatch_cases:
        decision = decide_hba(rendered, user, database, PAIRED)
        if decision != "reject":
            fail(f"{user} was {decision} for {database}; mismatched tenant login must be rejected")

    if decide_hba(rendered, "authenticator_aaa", "supa_aaa", PAIRED) != "allow":
        fail("paired authenticator_aaa was not admitted to supa_aaa")
    if decide_hba(rendered, "role_bbb", "supa_bbb", PAIRED) != "allow":
        fail("paired role_bbb was not admitted to supa_bbb")
    if decide_hba(rendered, "authenticator_aaa", "supa_aaa", {}) != "reject":
        fail("authenticator_aaa without samerole membership was not rejected")

    again = render_inventory(rendered)
    if again is not None:
        fail("paired inventory was not idempotent")
    stable = rendered
    for marker in (
        "SupaCloud tenant authenticator loopback",
        "SupaCloud tenant database role loopback",
        "SupaCloud reject unpaired authenticator loopback",
        "SupaCloud reject unpaired database role loopback",
    ):
        if stable.count(marker) != 1:
            fail(f"marker {marker!r} appears {stable.count(marker)} times")

    legacy_rendered = render_inventory(LEGACY)
    if legacy_rendered is None or "/^supa_" in legacy_rendered:
        fail("legacy unpaired authenticator rule was not rewritten")
    if decide_hba(legacy_rendered, "authenticator_aaa", "supa_bbb", PAIRED) != "reject":
        fail("rewritten legacy rule still accepts authenticator_aaa on supa_bbb")
    check_native_access(rendered)


if __name__ == "__main__":
    main()
