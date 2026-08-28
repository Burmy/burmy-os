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

> **Status: this specific Excel-diff design remains UNBUILT, by owner decision at M9.** `finance_expected_totals`
> (below) still exists, still unused. M9 shipped a lighter alternative instead — see "Transactions
> ledger & export (M9)" further down — on the reasoning that M4's checksum validation, M5's Tier 2
> dedupe reconciliation, and M8's aggregate/drill-down equality proof already substantiate most of what
> this feature would exist to prove. Revisit this design if a concrete need for the full category×month
> delta view shows up later; the schema is ready for it.

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
| `Address` | `city` left-justified in 14 columns, then the state, then a trailing space. Empty on payment rows. **Discarded at parse** (never persisted to staging), read transiently as an exact location hint for merchant normalization. |
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

### The import sheet lists what has already been imported

The upload panel showed only STAGED imports, under "Resume". Finished ones appeared nowhere, so "did I
already do August's card statement?" could only be answered by leaving the panel and going to look at
the transactions — and two BoA exports downloaded a month apart have near-identical filenames.

`listCommittedImports` (`db/finance/imports.ts`) now feeds an "Already imported" list, newest first,
showing each file's name and its **date range**. The range rather than the row count, because a row
count does not distinguish two statements and a date range always does.

Nothing new is retained to make this possible: `finance_import_files.original_filename` has always been
recorded, and a filename is not statement content — this does not touch CLAUDE.md's rule that raw
uploads are deleted immediately after parsing.

---

## Categorization & classification (M6)

Two mechanisms, both narrow and deterministic. Investment auto-classification
(account-type based) was proposed and then explicitly deferred by owner
decision: it is currently unreachable (no adapter targets `brokerage`
accounts) and "every transaction on a brokerage account is an investment" was
judged not certain to stay semantically correct. `finance_rules` stays empty —
no rule-builder UI. No confidence scoring — `confidence` columns stay null,
match/no-match is binary.

### Merchant memory — recurring mappings from confirmed history

`finance_merchant_memory` (built in M1, unused until now): unique on
`(owner_id, merchant_key)`. At staging, every candidate's `merchant_key` is
looked up in bulk (`getMerchantMemoryForKeys`); a hit pre-fills
`suggested_category_id` with `categorization_source = 'merchant_memory'`, so
the owner sees most rows already categorized in the M5 preview. At commit,
whatever category ends up on a row — accepted suggestion or owner override —
is upserted back (`ON CONFLICT DO UPDATE`, incrementing `confirmed_count`).
**The owner's current choice always wins**: overriding a suggestion updates
the memory to the new category, not the old one. This is the whole mechanism
behind "Capital One Auto → Car Payments", "Planet Fitness → Gym", and "known
payroll → Income" — none of them needed bespoke logic. Payroll in particular
needs nothing extra: M5 already types inflows `income` by sign; memory only
ever supplies the *category*.

`review_status` follows directly: `needs_review` with no category,
`confirmed` when `categorization_source = 'manual'` (the owner picked it),
`auto` otherwise (memory supplied it and nothing overrode that) —
`reviewStatusFor()` in `import/staging.ts`.

### Counterpart matching — transfers and credit-card payments, one mechanism

M4 found that BoA stamps both legs of a transfer or card payment with the same
bank-assigned token (`Confirmation# X` on checking, `CONF#X` on the card),
opposite signs, equal magnitude, days apart. That token is what makes this
safe to automate under invariant 5: without it, "is this a card payment" is a
description-keyword guess; with it, it is a deterministic cross-reference
between two real transactions the bank itself linked — not a fuzzy or scored
match, a single exact lookup.

`src/server/finance/classify/counterpart.ts` (pure):

