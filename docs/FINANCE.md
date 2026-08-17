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
exists.**

> **M4 verdict: coverage and in-sample uniqueness confirmed; cross-export stability UNVERIFIED, so no
> unique constraint exists and Tier 2 does all the work.** Obtaining the two overlapping exports was
> explicitly descoped rather than allowed to block M4 or M5. The parser captures the identifier so
> verifying later is a comparison, not a rewrite. Full log at the bottom of this document.

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

> **Status: OBSERVED.** Filled in during M4 from two real exports read in
> conversation — a checking export covering 05/13–06/11/2026 and a credit-card
> export covering 04/28–05/27/2026. Superseded the pre-M4 guesses, which came from
> third-party statement-converter pages and were wrong in three places.

### What the plan expected versus what the files contain

| Plan assumed | Reality |
| --- | --- |
| Deposit trends `Date / Description / Amount` | Adds `Running Bal.`, and is preceded by a **five-line preamble with its own three-column header, then a blank line**. Row 1 is not the header. |
| Card is `Posted Date / Reference Number / Payee / Amount` | Also carries `Address`, fixed-width padded with a trailing space, empty on payment rows. |
| "Multiple dates per transaction" | The card export has **one date only**, labelled `Posted Date`. There is no transaction date. |
| Filename indicates the period | The file named for May covered 04/28–05/27. |

### Deposit export

```
Description,,Summary Amt.                  ← summary header, 3 columns
Beginning balance as of 05/13/2026,,"…"
Total credits,,"…"
Total debits,,"…"
Ending balance as of 06/11/2026,,"…"
                                           ← BLANK LINE
Date,Description,Amount,Running Bal.       ← the real header, 4 columns
05/13/2026,Beginning balance as of …,,"…"  ← pseudo-row, EMPTY amount
05/14/2026,"…","-540.25","9,909.75"
```

| Aspect | Observed |
| --- | --- |
| Header position | Line 7. Located by scanning for required columns, never by index. |
| First data row | A `Beginning balance` pseudo-row with an **empty** amount. Skipped — importing it would put a phantom 0.00 transaction on day one of every statement. |
| Amounts | Quoted, comma thousands separators, single signed column. |
| Sign | **Negative = outflow**, the inverse of Burmy's convention. Inverted once, in the normalizer. |
| Quoting | Mixed: some descriptions quoted, some not. Commas appear **inside** quoted description fields. |
| Descriptions | ACH detail as `ORIGINATOR DES:PURPOSE ID:… INDN:… CO ID:… PPD`. `INDN:` is the **account holder's own name** and must never become a merchant key. |
| Row order | Ascending. |
| `Running Bal.` | Unmapped, discarded at parse. Used transiently for validation only. |

**The summary block is a checksum, and it is the strongest correctness signal the
project has.** Verified against the real export to the cent:

```
parsed credits            = stated Total credits
parsed debits             = stated Total debits
beginning + credits − debits = stated Ending balance
every Running Bal.        = previous balance + row amount
```

A dropped row, an inverted sign, or a thousands separator eaten by a bad split all
become loud failures instead of a total that is quietly wrong — on every real
import, forever, not only against fixtures. `assertDepositTotals` and
`assertRunningBalances` enforce it, and the fixture preserves the property because
the totals are recomputed after redaction.

### Card export

| Aspect | Observed |
| --- | --- |
| Header position | Line 1. No preamble, therefore **no summary block and no checksum** — the deposit export's strongest guarantee is unavailable here. |
| Dates | `Posted Date` only. Populates **both** `transaction_date` and `posted_date`, because the column is `NOT NULL` and the monthly grid buckets on it. Inventing an earlier transaction date would be fabricating data. |
| Amounts | Unquoted, **no thousands separator in the sample**. No value reached four figures, so behaviour above 999.99 is an **assumption**; `parseMoney` accepts both forms and fixtures cover each. |
| Sign | Negative = purchase. Inverted, as above. |
| `Address` | `city` left-justified in 14 columns, then the state, then a trailing space. Empty on payment rows. **Discarded at parse** (plan §18 keeps address fragments out of staging), read transiently as an exact location hint for merchant normalization. |
| `Payee` | Truncated to ~22 characters. City and state are appended, sometimes **fused with no separator** (`BAY HARBOURCA`, `Sunset ValleyTX`) and sometimes spaced (`SPRINGFIELD TX`) — in the same file. One payee had its spaces stripped entirely. |
| Row order | **Descending**, the opposite of the deposit export. No stage assumes ordering. |
| Processor prefixes | `TST*`, `SQ *`, `NPO* `, `YSI*`, `PADDLE.NET* `, `OPENAI *`, `ROVER.COM* ` |
| Store numbers | Trailing hashed (`#0366`, `# 2065`, `#801`), trailing bare (5 and 9 digits), and **leading bare** (`078 …`). |

