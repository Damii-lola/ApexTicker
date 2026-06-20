function normalizeForBankMatch(text) {
  return text.replace(/\s+/g, '').toLowerCase();
}

const UI_NOISE_WORDS = ['delete', 'back', 'edit', 'search', 'menu', 'call', 'video', 'more', 'cancel', 'send'];
const WEEKDAY_REGEX = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

// Pulls the sender name shown at the top of the message thread — this is how
// the OS displays whoever sent the SMS, so it works for any bank or fintech
// without needing a list of known names.
function extractSenderName(rawText) {
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const messageStartIndex = lines.findIndex((l) => /\b(debit|credit)\b/i.test(l));
  const headerLines = messageStartIndex > 0 ? lines.slice(0, messageStartIndex) : lines.slice(0, 4);

  const candidates = headerLines.filter((line) => {
    const lower = line.toLowerCase();
    if (UI_NOISE_WORDS.some((w) => lower === w || lower.includes(w))) return false;
    if (/^\d{1,2}:\d{2}$/.test(line)) return false;        // clock time
    if (/^\d+$/.test(line)) return false;                  // bare number
    if (/^[\d\s/,.\-]+$/.test(line)) return false;          // date-like noise
    if (WEEKDAY_REGEX.test(line)) return false;             // "Friday, 19 June 2026"
    if (line.length < 2) return false;
    return true;
  });

  if (!candidates.length) return null;
  // The sender name is typically the most prominent (longest) header text,
  // versus single-character status bar fragments OCR sometimes catches.
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

function extractDate(text) {
  const match = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
  return match ? match[0] : null;
}

function extractTime(text) {
  const matches = text.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/g);
  return matches ? matches[matches.length - 1] : null;
}

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
  // "ngn" must be checked before bare "n" in the alternation, or it matches
  // just the N and leaves "GN" stuck in front of the digits.
  const amount = parseAmountFromLabel(
    segment.text,
    /amt[:\s]*(?:₦|ngn|n|usd|\$|gbp|£|eur|€)?\s*(\d[\d,]*\.?\d{0,2})/i
  );
  const balanceMentioned = parseAmountFromLabel(
    segment.text,
    /(?:avail\s*bal|available\s*balance|balance|bal)[:\s]*(?:₦|ngn|n|usd|\$|gbp|£|eur|€)?\s*(\d[\d,]*\.?\d{0,2})/i
  );
  const type = segment.direction === 'credit' ? 'income' : segment.direction === 'debit' ? 'expense' : null;
  const date = extractDate(segment.text);
  const time = extractTime(segment.text);
  return { amount, type, balanceMentioned, date, time };
}

function parseTransactionFromText(rawText) {
  const segments = splitIntoMessages(rawText);
  const bankName = extractSenderName(rawText);

  if (!segments.length) {
    return {
      amount: null, type: null, balanceMentioned: null, date: null, time: null,
      bankName, confidence: 'low', missingFields: ['type', 'amount', 'date'], rawText,
    };
  }

  const latestSegment = segments[segments.length - 1];
  const parsed = parseSegment(latestSegment);

  const missingFields = [];
  if (!parsed.type) missingFields.push('type');
  if (parsed.amount === null) missingFields.push('amount');
  if (!parsed.date) missingFields.push('date');

  const confidence =
    missingFields.length === 0 ? 'high' : missingFields.length === 1 ? 'medium' : 'low';

  return { ...parsed, bankName, confidence, missingFields, rawText };
}

module.exports = { parseTransactionFromText };