```
extractConfirmationToken(description) -> token | null     -- CONF#/Confirmation#, case-insensitive
dateWindow(date, days) -> { start, end }                   -- ±N days, UTC epoch math
findQualifyingCounterpart(token, amountCents, thisAccountType, candidates)
  -> { id, transactionType: 'transfer' | 'credit_card_payment' } | null
```

A candidate qualifies only if ALL of: same owner (enforced by the SQL that
supplies the pool), same token (exact — the SQL pre-filter is a coarse `ILIKE`
substring match, re-checked exactly here to rule out one token merely
containing another), `amount_cents` the EXACT negation of this transaction's
(one comparison capturing both opposite sign and equal magnitude), a
different account, within **±7 days**, and `type_source` still `'default'` —
filtered in the SQL itself, so an ineligible row is never even selectable, not
just skipped when found. **Zero or more than one qualifying candidate is
`null` — no match, not a best guess.** The type label depends on EITHER side
being a `credit_card` account (checked both ways, so importing the card
statement before or after the checking statement resolves identically);
otherwise `transfer`.

`commitImport()` runs this once per staged row carrying a token, against
COMMITTED history (not just the current batch — a batch is single-account by
construction, so the two legs of a pair can never both be in one import
anyway). A match sets both legs' `transaction_type`, `type_source =
'counterpart_match'`, and `counterpart_transaction_id` pointing at each other
— including a **retroactive UPDATE of an already-committed transaction from a
prior import**, in either import order. `review_status` on that retroactive
update moves `needs_review → auto` (a SQL `CASE`, not a flat set) but never
touches an existing `confirmed` — the classification must never appear to
overrule a category decision the owner already made.

**Verified against real fixture data only for the credit-card-payment case**
(M4's two real exports). The transfer path (e.g. checking ↔ savings) is the
identical mechanism, unverified for BoA's inter-account-transfer token format
specifically — if the pattern doesn't hold, the transaction simply stays
default-classified rather than being guessed. `COUNTERPART_WINDOW_DAYS = 7`
matches the window specified for M6 during planning.

### Never overwrites a manual decision, by construction

Every write this milestone makes — the type/counterpart UPDATE above, and (by
simply never running for rows outside `type_source = 'default'`) any future
manual confirmation M7 adds — is gated on `type_source = 'default'`. M7's
planned "mark as Transfer/Card Payment/Investment" UI will set `type_source =
'manual_confirmation'`; from that moment, this milestone's automation cannot
touch that transaction's type again, by the same guard, with no additional
code required when M7 ships. Verified directly: a transaction with
`type_source` manually forced to `'manual_confirmation'` is confirmed
untouched by a newly-imported, otherwise-qualifying counterpart, and the new
transaction correctly falls back to its M5 default rather than linking
one-sided.

### What was deferred, and why

- **Investment auto-classification** (account-type based) — proposed, then
  cut by owner decision before implementation. Currently unreachable (no
  adapter produces `brokerage`-account transactions) and "every transaction on
  a brokerage account is an investment" may not hold once real usage exists.
  Revisit when there's a concrete case.
- **A `counterpart_transaction_id` foreign-key constraint** — the column has
  none (M1). Considered and explicitly not added: application-level guards
  (`type_source = 'default'` on every write) plus the integration tests above
  are sufficient for V1; a migration purely for architectural neatness was
  ruled out by owner decision.
- **Correcting a wrong auto-classification** — no UI in M6. The matching
  criteria are strict enough that a false positive should be rare, but M7's
  review queue, not M6, is where an owner would fix one.
- **A staging-time counterpart-match preview** — the review table shows
  merchant-memory category suggestions immediately, but NOT a "this will
  become a Transfer" indicator before commit. Type classification is decided
  and applied only at commit, same as Tier 2 duplicate reconciliation's own
  staging-preview-vs-commit-authoritative split from M5. A cheap scope cut,
  not a limitation of the mechanism.

## Review queue (M7)

`/finance/review`: `needs attention → fix it → confirmed`. Reads and corrects
already-committed `finance_transactions`; it does not touch the import
pipeline, and it adds no automatic classification of its own — every
correction here is the owner acting, never the system guessing.

### No confirmed-but-uncategorized spending — the rule that shapes everything else

M6 let a transaction reach `needs_review` for exactly one reason (no category)
and `confirmed` in a few ways, none of them requiring a category explicitly —
M7 tightens this on owner instruction, because `finance_categories` is M8's
grid row axis, and a `confirmed` expense with no category has nowhere
trustworthy to appear in it.

`reviewStatusForCorrection(categoryId, transactionType)` (`classify/manual.ts`)
is the one rule every M7 write goes through:

```
confirmed   <-  categoryId is set,  OR  transactionType is exclusionary
needs_review <- otherwise
```

Exclusionary types (`transfer`, `credit_card_payment`, `investment`) are
exempt because they never appear in a spending category total in the first
place — requiring a category from them would serve nothing. This rule is
**not** the same function as M6's `reviewStatusFor` (which distinguishes
`confirmed` from `auto` by *who* categorized something) — that one still
governs a transaction *reverting* to its default type when a counterpart pair
is unlinked (below), because reverting restores a prior state rather than
correcting one, and its status should reflect whatever categorization already
existed, not this rule.

**Consequence:** the generic "mark reviewed without categorizing" action from
the original proposal was cut. There is no concrete case left needing it —
assigning a category resolves an ordinary transaction, and correcting the type
to an exclusionary one resolves the rest, via the same rule either way.
**Income is deliberately NOT special-cased for V1** — the proposal raised the
possibility that an income total might not need per-category breakdown the
way spending does, but M8 does not exist yet to say so with any confidence.
Applying the identical rule to both keeps the invariant simple and consistent;
carving out income is a narrow, easy follow-up once M8's actual design is
known, not a guess worth making now.

### The counterpart unlink — atomic, both sides, every time

Manually correcting the type of a transaction that is currently linked
(`counterpart_transaction_id` set, always by M6's own matching) breaks the
pair entirely rather than leaving one side pointing at a partner that no
longer agrees with it:

```
THIS transaction  -> the new type, type_source = 'manual_confirmation',
                      counterpart_transaction_id cleared.
