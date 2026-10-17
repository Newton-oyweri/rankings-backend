import express, { type Request, type Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL!; // cloudflare tunnel URL, no trailing slash

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Middleware
app.use(cors());
// Keep the raw body, Paystack's webhook signature is computed over it
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);


// Health check
app.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Rankings Backend API is live!', timestamp: new Date() });
});

type DepositStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'ABANDONED';

// Paystack verify status -> our ledger status
const STATUS_MAP: Record<string, DepositStatus> = {
  success: 'SUCCESS',
  failed: 'FAILED',
  reversed: 'FAILED',
  abandoned: 'ABANDONED',
  ongoing: 'PENDING',
  pending: 'PENDING',
  processing: 'PENDING',
  queued: 'PENDING',
};

// Ask Paystack for the truth and update the ledger. Safe to call any number of times.
async function reconcile(reference: string): Promise<DepositStatus | null> {
  const verifyRes = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
  );
  const verify = await verifyRes.json();
  const tx = verify?.data;

  if (!verify?.status || !tx) {
    console.warn(`Verify failed for ${reference}:`, verify?.message);
    return null;
  }

  const mapped = STATUS_MAP[String(tx.status)] ?? 'PENDING';
  if (mapped === 'PENDING') return 'PENDING';

  if (mapped === 'SUCCESS' && tx.currency !== 'KES') {
    console.error(`Unexpected currency ${tx.currency} for ${reference}, not crediting`);
    return null;
  }

  const { data, error } = await supabase.rpc('settle_deposit', {
    p_reference: reference,
    p_status: mapped,
    p_amount: Math.round(Number(tx.amount)) / 100, // subunits -> KES
  });

  if (error) {
    console.error(`settle_deposit error for ${reference}:`, error.message);
    return null;
  }

  console.log(`Deposit ${reference} -> ${data}`);
  return data === 'ALREADY_SUCCESS' ? 'SUCCESS' : (data as DepositStatus);
}














// Initialize a deposit
app.post('/api/paystack/initialize', async (req: Request, res: Response) => {
  const { email, amount, userId } = req.body;

  if (!email || !amount || !userId) {
    return res.status(400).json({ error: 'Missing required fields: email, amount, userId' });
  }

  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const amountKes = Math.round(numAmount * 100) / 100;
  const reference = `dep_${String(userId).slice(0, 8)}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

  try {
    // 1. Ledger first: PENDING row exists before the user ever sees checkout
    const { error: pendingErr } = await supabase.rpc('create_pending_deposit', {
      p_user_id: userId,
      p_reference: reference,
      p_amount: amountKes,
    });
    if (pendingErr) {
      console.error('create_pending_deposit error:', pendingErr);
      return res.status(500).json({ error: 'Could not create deposit record' });
    }

    // 2. Initialize with Paystack
    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        amount: Math.round(amountKes * 100),
        currency: 'KES',
        reference,
        callback_url: `${PUBLIC_BASE_URL}/api/paystack/callback`,
        metadata: { userId },
      }),
    });

    const data = await paystackRes.json();

    if (!paystackRes.ok || !data?.status) {
      await supabase.rpc('settle_deposit', { p_reference: reference, p_status: 'FAILED' });
      return res.status(400).json({ error: data?.message || 'Paystack initialize failed' });
    }

    return res.json({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference,
    });
  } catch (error: any) {
    console.error('Paystack init error:', error);
    await supabase.rpc('settle_deposit', { p_reference: reference, p_status: 'FAILED' });
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Callback: user lands here after checkout. We reconcile as a backup to the webhook.
app.get('/api/paystack/callback', async (req: Request, res: Response) => {
  const reference = String(req.query.reference || req.query.trxref || '');
  let status: DepositStatus | null = null;

  if (reference) {
    try {
      status = await reconcile(reference);
    } catch (err) {
      console.error('Callback reconcile error:', err);
    }
  }

  const message =
    status === 'SUCCESS'
      ? 'Payment received. You can close this window and return to the app.'
      : status === 'FAILED'
      ? 'Payment failed. You can close this window and try again.'
      : 'Payment is still processing. You can close this window, your balance will update shortly.';

  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px">
<div><h2>${message}</h2></div></body></html>`);
});

// Webhook: Paystack calls this on charge events
app.post('/api/paystack/webhook', async (req: Request, res: Response) => {
  const signature = String(req.headers['x-paystack-signature'] || '');
  const rawBody: Buffer | undefined = (req as any).rawBody;

  if (!rawBody) return res.sendStatus(400);

  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.warn('Invalid Paystack webhook signature');
    return res.sendStatus(401);
  }

  // Acknowledge immediately, then process
  res.sendStatus(200);

  const { event, data } = req.body;
  console.log('Paystack webhook:', event, data?.reference);

  // charge.success, charge.failed, etc: we never trust the payload, we re-verify
  if (typeof event === 'string' && event.startsWith('charge.') && data?.reference) {
    try {
      await reconcile(data.reference);
    } catch (err) {
      console.error('Webhook processing error:', err);
    }
  }
});

// Sweeper: settles deposits stuck in PENDING (abandoned checkouts, missed webhooks)
async function sweepPendingDeposits() {
  try {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('wallet_transactions')
      .select('reference')
      .eq('type', 'DEPOSIT')
      .eq('status', 'PENDING')
      .like('reference', 'dep_%')
      .lt('created_at', cutoff)
      .limit(50);

    if (error) throw error;

    for (const row of data || []) {
      try {
        await reconcile(row.reference as string);
      } catch (err) {
        console.error(`Sweep error for ${row.reference}:`, err);
      }
    }
  } catch (err) {
    console.error('Sweeper error:', err);
  }
}

setInterval(sweepPendingDeposits, 2 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});