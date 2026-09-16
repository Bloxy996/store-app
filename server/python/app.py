# ---------------------------------------------------------------------------
# store's Python service — see README.md in this folder for what it's for
# and why it's separate from server/ (the Node backend). A general-purpose
# home for backend logic that benefits from real Python libraries with no
# good browser or Node equivalent — currently just statements_engine
# (sentence-transformers/torch for semantic phrase similarity), but written
# to grow: new features live in their own module next to statements_engine.py
# and get their own route(s) registered below, rather than needing a
# separate process each.
#
# The Node backend (server/src/routes/*.js) is the only intended caller —
# this process isn't meant to be reachable from the internet directly, so
# there's no auth/session handling here; that's the Node layer's job (it
# already gates these routes behind a signed-in session before proxying).
# ---------------------------------------------------------------------------

import os

from flask import Flask, jsonify, request

import statements_engine as se

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


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=int(os.environ.get('PORT', 8788)))