THE OTHER leg      -> reverts to the plain M5 default (expense/income by
                      sign), type_source = 'default', counterpart_transaction_id
                      cleared, review_status recomputed via M6's
                      reviewStatusFor (it is reverting, not being corrected).
```

Both writes happen in one transaction (`updateTransactionType` in
`db/finance/transactions.ts`). No confirmation modal — the review row shows
"Linked to {account} — changing the type will unlink both" before the action
runs, so it is visible rather than a surprise, but unlinking itself is not
optional once the type actually changes. Verified directly: correcting one
leg leaves the other with `counterpart_transaction_id = null` on BOTH sides,
never a one-way stale reference.

### Merchant memory from a review-queue correction — opt-in, not automatic

M6's import-time rule (any committed category unconditionally updates memory)
is deliberately **not** reused here. A review-queue correction is plausibly a
one-off exception ("this one Amazon order was a gift, not Shopping") rather
than a signal that the standing mapping is wrong — applying it unconditionally
would let one exception silently retrain every future import from that
merchant.

**Behavior:** a per-row "Remember for future imports" checkbox next to the
category picker, **unchecked by default**. Checked, a category change upserts
`finance_merchant_memory` exactly as `commitImport()` does. Unchecked (the
default), only that one transaction changes. Since `finance_transactions`
stores `normalized_merchant` but not `merchant_key`, the key is rederived via
`merchantKeyFrom()` — a small function extracted from `merchant.ts`'s
existing internal derivation, not a new rule.

Bulk category assignment never writes to merchant memory, unconditionally —
a bulk selection is the common case where several unrelated merchants are
involved, and a per-row remember decision inside a bulk action would defeat
the "stays simple" bar it was built to.

### The manual type picker shows 7 of the 8 real values

`MANUAL_TRANSACTION_TYPES` (`classify/manual.ts`) excludes `adjustment` on
purpose — it reads as an internal bookkeeping concept (a balance correction)
rather than a "kind of transaction" an owner would intentionally hand-pick,
unlike the other seven. The database column still accepts it; this milestone
neither produces nor requires it. The same list drives both the Select's
options and the Server Action's Zod validation, so the UI and the accepted
values can never drift apart.

### What was deferred

New automatic classification heuristics, LLM/AI, a rule-builder UI, fuzzy
matching, other banks, M8 grid work, analytics/reporting — all explicitly out
of scope by owner instruction. Also not built: deleting a transaction (never
asked for, and a meaningfully different risk than anything else here),
pagination beyond a 500-row safety cap, a confirmation modal for the unlink.

## Monthly grid & drill-down (M8)

`/finance/monthly` — the landing route, and the actual product: the useful
part of the owner's spreadsheet, recreated. Every number is a live SQL
aggregate over `finance_transactions`; nothing is ever stored (invariant 1).
This section documents what shipped; it **supersedes the earlier "The monthly
grid" mockup above** in two ways the owner explicitly chose during proposal
review — see "Where this differs from the original mockup" below.

### The base filter — one function, used twice

`gridBaseConditions(ownerId, year)` (`db/finance/grid.ts`) is the entire
double-counting and under/over-counting guarantee, and it is not duplicated
anywhere:

```
owner_id = $1
review_status IN ('confirmed', 'auto')            -- needs_review excluded from every number
transaction_type NOT IN ('transfer', 'credit_card_payment')  -- excluded even if categorized
transaction_date BETWEEN {year}-01-01 AND {year}-12-31
```

`investment` is deliberately **not** excluded — it gets its own category
column and counts toward Total Expenditure, same as the "Transaction types"
table above always specified. Both `getMonthlyGridAggregates` (the grid's one
`GROUP BY month, category_id, transaction_type` query) and
`getCellTransactions` (drill-down) build their `WHERE` from this exact same
function — not two copies of an equivalent filter. That sharing, not
diligence, is why a drill-down total structurally cannot disagree with the
cell it came from. `tests/integration/finance-grid.test.ts` proves it
directly: it runs both queries for the same scope and asserts the sums are
bit-for-bit equal, for a category cell, Total Expenditure, Income, and the
year-Total (`month: null`) case.

### The three summary columns

- **Total Expenditure** — `SUM(amount_cents)` over every non-`income` row in
  scope (`expense`, `refund`, `fee`, `adjustment`, `investment`). A refund
  nets against its category through the same `SUM`, no special case. Renamed
  from the mockup's "Total Outflow"; identical formula.
- **Income** — the negated `SUM` of `income`-typed rows. Stored negative
  (money arriving, under the outflow-positive convention), sign-flipped **for
  display only**, exactly as the mockup above already specified. A month with
  zero income normalizes to `+0`, not `-0` — see the M1-precedent gotcha in
  `CLAUDE.md`.
- **Gross Savings** — `Income − Total Expenditure`, can go negative. Renamed
  from the mockup's "Net"; identical formula. Not independently drillable —
  a difference isn't "produced by" one coherent transaction list, so its
  amount opens a breakdown dialog showing Income and Total Expenditure as two
  separately-drillable line items instead (an approved judgment call).

### Column order is authoritative — owner instruction, overriding the original mockup

Columns render in the owner's configured `sort_order`, flat, **never**
regrouped into Spending/Investment/Income blocks. `category.kind` shows as a
small non-reordering label under the column name, for context only. Live
categories always get a column, even with zero activity all year. An archived
category earns a column only if it has at least one transaction in the
selected year, appended after the live columns in `sort_order`/name order —
archived history is visible without disturbing where a live category sits.
A category whose transactions net to exactly zero still gets a `$0.00`
button, not `—`; `—` means zero contributing transactions, not zero net
amount, because a zero-net cell (e.g. fully refunded) is still something the
owner may want to inspect.

### The invariant-violation (unreconciled) warning

A `confirmed`/`auto`, non-exclusionary transaction with no category should be
impossible under M7's invariant. If one exists anyway (old data, a future
bug), its money is never dropped — it is already counted in Total
Expenditure/Income by the same type-grouped `SUM`, independent of category —
but it appears in no column, since there is no column to place it in. Rather
than let the totals and the visible columns silently disagree, the page shows
a small banner: count, amount, and a link to Review. It costs no extra query
— it is the aggregate query's own `category_id IS NULL` groups, rolled up.

### Drill-down

Every cell with a contributing transaction is a button. It opens a dialog
that fetches through `getCellDrillDownAction` (a `requireOwner()`-gated
Server Action), which calls the exact `getCellTransactions` sharing the base
filter above. Each row shows `transaction_date`, account, `normalized_merchant`
alongside the raw `original_description`, category (or "Uncategorized"),
type (via `TRANSACTION_TYPE_LABELS`), and the signed amount — capped at 500
rows, ordered by date. The dialog footer states the total, computed
server-side from the same rows returned, so a rendering bug can never make
the displayed total drift from the displayed rows either.

### Where this differs from the original mockup above

Two changes the owner made explicitly when approving the M8 proposal, kept
here rather than edited into the older text so the decision trail stays
visible:

1. **No Spending/Investment/Income column grouping, no collapsible Income
   section.** The mockup above shows blocked sections with subtotals; V1
   ships one flat table in `sort_order` instead — simpler, and it avoids a
   second ordering system alongside the owner's own category order.
2. **Naming**: "Total Outflow" → "Total Expenditure", "Net" → "Gross
   Savings". Formulas unchanged.

### What was deferred

Charts, budgets, trends, forecasting, AI insights, custom dashboards, a
report builder — all explicitly out of scope by owner instruction **at M8**.
The Excel-comparison "Reconciliation" feature described earlier in this
document (`finance_expected_totals`) is a separate, still-unbuilt feature, not
part of M8 — cell drill-down is what currently replaces manually checking a
spreadsheet, the same role the mockup above assigned to it.

**Charts and trends were subsequently un-deferred and built, in M11.** The
owner asked for them after living with the bare grid; see "Finance dashboard
(M11)" below. Budgets, forecasting, AI insights and a report builder remain
out of scope, and the M8 grid itself is unchanged beneath the dashboard.

## Transactions ledger & export (M9)

`/finance/transactions` — a Finance subpage (not a third sidebar
destination), reached from a secondary button next to "Import statement" on
`/finance/monthly`. The complete historical ledger: every committed
transaction, searchable and filterable, newest-first, paginated at 100 rows.

**Deliberately NOT `gridBaseConditions()`.** Monthly's base filter excludes
`needs_review`, `transfer` and `credit_card_payment` by design — that is
exactly what a full ledger must **not** do by default. A single new
condition-builder, `ledgerConditions()` (`db/finance/transactions.ts`), is
reused unmodified by the paginated listing, the reconciliation summary, and
the CSV export, so "the current filter" cannot structurally mean three
different things in three places — the same discipline
`gridBaseConditions()` established for the aggregate/drill-down pair in M8.

### Editing history, not a second correction system

Category and type corrections reuse M7's `updateTransactionCategory` /
`updateTransactionType` **completely unmodified** — no parallel business
logic. That means, unchanged from M7: the counterpart unlink is atomic and
hits both legs every time; a manual type correction always sets
`type_source = 'manual_confirmation'`; `reviewStatusForCorrection` decides
`confirmed` vs `needs_review` the same way regardless of which page made the
edit; merchant memory is written only when the owner explicitly checks
"remember," never automatically. Because Monthly computes every total live
from `finance_transactions` with nothing cached, an edit made from
Transactions is visible on Monthly's very next load — no invalidation logic
needed anywhere.

### Reconciliation, kept intentionally small

Three counts, computed from `ledgerConditions()` for whatever filter is
currently on screen: the transaction count, the needs-review count, and the
`transfer`/`credit_card_payment` row count excluded from every Monthly
total. No overall signed dollar total is shown — summing income, expense,
refunds and transfers into one number is not a meaningful figure and risked
reading as competing with Monthly's own totals.

**The excluded figure is a plain row count, deliberately with NO paired
dollar amount** — this went through two drafts. A credit-card-payment PAIR
is two rows for one real movement of money: the checking-side outflow and
the card-side "payment thank you" inflow are the same dollars, moving once.
A signed `SUM` across both legs cancels toward zero exactly when both are
in scope (no account filter applied) — caught before it ever shipped.
`SUM(ABS(...))` avoids that cancellation but then **double-counts** the
pair: a real $675 linked payment reads as $1,350 excluded — caught by the
owner in real use, after the milestone carrying the `ABS` version had
already been accepted. Recovering the true $675 would mean matching legs
back into pairs, which is real reconciliation/netting logic this page
deliberately does not build (see "Reconciliation" above). Showing the row
count only sidesteps the whole class of bug instead of picking a
lesser-wrong dollar figure.

This strip is additive to, not a replacement for, the correctness
guarantees that already exist: M4's BoA checksum, M5's Tier 2 count
reconciliation, and M8's aggregate/drill-down equality proof. See the note
under "Reconciliation" above for why the `finance_expected_totals`
Excel-diff design was not built as part of this.

### Export

CSV only — Papa Parse is already a dependency and CSV opens natively in
Excel/Sheets, so ExcelJS's M9 dependency-security gate was never triggered.
Always reflects the **exact current filter**, ignoring on-screen
pagination; clearing every filter is the full-ledger export. Bounded at
20,000 rows (`LEDGER_EXPORT_ROW_LIMIT`) — exceeding it **fails visibly**
(HTTP 413 with an explanatory message), never a silently truncated file.

Columns: Transaction Date, Account, Institution, Normalized Merchant, Raw
Description, Amount, Category, Transaction Type, Review Status,
Categorization Source, Type Source. Internal ids, `dedupe_key`,
`source_transaction_id`, `posted_date` and `last_four` are never exported.

**Sign convention: positive = outflow, identical to everywhere else in the
app.** The Amount column header itself states this
(`Amount (USD, + = outflow)`), so the file is self-documenting without a
comment row.

**Formula-injection guard.** Any free-text cell sourced from a bank
statement or the owner's own typing (merchant, raw description, account
name, institution, category name) that starts with `=`, `+`, `-` or `@`
gets a leading `'`. The Amount column is deliberately **exempt** — it is
produced entirely by `toDecimalString()`, never by statement or owner text,
and blanket-sanitizing it would prefix every negative amount and break the
column as a number in the exact file this feature exists to produce.
`src/server/finance/export/csv.ts` is pure and framework-free, matching the
rest of `src/server/finance/`.

