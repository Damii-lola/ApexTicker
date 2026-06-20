require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const { createClient } = require('@supabase/supabase-js');
const { parseTransactionFromText } = require('./smsParser');

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

// ── OCR: extract + parse text from a screenshot — preview only, nothing saved yet
app.post('/api/ocr/parse-sms', upload.single('screenshot'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No screenshot uploaded. Field name must be "screenshot".' });
    }
    const { data } = await Tesseract.recognize(req.file.buffer, 'eng');
    const rawText = data.text || '';
    const parsed = parseTransactionFromText(rawText);
    return res.json(parsed);
  } catch (err) {
    console.error('OCR error:', err);
    return res.status(500).json({ error: 'Failed to process screenshot.' });
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
