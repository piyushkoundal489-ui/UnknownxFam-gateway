# API reference

Base URL: `https://YOUR-DOMAIN` (the value of `APP_URL`). In the Replit workspace, use the `/gateway-api` prefix; the legacy `/api` routes remain available when they are not claimed by another service. All responses are JSON, except the QR
image endpoint, which is always a real PNG.

**Authentication:** send your **7-digit numeric API key** as `X-API-Key: <key>` (preferred), `Authorization: Bearer
<key>`, or `?key=<key>` (kept for compatibility). A key only works when paired with the exact UPI ID it was issued
for — sending someone else's UPI ID with your key (or vice versa) is always rejected as invalid.

Every response — success or error — follows the same envelope: `Portal_Owner` is always the first key,
`Powered_By` is always the last. There is no `credits` field anywhere in this API.

Rate limits (per caller IP unless noted): 240 req/min general API traffic, 60 req/min order creation per merchant,
300 req/min status/UTR lookups per merchant, 120 req/min pay-page/QR polling, 300 req/min webhook delivery.
Exceeding a limit returns `429`.

> **A 7-digit numeric key has a small guess space (10,000,000 possible values).** This gateway mitigates that with
> strict IP-based rate limiting on failed auth attempts (`api_bad_auth_ip`: 20 failures / 5 min blocks the caller
> IP) and by requiring the UPI ID to match. For a public-facing deployment handling real money, pair this with
> an edge/CDN rate-limiting layer in front of Render and consider this a documented trade-off, not a hidden one.

**Key lifecycle:** all randomly generated keys are exactly seven numeric digits, whether they are personal keys
generated in Settings, personal keys issued by an admin, or admin-managed shared keys. An admin can also issue a
personal key with an explicit custom value and/or a custom expiry (or no expiry) from that user's admin detail
page — see the README's "Admin: roles, account status, audit" section. A key past its expiry is refused with `403`
and `"message": "This API key has expired"`, distinct from an unrecognized key (`401`) or a disabled account
(`403`, different message).

---
## Create order
`GET /gateway-api/{upi-id}/create_order.php?amount={amount}&key={key}` (POST also accepted; form or JSON body; `key` may
instead be sent as `X-API-Key` or `Authorization: Bearer`)

| Param | In | Required | Notes |
|---|---|---|---|
| upi-id | path | yes | URL-encoded UPI ID this merchant registered (e.g. `merchant%40okhdfcbank`) |
| amount | query/body | yes | Rupees, up to 2 decimals, 1–100000 |
| key | header/query | yes | This merchant's 7-digit API key |

**200 response**
```json
{
  "Portal_Owner": "@UnknownNvrDie 👾",
  "success": true,
  "status": "PENDING",
  "payment_received": false,
  "order_id": "ORDER_AB12CD34EF56",
  "payment_id": "PAY_AB12CD34EF56",
  "amount": 499.01,
  "currency": "INR",
  "upi_id": "merchant@okhdfcbank",
  "upi_link": "upi://pay?pa=merchant%40okhdfcbank&pn=Merchant&am=499.01&cu=INR&tn=ORDER_AB12CD34EF56",
  "qr_url": "https://YOUR-DOMAIN/temporary/qr/ORDER_AB12CD34EF56.png",
  "status_url": "https://YOUR-DOMAIN/gateway-api/merchant%40okhdfcbank/key=1234567?id=ORDER_AB12CD34EF56",
  "expires_in": 900,
  "expires_at": "2026-09-22T10:45:00Z",
  "Powered_By": "UnknownxGateway"
}
```
The QR and `upi_link` use the exact UPI ID registered to the selected merchant and the exact `amount` supplied in the
request. Amounts are never changed. If that merchant already has an open order for the same amount, the request
returns HTTP `409` with the existing order ID; complete it or wait for it to expire before creating another.
Other errors use the same envelope shape with `success: false` and a `message`; HTTP `400` bad amount/UPI,
`401` bad key, `409` duplicate open amount, `429` rate limit.

## The QR image
`GET /temporary/qr/{order_id}.png` — **always returns real PNG bytes** (`Content-Type: image/png`), never JSON,
HTML, or a redirect, in every case:
- **200** — the order is still open (`PENDING`/`PROCESSING`): a real, scannable UPI QR encoding the exact
  `upi_link` above (error-correction level H).
- **410** — the order is no longer open (paid, expired, cancelled, …): a plain placeholder image. The active QR
  is never re-served once an order leaves the open state.
- **404** — unknown order id: a plain placeholder image.

## Payment status (by your own order/payment ID)
`GET /gateway-api/payment/status?order_id={id}&key={key}`
Read-only — status can only change via a verified payment, never through this endpoint. Another merchant's order
id looks like `NOT_FOUND`. `id` may also be used in place of `order_id`.