### What was deferred

The `finance_expected_totals` Excel-diff reconciliation UI (see above),
XLSX import/export, bulk category/type edit from Transactions, deleting a
transaction, a `pg_trgm`/GIN search index (plain `ILIKE` is sufficient at
personal-ledger scale) — all explicitly out of scope. No new
categorization/classification work: M6 and M7's mechanisms are untouched.

---

## Finance dashboard (M11)

`/finance/monthly` leads with a dashboard; the M8 year grid sits beneath it,
relabeled "Full year grid" and otherwise untouched.

**Headline stat cards** for the selected month — Income, Expenses, Net,
Savings rate, Average daily spending, Transaction count — each with a
month-over-month comparison. **Charts** (Recharts): income-vs-expense trend,
net cashflow, category breakdown and trend, largest expenses. **A "This Year"
tab** with a Jan–Dec stacked bar and an annual category donut that falls back
to a horizontal bar past 7 categories.

**Every number is still computed by SQL at read time.** The invariant does not
bend for a dashboard: `db/finance/grid.ts` gained `getMonthlyTotalsAllTime`,
`getCategoryTotalsForWindow`, `getDailyTotalsForMonth` and
`getTopExpensesForMonth`, and the pure month math lives in
`server/finance/dashboard.ts`. The category-totals/monthly-totals
reconciliation is proven by an integration test, not asserted here.

