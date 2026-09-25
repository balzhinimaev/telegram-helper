// A local, lossless repair, not fuzzy quotation matching. The caller must still
// run the normal evidence validator; unresolved evidence is returned unchanged.
const SPACE = /[ \t\r\n\f\v\u00a0]/u;
const MAX_QUOTE_CHARACTERS = 180;

function indexedWhitespace(text) {
  let normalized = '';
  const starts = [], ends = [];
  for (let index = 0; index < text.length;) {
    const start = index;
    if (SPACE.test(text[index])) {
      do { index++; } while (index < text.length && SPACE.test(text[index]));
      normalized += ' ';
      starts.push(start);
      ends.push(index);
    } else {
      // Indices stay in UTF-16, matching String#indexOf and String#slice. No
      // Unicode normalization or case/punctuation changes are performed.
      normalized += text[index];
      starts.push(index);
      ends.push(++index);
    }
  }
  return { normalized, starts, ends };
}

/**
 * Restore only collapsed/replaced whitespace to an exact same-ID source span.
 * `segments` are ONLY the input supplied to this node; separate segments are
 * never joined. For reductions, provide the checked inherited evidence array.
 * Returns the original object unless there is one unambiguous legal repair.
 * The original input and inherited records are never mutated.
 */
export function restoreEvidenceWhitespace(evidence, segments, inheritedEvidence = null) {
  if (!evidence || typeof evidence.id !== 'string' || typeof evidence.quote !== 'string'
    || !evidence.quote.trim() || Array.from(evidence.quote).length > MAX_QUOTE_CHARACTERS
    || !Array.isArray(segments) || (inheritedEvidence !== null && !Array.isArray(inheritedEvidence))) return evidence;

  const sources = segments.filter(segment => segment?.id === evidence.id && typeof segment.text === 'string');
  // Do not reinterpret an already exact quotation, even if its context fails.
  if (sources.some(source => source.text.includes(evidence.quote))) return evidence;
  const needle = indexedWhitespace(evidence.quote).normalized;
  let matches = 0, repaired;
  for (const source of sources) {
    const { normalized, starts, ends } = indexedWhitespace(source.text);
    let offset = normalized.indexOf(needle);
    while (offset !== -1) {
      // Count all occurrences before provenance filtering. A repeated phrase is
      // ambiguous even if only one occurrence fits an inherited excerpt.
      matches++;
      if (matches > 1) return evidence;
      repaired = source.text.slice(starts[offset], ends[offset + needle.length - 1]);
      offset = normalized.indexOf(needle, offset + 1);
    }
  }
  if (matches !== 1 || Array.from(repaired).length > MAX_QUOTE_CHARACTERS) return evidence;
  if (inheritedEvidence !== null && !inheritedEvidence.some(prior => prior?.id === evidence.id
    && typeof prior.quote === 'string' && prior.quote.includes(repaired))) return evidence;
  return { ...evidence, quote: repaired };
}
