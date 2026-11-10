#!/usr/bin/env python3
"""Regression: mismatched authenticator_/role_ must not be admitted to another supa_ database."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from patch_pigsty_tenant_hba import decide_hba, render_inventory


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

PAIRED = {
    "authenticator_aaa": {"supa_aaa"},
    "role_aaa": {"supa_aaa"},
    "authenticator_bbb": {"supa_bbb"},
    "role_bbb": {"supa_bbb"},
}


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


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


if __name__ == "__main__":
    main()