`dashboardBaseConditions()` is **deliberately duplicated from**, not coupled
to, M8's `gridBaseConditions()` — the same precedent M9's `ledgerConditions()`
set. Three filters that agree today may need to diverge tomorrow, and a shared
one would make that a refactor instead of an edit.

**One trap this created, worth repeating from CLAUDE.md:**
`getMonthlyTotalsAllTime` sign-flips income to a positive display figure at the
DB boundary. Calling `formatInflow()` on an already-flipped aggregate
double-flips it and renders a real paycheck as `-$6,400.00`. `formatInflow` is
only correct on a raw, still-negative stored value — a single transaction row,
never a pre-summed total.

---

## Statement coverage — the dashboard reports on finished months only

**The problem.** A calendar month and a statement cycle are not the same thing. The owner's credit
card statement closes around the 27th and the checking statement around the 15th, so on 28 August the
database holds card data through ~the 27th and checking data through ~the 15th. The August stat cards
reported income of $3,813.88 against expenses of $6,497.68 — a −70.4% savings rate and a "↓56% vs Jul"
that measured two weeks of one month against all of another. Every figure was arithmetically correct
and completely misleading. The month wasn't bad; it wasn't over.

**The rule, in one sentence:**

> A month is COVERED when every still-reporting account has at least one transaction dated on or after
> that month's last day.

