import argparse
from pathlib import Path
import subprocess
import sys

try:
    from PIL import Image
except ImportError:
    print("Requirement 'Pillow' not found. Installing automatically...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "Pillow"])
    from PIL import Image

VALID_EXTS = {".jpg", ".jpeg", ".png"}

def images_to_pdf(folder_path: Path, output_pdf: Path):
    if not folder_path.is_dir():
        print(f"Error: Directory '{folder_path}' was not found.")
        return

    image_paths = sorted([p for p in folder_path.iterdir() if p.suffix.lower() in VALID_EXTS])

    if not image_paths:
        print("No valid images found.")
        return

    images = []
    try:
        for p in image_paths:
            print(f"Processing {p.name}...")
            images.append(Image.open(p).convert("RGB"))

        output_pdf.parent.mkdir(parents=True, exist_ok=True)
        images[0].save(output_pdf, "PDF", save_all=True, append_images=images[1:])
        print(f"\nSuccessfully saved PDF to: '{output_pdf}'")

    except Exception as e:
        print(f"Error creating PDF: {e}")
    finally:
        for img in images:
            img.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Compile a folder of images into a single PDF.")
    parser.add_argument("folder", type=Path, help="Path to the image folder")
    parser.add_argument("-o", "--output", type=Path, default=Path("output.pdf"), help="Output PDF file path (default: output.pdf)")

    args = parser.parse_args()
    images_to_pdf(args.folder, args.output)