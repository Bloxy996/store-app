// ---------------------------------------------------------------------------
// Ported from temp/processing/converters/md2imgs.py: finds link-reference-
// style embedded base64 images in a note's raw content — some markdown
// paste/export tools write `[image1]: <data:image/png;base64,...>` link
// definitions instead of a real image file — and decodes them back into
// real image bytes so they can be uploaded as normal Drive image files
// (see features/tools/ToolsPanel.jsx). Pure decoding only; doesn't touch
// the note content itself.
// ---------------------------------------------------------------------------

const EMBED_RE = /^\[(image\d+)\]:\s*<?data:(image\/(?:png|jpe?g));base64,([A-Za-z0-9+/=\s]+)>?$/gim;

// Returns [{ id, mimeType, ext, bytes }] — bytes is a Uint8Array ready for
// driveUploadBinary. Malformed base64 in one match is skipped rather than
// failing the whole extraction.
function extractEmbeddedImages(content) {
  const out = [];
  for (const m of (content || '').matchAll(EMBED_RE)) {
    const [, id, mimeType, b64] = m;
    try {
      const binary = atob(b64.replace(/\s+/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      out.push({ id, mimeType, ext: mimeType === 'image/png' ? 'png' : 'jpg', bytes });
    } catch {
      // Skip — not valid base64.
    }
  }
  return out;
}

export { extractEmbeddedImages };
