import { IconDownload, IconFile } from '../../components/icons.jsx';
import { useDriveImageUrl } from '../../hooks/useDriveImageUrl.js';

function EmbeddedImagePane({ token, file }) {
  const { url, error } = useDriveImageUrl(token, file.id);
  return (
    <div className="editor-preview image-pane">
      <h1 className="preview-title">{file.name}</h1>
      {error && <p className="muted small">{error}</p>}
      {!error && !url && <p className="muted small">Loading…</p>}
      {url && <img src={url} alt={file.name} className="image-pane-img" />}
    </div>
  );
}


function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!n || Number.isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}


// Reading-view / tab-content pane for any non-note file, dispatching on
// kind. Video and audio get a real <video>/<audio> player; anything else
// (pdf, zip, docx, ...) gets a download prompt — Drive bytes are only ever
// pulled on demand here, same rule as images.
function AssetPane({ token, file }) {
  if (file.kind === 'image') return <EmbeddedImagePane token={token} file={file} />;
  const { url, error } = useDriveImageUrl(token, file.id);
  return (
    <div className="editor-preview image-pane">
      <h1 className="preview-title">{file.name}</h1>
      {error && <p className="muted small">{error}</p>}
      {!error && !url && <p className="muted small">Loading…</p>}
      {url && file.kind === 'video' && (
        <video src={url} controls className="asset-pane-video" />
      )}
      {url && file.kind === 'audio' && (
        <audio src={url} controls className="asset-pane-audio" />
      )}
      {url && file.kind === 'file' && (
        <div className="asset-pane-file">
          <IconFile size={40} />
          <p className="muted small">{formatFileSize(file.size)}</p>
          <a className="asset-download-btn" href={url} download={file.name}>
            <IconDownload size={14} /> Download
          </a>
        </div>
      )}
    </div>
  );
}


// Inline `![[video.mp4]]` embed within note content — fetches the blob only
// once the note containing it is actually being read (same on-demand rule
// as ImageEmbed below).
function VideoEmbed({ token, fileId, name }) {
  const { url, error } = useDriveImageUrl(token, fileId);
  if (error) return <span className="wikilink wikilink-missing-image">{name}</span>;
  if (!url) return <span className="muted small embed-loading">Loading {name}…</span>;
  return <video src={url} controls className="video-embed" />;
}


// Inline `![[audio.mp3]]` embed.
function AudioEmbed({ token, fileId, name }) {
  const { url, error } = useDriveImageUrl(token, fileId);
  if (error) return <span className="wikilink wikilink-missing-image">{name}</span>;
  if (!url) return <span className="muted small embed-loading">Loading {name}…</span>;
  return (
    <span className="audio-embed-wrap">
      <audio src={url} controls className="audio-embed" />
      <span className="audio-embed-name">{name}</span>
    </span>
  );
}


// Inline chip for any other linked file (pdf, zip, docx, ...) — click opens
// it in a new tab / downloads it, same as the sidebar's file rows.
function FileChip({ name, label, onOpen }) {
  return (
    <span className="file-chip" onClick={onOpen} title={`Open ${name}`}>
      <IconFile size={13} />
      {label || name}
    </span>
  );
}

export { EmbeddedImagePane, formatFileSize, AssetPane, VideoEmbed, AudioEmbed, FileChip };
