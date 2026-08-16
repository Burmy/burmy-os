# Finance Domain Reference

The rules that make the numbers correct. When implementation and this document disagree, one of them
is a bug — resolve it, do not paper over it.

---

## The problem being solved

The owner maintained a manual Excel sheet: **rows are spending categories, columns are months**, each
cell hand-summed with a hand-typed comment listing the purchases behind it. Producing it meant reading
every transaction, categorizing it mentally, adding amounts by hand, and typing the total into a cell.

Burmy automates everything after "I downloaded a CSV". The grid maintains itself, and every cell drills
down to the transactions behind it.

**Governing invariant:** transactions are the only source of truth. Every number is derived by SQL at
read time. No total is ever stored. No LLM ever computes one.

---

## Money

**Signed `BIGINT` of minor units (cents). Positive = outflow.**

Why not `NUMERIC`: the `pg` driver returns `NUMERIC` as a **string** to preserve precision. Every
aggregate would need parsing at the boundary, and the obvious `parseFloat` reintroduces exactly the
floating-point bug we are avoiding. The type that looks safest introduces the failure mode.

Why `BIGINT` is safe in JavaScript: cents fit `Number.MAX_SAFE_INTEGER` up to roughly $90 trillion.

**The sign convention falls out of a confirmed requirement — reimbursements reduce their category:**

```
Food — August
  Velvet Taco        +6000
  Zelle from Alex    -3000     ← reimbursement, SAME category
  H-E-B              +5914
  ──────────────────────────
  SUM(amount_cents) = 8914  →  $89.14      plain SUM, no special cases
```

A `direction` column is **deliberately absent** from `finance_transactions` — it is
`sign(amount_cents)`, and storing it separately invites the two to disagree. `detected_direction`
exists on staging only, where the adapter records the convention it observed so the normalizer can
**assert** it rather than assume it.

All arithmetic lives in `src/server/finance/money.ts` behind a branded `Cents` type. Nothing else does
money math. Splits use **largest-remainder allocation** so children always sum to the parent exactly.

---

## Transaction types

| Type | In the grid? | In Expenses? | In Total Outflow? | Notes |
| --- | --- | --- | --- | --- |
| `expense` | Yes (Spending) | Yes | Yes | Ordinary spending |
| `refund` | Yes (Spending) | Yes, net | Yes, net | Negative amount, same category as the purchase |
| `fee` | Yes (Spending) | Yes | Yes | Interest, service charges |
| `adjustment` | Yes (Spending) | Yes | Yes | Manual correction |
| `investment` | Yes (Spending) | **No** | **Yes** | Appears as e.g. a `Stocks` row |
| `income` | Yes (**Income section**) | No | No | Sign flipped for display only |
| `transfer` | **No** | No | No | Between the owner's own accounts |
| `credit_card_payment` | **No** | No | No | Checking → credit card |

### Credit card payments must not double-count

```
Credit card statement          Checking statement
  Starbucks    $20               CHASE CARD PAYMENT  $200
  Amazon      $100
  Shell        $80
  PAYMENT THANK YOU  -$200

Purchases            → expense              → counted   = $200
Card-side payment    → credit_card_payment  → excluded
Checking-side payment→ credit_card_payment  → excluded
                                              ─────────────
                                              TOTAL  $200      ✓ not $400, not $0
```

Both payment legs are excluded everywhere. Where both are present in a batch they are linked via
`counterpart_transaction_id`.

### Investments

```
Expenses          $4,183
Investments         $800      ← the Stocks row still appears in the grid
──────────────────────────
Total Outflow     $4,983
```

A `Stocks` category with `kind='investment'` gives a grid row *and* correct subtotals.

### Refunds are not income

A refund carries the **same category** as the purchase and nets the category down. Explicit
refund→purchase linking is V1.1; the arithmetic is already correct without it.

---

## Categories

Flat, owner-defined, **merchant-shaped names allowed**. `Planet Fitness` and `Amazon` are ordinary
categories that happen to carry a merchant rule.

`merchant` remains a **separate field** on the transaction and is never conflated with `category`.
A transaction can have `merchant = "PLANET FIT 4815"` and `category = "Planet Fitness"` — the display
name and the classification are different things.

`kind` ∈ `spending | income | investment` drives grid sectioning and subtotals.
`parent_id` exists in the schema for future rollups but the V1 UI stays flat.

Categories are **archived, never deleted** — history must stay intact.

---

## Deduplication

### Two keys, deliberately separate

