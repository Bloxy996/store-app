import argparse
import concurrent.futures
import re
import subprocess
import sys
import threading
import urllib.request
from pathlib import Path

try:
    from yt_dlp import YoutubeDL
except ImportError:
    print("Requirement 'yt-dlp' not found. Installing automatically...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "yt-dlp"])
    from yt_dlp import YoutubeDL

TOPIC_RE = re.compile(r"\s*-\s*Topic$", re.IGNORECASE)
WS_RE = re.compile(r"\s+")
THUMB_EXTS = {".jpg", ".jpeg", ".webp", ".png"}
ICON_CACHE: dict[str, Path | None] = {}
ICON_LOCK = threading.Lock()

def get_cookie_opts(cookie_file: Path | None) -> dict:
    if cookie_file and cookie_file.exists():
        return {"cookiefile": str(cookie_file)}
    return {}

def get_unique_links(file_path: Path) -> list[str]:
    if not file_path.exists():
        return []
    lines = file_path.read_text(encoding="utf-8").splitlines(keepends=True)
    seen, cleaned, links = set(), [], []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            cleaned.append(line)
            continue
        if stripped not in seen:
            seen.add(stripped)
            links.append(stripped)
        cleaned.append(line)
    file_path.write_text("".join(cleaned), encoding="utf-8")
    return links

def expand_link(link: str, cookie_opts: dict) -> list[tuple[str, str | None]]:
    opts = {"quiet": True, "no_warnings": True, "extract_flat": True, "skip_download": True, **cookie_opts}
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(link, download=False)
    except Exception:
        return [(link, None)]

    if info and info.get("_type") == "playlist":
        pairs = []
        for entry in info.get("entries") or []:
            if not entry:
                continue
            vid = entry.get("id")
            url = entry.get("webpage_url") or entry.get("url") or vid
            if url:
                if not url.startswith("http"):
                    url = f"https://www.youtube.com/watch?v={url}"
                pairs.append((url, vid))
        return pairs
    return [(link, info.get("id") if info else None)]

def find_ffmpeg(script_dir: Path) -> str:
    for name in ("ffmpeg.exe", "ffmpeg"):
        if (script_dir / name).exists():
            return str(script_dir / name)
    return "ffmpeg"

def fetch_artist_icon(channel_url: str | None, channel_id: str | None, cache_dir: Path, cookie_opts: dict) -> Path | None:
    if not channel_url:
        return None
    key = channel_id or channel_url

    with ICON_LOCK:
        if key in ICON_CACHE:
            return ICON_CACHE[key]

    icon_path = cache_dir / f".artist_icon_{re.sub(r'[^A-Za-z0-9_-]', '_', key)}.jpg"
    try:
        about_url = channel_url.rstrip("/") + "/about"
        opts = {"quiet": True, "no_warnings": True, "extract_flat": True, "skip_download": True, **cookie_opts}
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(about_url, download=False)
        thumbs = info.get("thumbnails") or []
        if not thumbs:
            with ICON_LOCK: ICON_CACHE[key] = None
            return None
        best = max(thumbs, key=lambda t: (t.get("width") or 0) * (t.get("height") or 0))
        url = best.get("url")
        if not url:
            with ICON_LOCK: ICON_CACHE[key] = None
            return None
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            icon_path.write_bytes(resp.read())
    except Exception:
        with ICON_LOCK: ICON_CACHE[key] = None
        return None

    with ICON_LOCK: ICON_CACHE[key] = icon_path
    return icon_path

def finalize_file(audio_path: Path, thumb_path: Path | None, icon_path: Path | None, artist: str | None, ffmpeg_bin: str) -> None:
    if not audio_path.exists():
        return
    has_thumb = thumb_path and thumb_path.exists()
    has_icon = icon_path and icon_path.exists()
    if not has_thumb and not has_icon and not artist:
        return

    tmp_out = audio_path.with_suffix(".tmp.mp3")
    cmd = [ffmpeg_bin, "-y", "-i", str(audio_path)]
    maps, meta = ["-map", "0:a"], []
    idx, stream = 1, 0

    if has_thumb:
        cmd += ["-i", str(thumb_path)]
        maps += ["-map", str(idx)]
        meta += [f"-metadata:s:v:{stream}", "title=Album cover", f"-metadata:s:v:{stream}", "comment=Cover (front)"]
        idx += 1; stream += 1

    if has_icon:
        cmd += ["-i", str(icon_path)]
        maps += ["-map", str(idx)]
        meta += [f"-metadata:s:v:{stream}", "title=Artist icon", f"-metadata:s:v:{stream}", "comment=Artist/performer"]

    cmd += maps + ["-c", "copy"]
    if has_thumb or has_icon:
        cmd += ["-id3v2_version", "3"] + meta
    if artist:
        cmd += ["-metadata", f"artist={artist}"]
    cmd.append(str(tmp_out))

    try:
        res = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace")
        if res.returncode == 0:
            tmp_out.replace(audio_path)
        else:
            tmp_out.unlink(missing_ok=True)
    except Exception:
        tmp_out.unlink(missing_ok=True)

    if has_thumb:
        thumb_path.unlink(missing_ok=True)

def download_one(url: str, out_dir: Path, script_dir: Path, ffmpeg_bin: str, cookie_opts: dict, embed_icon: bool, index: int, total: int) -> str | None:
    res_meta = {}

    def hook(d: dict):
        if d.get("status") == "finished":
            info = d.get("info_dict") or {}
            res_meta["artist"] = info.get("channel") or info.get("uploader")
            res_meta["channel_url"] = info.get("channel_url") or info.get("uploader_url")
            res_meta["channel_id"] = info.get("channel_id") or info.get("uploader_id")

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "%(title)s.%(ext)s"),
        "outtmpl_na_placeholder": "",
        "windowsfilenames": True,
        "nooverwrites": True,
        "ignoreerrors": True,
        "quiet": True,
        "no_warnings": True,
        "ffmpeg_location": str(script_dir),
        "nocheckcertificate": True,
        "download_archive": str(script_dir / "downloaded.txt"),
        **cookie_opts,
        "postprocessor_hooks": [hook],
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"},
            {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"},
            {"key": "FFmpegMetadata", "add_chapters": True, "add_metadata": True},
        ],
        "writethumbnail": True,
        "parse_metadata": ["playlist_title:%(meta_album)s", "categories:%(meta_genre)s"],
    }

    print(f"[{index}/{total}] Downloading: {url}")
    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if not info:
                return "No info returned"
            audio_path = Path(ydl.prepare_filename(info)).with_suffix(".mp3")
    except Exception as e:
        return str(e)

    if not audio_path.exists():
        return "Audio file missing after download"

    raw_artist = res_meta.get("artist")
    clean_artist = WS_RE.sub(" ", TOPIC_RE.sub("", raw_artist).strip()) if raw_artist else None
    thumb_path = audio_path.with_suffix(".jpg")

    icon_path = fetch_artist_icon(res_meta.get("channel_url"), res_meta.get("channel_id"), out_dir, cookie_opts) if embed_icon else None
    finalize_file(audio_path, thumb_path, icon_path, clean_artist, ffmpeg_bin)
    
    print(f"[{index}/{total}] Done: {url}")
    return None

