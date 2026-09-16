// ---------------------------------------------------------------------------
// Ported from temp/processing/converters/imgs2pdf.py: bundles a folder of
// .jpg/.jpeg/.png images into a single PDF, one image per page, sized to
// that image's own pixel dimensions, in filename order. The original used
// Python + Pillow; here it's plain jsPDF in the browser — no backend
// involved, since decoding images and writing PDF bytes is something the
// browser already does natively, nothing about it benefits from running
// server-side.
//
// Takes plain File objects rather than local-disk directory handles (see
// lib/localFs.js) — a normal multi-file <input type="file"> picker covers
// "pick some images" more portably than the Chromium-only File System
// Access API, and this conversion never needs to write anything back to
// disk the way the Compile/Apply local-folder flow does.
// ---------------------------------------------------------------------------

import { jsPDF } from 'jspdf';

const VALID_EXTS = new Set(['.jpg', '.jpeg', '.png']);

function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve({ dataUrl: reader.result, width: img.width, height: img.height, isPng: file.type === 'image/png' });
      img.onerror = () => reject(new Error(`Could not read image: ${file.name}`));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error(`Could not read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// files: File[] (from an <input type="file" multiple accept="image/*">).
// Returns a PDF Blob, or throws if none of the files are a supported
// image type — same VALID_EXTS check imgs2pdf.py made.
async function buildPdfFromImages(files) {
  const images = Array.from(files)
    .filter((f) => VALID_EXTS.has(extOf(f.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!images.length) throw new Error('No .jpg/.jpeg/.png files found.');

  const loaded = await Promise.all(images.map(loadImage));
  const doc = new jsPDF({ unit: 'px', format: [loaded[0].width, loaded[0].height] });
  loaded.forEach((img, i) => {
    if (i > 0) doc.addPage([img.width, img.height]);
    doc.addImage(img.dataUrl, img.isPng ? 'PNG' : 'JPEG', 0, 0, img.width, img.height);
  });
  return doc.output('blob');
}

export { buildPdfFromImages };