| | `dedupe_key` | `merchant_key` |
| --- | --- | --- |
| Purpose | **Identity only** | Categorization matching + display |
| Input | Raw `original_description` | Aggressively normalized merchant |
| Normalization | **Frozen**: trim, uppercase, collapse whitespace. Nothing else, ever. | Evolving |
| Lifecycle | Computed once at import, persisted, never recomputed in place | Recomputable anytime |
| Versioned | Yes (`dedupe_key_version`) | No |

**Why:** merchant normalization is *meant* to evolve — every new strip rule improves categorization.
If identity depended on it, adding one rule would change the key for every future import and silently
stop matching against years of committed transactions, quietly reintroducing duplicates.

If the algorithm must ever change, `dedupe_key_version` bumps and a migration recomputes **every** row
in one pass. Mixed-version comparison is never permitted. `original_description` is retained precisely
to make that possible.

### Tier 1 — source transaction id (only once proven)

A column named "Reference Number" is **not** evidence that it is a stable, unique transaction
identifier. Trusting it on the strength of its name — and enshrining that in a unique constraint —
would reject legitimate transactions or silently merge distinct ones.

Gated on Milestone 4 verification, per account type:

1. **Stability** — export the same range twice on different days; identifiers must be byte-identical.
2. **Uniqueness** — no identifier appears on two genuinely different transactions.
3. **Coverage** — enough rows actually carry one.

**Until all three pass, `source_transaction_id` is advisory metadata only and no unique constraint
exists.** Findings are recorded in the log at the bottom of this document.

### Tier 2 — count reconciliation (the default)

```
dedupe_key = hash(account_id, transaction_date, amount_cents,
                  sha256(collapse_ws(upper(trim(original_description)))))   -- NOT unique

per dedupe_key:  surplus = staged_count − committed_count
                 surplus ≤ 0  → already present → excluded by default, shown, reversible
                 surplus > 0  → import exactly `surplus`
```

Two genuine $5 coffees on the same day yield `staged_count = 2`; if one is committed, one imports. No
positional index, nothing to corrupt, naturally idempotent.

### Tier 3 — near matches

Same account, same amount, date ±3 days, similar merchant → **flagged, requires a decision. Never
auto-excluded.**

Plus a file-level pre-check: an already-committed `file_sha256` warns *before* parsing.

**Nothing is ever silently destroyed.** Every exclusion is visible and reversible in the preview.

---

## Categorization

```
1. USER RULE          → 100    always wins
2. MERCHANT MEMORY    →  95    exact merchant_key previously confirmed
3. HISTORY            →  85    ≥3 prior confirmed, same merchant, unanimous
4. SOURCE CATEGORY    →  60    the bank's own category, via editable mapping
5. HEURISTICS         →  70
6. AI (V1.1, off)     →  ≤50   NEVER overrides 1–5
7. NEEDS REVIEW
```

Below threshold (default 70) → Needs Review regardless of source. `categorization_source` and
`categorization_confidence` are stored so the review UI can explain *why*, and a bad rule can be found
later.

### Exclusionary types are a separate, stricter track

A wrong **category** moves money between two visible rows — obvious in the grid. A wrong
**exclusionary type** (`transfer`, `credit_card_payment`, `investment`) removes money from spending
entirely, where it is invisible and silently understates every total.

Those three are **never assigned by graded heuristic.** They require one of:

1. an explicit user rule naming the type, **or**
2. a **qualified counterpart match**, **or**
3. explicit confirmation in the review queue.

**A qualified counterpart match requires all of:**

*Structural (necessary, never sufficient):* equal absolute amount · opposite sign · both accounts
owned · dates within ±7 days · **account-type compatibility** (`credit_card_payment` needs exactly one
card and one deposit account; `transfer` needs two non-card accounts; `investment` needs a brokerage
leg).

*Plus a semantic signal:* a recognized keyword on either leg (`PAYMENT`, `TRANSFER`, `XFER`,
`ONLINE BANKING TRANSFER`, `AUTOPAY`, `EPAY`, `PMT`), **or** the counterpart account's name fragment
or last-four appearing in the other description.

*Plus uniqueness:* **exactly one** candidate. Two or more → review item, never a guess.

Matching runs against **both the current batch and committed history** (±7 days) — the two legs may
arrive in different months.

> A $200 rent payment and a $200 card payment on the same day satisfy amount, date and direction and
> have nothing to do with each other. Auto-pairing on that evidence would silently delete $200 of real
> spending. The cost of asking is one review card; the cost of guessing wrong is a permanently
> understated year that nobody notices.

### Merchant normalization

Table-driven and pure. Strips processor prefixes (`TST*`, `SQ *`, `SP `), trailing store numbers,
city/state, reference and phone numbers; uppercases; collapses whitespace.

Emits `normalized_merchant` (readable — `VIA 313`) and `merchant_key` (aggressive, for matching).
Every rule is a test case.

### Learning

