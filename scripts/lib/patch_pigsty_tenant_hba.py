#!/usr/bin/env python3
"""Atomically add the SupaCloud tenant HBA rule to a Pigsty inventory."""

from __future__ import annotations

import os
import re
import stat
import sys
import tempfile


AUTHENTICATOR_RULE_MARKER = "SupaCloud tenant authenticator loopback"
DATABASE_ROLE_RULE_MARKER = "SupaCloud tenant database role loopback"

TENANT_HBA_RULES = (
    (
        AUTHENTICATOR_RULE_MARKER,
        "user: '\"/^authenticator_[a-z0-9-]+$\"', db: '\"/^supa_[a-z0-9-]+$\"', "
        "addr: 127.0.0.1/32, auth: pwd, order: 40",
    ),
    (
        DATABASE_ROLE_RULE_MARKER,
        "user: '\"/^role_[a-z0-9-]+$\"', db: '\"/^supa_[a-z0-9-]+$\"', "
        "addr: 127.0.0.1/32, auth: pwd, order: 41",
    ),
)


def render_inventory(content: str) -> str | None:
    updated_content = content
    missing_rules: list[tuple[str, str]] = []
    for marker, fields in TENANT_HBA_RULES:
        rule_pattern = re.compile(
            rf"(?m)^(?P<indent>[ ]*)-[ ]*\{{[^\n]*title:[ ]*['\"]{re.escape(marker)}['\"][^\n]*\}}[ ]*$"
        )
        existing_rule = rule_pattern.search(updated_content)
        if existing_rule:
            rendered_rule = f"{existing_rule.group('indent')}- {{ {fields}, title: '{marker}' }}"
            updated_content = rule_pattern.sub(rendered_rule, updated_content, count=1)
        else:
            missing_rules.append((marker, fields))

    if not missing_rules:
        return updated_content if updated_content != content else None

    sections = list(re.finditer(r"(?m)^([ ]*)pg_hba_rules:[ ]*(?:#.*)?$", updated_content))
    if len(sections) != 1:
        raise ValueError(f"expected one multiline pg_hba_rules section, found {len(sections)}")

    indent = sections[0].group(1) + "  "
    rendered_rules = "\n".join(
        f"{indent}- {{ {fields}, title: '{marker}' }}"
        for marker, fields in missing_rules
    )
    updated_content = (
        updated_content[: sections[0].end()]
        + "\n"
        + rendered_rules
        + updated_content[sections[0].end() :]
    )
    return updated_content


def atomic_write(path: str, content: str) -> None:
    file_mode = stat.S_IMODE(os.stat(path).st_mode)
    directory = os.path.dirname(path) or "."
    descriptor, temporary_path = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", dir=directory)
    try:
        os.fchmod(descriptor, file_mode)
        with os.fdopen(descriptor, "w", encoding="utf-8") as inventory_file:
            inventory_file.write(content)
            inventory_file.flush()
            os.fsync(inventory_file.fileno())
        os.replace(temporary_path, path)
    finally:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)


def patch_inventory(path: str) -> bool:
    with open(path, "r", encoding="utf-8") as inventory_file:
        content = inventory_file.read()
    updated_content = render_inventory(content)
    if updated_content is None:
        return False
    atomic_write(path, updated_content)
    return True


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <pigsty.yml>", file=sys.stderr)
        return 2
    try:
        patch_inventory(sys.argv[1])
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
