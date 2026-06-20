require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));

async function getCurrentBalance() {
  const { data, error } = await supabase
    .from('transactions')
    .select('amount')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).reduce((sum, row) => sum + Number(row.amount), 0);
}

const SMS_VISION_PROMPT = `You are reading a screenshot of a bank or fintech SMS conversation thread on a phone. The thread may contain multiple stacked messages. Identify ONLY the bottom-most (most recent) message in the thread — ignore older messages above it.

From that single message, extract:
- "senderName": the name shown at the very top of the conversation thread (the contact/sender the SMS is from). Read it exactly as displayed, even if stylized.
- "type": "credit" if the message says Credit/Received/Deposit, "debit" if it says Debit/Withdrawal/Purchase. null if unclear.
- "amount": the numeric transaction amount from the "Amt" line, as a plain number with no currency symbol or commas. null if not present.
- "date": the date from the "Date" line, in whatever format it appears (e.g. "19/06/2026"). null if not present.
- "time": the message timestamp shown next to that message bubble (e.g. "13:39"). null if not present.
- "matchedText": the exact text of just that bottom-most message, as best you can transcribe it.

Respond with ONLY a JSON object with these exact keys: senderName, type, amount, date, time, matchedText. No markdown, no explanation, no code fences.`;

async function callMistralVision(base64Image) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error('MISTRAL_API_KEY is not set on the server.');
  }
  const model = process.env.MISTRAL_VISION_MODEL || 'pixtral-large-latest';

  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: SMS_VISION_PROMPT },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Mistral API returned ${response.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Mistral API returned no content.');
  }

  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error('Mistral API returned non-JSON content.');
  }
}

// ── Vision-based extraction from a screenshot — preview only, nothing saved yet
app.post('/api/ocr/parse-sms', upload.single('screenshot'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No screenshot uploaded. Field name must be "screenshot".' });
    }

    const base64Image = req.file.buffer.toString('base64');
    const aiResult = await callMistralVision(base64Image);

    const rawAmount =
      typeof aiResult.amount === 'number'
        ? aiResult.amount
        : parseFloat(String(aiResult.amount ?? '').replace(/,/g, ''));
    const amount = isNaN(rawAmount) ? null : rawAmount;

    const type = aiResult.type === 'credit' ? 'income' : aiResult.type === 'debit' ? 'expense' : null;
    const bankName = aiResult.senderName || null;
    const date = aiResult.date || null;
    const time = aiResult.time || null;
    const rawText = aiResult.matchedText || null;

    const missingFields = [];
    if (!type) missingFields.push('type');
    if (amount === null) missingFields.push('amount');
    if (!date) missingFields.push('date');

    const confidence =
      missingFields.length === 0 ? 'high' : missingFields.length === 1 ? 'medium' : 'low';

    return res.json({ amount, type, date, time, bankName, confidence, missingFields, rawText });
  } catch (err) {
    console.error('OCR error:', err.message);
    return res.status(500).json({ error: `Failed to process screenshot: ${err.message}` });
  }
});

// ── Save a confirmed real transaction (day-to-day use, not onboarding)
app.post('/api/transactions/confirm', async (req, res) => {
  try {
    const { amount, type, source, rawText } = req.body;
    if (typeof amount !== 'number' || !['income', 'expense'].includes(type)) {
      return res.status(400).json({ error: 'amount (number) and type ("income"|"expense") are required.' });
    }
    const signedAmount = type === 'income' ? Math.abs(amount) : -Math.abs(amount);
    const currentBalance = await getCurrentBalance();
    const balanceAfter = currentBalance + signedAmount;

    const { data, error } = await supabase
      .from('transactions')
      .insert({ type, amount: signedAmount, source: source || 'ocr_sms', raw_text: rawText || null, balance_after: balanceAfter })
      .select()
      .single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error('Confirm transaction error:', err);
    return res.status(500).json({ error: 'Failed to save transaction.' });
  }
});

// ── Onboarding: user types real balance → log the delta as a calibration entry
app.post('/api/calibrate', async (req, res) => {
  try {
    const { balance } = req.body;
    if (typeof balance !== 'number') {
      return res.status(400).json({ error: 'balance (number) is required.' });
    }
    const currentBalance = await getCurrentBalance();
    const delta = balance - currentBalance;

    const { data, error } = await supabase
      .from('transactions')
      .insert({ type: 'calibration', amount: delta, source: 'manual_calibration', raw_text: null, balance_after: balance })
      .select()
      .single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error('Calibration error:', err);
    return res.status(500).json({ error: 'Failed to calibrate balance.' });
  }
});

app.get('/api/balance', async (req, res) => {
  try {
    const balance = await getCurrentBalance();
    return res.json({ balance });
  } catch (err) {
    console.error('Balance fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch balance.' });
  }
});

// ── Country + currency settings (single-row)
app.post('/api/settings', async (req, res) => {
  try {
    const { country, currencyCode, currencySymbol } = req.body;
    if (!country || !currencyCode || !currencySymbol) {
      return res.status(400).json({ error: 'country, currencyCode, and currencySymbol are required.' });
    }
    const { data, error } = await supabase
      .from('user_settings')
      .upsert({ id: 1, country, currency_code: currencyCode, currency_symbol: currencySymbol, updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error('Settings save error:', err);
    return res.status(500).json({ error: 'Failed to save settings.' });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const { data, error } = await supabase.from('user_settings').select('*').eq('id', 1).maybeSingle();
    if (error) throw error;
    return res.json(data || null);
  } catch (err) {
    console.error('Settings fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch settings.' });
  }
});

app.post('/api/calibrate-sync', async (req, res) => {
  try {
    const { id, type, amount, source, rawText, balanceAfter, createdAt } = req.body;
    if (!id || typeof amount !== 'number' || typeof balanceAfter !== 'number') {
      return res.status(400).json({ error: 'id, amount (number), and balanceAfter (number) are required.' });
    }
    const { data, error } = await supabase
      .from('transactions')
      .upsert(
        {
          id,
          type: type || 'calibration',
          amount,
          source: source || 'manual_calibration',
          raw_text: rawText || null,
          balance_after: balanceAfter,
          created_at: createdAt || new Date().toISOString(),
        },
        { onConflict: 'id' }
      )
      .select()
      .single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error('Calibration sync error:', err);
    return res.status(500).json({ error: 'Failed to sync calibration entry.' });
  }
});

// ── Onboarding: saves a parsed screenshot as a format sample — never touches the balance
app.post('/api/sms-format-sample', async (req, res) => {
  try {
    const { amount, type, bankName, transactionDate, transactionTime, rawText } = req.body;
    const { data, error } = await supabase
      .from('sms_format_samples')
      .insert({
        amount: amount ?? null,
        type: type ?? null,
        bank_name: bankName ?? null,
        transaction_date: transactionDate ?? null,
        transaction_time: transactionTime ?? null,
        raw_text: rawText ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error('Format sample save error:', err);
    return res.status(500).json({ error: 'Failed to save sample.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ApexTicker backend running on port ${PORT}`));
