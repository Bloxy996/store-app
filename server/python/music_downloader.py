# ---------------------------------------------------------------------------
# Ported from temp/processing/music/app.py. Same download/tag/embed pipeline
# (yt-dlp -> best audio -> mp3, ffmpeg embeds the video thumbnail as album
# art plus the channel's own icon as a second "artist" image, playlist
# links are expanded to their member videos first). What changed moving
# from a standalone CLI into a function a request handler calls:
#   - No links.txt/downloaded.txt on disk for dedup-across-runs — links
#     come in as a list per request and this process holds no state between
#     requests (matches the rest of this backend: no database, nothing
#     persisted but the session cookie). Skipping already-downloaded
#     tracks across separate requests is not something this does; within
#     one request, duplicate links in the input are still deduped.
#   - No console progress bar — returns a list of per-link results instead.
# ---------------------------------------------------------------------------

import concurrent.futures
import re
import subprocess
import threading
import urllib.request
from pathlib import Path

from yt_dlp import YoutubeDL

TOPIC_RE = re.compile(r'\s*-\s*Topic$', re.IGNORECASE)
WS_RE = re.compile(r'\s+')

_ICON_CACHE = {}
_ICON_LOCK = threading.Lock()


def _cookie_opts(cookies_path):
    return {'cookiefile': str(cookies_path)} if cookies_path and Path(cookies_path).exists() else {}


def _find_ffmpeg():
    script_dir = Path(__file__).resolve().parent
    for name in ('ffmpeg.exe', 'ffmpeg'):
        if (script_dir / name).exists():
            return str(script_dir / name)
    return 'ffmpeg'


def _expand_link(link, cookie_opts):
    opts = {'quiet': True, 'no_warnings': True, 'extract_flat': True, 'skip_download': True, **cookie_opts}
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(link, download=False)
    except Exception:
        return [(link, None)]
    if info and info.get('_type') == 'playlist':
        pairs = []
        for entry in info.get('entries') or []:
            if not entry:
                continue
            vid = entry.get('id')
            url = entry.get('webpage_url') or entry.get('url') or vid
            if url:
                if not url.startswith('http'):
                    url = f'https://www.youtube.com/watch?v={url}'
                pairs.append((url, vid))
        return pairs
    return [(link, info.get('id') if info else None)]


def _fetch_artist_icon(channel_url, channel_id, cache_dir, cookie_opts):
    if not channel_url:
        return None
    key = channel_id or channel_url
    with _ICON_LOCK:
        if key in _ICON_CACHE:
            return _ICON_CACHE[key]
    icon_path = cache_dir / f".artist_icon_{re.sub(r'[^A-Za-z0-9_-]', '_', key)}.jpg"
    try:
        opts = {'quiet': True, 'no_warnings': True, 'extract_flat': True, 'skip_download': True, **cookie_opts}
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(channel_url.rstrip('/') + '/about', download=False)
        thumbs = info.get('thumbnails') or []
        best = max(thumbs, key=lambda t: (t.get('width') or 0) * (t.get('height') or 0)) if thumbs else None
        url = best.get('url') if best else None
        if not url:
            with _ICON_LOCK:
                _ICON_CACHE[key] = None
            return None
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            icon_path.write_bytes(resp.read())
    except Exception:
        with _ICON_LOCK:
            _ICON_CACHE[key] = None
        return None
    with _ICON_LOCK:
        _ICON_CACHE[key] = icon_path
    return icon_path


