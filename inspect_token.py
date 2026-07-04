#!/usr/bin/env python3
"""Safely describe the stored Dooremi JWT without printing its secrets."""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
import subprocess
import sys
from typing import Any, Optional


KEYCHAIN_SERVICE = "app.tennis-booker.local"
KEYCHAIN_ACCOUNT = "dooremi-bearer"
TIME_CLAIMS = {"ct", "exp", "iat", "nbf"}


def load_token() -> str:
    result = subprocess.run(
        [
            "/usr/bin/security",
            "find-generic-password",
            "-a",
            KEYCHAIN_ACCOUNT,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
        ],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    token = result.stdout.strip()
    if result.returncode or not token:
        raise RuntimeError("No Tennis Booker token was found in macOS Keychain.")
    return token


def decode_segment(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def describe_value(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer ({} digits)".format(len(str(abs(value))))
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        numeric = ", numeric" if value.isdigit() else ""
        return "string ({} characters{})".format(len(value), numeric)
    if isinstance(value, list):
        return "array ({} items)".format(len(value))
    if isinstance(value, dict):
        return "object ({} keys)".format(len(value))
    if value is None:
        return "null"
    return type(value).__name__


def timestamp_text(value: Any) -> Optional[str]:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        utc = dt.datetime.fromtimestamp(value, tz=dt.timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None
    if not 2000 <= utc.year <= 2200:
        return None
    sgt = utc.astimezone(dt.timezone(dt.timedelta(hours=8), name="SGT"))
    return "{} / {}".format(
        utc.isoformat(timespec="seconds"),
        sgt.isoformat(timespec="seconds"),
    )


def inspect(token: str) -> None:
    parts = token.split(".")
    print("Source: macOS Keychain")
    print(
        "SHA-256 fingerprint: {}… (non-reversible; useful only for comparison)".format(
            hashlib.sha256(token.encode("utf-8")).hexdigest()[:12]
        )
    )
    print("Segments: {} {}".format(len(parts), [len(part) for part in parts]))

    if len(parts) != 3:
        print("Format: opaque Bearer token, not a three-segment JWT")
        return

    try:
        header = json.loads(decode_segment(parts[0]).decode("utf-8"))
        payload = json.loads(decode_segment(parts[1]).decode("utf-8"))
        signature = decode_segment(parts[2])
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        print("Format: three segments, but the JWT metadata could not be decoded")
        return

    if not isinstance(header, dict) or not isinstance(payload, dict):
        print("Format: JWT with unexpected non-object metadata")
        return

    print("Format: JWT / JWS")
    print("Header:")
    for name in sorted(header):
        if name in {"alg", "typ"} and isinstance(header[name], str):
            print("  {}: {}".format(name, header[name]))
        else:
            print("  {}: {} [value redacted]".format(name, describe_value(header[name])))

    print("Payload claim metadata:")
    if not payload:
        print("  (none)")
    for name in sorted(payload):
        print("  {}: {} [value redacted]".format(name, describe_value(payload[name])))
        if name in TIME_CLAIMS:
            rendered = timestamp_text(payload[name])
            if rendered:
                print("    timestamp: {} (UTC / Singapore)".format(rendered))

    present_times = sorted(TIME_CLAIMS.intersection(payload))
    absent_standard_times = [
        name for name in ("exp", "iat", "nbf") if name not in payload
    ]
    print("Time-like claims present: {}".format(", ".join(present_times) or "none"))
    print(
        "Standard time claims absent: {}".format(
            ", ".join(absent_standard_times) or "none"
        )
    )
    print("Signature: {} bytes (not printed)".format(len(signature)))

    algorithm = header.get("alg")
    if algorithm == "HS256":
        print(
            "Construction: HMAC-SHA256(server secret, "
            "base64url(header) + '.' + base64url(payload))"
        )
    else:
        print("Construction algorithm: {}".format(algorithm or "not declared"))
    print("Verification: requires Dooremi's signing key; this script does not verify it")
    print("Claim values, the raw token, and the signature were not printed.")


def main() -> int:
    try:
        inspect(load_token())
    except RuntimeError as error:
        print("Error: {}".format(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