def cleanup(out_dir: Path):
    mp3s = {p.stem for p in out_dir.glob("*.mp3")}
    for ext in THUMB_EXTS:
        for img in out_dir.glob(f"*{ext}"):
            if not img.name.startswith(".artist_icon_") and img.stem not in mp3s:
                img.unlink(missing_ok=True)
    for icon in out_dir.glob(".artist_icon_*.jpg"):
        icon.unlink(missing_ok=True)

def main():
    parser = argparse.ArgumentParser(description="Parallel YouTube Audio Downloader")
    parser.add_argument("-f", "--file", type=Path, default=Path("links.txt"), help="Path to links file")
    parser.add_argument("-o", "--output", type=Path, default=Path("downloads"), help="Output directory")
    parser.add_argument("-w", "--workers", type=int, default=20, help="Max parallel downloads")
    parser.add_argument("--cookies", type=Path, default=Path("cookies.txt"), help="Cookies file path")
    parser.add_argument("--no-icon", action="store_true", help="Disable artist icon embedding")

    args = parser.parse_args()
    cookie_opts = get_cookie_opts(args.cookies)

    script_dir = Path(__file__).resolve().parent
    ffmpeg_bin = find_ffmpeg(script_dir)
    links = get_unique_links(args.file)

    if not links:
        print(f"No links found in '{args.file}'.")
        return

    print(f"Expanding {len(links)} link(s)...")
    pairs = []
    for link in links:
        pairs.extend(expand_link(link, cookie_opts))

    if not pairs:
        print("No video entries found.")
        return

    archive_file = script_dir / "downloaded.txt"
    archived_ids = set(archive_file.read_text().splitlines()) if archive_file.exists() else set()
    to_dl = [(url, vid) for url, vid in pairs if not (vid and vid in archived_ids)]

    print(f"{len(pairs) - len(to_dl)} skipped (already downloaded). Processing {len(to_dl)} tracks with {args.workers} workers...")
    args.output.mkdir(parents=True, exist_ok=True)

    failures = []
    lock = threading.Lock()

    def worker(url: str, idx: int, tot: int):
        reason = download_one(url, args.output, script_dir, ffmpeg_bin, cookie_opts, not args.no_icon, idx, tot)
        if reason:
            with lock:
                failures.append((url, reason))

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(worker, url, i, len(to_dl)) for i, (url, _) in enumerate(to_dl, 1)]
        concurrent.futures.wait(futures)

    cleanup(args.output)
    print(f"\nDone! Processed {len(to_dl)} tracks. ({len(failures)} failed)")
    for url, reason in failures:
        print(f"  - Failed: {url} ({reason})")

if __name__ == "__main__":
    main()