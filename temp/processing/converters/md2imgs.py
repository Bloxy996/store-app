import argparse
import base64
from pathlib import Path
import re

PATTERN = re.compile(
    r'^\[(?P<img_id>image\d+)\]:\s*<?data:image/png;base64,(?P<b64_data>[A-Za-z0-9+/=\s]+)>?$',
    re.MULTILINE,
)

def extract_images(md_path: Path, output_dir: Path):
    if not md_path.is_file():
        print(f"Error: File '{md_path}' was not found.")
        return

    output_dir.mkdir(parents=True, exist_ok=True)
    content = md_path.read_text(encoding='utf-8')
    matches = list(PATTERN.finditer(content))

    for match in matches:
        img_id = match.group('img_id')
        b64_data = re.sub(r'\s+', '', match.group('b64_data'))
        img_path = output_dir / f"{img_id}.png"

        try:
            img_path.write_bytes(base64.b64decode(b64_data))
            print(f"Saved: {img_path}")
        except Exception as e:
            print(f"Failed to save '{img_id}': {e}")

    if matches:
        print(f"\nDone! Extracted {len(matches)} image(s) to '{output_dir}'.")
    else:
        print("No matching base64 image tags found.")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Extract base64 images from a Markdown file.")
    parser.add_argument("file", type=Path, help="Path to the Markdown file")
    parser.add_argument("-o", "--output", type=Path, default=Path("images"), help="Output directory (default: images)")
    
    args = parser.parse_args()
    extract_images(args.file, args.output)