const textEncoder = new TextEncoder();

function toBytes(value) {
  return typeof value === 'string' ? textEncoder.encode(value) : value;
}

async function loadImageAsJpeg(file, quality = 0.92) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { width: canvas.width, height: canvas.height, bytes };
}

function assemblePdf(images) {
  const chunks = [];
  let offset = 0;
  const objOffsets = [];

  const push = (value) => {
    const bytes = toBytes(value);
    chunks.push(bytes);
    offset += bytes.length;
  };

  const startObj = (num) => {
    objOffsets[num] = offset;
  };

  push('%PDF-1.4\n');

  startObj(1);
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  const kids = images.map((_, i) => `${3 + 3 * i} 0 R`).join(' ');
  startObj(2);
  push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${images.length} >>\nendobj\n`);

  images.forEach((img, i) => {
    const pageNum = 3 + 3 * i;
    const contentNum = 4 + 3 * i;
    const imgNum = 5 + 3 * i;
    const contentStr = `q ${img.width} 0 0 ${img.height} 0 0 cm /Im0 Do Q`;

    startObj(pageNum);
    push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${img.width} ${img.height}] ` +
        `/Resources << /XObject << /Im0 ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`
    );

    startObj(contentNum);
    push(`${contentNum} 0 obj\n<< /Length ${contentStr.length} >>\nstream\n${contentStr}\nendstream\nendobj\n`);

    startObj(imgNum);
    push(
      `${imgNum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`
    );
    push(img.bytes);
    push('\nendstream\nendobj\n');
  });

  const xrefOffset = offset;
  const totalObjs = 2 + images.length * 3;
  let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= totalObjs; n++) {
    xref += `${String(objOffsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return new Blob(chunks, { type: 'application/pdf' });
}

async function buildPdfFromImages(files) {
  if (!files || !files.length) throw new Error('No images to build a PDF from.');
  const images = [];
  for (const file of files) {
    images.push(await loadImageAsJpeg(file));
  }
  return assemblePdf(images);
}

export { buildPdfFromImages };