Read it as *"we have imported data that runs past the end of this month."* It lives in
`src/server/finance/dashboard.ts` (`partitionCoverage`, `isMonthCovered`, `latestCoveredMonth`,
`dropUncoveredTail`) and is fed by one query, `getAccountCoverage` — the max `transaction_date` per
active account.

**"Still-reporting" is `partitionCoverage`, and it is not optional.** An account more than
`DORMANT_AFTER_DAYS` (75) behind the newest transaction *in the ledger* is treated as closed and drops
out of the rule. See "The dormant-account bug" below for why the number is 75 and why it is measured
against the ledger rather than against today.

**Derived from the transactions, not configured.** No statement-close-day setting, no "mark month
complete" checkbox. A configured close day *lies* when a statement is late or an import is skipped,
which are precisely the situations where a wrong answer does damage; the derived rule self-corrects
the moment the next file lands.

**Worked through the real cycle, on 5 September** — card latest `Aug 26`, checking latest `Aug 14`:

| Month | Covered? | Why |
| --- | --- | --- |
| July | **Yes** | Both accounts run past Jul 31. The card statement closing 27 Aug contains Jul 28–31; the checking one closing 15 Aug contains Jul 16–31 |
| August | **No** | Neither reaches Aug 31 |

July is correctly whole even though no single statement is aligned to it — the month is complete
*across* the two files even though neither file is a month.