def _finalize_file(audio_path, thumb_path, icon_path, artist, ffmpeg_bin):
    has_thumb = thumb_path and thumb_path.exists()
    has_icon = icon_path and icon_path.exists()
    if not audio_path.exists() or (not has_thumb and not has_icon and not artist):
        return
    tmp_out = audio_path.with_suffix('.tmp.mp3')
    cmd = [ffmpeg_bin, '-y', '-i', str(audio_path)]
    maps, meta, idx, stream = ['-map', '0:a'], [], 1, 0
    if has_thumb:
        cmd += ['-i', str(thumb_path)]
        maps += ['-map', str(idx)]
        meta += [f'-metadata:s:v:{stream}', 'title=Album cover', f'-metadata:s:v:{stream}', 'comment=Cover (front)']
        idx += 1
        stream += 1
    if has_icon:
        cmd += ['-i', str(icon_path)]
        maps += ['-map', str(idx)]
        meta += [f'-metadata:s:v:{stream}', 'title=Artist icon', f'-metadata:s:v:{stream}', 'comment=Artist/performer']
    cmd += maps + ['-c', 'copy']
    if has_thumb or has_icon:
        cmd += ['-id3v2_version', '3'] + meta
    if artist:
        cmd += ['-metadata', f'artist={artist}']
    cmd.append(str(tmp_out))
    try:
        res = subprocess.run(cmd, capture_output=True, encoding='utf-8', errors='replace')
        if res.returncode == 0:
            tmp_out.replace(audio_path)
        else:
            tmp_out.unlink(missing_ok=True)
    except Exception:
        tmp_out.unlink(missing_ok=True)
    if has_thumb:
        thumb_path.unlink(missing_ok=True)


def _download_one(url, out_dir, ffmpeg_bin, cookie_opts, embed_icon):
    res_meta = {}

    def hook(d):
        if d.get('status') == 'finished':
            info = d.get('info_dict') or {}
            res_meta['artist'] = info.get('channel') or info.get('uploader')
            res_meta['channel_url'] = info.get('channel_url') or info.get('uploader_url')
            res_meta['channel_id'] = info.get('channel_id') or info.get('uploader_id')

    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': str(out_dir / '%(title)s.%(ext)s'),
        'outtmpl_na_placeholder': '',
        'windowsfilenames': True,
        'nooverwrites': True,
        'ignoreerrors': True,
        'quiet': True,
        'no_warnings': True,
        'nocheckcertificate': True,
        **cookie_opts,
        'postprocessor_hooks': [hook],
        'postprocessors': [
            {'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '192'},
            {'key': 'FFmpegThumbnailsConvertor', 'format': 'jpg', 'when': 'before_dl'},
            {'key': 'FFmpegMetadata', 'add_chapters': True, 'add_metadata': True}
        ],
        'writethumbnail': True
    }
    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if not info:
                return {'url': url, 'error': 'No info returned'}
            audio_path = Path(ydl.prepare_filename(info)).with_suffix('.mp3')
    except Exception as e:
        return {'url': url, 'error': str(e)}

    if not audio_path.exists():
        return {'url': url, 'error': 'Audio file missing after download'}

    raw_artist = res_meta.get('artist')
    clean_artist = WS_RE.sub(' ', TOPIC_RE.sub('', raw_artist).strip()) if raw_artist else None
    thumb_path = audio_path.with_suffix('.jpg')
    icon_path = _fetch_artist_icon(res_meta.get('channel_url'), res_meta.get('channel_id'), out_dir, cookie_opts) if embed_icon else None
    _finalize_file(audio_path, thumb_path, icon_path, clean_artist, ffmpeg_bin)

    return {'url': url, 'path': str(audio_path), 'title': audio_path.stem, 'artist': clean_artist}


def download_links(links, out_dir, workers=8, embed_icon=True, cookies_path=None):
    """Expands playlist links, downloads every resulting track as an
    mp3 (with embedded cover art + metadata) into out_dir, and returns
    one result dict per track: {url, path, title, artist} on success or
    {url, error} on failure. Caller owns out_dir's lifetime (create
    before calling, clean up after reading the files back out)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cookie_opts = _cookie_opts(cookies_path)
    ffmpeg_bin = _find_ffmpeg()

    pairs, seen_urls = [], set()
    for link in dict.fromkeys((links or [])):  # de-dup input, preserve order
        for url, vid in _expand_link(link, cookie_opts):
            if url not in seen_urls:
                seen_urls.add(url)
                pairs.append((url, vid))

    results = [None] * len(pairs)

    def worker(i, url):
        results[i] = _download_one(url, out_dir, ffmpeg_bin, cookie_opts, embed_icon)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = [executor.submit(worker, i, url) for i, (url, _) in enumerate(pairs)]
        concurrent.futures.wait(futures)

    return results
