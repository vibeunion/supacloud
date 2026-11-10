#!/usr/bin/env python3
"""Atomically add SupaCloud tenant HBA pairing rules to a Pigsty inventory.

PostgreSQL matches the user and database fields separately, so a regex pair
authenticator_* / supa_* still admits authenticator_A to supa_B. These rules
use the samerole keyword: authenticator_<ref> and role_<ref> are admitted from
127.0.0.1/32 only when they are members of the role whose name is the requested
database. Any other loopback login of those name patterns is rejected before a
later all/all rule can admit it.

Pigsty still owns pg_hba.conf. This patch only inserts or replaces the titled
SupaCloud lines inside the existing pg_hba_rules list. A Pigsty regenerate that
drops those lines, or an earlier rule that already admits every loopback user,
puts the unpaired pattern back. Re-apply with ensure_pigsty_tenant_hba_rule
after granting the samerole memberships. Membership without this inventory
patch does not pair connections, and this patch without membership rejects
tenant logins.
"""

from __future__ import annotations

import ipaddress
import os
import re
import stat
import sys
import tempfile
from collections.abc import Collection, Mapping


AUTHENTICATOR_RULE_MARKER = "SupaCloud tenant authenticator loopback"
DATABASE_ROLE_RULE_MARKER = "SupaCloud tenant database role loopback"
AUTHENTICATOR_REJECT_MARKER = "SupaCloud reject unpaired authenticator loopback"
DATABASE_ROLE_REJECT_MARKER = "SupaCloud reject unpaired database role loopback"

TENANT_HBA_RULES = (
    (
        AUTHENTICATOR_RULE_MARKER,
        "user: '\"/^authenticator_[a-z0-9-]+$\"', db: samerole, "
        "addr: 127.0.0.1/32, auth: pwd, order: 40",
    ),
    (
        DATABASE_ROLE_RULE_MARKER,
        "user: '\"/^role_[a-z0-9-]+$\"', db: samerole, "
        "addr: 127.0.0.1/32, auth: pwd, order: 41",
    ),
    (
        AUTHENTICATOR_REJECT_MARKER,
        "user: '\"/^authenticator_[a-z0-9-]+$\"', db: all, "
        "addr: 127.0.0.1/32, auth: reject, order: 42",
    ),
    (
        DATABASE_ROLE_REJECT_MARKER,
        "user: '\"/^role_[a-z0-9-]+$\"', db: all, "
        "addr: 127.0.0.1/32, auth: reject, order: 43",
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


def _parse_flow(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    index = 0
    while index < len(body):
        while index < len(body) and body[index] in " \t,":
            index += 1
        if index >= len(body):
            break
        key_end = body.find(":", index)
        if key_end < 0:
            break
        key = body[index:key_end].strip()
        index = key_end + 1
        while index < len(body) and body[index] in " \t":
            index += 1
        if index < len(body) and body[index] == "'":
            index += 1
            chars: list[str] = []
            while index < len(body):
                if body[index] == "'" and index + 1 < len(body) and body[index + 1] == "'":
                    chars.append("'")
                    index += 2
                    continue
                if body[index] == "'":
                    index += 1
                    break
                chars.append(body[index])
                index += 1
            fields[key] = "".join(chars)
            continue
        end = index
        while end < len(body) and body[end] != ",":
            end += 1
        fields[key] = body[index:end].strip()
        index = end
    return fields


def _name_matches(field: str, name: str) -> bool | None:
    if field == "samerole":
        return None
    if field == "all":
        return True
    raw = field
    if len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"':
        raw = raw[1:-1]
    if raw.startswith("/"):
        pattern = raw[1:]
        if pattern.endswith("/"):
            pattern = pattern[:-1]
        return re.search(pattern, name) is not None
    return raw == name


def _addr_matches(addr: str, client: str) -> bool:
    if addr in {"all", "world", "0.0.0.0/0"}:
        return True
    if addr == "localhost":
        return client in {"127.0.0.1", "::1"}
    try:
        return ipaddress.ip_address(client) in ipaddress.ip_network(addr, strict=False)
    except ValueError:
        return addr == client


def hba_rules(content: str) -> list[dict[str, str]]:
    rules: list[dict[str, str]] = []
    for line in content.splitlines():
        stripped = line.strip()
        if not stripped.startswith("- {") or "}" not in stripped:
            continue
        start = stripped.find("{")
        end = stripped.rfind("}")
        rules.append(_parse_flow(stripped[start + 1 : end]))
    return rules


def decide_hba(
    content: str,
    user: str,
    database: str,
    members: Mapping[str, Collection[str]],
    client: str = "127.0.0.1",
) -> str:
    """Return allow, reject, or no-match using PostgreSQL first-match HBA semantics."""
    ordered = sorted(hba_rules(content), key=lambda rule: int(rule.get("order", "0") or "0"))
    for rule in ordered:
        if _name_matches(rule.get("user", ""), user) is False:
            continue
        database_match = _name_matches(rule.get("db", ""), database)
        if database_match is None:
            if database not in members.get(user, ()):
                continue
        elif database_match is False:
            continue
        if not _addr_matches(rule.get("addr", "all"), client):
            continue
        if rule.get("auth") in {"reject", "deny"}:
            return "reject"
        return "allow"
    return "no-match"


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
