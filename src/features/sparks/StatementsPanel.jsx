import { useMemo, useState } from 'react';

import { IconCheck, IconRefresh, IconSearch } from '../../components/icons.jsx';
import { insertStatements, lookupStatements, sortStatements, spellcheckStatements } from '../../lib/statementsApi.js';
import { makeSparkId, STATEMENTS_CATEGORY } from '../../lib/sparkStore.js';

function newStatementSpark(text) {
  return { id: makeSparkId(), createdAt: Date.now(), category: STATEMENTS_CATEGORY, linkedFileIds: [], screenshotFileId: '', text };
}

// Replays the Python service's per-phrase insert results against the
// existing "statements" spark objects in the same order it applied them
// to its own string list — so `position`/`previous` from the API line up
// with array indices here exactly, and every spark keeps its id (and
// therefore createdAt) unless it's a phrase inserted this call.
function applyInsertResults(existingSparks, results) {
  const working = existingSparks.slice();
  results.forEach((r) => {
    if (r.action === 'inserted') working.splice(r.position, 0, newStatementSpark(r.phrase));
    else if (r.action === 'replaced_duplicate') working[r.position] = { ...working[r.position], text: r.phrase };
    // 'skipped_duplicate' — nothing to apply.
  });
  return working;
}

// The Statements spark category (see CLAUDE.md 3.9 and this repo's
// temp/processing/statements — now folded in here rather than being its
// own standalone tool). Sparks in this category are order-sensitive: the
// stored array order *is* the sorted order, maintained by the Python
// similarity engine's sort/insert operations, not by capture time like
// every other spark category.
function StatementsPanel({ sparks, busy, saveSparks }) {
  const statementsSparks = useMemo(() => sparks.filter((s) => s.category === STATEMENTS_CATEGORY), [sparks]);
  const existingPhrases = useMemo(() => statementsSparks.map((s) => s.text), [statementsSparks]);

  const [addText, setAddText] = useState('');
  const [working, setWorking] = useState(false);
  const [insertSummary, setInsertSummary] = useState(null);
  const [spellResults, setSpellResults] = useState(null);

  const [lookupText, setLookupText] = useState('');
  const [lookupN, setLookupN] = useState(5);
  const [lookupResults, setLookupResults] = useState(null);

  const newPhrases = () =>
    addText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

  const handleSpellcheck = async () => {
    const phrases = newPhrases();
    if (!phrases.length) return;
    setWorking(true);
    try {
      setSpellResults(await spellcheckStatements(phrases));
    } finally {
      setWorking(false);
    }
  };

  const applySuggestion = (phrase, word, suggestion) => {
    if (!suggestion) return;
    setAddText((t) => t.replace(new RegExp(`\\b${word}\\b`), suggestion));
  };

  const handleInsert = async () => {
    const phrases = newPhrases();
    if (!phrases.length) return;
    setWorking(true);
    setInsertSummary(null);
    try {
      const { results } = await insertStatements(existingPhrases, phrases);
      const nextStatements = applyInsertResults(statementsSparks, results);
      const others = sparks.filter((s) => s.category !== STATEMENTS_CATEGORY);
      await saveSparks([...others, ...nextStatements]);
      setInsertSummary(results);
      setAddText('');
      setSpellResults(null);
    } finally {
      setWorking(false);
    }
  };

  const handleResortAll = async () => {
    if (existingPhrases.length < 2) return;
    setWorking(true);
    try {
      const sorted = await sortStatements(existingPhrases);
      const others = sparks.filter((s) => s.category !== STATEMENTS_CATEGORY);
      await saveSparks([...others, ...sorted.map(newStatementSpark)]);
    } finally {
      setWorking(false);
    }
  };

  const handleLookup = async () => {
    const queries = lookupText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (!queries.length) return;
    setWorking(true);
    try {
      setLookupResults(await lookupStatements(queries, existingPhrases, lookupN));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="compile-panel-section" style={{ border: 'none', padding: 0 }}>
      <p className="muted compile-panel-hint">
        {statementsSparks.length} stored phrase{statementsSparks.length === 1 ? '' : 's'}, in similarity-sorted order.
      </p>

      <div className="compile-panel-section">
        <div className="compile-panel-title">Add phrases</div>
        <textarea
          className="spark-textarea"
          rows={4}
          placeholder="One phrase per line…"
          value={addText}
          onChange={(e) => setAddText(e.target.value)}
        />
        <div className="compile-result-actions">
          <button className="btn-secondary" onClick={handleSpellcheck} disabled={working || busy || !addText.trim()}>
            {working ? <IconRefresh size={13} className="spin" /> : <IconCheck size={13} />} Check spelling
          </button>
          <button className="btn-secondary" onClick={handleInsert} disabled={working || busy || !addText.trim()}>
            {working ? <IconRefresh size={13} className="spin" /> : null} Insert (sorted)
          </button>
        </div>
        {spellResults && (
          <div className="compile-apply-results">
            {spellResults.every((r) => !r.issues.length) && <div className="compile-apply-row">No issues found.</div>}
            {spellResults
              .filter((r) => r.issues.length)
              .map((r) => (
                <div key={r.phrase} className="compile-apply-row">
                  <span className="compile-apply-path">{r.phrase}</span>
                  <span className="compile-apply-status">
                    {r.issues.map((iss) => (
                      <button key={iss.word} className="spark-chip" onClick={() => applySuggestion(r.phrase, iss.word, iss.suggestion)}>
                        {iss.word} → {iss.suggestion || '?'}
                      </button>
                    ))}
                  </span>
                </div>
              ))}
          </div>
        )}
        {insertSummary && (
          <div className="compile-apply-results">
            {insertSummary.map((r, i) => (
              <div key={i} className="compile-apply-row">
                <span className="compile-apply-path">{r.phrase}</span>
                <span className="compile-apply-status">{r.action.replace('_', ' ')}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="compile-panel-section">
        <div className="compile-panel-title">Lookup similar phrases</div>
        <textarea
          className="spark-textarea"
          rows={3}
          placeholder="One phrase per line…"
          value={lookupText}
          onChange={(e) => setLookupText(e.target.value)}
        />
        <label className="spark-field-wrap">
          <span className="compile-chip-label">Results per phrase</span>
          <input
            className="spark-input"
            type="number"
            min={1}
            max={50}
            value={lookupN}
            onChange={(e) => setLookupN(Number(e.target.value) || 5)}
          />
        </label>
        <button className="btn-secondary compile-run-btn" onClick={handleLookup} disabled={working || busy || !lookupText.trim()}>
          {working ? <IconRefresh size={13} className="spin" /> : <IconSearch size={13} />} Search
        </button>
        {lookupResults && (
          <div className="compile-apply-results">
            {lookupResults.map((r) => (
              <div key={r.query}>
                <div className="compile-apply-row">
                  <span className="compile-apply-path">{r.query}</span>
                </div>
                {r.matches.map((m) => (
                  <div key={m.phrase} className="compile-apply-row">
                    <span className="compile-apply-path" style={{ paddingLeft: 14 }}>
                      {m.phrase}
                    </span>
                    <span className="compile-apply-status">{m.score.toFixed(3)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="compile-panel-section">
        <div className="compile-panel-title">All stored phrases</div>
        <div className="compile-apply-results">
          {statementsSparks.length === 0 && <p className="muted small empty-hint">None yet — add some above.</p>}
          {statementsSparks.map((s) => (
            <div key={s.id} className="compile-apply-row">
              <span className="compile-apply-path">{s.text}</span>
            </div>
          ))}
        </div>
        {statementsSparks.length > 1 && (
          <button className="btn-secondary compile-run-btn" onClick={handleResortAll} disabled={working || busy}>
            {working ? <IconRefresh size={13} className="spin" /> : <IconRefresh size={13} />} Re-sort all
          </button>
        )}
      </div>
    </div>
  );
}

export { StatementsPanel };
