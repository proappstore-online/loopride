# ADR 0001: Fare collection, payouts and receipts

Status: **accepted for the ledger and receipts; payment collection and payouts are deferred pending a PAS policy decision (see "Needs an owner decision")**
Issue: #9. Depends on #6 (quotes) and #7 (trip lifecycle).

## Context

RideShare prices a trip with a server-side quote (#6) and ends it through a
server-authoritative lifecycle (#7), so the amount owed for every trip is already
determined by data in the PAS database. What is missing is a record of that amount
that cannot drift, a receipt, and a plan for moving money.

Constraints from the platform (https://proappstore.online/skills.md):

- **Rule 4: "No in-app payments. Monetization is through the platform subscription
  only. Don't gate features behind separate payments."** A rideshare that charges
  riders and pays drivers is, read literally, an in-app payment.
- Third-party secrets must stay server-side (`app.proxy.fetch`, `pas integrate stripe`);
  nothing sensitive reaches the browser.
- Privacy: no tracking, no third-party scripts, and deleting an account deletes its data.
- App SQL actions are single-statement, caller-scoped queries. They cannot call a
  payment provider or verify a webhook, so any real money movement needs a
  server-side component that this repository does not have.

## Decisions

### 1. What is built now: an immutable ledger, not a payment flow

The app records what each trip cost and issues receipts. It does **not** charge
anyone. Receipts and the driver earnings view say so in plain words.

- `fare_statements`: exactly one row per finished trip, written inside the same
  transaction that ends the trip (completion, rider or driver cancellation, either
  no-show, ops cancellation). Nothing in the app edits or deletes it. It snapshots
  the accepted quote, its components, the amount, tax, platform fee, the driver's
  payout accrual, the policy version in force, and the pickup/drop-off labels.
- Amount rules: a completed trip costs exactly the **accepted quote** (a price shown
  before the request is a price, never raised afterwards); a cancelled trip costs the
  lifecycle fee recorded at that moment (#7); free cancellations and driver faults
  produce a zero-amount statement so every trip has one.
- `fare_adjustments`: append-only corrections. Only `credit` is used today; `refund`
  is reserved for when a captured payment exists. Credits are ops-only, need a reason
  and a note, take a caller-supplied idempotency key so a retry cannot double-credit,
  and their total can never exceed the statement amount (a fare cannot go negative,
  and cannot be increased). A dispute fee waiver (#7) is recorded as a credit, so the
  statement keeps the original number.
- Receipts are a read of statement plus credits; they never change after the trip.

### 2. No payment credentials or card data in the browser

Enforced by design and by test (`web/src/compliance.test.ts`, and a schema scan in
`domainSchema.test.ts`): no payment SDK, no card/bank/credential field or parameter
name in the bundle, manifest or database, and no non-platform script. When collection
is added it must use a **provider-hosted page** (redirect or hosted checkout), so the
browser only ever receives a URL and a result status. Provider secret keys live only in
the server-side integration; webhooks are verified by signature server-side.

### 3. Marketplace payments (deferred)

Preferred model once permitted: the platform is the merchant of record, riders pay by
provider-hosted checkout, and drivers are paid through the provider's connected-account
product (the provider performs driver identity checks, so the app never stores bank
details). Alternatives considered:

| Option | Verdict |
|---|---|
| Pay the driver directly (cash/offline), app only issues statements | Works under Rule 4 today; this is what the ledger already supports. |
| Provider-hosted checkout + connected-account payouts, platform as merchant of record | Preferred for a real marketplace; needs a PAS exception and a server-side worker. |
| Driver as merchant of record per trip | Heavier driver onboarding and tax burden; rejected. |
| Card entry in the app | Rejected: card data in the browser. |

### 4. Taxes

Statements carry `tax_rate_bp`, `tax_cents` (tax-inclusive: tax is the part of the
amount that is tax) and `policy_version`, so a rate change never rewrites history.
Policy `v0-unconfigured` uses 0%. Ride-hailing taxes and levies, whether fares are tax
inclusive, and who remits are jurisdiction-specific and need an accountant; the code
deliberately does not guess a rate.

### 5. Refunds

Money is returned only through ledger rows. Today that is a `credit` (reduces what is
owed; no money has moved). When payments exist, a `refund` row must be created in the
same transaction as the provider refund request, may not exceed captured minus already
refunded, must carry an idempotency key, and is reconciled against the provider's
record. `ops_reconcile` already flags any refund recorded without a payment
(`refunds_without_payment`).

### 6. Driver payouts

Each statement accrues `driver_payout_cents = amount - tax - platform fee` (commission
policy `v0` is 0%, unconfigured). Drivers see their accruals (`list_my_earnings`);
nothing is paid out. Real payouts need the connected-account integration in section 3.
Credits are borne by the platform (the accrual is unchanged); clawing back from a driver
at fault is a future policy. No bank details are stored in the app database.

### 7. PAS subscription constraints

The platform subscription is the only monetization PAS permits and is independent of
this work. No RideShare feature is or will be gated behind a fare payment. Whether
charging riders at all is allowed under Rule 4 is the open question below, not
something this ADR decides on PAS's behalf.

### 8. Reconciliation

`ops_reconcile` (ops role) returns one row per inconsistency and an empty result means
all money records tie back to trip data: `missing_statement`, `fare_not_quote`,
`quote_changed`, `components_mismatch`, `fee_not_lifecycle`, `credits_exceed_final`,
`refunds_without_payment`, `payout_mismatch`, `adjustment_without_statement`.

### 9. Retention and deletion

Deleting an account deletes the rider's statements and credits with the rest of their
data, consistent with the PAS privacy rule. If a jurisdiction requires keeping tax
records, that obligation falls on the payment provider's or accountant's records, which
do not exist yet. Revisit before collection is enabled.

## Sandbox and failure-path tests

Implemented (all run in CI, against real SQLite executing the committed `migrations.json`
and `mcp.json`, in `web/src/lib/domainSchema.test.ts`, plus `web/src/compliance.test.ts`):

| Path | Test |
|---|---|
| Statement per ending (completion, grace/late/arrived cancel, driver cancel, rider and driver no-show, ops cancel) | "finalizes a statement when ..." |
| Quote components snapshotted and re-added | "snapshots the quote components" |
| Refused or repeated transitions create no statement and never two | "refused and repeated calls ..." |
| Statement unchanged when the quote or ride is edited later; drift detected | "never changes after the fact" |
| Credit over the amount, across several credits, zero/negative, bad reason, blank note/key, unknown trip | "can never exceed ...", "rejects invalid input" |
| Retry with the same key does not double-credit | "is idempotent on the request key" |
| Ops cannot credit trips they rode or drove; role gate declared | "is ops-only in the manifest ..." |
| Dispute waiver becomes a credit and reconciles; rejected dispute does nothing | "a dispute fee waiver ..." |
| Reconciliation clean on normal flows; each corruption detected | "reconciliation" group |
| Nothing edits/deletes the ledger; only trip-ending actions create statements | "immutability and privacy" group |
| No card/credential/SDK/script in bundle, manifest or schema | "payment compliance" group |

To be added with the provider integration (test mode only, never live keys in CI):
declined card, authentication required, provider timeout then retry (idempotency key
reused), duplicate webhook, out-of-order webhooks, webhook with a bad signature,
amount mismatch between statement and capture, partial capture, refund larger than
captured, refund provider failure, payout to an unverified driver, payout failure and
retry, and a reconciliation run against the provider's balance report.

## Needs an owner decision (not decided here)

1. **Is charging riders through the app allowed under PAS Rule 4?** If not, the product
   is statements-only with payment between rider and driver. If a PAS exception is
   possible, the integration in section 3 can be built.
2. Commission rate, tax rules and who is merchant of record (sections 4 and 6).
3. Legal retention of financial records versus account deletion (section 9).
4. Who bears credits issued for driver-caused problems (section 6).
