// Fill this in when you're ready to send real money. This is intentionally
// NOT wired into server.js yet — do that once you've tested it against
// PayPal's sandbox and are confident about error handling and idempotency.
//
// Docs: https://developer.paypal.com/docs/payouts/standard/

async function getPayPalAccessToken() {
  const base = process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
  const creds = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error('PayPal auth failed');
  const json = await res.json();
  return json.access_token;
}

async function sendPayPalPayout({ withdrawalId, receiverEmail, amountUsd }) {
  const base = process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
  const accessToken = await getPayPalAccessToken();

  const res = await fetch(`${base}/v1/payments/payouts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender_batch_header: {
        sender_batch_id: withdrawalId, // idempotency: reuse the same id on retry
        email_subject: 'You have a DollarTube payout!'
      },
      items: [{
        recipient_type: 'EMAIL',
        amount: { value: amountUsd.toFixed(2), currency: 'USD' },
        receiver: receiverEmail,
        note: 'DollarTube reward payout',
        sender_item_id: withdrawalId
      }]
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || 'PayPal payout failed');
  return json.batch_header.payout_batch_id;
}

module.exports = { sendPayPalPayout };
