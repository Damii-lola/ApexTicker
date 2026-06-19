function extractAmounts(text) {
  const regex = /(?:₦|NGN|N)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/gi;
  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const numeric = parseFloat(match[1].replace(/,/g, ''));
    if (!isNaN(numeric)) {
      matches.push({
        value: numeric,
        contextBefore: text.slice(Math.max(0, match.index - 25), match.index).toLowerCase(),
      });
    }
  }
  return matches;
}

function classifyDirection(text) {
  const lower = text.toLowerCase();
  const creditWords = ['credited', 'received', 'deposit', 'inflow', 'paid in'];
  const debitWords = ['debited', 'withdraw', 'purchase', 'spent', 'paid out', 'sent'];

  const creditHits = creditWords.filter((w) => lower.includes(w));
  const debitHits = debitWords.filter((w) => lower.includes(w));

  if (creditHits.length && !debitHits.length) return 'income';
  if (debitHits.length && !creditHits.length) return 'expense';
  if (creditHits.length && debitHits.length) {
    const creditPos = Math.min(...creditHits.map((w) => lower.indexOf(w)));
    const debitPos = Math.min(...debitHits.map((w) => lower.indexOf(w)));
    return creditPos < debitPos ? 'income' : 'expense';
  }
  return null;
}

function parseTransactionFromText(rawText) {
  const text = rawText.replace(/\s+/g, ' ').trim();
  const amounts = extractAmounts(text);
  const balanceFlags = ['bal', 'balance', 'avail'];

  const transactionAmounts = amounts.filter(
    (a) => !balanceFlags.some((flag) => a.contextBefore.includes(flag))
  );
  const balanceAmounts = amounts.filter((a) =>
    balanceFlags.some((flag) => a.contextBefore.includes(flag))
  );

  const direction = classifyDirection(text);
  const primary = transactionAmounts[0] || amounts[0] || null;
  const balanceMentioned = balanceAmounts.length
    ? balanceAmounts[balanceAmounts.length - 1].value
    : null;

  return {
    amount: primary ? primary.value : null,
    type: direction,
    balanceMentioned,
    confidence: primary && direction ? 'high' : primary || direction ? 'medium' : 'low',
  };
}

module.exports = { parseTransactionFromText };
