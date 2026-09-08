#!/usr/bin/env python3
"""Create an LLM-ready repository context file with gitingest."""

import argparse
from pathlib import Path

from gitingest import ingest


EXCLUDE_PATTERNS = {
    ".git/",
    ".github/",
    ".venv/",
    "__pycache__/",
    "dist/",
    "node_modules/",
    "public/",
    ".gitignore",
    "changes.patch",
    "LICENSE",
    "package-lock.json",
    "package.json",
}


def aggregate(root: Path, output: Path) -> None:
    """Run gitingest against a local repository."""
    try:
        output.relative_to(root)
    except ValueError:
        pass
    else:
        EXCLUDE_PATTERNS.add(output.relative_to(root).as_posix())

    ingest(
        str(root),
        exclude_patterns=EXCLUDE_PATTERNS,
        include_gitignored=False,
        output=str(output),
    )
    print(f"Created {output}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path.cwd(),
        help="Repository root (default: current directory)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("reader/context.txt"),
        help="Output text file (default: reader/context.txt)",
    )
    args = parser.parse_args()

    root = args.root.resolve()
    output = args.output if args.output.is_absolute() else root / args.output
    aggregate(root, output.resolve())


if __name__ == "__main__":
    main()