**The spaced-versus-fused city/state rule is unresolved.** Both forms appear in one
file and no reliable rule separates them from the payee text, so the fixtures record
both verbatim and merchant normalization handles both. Where the format supplies an
`Address` column the location is removed exactly; otherwise the conservative
one-token rule applies.

### Confirmation numbers link both legs of a card payment

The single most valuable discovery in the real data. The checking leg carries
`Confirmation# <token>`; the card leg carries `CONF#<token>` — the **same token**,
opposite signs, a day apart. It held for two independent payments.

Plan §24 designed a qualified counterpart match as structural conditions plus a
recognized keyword plus uniqueness, because amount and date alone are
coincidence-prone. A shared confirmation number is far stronger: effectively one
transaction id present on both legs.

**M4 only preserves it.** Extracting and matching is M6's work — doing it in the
parser would put classification inside a stage that must not classify. A test in
`tests/unit/parse-boa.test.ts` asserts the linkage survives, so a future "tidy up
the description" change cannot silently destroy it.

Three corroborating observations, all of which confirm existing design decisions:

- One payment appears in the card export but predates the checking window; another
  appears in checking but postdates the card statement. **Multi-file batching and
  the ±7-day window are both load-bearing, and an unmatched leg is normal rather
  than an error.**
- A third-party card autopay in the checking export has no counterpart leg at all,
  so it correctly stays a review item and must never be auto-excluded.
- The two legs were dated one day apart, which is why the window cannot be zero.

---

## Deduplication — Tier 1 verification log

### Verdict: Tier 2 is the active mechanism. Tier 1 remains unverified.

| Account type | Identifier column | Coverage | Unique in sample | Stable across exports | Verdict | Date |
| --- | --- | --- | --- | --- | --- | --- |
| BoA deposit | *(none provided)* | 0% | n/a | n/a | **No identifier exists.** Tier 2 only. | 2026-08-17 |
| BoA card | `Reference Number` | **100%** (40/40 rows, payments included) | **Yes** (40 distinct) | **UNVERIFIED** | **Candidate only. No unique constraint.** | 2026-08-17 |

**What was measured.** Both properties a single export can answer: coverage and
in-file uniqueness. `observeTierOne()` computes them, and a test asserts the result
against the fixture.

**What was not, and why.** Byte-stability across two exports of the same period is
the property a unique constraint would actually depend on, and it requires two
overlapping exports pulled on different days. Those were not available, and
obtaining them was explicitly descoped rather than blocking M4 or M5.

**Structural observations, recorded but not relied on.** The identifier is 23
digits. Its shape is consistent with a card-network acquirer reference number, and a
three-digit group appears to track the posting date as a day-of-year (`…145…` on
May 25, `…146…` on May 27). Payment rows follow a visibly different pattern from
purchase rows. None of this is evidence of stability — a value can be structured and
still be regenerated per export.

**Consequences, in force now:**

- `source_transaction_id` is **captured** by the parser and stored as advisory
  metadata.
- There is **no unique constraint** on it, and the index stays non-unique.
- **Nothing in `dedupe.ts` reads it.** A test asserts that two rows with different
  reference numbers but identical account, date, amount and description still
  collide on identity — proving Tier 2 is what is actually running.
- `tierOneCandidateStability()` exists and is unused. Verifying later is a
  comparison of two captured sets, not a parser change.

**To close this out later:** obtain two exports of the same card account covering an
overlapping period, pulled on different days; run `tierOneCandidateStability()` over
the two captured identifier sets; record the result here. A unique constraint is
added only if coverage, uniqueness **and** stability all pass, per account type.

---

## Deduplication — Tier 2, the active mechanism

Unchanged from the plan and now implemented as pure functions in `dedupe.ts`.

```
dedupe_key = sha256( v1, account_id, transaction_date, amount_cents,
                     sha256(collapse_ws(upper(trim(original_description)))) )   -- NOT unique

per key:  surplus = staged_count − committed_count
          surplus ≤ 0  → already present → excluded by default, shown, reversible
          surplus > 0  → import exactly `surplus`
```

`identityDescription` is **frozen**: trim, collapse whitespace, uppercase. Nothing
else, ever. Punctuation is identity-bearing here precisely because stripping it is a
`merchantKey` concern — and a test asserts that two descriptions which normalize to
the *same* `merchantKey` still produce *different* dedupe keys. That is the whole
reason the two are separate.

The database query that supplies `committed_count`, and the preview that lets the
owner override the default, are the import pipeline's job in M5. `dedupe.ts`
computes; it does not decide.

## Import pipeline (M5)

One CSV per import, in memory only — never written to disk, never persisted as a
blob. `upload → parse & stage → preview → categorize/include-exclude → commit`. No
generic mapper, no confirmation-number matching, no transfer/card-payment
reconciliation, no bank beyond Bank of America. Those are M6+.

