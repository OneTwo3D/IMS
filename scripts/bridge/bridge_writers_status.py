#!/usr/bin/env python3
"""Read-only status of the three systemd units that make the legacy WooCommerce <-> Mintsoft bridge a WRITER.

THIS FILE LIVES IN THE IMS REPOSITORY. It is meant to be COPIED to the bridge host (into the woocommerce-mintsoft-sync checkout,
as scripts/bridge_writers_status.py) by ops and run there; the bridge repository is not changed by IMS. It imports nothing from the bridge.

It changes nothing: it runs `systemctl show` (and `journalctl -n 1`) and prints a small report. An administrator pastes the output into
`npm run writers:attest -- --kind bridge-units-masked --output-file -` or the Sync > Writer confirmations screen; IMS parses it strictly and
`writers:check` (phase P2-M and later) requires all three units masked (LoadState=masked) and inactive (ActiveState=inactive), and the last
trigger BEFORE the Mintsoft step's live-from instant. Run it AFTER the units are masked, and run it again whenever in doubt: IMS only ever sees the
newest report, which is a snapshot, not a watch.

Usage:  bridge_writers_status.py [--systemctl PATH] [--journalctl PATH]
Exit:   0 the report was printed (whatever the units' state: judging it is IMS's job); 2 a unit could not be read (nothing is printed on stdout).

Output format (version 1, kept in step with lib/domain/writer-attestation/bridge-status.ts in IMS):

  # bridge_writers_status v1
  host: <name>
  generated_at: 2026-12-31T10:00:00Z
  unit: wc-mintsoft-order-sweep.timer LoadState=masked ActiveState=inactive UnitFileState=masked
  unit: wc-mintsoft-order-sweep.service LoadState=masked ActiveState=inactive UnitFileState=masked
  unit: wc-mintsoft-webhook.service LoadState=masked ActiveState=inactive UnitFileState=masked
  last_trigger: 2026-12-30T23:55:01Z        (or: never)

`last_trigger` is the LATEST of: the sweep timer's LastTriggerUSec, the sweep service's ExecMainStartTimestamp / InactiveExitTimestamp, and the time of the
sweep service's newest journal entry, so a sweep started by hand (without the timer) counts too.
"""
import argparse
import datetime
import json
import re
import socket
import subprocess
import sys

HEADER = "# bridge_writers_status v1"
UNITS = (
    "wc-mintsoft-order-sweep.timer",
    "wc-mintsoft-order-sweep.service",
    "wc-mintsoft-webhook.service",
)
STATE_PROPS = ("LoadState", "ActiveState", "UnitFileState")
# Properties that carry a time. `systemctl show` prints them as microseconds since the epoch (the *USec ones) or as a human date; both are handled.
TIME_PROPS = {
    "wc-mintsoft-order-sweep.timer": ("LastTriggerUSec", "LastTriggerUSecMonotonic"),
    "wc-mintsoft-order-sweep.service": ("ExecMainStartTimestamp", "InactiveExitTimestamp"),
    "wc-mintsoft-webhook.service": (),
}
SAFE = re.compile(r"^[A-Za-z0-9_.:-]{1,40}$")


class StatusError(Exception):
    pass


def run(argv):
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise StatusError("could not run %s: %s" % (argv[0], error))
    return done


def show(systemctl, unit, props):
    # `--` stops option parsing; `-p` per property keeps the output to the facts we print.
    base = [systemctl, "show", "--no-pager"]
    tail = []
    for prop in props:
        tail += ["-p", prop]
    tail += ["--", unit]
    # `--timestamp=utc` (systemd 247+) prints every time in UTC, so a host on local time with a zone name (BST, CET) is read correctly. An older systemd
    # refuses the option: it is run again without it, and a time that then carries a zone this script cannot read stops the run (exit 2), never a guess.
    done = run(base + ["--timestamp=utc"] + tail)
    if done.returncode != 0:
        done = run(base + tail)
    if done.returncode != 0:
        raise StatusError("systemctl show %s failed (exit %d)" % (unit, done.returncode))
    values = {}
    for line in done.stdout.splitlines():
        key, sep, value = line.partition("=")
        if sep:
            values[key] = value.strip()
    return values


