require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const rateLimit = require('express-rate-limit');

const db = require('./db');
const { signToken, requireAuth } = require('./auth');

const app = express();
app.use(cors());
app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

const MIN_WITHDRAW_USD = 5.0;
const DAILY_REWARDS_USD = [0.05, 0.08, 0.10, 0.15, 0.20, 0.30, 0.50]; // by streak day 0..6
const AD_REWARD_USD = 0.25;
const AD_SESSION_TTL_MS = 5 * 60 * 1000; // token must be redeemed within 5 min
const SURVEY_WEBHOOK_SECRET = process.env.SURVEY_WEBHOOK_SECRET;

// ---------- helpers ----------

function getBalance(userId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount_usd), 0) AS bal FROM ledger WHERE user_id = ? AND status = 'confirmed'`
  ).get(userId);
  return Number(row.bal.toFixed(4));
}

function credit(userId, type, amountUsd, refTable, refId) {
  db.prepare(
    `INSERT INTO ledger (id, user_id, type, amount_usd, ref_table, ref_id) VALUES (?,?,?,?,?,?)`
  ).run(uuid(), userId, type, amountUsd, refTable || null, refId || null);
}

// ---------- auth ----------

app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Email and an 8+ char password are required' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const id = uuid();
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?,?,?,?)')
    .run(id, email, hash, name || 'Runner');

  const user = { id, email };
  res.json({ token: signToken(user), user: { id, email, name: name || 'Runner' } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email || '');
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  res.json({ token: signToken(user), user: { id: user.id, email: user.email, name: user.name } });
});

// ---------- wallet ----------

app.get('/api/wallet', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, name, currency FROM users WHERE id = ?').get(req.userId);
  res.json({ user, balanceUsd: getBalance(req.userId), minWithdrawUsd: MIN_WITHDRAW_USD });
});

app.get('/api/wallet/ledger', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT type, amount_usd, status, created_at FROM ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
  ).all(req.userId);
  res.json({ ledger: rows });
});

// ---------- ad rewards ----------
// Flow: client asks to start an ad -> server issues a session + expiry.
// Client shows the ad via the real ad SDK. On the SDK's server-side reward
// callback (or here, a manual /complete call while you wire that up), the
// server checks the session is still valid and unconfirmed, THEN credits.
// A client can never credit itself directly.

app.post('/api/rewards/ad/start', requireAuth, (req, res) => {
  const id = uuid();
  const expiresAt = new Date(Date.now() + AD_SESSION_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO ad_sessions (id, user_id, amount_usd, expires_at) VALUES (?,?,?,?)`
  ).run(id, req.userId, AD_REWARD_USD, expiresAt);
  res.json({ sessionId: id, rewardUsd: AD_REWARD_USD, expiresAt });
});

// In production this endpoint is called by your ad network's server-to-server
// reward postback (AdMob/IronSource/AppLovin all support this), not directly
// by the client — swap the auth here for the network's verification scheme
// (shared secret / signature) instead of a user JWT.
app.post('/api/rewards/ad/complete', requireAuth, (req, res) => {
  const { sessionId } = req.body || {};
  const session = db.prepare(
    `SELECT * FROM ad_sessions WHERE id = ? AND user_id = ?`
  ).get(sessionId || '', req.userId);

  if (!session) return res.status(404).json({ error: 'Unknown ad session' });
  if (session.status !== 'pending') return res.status(409).json({ error: 'Session already used' });
  if (new Date(session.expires_at) < new Date()) {
    db.prepare(`UPDATE ad_sessions SET status = 'expired' WHERE id = ?`).run(session.id);
    return res.status(410).json({ error: 'Ad session expired' });
  }

  db.prepare(`UPDATE ad_sessions SET status = 'confirmed' WHERE id = ?`).run(session.id);
  credit(req.userId, 'ad_reward', session.amount_usd, 'ad_sessions', session.id);
  res.json({ balanceUsd: getBalance(req.userId), credited: session.amount_usd });
});

// ---------- survey rewards ----------
// This is a webhook a survey provider (Pollfish/BitLabs/CPX Research etc.)
// calls when a user completes a survey — not something the client calls.
// Verify with the shared secret / signature scheme your provider gives you;
// this sample uses a simple HMAC-SHA256 of the raw body as an example.