### Account/format compatibility

`detectFormat()` identifies the statement; the owner separately picks which account
it belongs to (Burmy has no other way to know — it never connects to a bank).
`src/server/finance/import/compatibility.ts` checks the two agree — a `boa-card`
export cannot stage against a `checking`/`savings` account, and a `boa-deposit`
export cannot stage against `credit_card` — and refuses with a clear error before
anything is staged. Without this, a card export uploaded against the wrong account
would parse cleanly (nothing about the file says which account it is) and every row
would carry a plausible-looking wrong `account_id`: not rejected, not flagged,
just silently misfiled spending that the dedupe key would never collide with real
history and so would never surface as a duplicate either.

### Tolerant parsing

`parseStatement()` (M4) throws on the first row that fails normalization — a
missing field, an impossible date — which aborts the *entire* file. M5 needs
per-row failures to be visible and reviewable instead, so `parse/index.ts` gained
`parseStatementTolerant()`, additive alongside the original: same format detection,
same FILE-level assertions (the deposit checksum, the running balance, the
all-inflow guard all still abort the whole file — those really do mean the file is
suspect), but row normalization runs in a loop with its own try/catch, collecting
successes as candidates and failures as `{ lineNumber, message }`. `parseStatement()`
itself, and its M4 test suite, are unchanged; the two functions now share their
detection/assertion logic via a private `detectAndParse()` helper rather than
duplicating it.

A failed row stages with every data field null, `parse_error` set to the message,
and `decision` permanently `exclude` — visible in the preview with its error text
next to it, never silently dropped, never includable (there is nothing valid to
write to `finance_transactions`).

### Staging-time reconciliation, and the commit-time re-check

At staging, every dedupe key groups its candidates and reconciles once against
`committed_count` as of that moment (`planStagedDecisions()` in
`import/staging.ts`, wrapping `dedupe.ts`'s `reconcileCounts()`). That default is
what the owner sees and can override per row.

That single check is not enough for correctness under concurrency: two imports
staged around the same time can each see "0 committed" for the same key and each
default their row to Include — correct individually, wrong if both commit.
`commitImport()` therefore re-runs the identical reconciliation a second time,
*inside* the commit transaction, immediately before inserting, against the
now-current committed count. Postgres's default READ COMMITTED isolation would not
catch this on its own (two inserts of new rows never conflict with each other), so
the transaction opens with `pg_advisory_xact_lock`, keyed to the owner, which
serializes commits for that owner — trivial cost with exactly one owner, and it
means the second commit's re-check genuinely sees the first one's result.

The re-check applies only to rows still following the staging-time default. A row
the owner explicitly flipped — `decision_overridden = true` on
`finance_import_rows`, set by `updateRowDecision()` whenever `decision` is passed
explicitly — is honoured unconditionally, never demoted by the re-check. This is
what "explicit review confirmation" (CLAUDE.md invariant 5's third permitted path,
here applied to duplicate handling rather than exclusionary typing) means in
practice: the owner reviewing a row flagged as a duplicate and recognising a
genuine same-day repeat is stronger evidence than a second automatic count, and the
mechanism must not silently overrule it.

A row demoted by the re-check has its persisted `decision` corrected in the same
transaction (so a reload shows the truth) and is reported back to the owner as
`demotedByRaceCount` in the commit summary — the count differing from what the
preview showed is surfaced, not hidden.

### File-hash messaging is status-aware

`finance_import_files.file_sha256` lets `findPriorFileUpload()` recognise an exact
re-upload before parsing even runs. The wording depends on what happened to the
prior import: only `status = 'committed'` is ever described as "already
imported" — a match still `review` (uploaded before, not yet acted on) or
`discarded` (uploaded before, deliberately abandoned) gets its own honest
sentence. Calling either of those "already imported" would be a claim the owner has
no way to verify and that is not true. The warning is informational either way,
never a hard block: Tier 2 row-level reconciliation is what actually guarantees a
re-upload adds nothing, regardless of whether the owner reads the banner.

### Transaction type: sign only, nothing else

M5 assigns exactly `expense` (outflow) or `income` (inflow) by the sign of
`amount_cents` alone (`defaultTransactionType()`), with `type_source = 'default'`.
Never `transfer`, `credit_card_payment` or `investment` — invariant 5 requires
deterministic evidence for those, and M5 has none. There is deliberately no
transaction-type picker in the M5 UI; refining beyond expense/income (refunds,
fees, exclusionary detection) is M6's classifier.

### Category is optional at commit

The owner can leave a row uncategorized and commit anyway. A category picked in
the preview commits with `review_status = 'confirmed'`; a blank one commits with
`category_id = null` and `review_status = 'needs_review'`, for M7's review queue to
pick up. This is what lets the monthly import be fast even when a few rows need
more thought than the moment allows.
