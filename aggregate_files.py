#!/usr/bin/env python3
"""Aggregate repository text files into one document for an LLM context."""

from pathlib import Path
import argparse


EXCLUDED_DIRS = {
    ".git",
    ".github",
    ".venv",
    "__pycache__",
    "dist",
    "node_modules",
    "public",
}
EXCLUDED_FILES = {".gitignore", "changes.patch", "LICENSE", "package-lock.json", "package.json"}


def aggregate(root: Path, output: Path) -> None:
    files = []

    for path in root.rglob("*"):
        if not path.is_file() or path == output:
            continue

        relative = path.relative_to(root)
        if any(part in EXCLUDED_DIRS for part in relative.parts):
            continue
        if path.name in EXCLUDED_FILES:
            continue

        files.append(path)

    files.sort(key=lambda path: path.relative_to(root).as_posix())

    with output.open("w", encoding="utf-8") as aggregate_file:
        for path in files:
            relative = path.relative_to(root).as_posix()
            aggregate_file.write(f"\n\n===== BEGIN FILE: {relative} =====\n\n")
            try:
                content = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                content = path.read_text(encoding="utf-8", errors="replace")
            aggregate_file.write(content)
            if not content.endswith("\n"):
                aggregate_file.write("\n")
            aggregate_file.write(f"\n===== END FILE: {relative} =====\n")

    print(f"Aggregated {len(files)} files into {output}")


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
        default=Path("repository_context.txt"),
        help="Output text file (default: repository_context.txt)",
    )
    args = parser.parse_args()

    root = args.root.resolve()
    output = args.output if args.output.is_absolute() else root / args.output
    aggregate(root, output.resolve())


if __name__ == "__main__":
    main()