def parse_time(text):
    """A systemctl time property -> aware UTC datetime, or None for unset ('', 'n/a', '0')."""
    text = (text or "").strip()
    if text in ("", "n/a", "0"):
        return None
    if text.isdigit():
        micro = int(text)
        if micro == 0:
            return None
        return datetime.datetime.fromtimestamp(micro / 1_000_000, tz=datetime.timezone.utc)
    # Human form, e.g. "Wed 2026-12-30 23:55:01 UTC" (the zone is the one the host prints; only UTC and numeric offsets are accepted).
    match = re.search(r"(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(UTC|GMT|[+-]\d{2}:?\d{2})?", text)
    if not match:
        raise StatusError("unreadable time %r" % text)
    zone = match.group(3)
    base = datetime.datetime.strptime("%s %s" % (match.group(1), match.group(2)), "%Y-%m-%d %H:%M:%S")
    if zone in (None, "UTC", "GMT"):
        if zone is None:
            raise StatusError("time %r carries no zone" % text)
        return base.replace(tzinfo=datetime.timezone.utc)
    sign = 1 if zone[0] == "+" else -1
    digits = zone[1:].replace(":", "")
    offset = datetime.timedelta(hours=int(digits[:2]), minutes=int(digits[2:]))
    return (base - sign * offset).replace(tzinfo=datetime.timezone.utc)


def journal_last(journalctl, unit):
    """The newest journal entry of `unit`, or None. A host with no journal access reads as 'no entry': the unit properties still count."""
    done = run([journalctl, "--no-pager", "-n", "1", "-o", "json", "-u", unit])
    if done.returncode != 0:
        return None
    for line in reversed(done.stdout.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            stamp = json.loads(line).get("__REALTIME_TIMESTAMP")
        except ValueError:
            return None
        return parse_time(str(stamp)) if stamp else None
    return None


def build(systemctl, journalctl, now):
    lines = [HEADER, "host: %s" % re.sub(r"[^A-Za-z0-9_.-]", "-", socket.gethostname())[:255],
             "generated_at: %s" % now.strftime("%Y-%m-%dT%H:%M:%SZ")]
    latest = None
    for unit in UNITS:
        props = show(systemctl, unit, STATE_PROPS + TIME_PROPS[unit])
        states = []
        for prop in STATE_PROPS:
            value = props.get(prop, "")
            # An empty UnitFileState (a transient or not-found unit) is reported as 'none', never left blank: IMS refuses a blank.
            value = value if value != "" else "none"
            if not SAFE.match(value):
                raise StatusError("unexpected value for %s of %s" % (prop, unit))
            states.append("%s=%s" % (prop, value))
        lines.append("unit: %s %s" % (unit, " ".join(states)))
        for prop in TIME_PROPS[unit]:
            if prop.endswith("Monotonic"):
                continue
            moment = parse_time(props.get(prop, ""))
            if moment is not None and (latest is None or moment > latest):
                latest = moment
    entry = journal_last(journalctl, "wc-mintsoft-order-sweep.service")
    if entry is not None and (latest is None or entry > latest):
        latest = entry
    lines.append("last_trigger: %s" % (latest.strftime("%Y-%m-%dT%H:%M:%SZ") if latest else "never"))
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--systemctl", default="systemctl")
    parser.add_argument("--journalctl", default="journalctl")
    args = parser.parse_args(argv)
    try:
        report = build(args.systemctl, args.journalctl, datetime.datetime.now(datetime.timezone.utc))
    except StatusError as error:
        sys.stderr.write("bridge_writers_status: %s\n" % error)
        return 2
    sys.stdout.write(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
