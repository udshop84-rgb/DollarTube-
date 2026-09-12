# DollarTube backend

Node/Express + SQLite backend for the DollarTube front-end. The core design
rule: **a balance is never a number the client can set directly.** It's always
`SUM(ledger)`, and every ledger row traces back to something the server (or a
trusted third party, via a signed webhook) actually verified.

## Setup

```bash
npm install
cp .env.example .env      # then fill in JWT_SECRET at minimum
npm run initdb             # creates dollartube.db from schema.sql
npm start                  # listens on :4000
```

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/auth/register` | — | create account, returns JWT |
| `POST /api/auth/login` | — | returns JWT |
| `GET /api/wallet` | JWT | current balance |
| `GET /api/wallet/ledger` | JWT | recent transaction history |
| `POST /api/rewards/ad/start` | JWT | issue an ad session token before playing an ad |
| `POST /api/rewards/ad/complete` | JWT* | confirm the ad session, credit the reward |
| `POST /api/rewards/survey/postback` | HMAC signature | provider webhook, credits a survey reward |
| `POST /api/rewards/daily/claim` | JWT | server computes streak + amount, credits it |
| `POST /api/withdraw` | JWT | holds the funds, creates a pending withdrawal |
| `GET /api/withdraw/history` | JWT | list a user's withdrawals |
| `POST /api/admin/withdraw/:id/resolve` | JWT (lock down for real admins) | mark paid/rejected once the payout provider confirms |

\* In production, `/ad/complete` should be called by your ad network's
server-to-server reward callback (AdMob, AppLovin, IronSource all have one),
not by the client. Keeping it JWT-authed from the client is a placeholder so
you can test the flow before that integration exists.

## Three things you need to wire up before this pays real money

1. **Ad network SSV (server-side verification)** — point your mediation
   network's reward callback at `/api/rewards/ad/complete` (or a dedicated
   route using their signature scheme instead of a user JWT).
2. **Survey provider postback** — Pollfish/BitLabs/CPX Research etc. give you
   a webhook secret; set `SURVEY_WEBHOOK_SECRET` to it and configure their
   dashboard to POST completions to `/api/rewards/survey/postback` with a
   `X-Signature` header (HMAC-SHA256 of the body — adjust to match your
   provider's exact scheme, they're not all identical).
3. **A real payout call** — `payout.js` has a working PayPal Payouts stub.
   Wire it into `/api/withdraw` (or a background job that scans `pending`
   withdrawals) once you've tested it against PayPal sandbox, and call
   `/api/admin/withdraw/:id/resolve` with the result.

## The game itself doesn't fund anything

Distance-based coins in the runner game aren't tied to any revenue event —
there's no `game_bonus` credit wired into `server.js` on purpose. Paying real
money per meter run, unconnected to an ad impression or survey, has no
funding source and is how these balances become IOUs the business can't
cover. Two honest options:
- Make in-game coins a **non-withdrawable virtual currency** (cosmetics, extra
  lives, leaderboard points) — no ledger entry, no backend change needed.
- Or fund them for real by showing a rewarded/interstitial ad at run-end and
  crediting through the same `ad_reward` flow above.

## Front-end integration

The current `my_earning.html` writes everything to `localStorage` via the
`Store` object. To connect it here, replace `Store.data.balanceUSD += x` /
`Store.save()` calls with `fetch()` calls to the routes above, store the JWT
from login, and re-render from `GET /api/wallet` instead of local state. Happy
to do that wiring next if useful.
