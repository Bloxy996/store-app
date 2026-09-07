import argparse
import os
import pathlib
import shutil

DIVIDER = "=" * 20

def _get_deepest_match(rel_path: pathlib.Path, patterns: list[str]) -> int:
    parts = rel_path.parts
    max_idx = -1
    for p in patterns:
        p_parts = pathlib.Path(p.replace('\\', '/')).parts
        if not p_parts:
            continue
        for i in range(len(parts) - len(p_parts) + 1):
            if parts[i:i + len(p_parts)] == p_parts:
                max_idx = max(max_idx, i + len(p_parts) - 1)
    return max_idx

def _yield_valid_files(root_dir: pathlib.Path, exts: set[str], inc: list[str], exc: list[str]):
    if not root_dir.is_dir():
        print(f"Error: Path '{root_dir}' is not a valid directory.")
        return

    for root, dirs, files in os.walk(root_dir):
        rel_root = pathlib.Path(root).relative_to(root_dir)
        if not inc:
            dirs[:] = [d for d in dirs if _get_deepest_match(rel_root / d, exc) == -1]

        for file in files:
            file_path = pathlib.Path(root) / file
            rel_path = file_path.relative_to(root_dir)

            if exts and file_path.suffix.lower() not in exts:
                continue

            d_inc, d_exc = _get_deepest_match(rel_path, inc), _get_deepest_match(rel_path, exc)
            if inc:
                if d_inc == -1 or d_exc >= d_inc:
                    continue
            elif d_exc != -1:
                continue

            yield file_path, rel_path

def process_files(root: pathlib.Path, output: pathlib.Path, exts: set[str], inc: list[str], exc: list[str], aggregate: bool):
    if aggregate:
        target = output.with_suffix('.txt') if output.suffix.lower() != '.txt' else output
        print(f"Aggregating content to: {target}")
        with open(target, 'w', encoding='utf-8') as outfile:
            for f_path, rel_path in _yield_valid_files(root, exts, inc, exc):
                try:
                    content = f_path.read_text(encoding='utf-8')
                except Exception as e:
                    content = f"[Error reading file: {e}]"
                outfile.write(f"{DIVIDER}\nFILE: {rel_path}\n{DIVIDER}\n\n{content}\n\n")
                print(f"Aggregated: {rel_path}")
    else:
        if output.exists():
            shutil.rmtree(output)
        output.mkdir(parents=True, exist_ok=True)

        for f_path, rel_path in _yield_valid_files(root, exts, inc, exc):
            dest = output / f_path.name
            counter = 1
            while dest.exists():
                dest = output / f"{f_path.stem}_{counter}{f_path.suffix}"
                counter += 1
            try:
                shutil.copy2(f_path, dest)
                print(f"Copied: {rel_path}")
            except Exception as e:
                print(f"Error copying {rel_path}: {e}")

def reverse_aggregated(root: pathlib.Path, source: pathlib.Path, overwrite: bool):
    source = source.with_suffix('.txt') if source.suffix.lower() != '.txt' else source
    if not source.is_file():
        print(f"Error: File '{source}' does not exist.")
        return

    content = source.read_text(encoding='utf-8')
    sections = content.split(f"{DIVIDER}\nFILE: ")
    restored = 0

    for sec in sections:
        if not sec.strip() or f"\n{DIVIDER}\n\n" not in sec:
            continue
        rel_path_str, file_content = sec.split(f"\n{DIVIDER}\n\n", 1)
        if file_content.endswith("\n\n"):
            file_content = file_content[:-2]

        target = root / rel_path_str.strip()
        if file_content.startswith("[Error reading file:") or (target.exists() and not overwrite):
            continue

        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            target.write_text(file_content, encoding='utf-8')
            print(f"Restored: {target.relative_to(root)}")
            restored += 1
        except Exception as e:
            print(f"Error restoring {rel_path_str}: {e}")

    print(f"\nSuccessfully restored {restored} file(s) to '{root}'.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Process or unpack directory files.")
    parser.add_argument("root", type=pathlib.Path, help="Root target directory")
    parser.add_argument("-o", "--output", type=pathlib.Path, default=pathlib.Path("context"), help="Output file/dir name (default: context)")
    parser.add_argument("-e", "--exts", nargs="*", default=[], help="File extensions to include (e.g. .py .txt)")
    parser.add_argument("-i", "--include", nargs="*", default=[], help="Sub-paths/patterns to force include")
    parser.add_argument("-x", "--exclude", nargs="*", default=[], help="Sub-paths/patterns to exclude")
    parser.add_argument("-a", "--aggregate", action="store_true", help="Merge files into a single text document")
    parser.add_argument("-r", "--reverse", action="store_true", help="Unpack an aggregated text file back into directory structure")
    parser.add_argument("--no-overwrite", action="store_true", help="Prevent overwriting files during reverse operation")

    args = parser.parse_args()
    valid_exts = {e.lower() if e.startswith('.') else f".{e.lower()}" for e in args.exts}

    if args.reverse:
        reverse_aggregated(args.root, args.output, overwrite=not args.no_overwrite)
    else:
        process_files(args.root, args.output, valid_exts, args.include, args.exclude, args.aggregate)