#!/usr/bin/env python3
"""
aggregate.py — collect a list of repo files into one pasteable block.

Usage:
    python reader/aggregate.py path/one.js path/two.py
    python reader/aggregate.py --list paths.txt
    python reader/aggregate.py --list paths.txt --output aggregated.txt

Run this from the repo root (or pass --root to point elsewhere). Paths are
resolved relative to --root. Missing files are reported but don't stop the
run. Output goes to stdout by default so you can pipe/copy it straight into
a chat prompt; use --output to write it to a file instead.
"""

import argparse
import sys
from pathlib import Path

EXT_LANG = {
    ".js": "javascript", ".jsx": "jsx", ".ts": "typescript", ".tsx": "tsx",
    ".py": "python", ".json": "json", ".css": "css", ".md": "markdown",
    ".html": "html", ".yml": "yaml", ".yaml": "yaml", ".sh": "bash",
}


def lang_for(path: Path) -> str:
    return EXT_LANG.get(path.suffix.lower(), "")


def load_paths(args) -> list[str]:
    paths = list(args.paths)
    if args.list:
        list_file = Path(args.list)
        if not list_file.exists():
            sys.exit(f"--list file not found: {list_file}")
        paths += [
            line.strip() for line in list_file.read_text().splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
    if not paths:
        sys.exit("No file paths given (pass them as args or via --list).")
    return paths


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="*", help="File paths to aggregate")
    parser.add_argument("--list", help="Text file with one path per line")
    parser.add_argument("--root", default=".", help="Repo root paths are relative to (default: cwd)")
    parser.add_argument("--output", help="Write result to this file instead of stdout")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    paths = load_paths(args)

    blocks = []
    missing = []
    for rel in paths:
        full = (root / rel).resolve()
        if not full.is_file():
            missing.append(rel)
            continue
        content = full.read_text(encoding="utf-8", errors="replace")
        blocks.append(f"### `{rel}`\n\n```{lang_for(full)}\n{content}\n```\n")

    result = "\n".join(blocks)

    if missing:
        print(f"WARNING: {len(missing)} path(s) not found, skipped:", file=sys.stderr)
        for m in missing:
            print(f"  - {m}", file=sys.stderr)

    if args.output:
        Path(args.output).write_text(result, encoding="utf-8")
        print(f"Wrote {len(blocks)} file(s) to {args.output}", file=sys.stderr)
    else:
        print(result)


if __name__ == "__main__":
    main()