**What changes on screen:**

- **`/finance/monthly` lands on last month, not this one.** A plain `month − 1` (`previousMonth`, so
  January rolls the year back), deliberately *not* "the newest covered month" — the default is where
  you land and should be the same every time you open the app. Whether that month is whole is a
  separate question, answered below it.
- **An uncovered month shows no numbers at all.** The six stat cards, the category breakdown, the
  insights and the largest-expenses list are replaced by `MonthNotReady`, which names every account and
  the date its data reaches: *"BoA Checking — through Aug 15."* That is the answer to "why is my August
  empty?", on screen, without going to look. It is `role="status"` and muted, not an error — this is the
  normal state of the current month for most of every month.
- **Trend charts end at the last covered month.** A partial month at the right-hand end of a line reads
  as a collapse in income and spending; a chart cannot carry a footnote. Only the TAIL is trimmed — a
  gap mid-history is a month that was never imported, and hiding it would misrepresent the series far
  more than showing it does.
- **`Avg. daily spending` always divides by the whole month.** It used to divide by the elapsed day and
  label the result "So far this month" — a partial figure dressed as an average. With no partial case
  left, there is no divisor that changes meaning depending on the date.
- **Year Overview counts covered months only**, so YTD figures and the annual donut agree with the
  monthly cards above them. A year with **zero** covered months renders `YearNotReady` — the same
  treatment the month view gets — rather than a row of `$0.00` cards. Zero covered months is an honest
  result; `$0.00` presented as a total is not a way to say it.
