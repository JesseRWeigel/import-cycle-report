#!/usr/bin/env python3
"""Look for credentials and machine paths in the tracked files, and prove the scan can see.

Three things here exist because a scan that reads nothing reports exactly like a clean tree:

  A POSITIVE CONTROL. A credential shaped string is written into a real tracked file, the whole
  scan is run again, and it has to be found. If it is not, the scanner is broken and the clean
  result it just printed meant nothing. The file is restored afterwards either way.

  A FLOOR ON THE FILE COUNT. Before the first commit `git ls-files` returns nothing at all, and a
  scan over nothing passes instantly.

  ITS OWN READER. Every file is opened as bytes here rather than handed to grep. One NUL byte
  makes git and grep classify a file as binary, and `grep -I` then skips it silently, so a secret
  in that file is invisible. That has actually happened in this workspace.

The patterns are assembled from fragments at run time, so this file does not itself contain a
complete credential shaped string. That keeps the scanner from matching its own pattern list and
keeps GitHub's push protection from rejecting the repository over a fake key.

That fragment trick is what lets this file be scanned like any other. The obvious alternative, an
exclusion for the scanner's own path, buys silence on the pattern list at the cost of going blind
to a real leak in the same file, and a scanner nobody checks the corner of is a scanner with a
hole in it. So there is no self exclusion here, and the last check below proves the file was read.
"""

import getpass
import os
import re
import subprocess
import sys

CONTROL_FILE = os.path.join("fixtures", "privacy_control.txt")
MIN_TRACKED = 30

USER = os.environ.get("SUDO_USER") or getpass.getuser()

PATTERNS = [
    ("openai style key", re.compile((r"sk-" + r"[A-Za-z0-9]{20,}").encode())),
    ("github token", re.compile((r"gh" + r"[pousr]_" + r"[A-Za-z0-9]{36}").encode())),
    # AWS key ids are uppercase by definition. A case insensitive version of this matches ordinary
    # base64 and turns every embedded image into a false alarm.
    ("aws access key id", re.compile((r"AK" + r"IA" + r"[0-9A-Z]{16}").encode())),
    ("slack token", re.compile((r"xox" + r"[baprs]-" + r"[A-Za-z0-9-]{20,}").encode())),
    ("google api key", re.compile((r"AI" + r"za" + r"[0-9A-Za-z_-]{35}").encode())),
    ("private key block", re.compile((r"-----BEGIN [A-Z ]*" + r"PRIVATE KEY-----").encode())),
    ("openrouter key", re.compile((r"sk-or-" + r"v1-" + r"[a-f0-9]{40,}").encode())),
    ("this machine's home directory", re.compile(re.escape(f"/home/{USER}").encode())),
    ("a macos home directory", re.compile(re.escape(f"/Users/{USER}").encode())),
    ("a projects directory shorthand", re.compile((r"~/" + r"Projects").encode())),
]

SELF = os.path.join("scripts", "privacy_scan.py")


def tracked_files(root):
    out = subprocess.run(
        ["git", "-C", root, "ls-files", "-z"], capture_output=True, check=True
    ).stdout
    return [p.decode() for p in out.split(b"\0") if p]


def staged_files_with_nul(root, files):
    """
    Which tracked files hold a NUL byte in the object git has, rather than on disk.

    Returns None when the objects could not be read at all, so "could not check" stays distinct
    from "checked, found nothing". Collapsing those two is how an advisory tool goes quiet.
    """
    if not files:
        return []
    spec = "".join(f":{p}\n" for p in files).encode()
    proc = subprocess.run(
        ["git", "-C", root, "cat-file", "--batch"], input=spec, capture_output=True
    )
    if proc.returncode != 0:
        return None
    out = proc.stdout
    found = []
    pos = 0
    for path in files:
        nl = out.find(b"\n", pos)
        if nl < 0:
            return None
        header = out[pos:nl].split(b" ")
        if len(header) < 3:
            # "<spec> missing", for a path staged for deletion. Nothing to read, and not a NUL.
            pos = nl + 1
            continue
        size = int(header[2])
        body = out[nl + 1 : nl + 1 + size]
        if b"\0" in body:
            found.append(path)
        pos = nl + 1 + size + 1
    return found


def scan(root, files):
    hits = []
    read = 0
    opened = 0
    seen = set()
    for rel in files:
        seen.add(rel)
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            continue
        try:
            data = open(path, "rb").read()
        except OSError as exc:
            hits.append((rel, "unreadable", str(exc)))
            continue
        opened += 1
        read += len(data)
        for label, pattern in PATTERNS:
            m = pattern.search(data)
            if m:
                line = data[: m.start()].count(b"\n") + 1
                hits.append((f"{rel}:{line}", label, m.group(0).decode("utf-8", "replace")[:60]))
    return hits, opened, read, seen


