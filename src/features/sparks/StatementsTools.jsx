import { useMemo, useState } from 'react';

import { IconAlertTriangle, IconLoader, IconSliders } from '../../components/icons.jsx';
import { DEFAULT_WEIGHTS, buildVocabulary, lookupSimilarStatements, spellcheckPhrase } from '../../lib/statementSort.js';

function StatementsTools({ category, categoryPhrases, allSparkTexts, onInsertSorted, busy }) {
  const [insertText, setInsertText] = useState('');
  const [insertReport, setInsertReport] = useState(null);
  const [lookupText, setLookupText] = useState('');
  const [topN, setTopN] = useState(5);
  const [lookupResults, setLookupResults] = useState(null);

  const vocabulary = useMemo(() => buildVocabulary(allSparkTexts), [allSparkTexts]);

  const typos = useMemo(() => {
    const lines = insertText.split('\n').map((l) => l.trim()).filter(Boolean);
    const seen = new Map();
    lines.forEach((line) => {
      spellcheckPhrase(line, vocabulary).forEach(({ word, suggestion }) => {
        if (!seen.has(word)) seen.set(word, suggestion);
      });
    });
    return Array.from(seen.entries());
  }, [insertText, vocabulary]);

  const handleInsert = async () => {
    if (!insertText.trim() || busy) return;
    const report = await onInsertSorted(insertText, DEFAULT_WEIGHTS);
    setInsertReport(report);
    setInsertText('');
  };

  const handleLookup = () => {
    if (!lookupText.trim()) {
      setLookupResults(null);
      return;
    }
    setLookupResults(lookupSimilarStatements(categoryPhrases, lookupText, topN, DEFAULT_WEIGHTS));
  };

  return (
    <div className="statements-tools">
      <div className="statements-section">
        <div className="statements-section-label">
          <IconSliders size={12} /> Insert sorted into “{category}”
        </div>
        <textarea
          className="statements-textarea"
          rows={4}
          placeholder="One phrase per line — each is scored against the phrases already here and inserted in sorted order."
          value={insertText}
          onChange={(e) => setInsertText(e.target.value)}
        />
        {typos.length > 0 && (
          <div className="statements-typos">
            <IconAlertTriangle size={12} />
            {typos.map(([word, suggestion]) => (
              <span key={word} className="statements-typo-chip">
                {word}
                {suggestion ? ` → ${suggestion}?` : ''}
              </span>
            ))}
          </div>
        )}
        <button className="btn-secondary statements-btn" onClick={handleInsert} disabled={busy || !insertText.trim()}>
          {busy ? <IconLoader size={13} /> : null} Insert sorted
        </button>
        {insertReport && (
          <div className="statements-output" role="status">
            {insertReport.map((r, i) => (
              <div key={i} className="statements-output-line">
                <span className={`statements-action statements-action-${r.action}`}>{r.action.replace('-', ' ')}</span> {r.phrase}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="statements-section">
        <div className="statements-section-label">Look up similar phrases</div>
        <textarea
          className="statements-textarea"
          rows={3}
          placeholder="One or more phrases to search for, one per line."
          value={lookupText}
          onChange={(e) => setLookupText(e.target.value)}
        />
        <div className="statements-lookup-row">
          <label htmlFor="statements-topn">Top</label>
          <input
            id="statements-topn"
            type="number"
            min={1}
            max={20}
            value={topN}
            onChange={(e) => setTopN(Math.max(1, Number(e.target.value) || 1))}
          />
          <button className="btn-secondary statements-btn" onClick={handleLookup} disabled={!lookupText.trim()}>
            Find similar
          </button>
        </div>
        {lookupResults && (
          <div className="statements-output">
            {lookupResults.map(({ query, matches }, i) => (
              <div key={i} className="statements-lookup-result">
                <div className="statements-lookup-query">“{query}”</div>
                {matches.length === 0 && <div className="muted small">No phrases in this category yet.</div>}
                {matches.map((m, j) => (
                  <div key={j} className="statements-output-line">
                    <span className="statements-score">{m.score.toFixed(2)}</span> {m.phrase}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export { StatementsTools };
