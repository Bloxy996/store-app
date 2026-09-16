# ---------------------------------------------------------------------------
# store's Python service — see README.md in this folder for what it's for
# and why it's separate from server/ (the Node backend). Two features live
# here because both benefit from real Python libraries with no good browser
# or Node equivalent: statements_engine (sentence-transformers/torch for
# semantic phrase similarity) and music_downloader (yt-dlp + ffmpeg).
#
# The Node backend (server/src/routes/statements.js, music.js) is the only
# intended caller — this process isn't meant to be reachable from the
# internet directly, so there's no auth/session handling here; that's the
# Node layer's job (it already gates these routes behind a signed-in
# session before proxying).
# ---------------------------------------------------------------------------

import base64
import mimetypes
import os
import shutil
import tempfile

from flask import Flask, jsonify, request

import statements_engine as se
from music_downloader import download_links

app = Flask(__name__)


def weights_from(body):
    w = (body or {}).get('weights') or {}
    return {**se.DEFAULT_WEIGHTS, **{k: float(v) for k, v in w.items() if k in se.DEFAULT_WEIGHTS}}


@app.get('/healthz')
def healthz():
    return jsonify(ok=True)


@app.post('/statements/sort')
def sort_route():
    body = request.get_json(force=True, silent=True) or {}
    phrases = [str(p) for p in (body.get('phrases') or [])]
    return jsonify(phrases=se.sort_phrases(phrases, weights_from(body)))


@app.post('/statements/insert')
def insert_route():
    body = request.get_json(force=True, silent=True) or {}
    existing = [str(p) for p in (body.get('existing') or [])]
    new_phrases = [str(p) for p in (body.get('newPhrases') or [])]
    phrases, results = se.insert_phrases(existing, new_phrases, weights_from(body))
    return jsonify(phrases=phrases, results=results)


@app.post('/statements/lookup')
def lookup_route():
    body = request.get_json(force=True, silent=True) or {}
    queries = [str(p) for p in (body.get('queries') or [])]
    corpus = [str(p) for p in (body.get('corpus') or [])]
    n = body.get('n', 5)
    return jsonify(results=se.lookup_similar(queries, corpus, n, weights_from(body)))


@app.post('/statements/spellcheck')
def spellcheck_route():
    body = request.get_json(force=True, silent=True) or {}
    phrases = [str(p) for p in (body.get('phrases') or [])]
    return jsonify(results=se.spellcheck_phrases(phrases))


@app.post('/music/download')
def music_download_route():
    body = request.get_json(force=True, silent=True) or {}
    links = [str(l) for l in (body.get('links') or []) if str(l).strip()]
    if not links:
        return jsonify(files=[], errors=[]), 400

    tmp_dir = tempfile.mkdtemp(prefix='store-music-')
    try:
        raw_results = download_links(
            links,
            tmp_dir,
            workers=int(body.get('workers') or 8),
            embed_icon=bool(body.get('embedIcon', True))
        )
        files, errors = [], []
        for r in raw_results:
            if r.get('error'):
                errors.append({'url': r['url'], 'error': r['error']})
                continue
            path = r['path']
            mime = mimetypes.guess_type(path)[0] or 'audio/mpeg'
            with open(path, 'rb') as f:
                data = base64.b64encode(f.read()).decode('ascii')
            files.append({
                'filename': os.path.basename(path),
                'mimeType': mime,
                'dataBase64': data,
                'title': r.get('title'),
                'artist': r.get('artist'),
                'sourceUrl': r['url']
            })
        return jsonify(files=files, errors=errors)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=int(os.environ.get('PORT', 8788)))
