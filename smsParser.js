function splitIntoMessages(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const anchorRegex = /\b(debit|credit)\b/gi;
  const anchors = [];
  let match;
  while ((match = anchorRegex.exec(normalized)) !== null) {
    anchors.push({ index: match.index, direction: match[1].toLowerCase() });
  }
  if (!anchors.length) return [];
  const segments = [];
  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i].index;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : normalized.length;
    segments.push({ direction: anchors[i].direction, text: normalized.slice(start, end) });
  }
  return segments;
}

function parseAmountFromLabel(text, labelRegex) {
  const match = text.match(labelRegex);
  if (!match) return null;
  const numeric = parseFloat(match[1].replace(/,/g, ''));
  return isNaN(numeric) ? null : numeric;
}

function parseSegment(segment) {
  const amount = parseAmountFromLabel(segment.text, /amt[:\s]*[₦n]?\s?(\d[\d,]*\.?\d{0,2})/i);
  const balanceMentioned = parseAmountFromLabel(
    segment.text,
    /(?:avail\s*bal|available\s*balance|balance|bal)[:\s]*[₦n]?\s?(\d[\d,]*\.?\d{0,2})/i
  );
  const type = segment.direction === 'credit' ? 'income' : segment.direction === 'debit' ? 'expense' : null;
  return { amount, type, balanceMentioned };
}

function parseTransactionFromText(rawText) {
  const segments = splitIntoMessages(rawText);
  if (!segments.length) {
    return { amount: null, type: null, balanceMentioned: null, confidence: 'low', rawText };
  }
  // Bottom-most segment in a chat-style screenshot = the most recent message
  const latestSegment = segments[segments.length - 1];
  const parsed = parseSegment(latestSegment);
  return {
    ...parsed,
    confidence:
      parsed.amount !== null && parsed.type !== null
        ? 'high'
        : parsed.amount !== null || parsed.type !== null
        ? 'medium'
        : 'low',
    rawText,
  };
}

module.exports = { parseTransactionFromText };