- **The full year grid is untouched** and still shows everything imported, partial months included. It
  is a ledger view, not a set of derived headline figures, and the owner asked for it to stay as it is.

**One property, stated rather than engineered around:** it is **conservative**. A month with genuinely
no activity in its final days reads as uncovered until the next statement arrives. The cost is a short
wait for unremarkable numbers; the cost of the opposite error is a confident wrong one.

### The dormant-account bug — why `partitionCoverage` exists

The first version of this rule judged every account the caller considered active, and documented the
consequence as an accepted cost: *"a dormant active account freezes every later month; the fix is
`is_active = false`."* That was written into the code, the docs and a passing test, and shipped.

In production the owner had a retired **"Historical (2024–2025)"** account whose last transaction was
1 Dec 2025. The result, on real data:

- every month of 2026 rendered `MonthNotReady` — no stat cards, ever;
- trend charts stopped eight months short, at Nov 2025;
- the Year Overview showed `$0.00` for YTD income, expenses, net and average — sitting directly above a
  Full year grid listing $6,774.60 of mortgage payments and $6,646.94 of car payments for that same
  year.

Nothing was arithmetically wrong. The design was: it made a person's own dashboard depend on their
noticing an account flag and going to change it — and there is no Accounts screen in the app to change
it on. **Dormancy is derivable from the data, so it is derived.**

**The threshold: 75 days.** It has to separate two things that look identical from one account's latest
date — a *late statement* (still in use, file not imported yet; must keep holding coverage) from a
*retired account* (nothing will ever release it; must stop). A cycle is ~1 month and the two accounts'
cycles are offset by half of one, so a live account sitting ~45 days behind the newest data is routine.
75 days is past two full cycles: two missed statements in a row, which ordinary lateness does not
produce.

**Measured against the newest transaction in the ledger, not against today.** Coverage is a statement
about imported data. An owner who hasn't imported anything for three months should see every account
still counting — their data is simply old — not every account declared dormant at once, which would
silently mark stale months "covered". Tested directly (`partitionCoverage` › "measures against the
newest transaction, not against today").

**A written-off account is still shown.** `MonthNotReady` lists it under *"Not waiting on this account —
no statements in over two months, so it is treated as closed."* An account silently dropped from the
rule that decides whether the dashboard renders is exactly what makes an app unexplainable to the person
who owns it. There is deliberately no "go and deactivate it" instruction: nothing here is waiting on the
owner any more.

**Why no test caught it.** `finance-dashboard.test.ts` covers the arithmetic, and the arithmetic was
right. Nothing rendered `FinanceDashboard` at all, so neither the frozen month view nor the zeroed Year
Overview was ever on a screen — real or simulated — before the owner saw it in production.
`tests/unit/finance-dashboard-view.test.tsx` now renders the component in each of those states; both
regression cases fail against the code as shipped.