def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    failures = 0

    def bad(msg):
        nonlocal failures
        failures += 1
        print(f"  FAIL  {msg}")

    files = tracked_files(root)
    if len(files) < MIN_TRACKED:
        bad(
            f"only {len(files)} tracked files. Either nothing is committed yet, in which case "
            "this scan passes without opening anything, or the repository is not what it seems."
        )

    hits, opened, read, seen = scan(root, files)
    if hits:
        for where, label, sample in hits:
            bad(f"{label} in {where}: {sample}")
    elif read == 0:
        bad(f"{opened} files were opened and zero bytes came back, so nothing was really read")
    else:
        # The byte total is deliberately not printed. This script's output gets pasted into the
        # README's Status section, the README is one of the tracked files, and a total that
        # includes it changes every time the paste changes. That is a number which can never
        # settle, and an output that cannot be reproduced cannot be diffed by anyone checking it.
        print(f"  ok    {opened} tracked files opened and read in full, nothing credential shaped")

    # No file is exempt, this one included. An exclusion for the scanner's own path would make a
    # real leak in it invisible, which is the hole the fragment assembly above exists to avoid.
    if SELF not in seen:
        bad(f"{SELF} was not among the files scanned, so the scanner exempts itself")
    else:
        print(f"  ok    {SELF} was scanned like every other file, with no self exclusion")

    # A NUL byte would make git and grep skip a file entirely. This reader does not skip, but the
    # presence of one is still worth naming, because every other tool in a pipeline will.
    with_nul = [
        f
        for f in files
        if os.path.isfile(os.path.join(root, f)) and b"\0" in open(os.path.join(root, f), "rb").read()
    ]
    if with_nul:
        bad(f"tracked files containing a NUL byte, invisible to grep based scans: {with_nul}")
    else:
        print(f"  ok    no tracked file contains a NUL byte, so a grep based scan would see them all")

    # And the same question of the committed blobs, because what ships is the commit and not the
    # working tree. This project had exactly that: a key separator written as a real NUL byte,
    # fixed on disk to the two character escape `\0` and still a NUL in the object that git had.
    committed_nul = staged_files_with_nul(root, files)
    if committed_nul is None:
        bad("could not read the committed blobs, so only the working tree was checked for NUL bytes")
    elif committed_nul:
        bad(
            "files whose COMMITTED contents contain a NUL byte, which every grep based scan will "
            f"skip even though the working copy looks fine: {committed_nul}"
        )
    else:
        print("  ok    no committed blob contains a NUL byte either, not just the working copy")

    # The generated report is the thing that gets emailed around, so it gets its own look.
    page = os.path.join(root, "docs", "index.html")
    if not os.path.isfile(page):
        bad("docs/index.html does not exist, so it could not be checked for leaked paths")
    else:
        data = open(page, "rb").read()
        leaked = [
            label for label, pattern in PATTERNS if pattern.search(data)
        ]
        if leaked:
            bad(f"the generated report contains: {', '.join(leaked)}")
        else:
            print(f"  ok    the generated report has no machine path or credential in it")
        if re.search(rb"/home/[a-z]", data) or re.search(rb"[A-Z]:\\\\Users", data):
            bad("the generated report contains an absolute home directory path")

    # ---- positive control ----------------------------------------------------------------
    control = os.path.join(root, CONTROL_FILE)
    if CONTROL_FILE not in files:
        bad(
            f"{CONTROL_FILE} is not tracked, so the positive control would not have been read "
            "by the scan above and proves nothing"
        )
    else:
        original = open(control, "rb").read()
        planted = [
            ("github token", "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
            ("aws access key id", "AK" + "IA" + "IOSFODNN7EXAMPLE"),
            ("this machine's home directory", f"/home/{USER}/somewhere/private"),
        ]
        try:
            with open(control, "wb") as fh:
                fh.write(original)
                for _, value in planted:
                    fh.write(f"planted: {value}\n".encode())
            control_hits, _, control_read, _ = scan(root, files)
            found = {label for _, label, _ in control_hits}
            missing = [label for label, _ in planted if label not in found]
            if control_read == 0:
                bad("the positive control run read zero bytes")
            elif missing:
                bad(
                    "the scan did NOT find planted "
                    + ", ".join(missing)
                    + f" in {CONTROL_FILE}, so its clean result above is meaningless"
                )
            else:
                print(
                    f"  ok    positive control: {len(planted)} planted strings all found in "
                    f"{CONTROL_FILE}, so the scan really reads tracked files"
                )
        finally:
            with open(control, "wb") as fh:
                fh.write(original)
        if open(control, "rb").read() != original:
            bad(f"{CONTROL_FILE} was not restored after the positive control")

    if failures:
        print(f"{failures} privacy check(s) failed")
        return 1
    print("privacy scan clean, and proved able to find what it looks for")
    return 0


if __name__ == "__main__":
    sys.exit(main())
