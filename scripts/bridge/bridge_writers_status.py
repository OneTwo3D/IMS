#!/usr/bin/env python3
"""Read-only status of the three systemd units that make the legacy WooCommerce <-> Mintsoft bridge a WRITER.

THIS FILE LIVES IN THE IMS REPOSITORY. It is meant to be COPIED to the bridge host (into the woocommerce-mintsoft-sync checkout,
as scripts/bridge_writers_status.py) by ops and run there; the bridge repository is not changed by IMS. It imports nothing from the bridge.

It changes nothing: it runs `systemctl show` (and `journalctl -n 1`) and prints a small report. An administrator pastes the output into
`npm run writers:attest -- --kind bridge-units-masked --output-file -` or the Sync > Writer confirmations screen; IMS parses it strictly and
`writers:check` (phase P2-M and later) requires all three units masked (LoadState=masked AND UnitFileState=masked: a runtime mask is lost at reboot) and
inactive (ActiveState=inactive), and the last trigger BEFORE the Mintsoft step's live-from instant. Run it AFTER the units are masked, and run it again whenever in doubt: IMS only ever sees the
newest report, which is a snapshot, not a watch.

Usage:  bridge_writers_status.py [--systemctl PATH] [--journalctl PATH]
Exit:   0 the report was printed (whatever the units' state: judging it is IMS's job); 2 a unit could not be read (nothing is printed on stdout).

LIMIT: the output is plain text that an administrator pastes into IMS. It is the owner's word plus a transcript, not evidence signed by this host.

Output format (version 1, kept in step with lib/domain/writer-attestation/bridge-status.ts in IMS):

  # bridge_writers_status v1
  host: <name>
  generated_at: 2026-12-31T10:00:00Z
  unit: wc-mintsoft-order-sweep.timer LoadState=masked ActiveState=inactive UnitFileState=masked
  unit: wc-mintsoft-order-sweep.service LoadState=masked ActiveState=inactive UnitFileState=masked
  unit: wc-mintsoft-webhook.service LoadState=masked ActiveState=inactive UnitFileState=masked
  journal_exit: 0
  journal_readable: 1                       (this user can read the SYSTEM journal: root, or in systemd-journal / adm, and `journalctl --header` works)
  journal_persistent: 1                     (/var/log/journal exists and Storage is not volatile)
  journal_earliest: 2026-10-01T00:00:00Z    (the earliest journal entry seen, or: none)
  boot_id: <id>                             (the current boot, or: unknown)
  boot_started: 2026-12-01T00:00:00Z        (when this boot's journal begins, or: unknown)
  last_trigger: 2026-12-30T23:55:01Z        (or: never, or: unknown)

`last_trigger` is the LATEST of: the sweep timer's LastTriggerUSec, the ExecMainStartTimestamp / InactiveExitTimestamp / InactiveEnterTimestamp of the sweep
service AND of the webhook service, and the time of the newest journal entry of each of the three units, so a sweep started by hand (without the timer)
and a webhook delivered after the live-from instant both count.

`journal_exit` is the worst exit status of the journalctl reads (0 = all three succeeded). systemd keeps unit timestamps in memory only, so they are LOST by
a reboot or a daemon-reload that garbage-collects an inactive masked unit. `never` is therefore printed only when every journal read succeeded and found
nothing, the user can READ the system journal and the journal is PERSISTENT (otherwise exit status 0 with no entries proves nothing: a non-privileged user sees
no system-unit messages, and a volatile journal is wiped by the same reboot). Otherwise the script prints `unknown`. IMS reads `unknown`, and a `never` without
journal_exit 0, readable, persistent and an earliest entry BEFORE the live-from instant S, as unreadable, never as clean. Run it as root (or a member of
systemd-journal / adm).
"""
import argparse
import datetime
import glob
import grp
import json
import os
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
    "wc-mintsoft-order-sweep.service": ("ExecMainStartTimestamp", "InactiveExitTimestamp", "InactiveEnterTimestamp"),
    # The webhook service had NO time property before: a webhook processed after the live-from instant (then stopped and masked) was invisible.
    "wc-mintsoft-webhook.service": ("ExecMainStartTimestamp", "InactiveExitTimestamp", "InactiveEnterTimestamp"),
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
    """(newest journal entry of `unit` or None, journalctl exit status). A non-zero status means the journal could not be read, which is NOT the same as 'no entry'."""
    done = run([journalctl, "--no-pager", "-n", "1", "-o", "json", "-u", unit])
    if done.returncode != 0:
        return None, done.returncode
    for line in reversed(done.stdout.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            stamp = json.loads(line).get("__REALTIME_TIMESTAMP")
        except ValueError:
            return None, 1
        return (parse_time(str(stamp)) if stamp else None), 0
    return None, 0


def fmt(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def journal_access(journalctl, assume_groups=None):
    """1 when the user running this script can read the SYSTEM journal, else 0.

    A non-root user outside the systemd-journal / adm groups gets exit status 0 and no entries for `-u <system unit>` (only a hint that it cannot see other
    users' and the system's messages), which looks exactly like "nothing ever ran". So access is established first: root, or membership of systemd-journal
    or adm, AND `journalctl --header` (it reads the journal files' headers) succeeding."""
    if assume_groups is not None:
        names = set(g for g in assume_groups.split(",") if g)
        privileged = os.geteuid() == 0 or bool(names & {"systemd-journal", "adm"})
    else:
        privileged = os.geteuid() == 0
        if not privileged:
            try:
                gids = set(os.getgroups()) | {os.getegid()}
                for name in ("systemd-journal", "adm"):
                    try:
                        if grp.getgrnam(name).gr_gid in gids:
                            privileged = True
                    except KeyError:
                        pass
            except OSError:
                privileged = False
    if not privileged:
        return 0
    done = run([journalctl, "--no-pager", "--header"])
    return 1 if done.returncode == 0 else 0


def journal_persistent(journal_dir, conf_paths):
    """1 when the journal survives a reboot: the journal directory exists and no journald.conf / drop-in sets Storage=volatile or none (the last setting wins)."""
    if not os.path.isdir(journal_dir):
        return 0
    storage = None
    files = []
    for path in conf_paths:
        if os.path.isdir(path):
            files += sorted(glob.glob(os.path.join(path, "*.conf")))
        else:
            files.append(path)
    for path in files:
        try:
            with open(path, "r") as handle:
                for line in handle:
                    match = re.match(r"^\s*Storage\s*=\s*(\S+)", line)
                    if match:
                        storage = match.group(1).lower()
        except OSError:
            pass
    return 0 if storage in ("volatile", "none") else 1


def journal_boots(journalctl):
    """(earliest journal entry or None, current boot id or None, start of the current boot's journal or None), from `journalctl --list-boots -o json`."""
    done = run([journalctl, "--no-pager", "--list-boots", "-o", "json"])
    if done.returncode != 0:
        return None, None, None
    try:
        boots = json.loads(done.stdout)
    except ValueError:
        return None, None, None
    if not isinstance(boots, list) or not boots:
        return None, None, None
    earliest = None
    for boot in boots:
        first = boot.get("first_entry")
        if isinstance(first, int) and first > 0:
            moment = datetime.datetime.fromtimestamp(first / 1_000_000, tz=datetime.timezone.utc)
            if earliest is None or moment < earliest:
                earliest = moment
    current = max(boots, key=lambda boot: boot.get("index", 0) if isinstance(boot.get("index"), int) else -10**9)
    boot_id = current.get("boot_id")
    boot_id = boot_id if isinstance(boot_id, str) and re.match(r"^[0-9a-f-]{8,64}$", boot_id) else None
    started = current.get("first_entry")
    started = datetime.datetime.fromtimestamp(started / 1_000_000, tz=datetime.timezone.utc) if isinstance(started, int) and started > 0 else None
    return earliest, boot_id, started


def build(systemctl, journalctl, now, options=None):
    options = options or {}
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
    journal_exit = 0
    for unit in UNITS:
        entry, status = journal_last(journalctl, unit)
        journal_exit = max(journal_exit, status)
        if entry is not None and (latest is None or entry > latest):
            latest = entry
    readable = journal_access(journalctl, options.get("assume_groups"))
    persistent = journal_persistent(options.get("journal_dir", "/var/log/journal"), options.get("journald_conf", ["/etc/systemd/journald.conf", "/etc/systemd/journald.conf.d"]))
    earliest, boot_id, boot_started = journal_boots(journalctl) if readable else (None, None, None)
    lines.append("journal_exit: %d" % journal_exit)
    lines.append("journal_readable: %d" % readable)
    lines.append("journal_persistent: %d" % persistent)
    lines.append("journal_earliest: %s" % (fmt(earliest) if earliest is not None else "none"))
    lines.append("boot_id: %s" % (boot_id or "unknown"))
    lines.append("boot_started: %s" % (fmt(boot_started) if boot_started is not None else "unknown"))
    if latest is not None:
        last = fmt(latest)
    elif journal_exit == 0 and readable == 1 and persistent == 1 and earliest is not None:
        # Every journal read succeeded, as a user who can see the system journal, on a persistent journal with entries: `never` here is a claim IMS can
        # weigh (it still requires the earliest entry to predate the live-from instant S).
        last = "never"
    else:
        # No time anywhere (lost with a reboot or a garbage-collected unit) and the journal could not be read: nothing can be said.
        last = "unknown"
    lines.append("last_trigger: %s" % last)
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--systemctl", default="systemctl")
    parser.add_argument("--journalctl", default="journalctl")
    # Test seams (the defaults are the real host):
    parser.add_argument("--journal-dir", default="/var/log/journal", help=argparse.SUPPRESS)
    parser.add_argument("--journald-conf", action="append", help=argparse.SUPPRESS)
    parser.add_argument("--assume-groups", default=None, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    options = {"journal_dir": args.journal_dir, "assume_groups": args.assume_groups}
    if args.journald_conf:
        options["journald_conf"] = args.journald_conf
    try:
        report = build(args.systemctl, args.journalctl, datetime.datetime.now(datetime.timezone.utc), options)
    except StatusError as error:
        sys.stderr.write("bridge_writers_status: %s\n" % error)
        return 2
    sys.stdout.write(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