app.post('/api/rewards/survey/postback', express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}), (req, res) => {
  const signature = req.headers['x-signature'];
  if (!SURVEY_WEBHOOK_SECRET || !signature) {
    return res.status(401).json({ error: 'Missing webhook signature configuration' });
  }
  const expected = crypto.createHmac('sha256', SURVEY_WEBHOOK_SECRET).update(req.rawBody).digest('hex');
  if (signature !== expected) return res.status(401).json({ error: 'Bad signature' });

  const { userId, provider, externalId, amountUsd } = req.body || {};
  if (!userId || !provider || !externalId || !(amountUsd > 0)) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Unknown user' });

  try {
    const id = uuid();
    db.prepare(
      `INSERT INTO survey_completions (id, user_id, provider, external_id, amount_usd, raw_payload)
       VALUES (?,?,?,?,?,?)`
    ).run(id, userId, provider, externalId, amountUsd, JSON.stringify(req.body));
    credit(userId, 'survey_reward', amountUsd, 'survey_completions', id);
    res.json({ ok: true });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(200).json({ ok: true, duplicate: true }); // already credited
    throw e;
  }
});

// ---------- daily bonus ----------
// Streak and eligibility are computed server-side from stored dates only —
// the client just asks "can I claim?", it can't say how much.

app.post('/api/rewards/daily/claim', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const today = new Date().toISOString().slice(0, 10);
  if (user.last_daily_claim === today) {
    return res.status(409).json({ error: 'Already claimed today' });
  }
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const newStreak = user.last_daily_claim === yesterday ? (user.daily_streak + 1) % 7 : 0;
  const reward = DAILY_REWARDS_USD[newStreak];

  db.prepare('UPDATE users SET last_daily_claim = ?, daily_streak = ? WHERE id = ?')
    .run(today, newStreak, req.userId);
  credit(req.userId, 'daily_bonus', reward, 'users', req.userId);
  res.json({ credited: reward, streak: newStreak, balanceUsd: getBalance(req.userId) });
});

// ---------- withdrawals ----------

app.post('/api/withdraw', requireAuth, (req, res) => {
  const { amountUsd, method, account } = req.body || {};
  const validMethods = ['paypal', 'bank', 'upi', 'wise', 'payoneer'];
  if (!validMethods.includes(method) || !account || !(amountUsd >= MIN_WITHDRAW_USD)) {
    return res.status(400).json({ error: `Amount must be >= $${MIN_WITHDRAW_USD}, method/account required` });
  }
  const balance = getBalance(req.userId);
  if (amountUsd > balance) return res.status(400).json({ error: 'Insufficient balance' });

  const id = uuid();
  const insertWithdrawal = db.transaction(() => {
    db.prepare(
      `INSERT INTO withdrawals (id, user_id, amount_usd, method, account) VALUES (?,?,?,?,?)`
    ).run(id, req.userId, amountUsd, method, account);
    // Hold the funds immediately so the same balance can't be withdrawn twice.
    credit(req.userId, 'withdrawal_hold', -amountUsd, 'withdrawals', id);
  });
  insertWithdrawal();

  // TODO: call your real payout provider here (e.g. PayPal Payouts API) and
  // update status based on the result — see payout.js for a stub to fill in.
  res.json({ withdrawalId: id, status: 'pending', balanceUsd: getBalance(req.userId) });
});

app.get('/api/withdraw/history', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT id, amount_usd, method, account, status, created_at FROM withdrawals
     WHERE user_id = ? ORDER BY created_at DESC`
  ).all(req.userId);
  res.json({ withdrawals: rows });
});

// Admin/ops endpoint to mark a withdrawal paid or rejected once the real payout
// provider confirms it. Lock this behind real admin auth before deploying.
app.post('/api/admin/withdraw/:id/resolve', requireAuth, (req, res) => {
  const { status, providerRef } = req.body || {};
  if (!['paid', 'rejected', 'processing'].includes(status)) {
    return res.status(400).json({ error: 'status must be processing, paid, or rejected' });
  }
  const wd = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!wd) return res.status(404).json({ error: 'Not found' });

  const resolve = db.transaction(() => {
    db.prepare(`UPDATE withdrawals SET status = ?, provider_ref = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, providerRef || null, wd.id);
    if (status === 'rejected') {
      credit(wd.user_id, 'withdrawal_refund', wd.amount_usd, 'withdrawals', wd.id);
    }
  });
  resolve();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`DollarTube backend listening on :${PORT}`));