## Check a payment by UTR / transaction ID — no UPI id needed
`GET /gateway-api/check_payment.php?id={UTR or transaction id}&key={key}` (also `/api/check_payment.php`; the key may instead be sent as `X-API-Key` or `Authorization: Bearer`)

Works with **any valid key** — a user's assigned key or a shared/public key — and a payment's **UTR** (12 digits) or **transaction ID** (e.g. `FMPIB6752235382`, or FamApp's longer `FMPU0la100c3-f0fb-79d7-9d08-38c445605e28`). It reads the payments the gateway has already verified from the merchants' payment e-mails. Order and payment IDs are *not* accepted here, and the response never contains `order_id`, `payment_id` or the merchant's balance.
```json
{
  "Portal_Owner": "@UnknownNvrDie 👾",
  "success": true,
  "payment_received": true,
  "status": "RECEIVED",
  "status_display": "Received ✅",
  "details": {
    "searched_utr": "628599957029",
    "successful": "true",
    "message": "You have successfully received ₹12.00",
    "order_id": null,
    "provider": "FamApp",
    "amount": 12,
    "currency": "INR",
    "transaction_id": "FMPIB6778122946",
    "utr": "628599957029",
    "received_from": "Laiba naved",
    "updated_balance": 12,
    "date": "7:12 pm 12-10-2026",
    "payment_time": "2026-10-12T13:42:05Z",
    "verification_source": "GMAIL_FAMAPP",
    "Powered_By": "UnknownxFamGateway 🕊️"
  }
}
```
Not found (HTTP 404):
```json
{
  "Portal_Owner": "@UnknownNvrDie 👾",
  "success": false,
  "payment_received": false,
  "status": "NOT_FOUND",
  "status_display": "Not found ❌",
  "details": {
    "searched_utr": "62599957029",
    "successful": "false",
    "order_id": "62599957029",
    "payment_id": null,
    "message": "Payment not found.",
    "Powered_By": "UnknownxFamGateway 🕊️"
  }
}
```
The emoji appears only in `status_display`. `details.searched_utr` always echoes the UTR / transaction ID you searched for. `details.order_id` is always `null` for a found payment (merchant order ids are never shown here); for NOT_FOUND it echoes the id you sent.
Other non-paid results (failed / expired / cancelled / pending) use the same envelope with the matching `status_display` and `details.successful` of `"false"` / `"pending"`. Unknown references return 404. Missing id/key → 400, wrong key → 401, expired / disabled key → 403 (all in the same `details` shape).

## Result fields on every status response
The older flat responses (`/payment/status`, `verify`) also carry `status_display` (`Payment Received ✅`, `Failed ❌`, `Expired ❌`, `Cancelled ❌`, `Pending ⏳`, `Not found ❌`), `successful` (`true ✅` / `false ❌` / `pending ⏳`), and for paid payments `message` and `date`. `success` (boolean) and `status` keep their old values.

## Check payment by UTR / transaction ID / order ID (per merchant)
`GET /gateway-api/{upi-id}/check_payment.php?key={key}&id={value}`
equivalently: `GET /gateway-api/{upi-id}/key={key}?id={value}`
`{value}` may be the order ID, the payment ID, the UTR, or the bank/provider transaction ID (e.g. FamApp's `FMPIB…`).

**Not an order of yours? It is still looked up.** If `{value}` is a UTR or transaction ID that belongs to none of your orders, the gateway
looks it up in your connected Gmail's payment alerts (first the alerts it has already read, otherwise a live search of the mailbox; only
trusted senders with a passing DKIM check count, and the reference must be that payment's own UTR / transaction ID). When found you get
HTTP 200 with `"status": "RECEIVED"` plus the details (`amount`, `utr`, `transaction_id`, `received_from`, `updated_balance`, `date`, `payment_time`, `provider`,
`order_id` if one is attached, `verification_source: "GMAIL_FAMAPP"`) in the `details` object shown below. Nothing found: 404 `NOT_FOUND`. Needs the merchant's Gmail connected.

**Response of `check_payment.php` / `key=` (this section)** — envelope + `details`; the emoji appears only in `status_display`:
```json
{
  "Portal_Owner": "@UnknownNvrDie 👾",
  "success": true,
  "payment_received": true,
  "status": "RECEIVED",
  "status_display": "Payment Received ✅",
  "details": {
    "searched_utr": "412345678901",
    "successful": "true",
    "message": "You have successfully received ₹499.01 from RAVI KUMAR",
    "order_id": "ORDER_AB12CD34EF56",
    "provider": "FamApp",
    "amount": 499.01,
    "currency": "INR",
    "transaction_id": "T2609221234",
    "utr": "412345678901",
    "received_from": "RAVI KUMAR",
    "updated_balance": 1234.56,
    "date": "4:00 pm 22-09-2026",
    "payment_time": "2026-09-22T10:30:00Z",
    "verification_source": "GMAIL_FAMAPP",
    "Powered_By": "UnknownxFamGateway 🕊️"
  }
}
```
A payment looked up by its **UTR or transaction ID** is `"status": "RECEIVED"` with `"status_display": "Payment Received ✅"` (`order_id` is your order id if the payment settled one of your orders, otherwise `null`). Looking an order up by its **order id / payment id** (for example the `status_url` from create-order) still returns `"status": "PAID"` once it is settled, so existing polling keeps working.
`status` is one of `PENDING | PROCESSING | PAID | RECEIVED | UNSUCCESSFUL | EXPIRED | CANCELLED | MANUAL_REVIEW | NOT_FOUND` (unchanged machine values).
Everything that is not a success has the same envelope (`success: false`, `payment_received: false`) and a short `details`:
```json
{
  "Portal_Owner": "@UnknownNvrDie 👾",
  "success": false,
  "payment_received": false,
  "status": "NOT_FOUND",
  "status_display": "Not found ❌",
  "details": {
    "searched_utr": "62599957029",
    "successful": "false",
    "order_id": "62599957029",
    "payment_id": null,
    "message": "Payment not found.",
    "Powered_By": "UnknownxFamGateway 🕊️"
  }
}
```
`details.successful` is `"true"`, `"false"` or `"pending"`. HTTP codes: 200 found, 404 not found, 400 missing id/key, 401 wrong key, 403 expired/disabled key — errors use the same envelope.
(`/gateway-api/payment/status`, `order_status` and `verify` still return the older flat layout shown above under "Result fields on every status response".)

`MANUAL_REVIEW` means matching evidence was found (sender, DKIM, amount, time window) but something didn't line up
cleanly enough to settle automatically (see "Payment verification" below) — a human needs to look at it. It is
never returned as `PAID` on a guess.

## Public status poll (used by the pay page)
`GET /gateway-api/order_status.php?order_id={id}` — no auth; order ids are unguessable.
`{"state":"PENDING","order_id":"...","paid_at":null,"expires_in":840}`

## Provider webhook
`POST /gateway-api/webhook.php` — authenticated by `X-Timestamp` + `X-Signature: hex(HMAC-SHA256(WEBHOOK_SECRET,
"<timestamp>.<raw body>"))`, timestamp within 5 minutes. Idempotent per `event_id`.
```json
{"event_id":"evt_1","order_id":"ORDER_AB12CD34EF56","amount":"499.01","currency":"INR","status":"PAID",
 "reference":"UTR...","transaction_id":"T2609221234","received_from":"...","purpose":"...","provider":"FamApp","updated_balance":1234.56}
```
`status` accepts `PAID`/`SUCCESS` (alias), `UNSUCCESSFUL`/`FAILED` (alias), or `PROCESSING`/`PENDING`.

## Merchant payment-alert forwarder
`POST /gateway-api/verify.php` — form or JSON: `secret` (your webhook secret, from Settings), `amount`, `order_id`
(recommended), `txn_ref`/`utr` (recommended), plus optional `transaction_id`, `received_from`, `purpose`,
`provider`, `updated_balance`. Matches the amount to your one open order (or the given `order_id`) and settles it;
if more than one open order matches, the order is put into `MANUAL_REVIEW` rather than guessed.

## Payment verification — how PAID is decided
A UPI QR being shown, scanned, or opened is **never** proof of payment. `status` only becomes `PAID` through
`settleOrder()` (`src/payments/core.js`), reached only by: a signature-verified provider webhook, a
secret-authenticated merchant forwarder call, a fully-verified Gmail/FamApp notification (sender allow-list +
Gmail's own DKIM verdict + matching amount + time window + an unambiguous, not-reused UTR/transaction-id/order
reference + a consistent running balance when one is known), or a SUPER_ADMIN manual confirmation with a mandatory
logged reason. Anything that looks like a match but fails one of these checks becomes `MANUAL_REVIEW`, never `PAID`.

---
### Examples — create order

**cURL**
```bash
curl -H "X-API-Key: 1234567" "https://YOUR-DOMAIN/api/merchant%40okhdfcbank/create_order.php?amount=499"
```
**Python**
```python
import requests
r = requests.get("https://YOUR-DOMAIN/api/merchant%40okhdfcbank/create_order.php",
                  params={"amount": 499}, headers={"X-API-Key": "1234567"})
print(r.json())
```
**PHP**
```php
<?php
$ctx = stream_context_create(['http' => ['header' => "X-API-Key: 1234567"]]);
$r = file_get_contents("https://YOUR-DOMAIN/api/merchant%40okhdfcbank/create_order.php?amount=499", false, $ctx);
print_r(json_decode($r, true));
```
**Node.js**
```js
const r = await fetch("https://YOUR-DOMAIN/api/merchant%40okhdfcbank/create_order.php?amount=499", { headers: { "X-API-Key": "1234567" } });
console.log(await r.json());
```