Changing a suggested category offers *"Always categorize merchants matching VIA 313 as Food?"*.
Accepting writes `finance_merchant_memory`. Memory is **learned and per-merchant**; rules are
**explicit and user-authored** — they are different things and live in different tables.

Month 1 might need 20 decisions; month 6 should need 2. **That convergence is the product**, and it is
measured rather than assumed: every merchant confirmed in month 1 must require zero review in month 2.

---

## The monthly grid

A **view**, never stored. Also the landing route (`/finance/monthly`).

One query feeds both sections; the split happens downstream on `category.kind`.

```sql
WHERE t.owner_id = $1
  AND t.transaction_date >= $2 AND t.transaction_date < $3
  AND t.transaction_type IN (
        'expense','refund','fee','adjustment',   -- Spending  (kind=spending)
        'investment',                            -- Spending  (kind=investment)
        'income'                                 -- Income    (kind=income)
      )
  -- 'transfer' and 'credit_card_payment' absent BY DESIGN.
```

**This single `IN` clause is the entire double-counting guarantee.** It is covered by tests.

```
                         JAN        FEB        MAR
SPENDING
  Mortgage             $2,019     $2,019     $2,019
  Gas                    $217        $71       $194
  Food                   $149       $214       $298
  ───────────────────────────────────────────────────
  Expenses             $5,798     $3,095     $3,683
  Stocks (investment)    $800       $800       $800
  ───────────────────────────────────────────────────
  Total Outflow        $6,598     $3,895     $4,483

INCOME                                                ← collapsible
  Paycheck             $6,400     $6,400     $6,400
  ───────────────────────────────────────────────────
  Total Income         $6,412     $6,411     $6,413
  ═══════════════════════════════════════════════════
  Net                    -$186    +$2,516    +$1,930
```

- **Income sign is flipped for display only.** Stored income stays negative; the flip is in the view
  layer.
- `Expenses` = `kind='spending'`. `Total Outflow` = `Expenses` + `Investments`.
- `Net` = `Total Income` − `Total Outflow` — the only row mixing sections.
- Income cells drill down identically.
- Collapsing the Income section hides `Net` and leaves spending totals unchanged.

**Cell drill-down replaces Excel comments** — a side panel listing the exact transactions, editable in
place, always current rather than hand-maintained.

---

## Reconciliation

The owner's Excel sheets are **hand-verified ground truth** for what each category×month total should
be. They import into `finance_expected_totals` and are compared against computed totals.

```
RECONCILIATION — 2025
Category      Excel       Burmy        Delta
Mortgage     $2,019      $2,019            —
Food           $149        $161      +$12.14   → 1 transaction categorized differently
Travel       $2,622      $2,180     -$442.00   → 2 transactions missing from import
```

This validates the importer, duplicate detection, categorization, classification and money arithmetic
against **years of human-verified data**. It is the strongest correctness signal this project has, and
it exists only because the owner already did the work by hand.

**An unexplained non-zero delta is a bug, not rounding.**

---

## Balances

Savings and brokerage balances are **manual monthly snapshots** — point-in-time state, unlike
everything else in the model, which is flow.

**Never derived from transfer flows.** Once interest or market movement is involved, a derived balance
drifts from reality permanently and silently.

---

## Bank of America adapter findings

> **Status: not yet verified.** BoA's exact column layout could not be confirmed from an authoritative
> primary source — search results were dominated by third-party statement-converter marketing pages.
> **Milestone 4 begins by reading one real redacted export** and this section is filled in from
> observed reality, not from documentation.

What is established well enough to design against:

| Aspect | Finding | Implication |
| --- | --- | --- |
| Column layout | Varies by product. Personal checking trends `Date / Description / Amount`; other products use `Posted Date / Reference Number / Payee / Amount`. | Two adapters (deposit-style, card-style) + generic fallback, selected by **header signature**, never filename |
| Amount sign | Single signed column in some exports, **separate Debit/Credit columns in others** | Normalizer accepts both, emits one signed `amount_cents`. Convention **asserted**, never assumed |
| Dates | Multiple dates per transaction; some formats omit the year | Store `transaction_date` and nullable `posted_date`. **Reject rather than guess** when a year is absent |
| Descriptions | Merchant name with reference numbers / city / state appended | Merchant normalization is a real component, not a `trim()` |
| History window | ~12–18 months available online | Older history exists **only** in the owner's local archive — which is why it is backed up first |

### Verification log

*To be completed in Milestone 4.*

| Account type | Identifier column | Stable? | Unique? | Coverage | Verdict | Date |
| --- | --- | --- | --- | --- | --- | --- |
| BoA deposit | — | — | — | — | pending | — |
| BoA card | — | — | — | — | pending | — |
