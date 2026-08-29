# Anime — the third product module

Canonical for the Anime domain, the way `docs/FINANCE.md` is for money and
`docs/GAMES.md` is for the library. Where this document and the code disagree,
**the code is authoritative** — that is a bug to fix, not a discrepancy to
document around.

---

## The problem being solved

The owner tracks every anime they watch on AniList, and watches on a streaming
site that logs progress back to AniList automatically as episodes finish.
AniList is a good *recorder* and a poor *library*: there is no cover wall worth
the name, no answer to "which studios do I actually watch", and it sits nowhere
near the Finance and Games libraries already in Burmy.

Anime is a library of everything watched, a page per show, a stats page and a
dated watch log — reading from AniList so the automatic logging the owner
already relies on keeps working.

### What it deliberately is not

- **No ratings.** Explicitly not wanted.
- **No trophies, achievements or completion percentages** beyond episode
  progress. There is nothing to earn.
- **No writes back to AniList.** The sync is read-only in one direction,
  permanently. AniList stays the recorder because Burmy cannot observe
  watching — the streaming site is AniList's client, not Burmy's.
- **No money.** Anime has no price field and no relationship to Finance.

### The rule this module amended, and the half that survived

CLAUDE.md used to say Burmy was two modules and "do not build a third". Anime is
a real third module the owner asked for on 2026-08-29, so that rule was **amended
deliberately**, not broken quietly. The load-bearing half still stands: **no
shared module framework, no generic module registry, no abstraction that two
modules both instantiate.** Anime copies the *shape* of Games and reuses
`src/components/ui/`, the `(private)` layout, `getDb()`, `requireOwner()` and
`src/proxy.ts` — and nothing else. Where a Games component and an Anime
component look near-identical, they are two files whose constraints differ.

Three primitives moved *into* `src/components/ui/` during this work rather than
being copied: `inline-edit-row.tsx`, `picker-dialog.tsx` and the tone-based
`status-badge.tsx`. Each had zero knowledge of the module it lived in. Promoting
a proven generic primitive is what the rule permits; one feature module
importing another is what it forbids, and these moves are what made that
unnecessary.

---

## Data model

### The `anime` table

One watchable entry — a season, a film, an OVA. The unit AniList tracks and the
unit the owner counts.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `owner_id` | text → `user.id` cascade | |
| `series_id` | uuid → `anime_series.id` **ON DELETE SET NULL** | Dissolving a franchise must never destroy the seasons in it. |
| `anilist_media_id` | integer | The link key. Resolve the match once, persist the external id. |
| `title_romaji` | text not null | The row's identity when nothing else is known. |
| `title_english` | text | Preferred for display when present. |
| `format` | `anime_format` | TV, TV Short, Movie, OVA, ONA, Special, Music. |
| `status` | `anime_status` not null | Watching, Completed, Dropped, Planning. |
| `episodes` | smallint | The total the show has. Null for an airing show with none published. |
| `progress` | smallint not null | Episodes into the current watch. **Stored truth.** |
| `repeat_count` | smallint not null | Rewatches. |
| `duration_minutes` | smallint | Per episode. An AVERAGE, not a measurement. |
| `season` / `season_year` | `anime_season` / smallint | |
| `studio` / `genre` / `source` | text / text / `anime_source` | `genre` is comma-joined and split at read time, exactly like `games.genre`. |
| `synopsis` / `cover_url` / `notes` | text | |
| `started_at` / `completed_at` | date (`mode: 'string'`) | Calendar facts, not instants. |
| `created_at` / `updated_at` | timestamptz not null | Set by hand on every write; there is no trigger. |

**There is no unique index on the title.** Games has one on
`(owner, lower(title), platform)` because a platform discriminates two rows with
the same name. Anime has no such discriminator — "Season 2" is a perfectly
ordinary title for two unrelated franchises to share — so the only uniqueness
enforced is `(owner_id, anilist_media_id) where not null`, which is what makes a
re-sync match rather than duplicate.

### Neither total episodes nor total time is stored

`episodesWatched = progress + repeat_count × episodes`, and
`minutesWatched = episodesWatched × duration_minutes`. Both are computed, in
`src/server/anime/runtime.ts` and nowhere else — the same containment rule
`money.ts` and `hours.ts` hold for their own arithmetic, and the same "never
store a total" invariant CLAUDE.md states first.

### `null` never becomes zero

A show with no known `duration_minutes` contributes NO minutes, not zero
minutes, and a group where nothing is known reports `null`. "We don't know" and
"none" are different answers, and collapsing them is how a confident wrong
number reaches a dashboard. Every screen renders `null` as `—`.

### Time watched is always an estimate, and is always labelled one

`duration_minutes` is an average AniList publishes. Skipped openings, a recap
episode and a double-length finale all move the real figure. Every rendering
carries a `≈`, and the stat card says how many shows were left out of the
estimate entirely.

---

## Series — a franchise, in its own table

### Why a table and not a self-reference

Games models a boxed set as a `games` row pointing at itself, because a boxed
set **is a thing you bought**: one price, one play time, one purchase. A
franchise is not something you watched. It has no episode count, no progress, no
status, no start or finish date — nothing to record.

Choosing a separate table buys the counting rule for free:

> Anything that counts SHOWS counts `anime` rows and never `anime_series` rows.
> Anything that sums episodes, time, studios or genres reads `anime` rows only.

Nothing that reads `anime` can return a franchise, so there is no counting filter
to apply and none to forget. `src/server/games/collections.ts` needs
`countableGames` at every counting call site precisely because a collection IS a
`games` row; `src/server/anime/series.ts` needs no equivalent.

### Everything a series shows is derived

A series stores a name, an optional cover override, and the AniList parent id
that lets a re-sync resolve the same one. Episode totals, time watched, the
airing span and the cover all come from its members at read time
(`seriesTotals`, `seriesCover`). A stored copy and the members it came from can
drift, and no step in this app would ever notice.

### Membership is editable from every direction it comes up

| From | Control |
| --- | --- |
| One show | "Part of" on the show page (`SeriesField`) — which can also CREATE the series |
| One franchise | "Add shows" on the series page (`SeriesMembersPanel`) |
| Several shows at once | Multi-select plus "Add to series" in the library's table view |
| A sync | An approved `series_hint`, which creates the series and files its members |

All four drive the same column through the same validation. Having them all is
not redundancy: filing a season you are looking at, gathering the seasons of a
franchise you are looking at, and grouping six of them at once are three
different moments, and each is clumsy from the other's screen.

### Franchises are browsable

`/anime/series` lists every one, as a card carrying its cover, its airing span,
its totals and the first few seasons in it — the nesting made visible. It was
added because a series had been reachable only sideways (a link in the library's
table, or by already knowing to pick it from the filter), and a nesting nobody
can browse is a data model rather than a feature.

Searching it matches a SEASON's name as well as the franchise's, because that is
how anyone looks for one: you remember "Final Season", not the base title the
grouping heuristic produced.

The Library tab stays FLAT on purpose. A season is still a show you watched, and
collapsing seasons into one card there would make the library's counts disagree
with the stats page.

`SeriesField` can also CREATE a series, which the Games equivalent cannot: a
game's collection is another game and always already exists, while a franchise
usually does not exist until the moment two seasons are found to belong together.
The suggested name comes from `suggestSeriesTitle`, which **under-strips on
purpose** — leaving two series the owner joins with one click is far better than
merging two different shows. It is a suggestion for an editable field, never an
identity key; `anilist_parent_id` is the identity.

### How a sync proposes a franchise

`groupRelatedMedia` takes connected components over AniList's
prequel/sequel/parent edges, restricted to media the owner actually has or is
about to get. Components, not pairs: AniList records relations pairwise, and
proposing each pair would ask the owner to approve one franchise three times and
could file a show into two different series depending on approval order.

A proposal is skipped when the owner has fewer than two of its shows, and skipped
again when everything they have is already filed in the same series. A sync that
re-proposes the same franchises every run is how a review screen trains its
reader to tick without looking.

Shows the SAME RUN is proposing as `new_anime` count as members. Without that a
first import — the moment grouping is most useful, when hundreds of shows arrive
at once — could never propose anything, because none of the shows exist yet.
`COMMIT_ORDER` puts `series_hint` after `new_anime` and the hint resolves media
ids to rows at that point, so approving the grouping but not one of the shows
simply files the members that exist.

Approving one **does the work**: find-or-create the series on
`anilist_parent_id`, then fill `series_id` on the members that have none. It
never moves a show the owner filed by hand. An earlier version staged this as an
advisory note that applied nothing — a checkbox that counted toward "Apply N
selected changes" and then changed nothing, which is worse than no control at
all.

`anilist_parent_id` is the smallest media id in the component: a pure function of
the set, so the same franchise resolves the same series on every run. A title
cannot do that job — it comes from a heuristic and the owner can rename it.

### Dissolving is not deleting

`anime.series_id` is `ON DELETE SET NULL`, so removing a series returns every
season to the library as a standalone entry. The confirm dialog says so in those
words, because "delete" beside a page listing six shows invites the opposite
assumption.

---

## Computed aggregates — nothing is ever stored

`src/server/anime/stats.ts` is pure and framework-free. Every figure on
`/anime/stats` is computed when the page renders.

| Figure | Rule |
| --- | --- |
| Shows | A count of `anime` rows, broken down by status in the card's hint. |
| Episodes watched | Rewatches included — a 24-episode show watched three times is 72 episodes actually spent. The hint attributes the rewatch share. |
| Time watched | `≈`, always. `—` when nothing has a known episode length; the hint names how many shows were excluded. |
| Completion rate | Over shows actually STARTED. Planning entries are excluded from both halves — a watchlist of 300 things not begun says nothing about follow-through. `null`, rendered `—`, when nothing has been started. |
| Studios / genres | By show count, with episodes carried alongside: "8 shows" and "620 episodes" tell different stories about a studio. A show counts once in EVERY genre it carries, so genre slices deliberately do not sum to the library. |
| Format / source | A missing value is left OUT rather than bucketed as "Unknown" — an absence of data is not a kind of anime. |
| Airing era | By the year a show AIRED, never the year it was watched, so a rewatch never moves a bar. Undated rows are dropped rather than planted at year zero. |
| Longest sits | By episodes watched, not minutes — minutes are unknown for some rows, and a leaderboard that silently omitted them would look like a bug. |

Long tails collapse into one `Other (n)` row via `capSlices`, capped in the
DOMAIN so the "Other" figure is computed once and matches what the chart's
tooltip reports.

---

## The AniList sync

### Configuration

`ANILIST_USERNAME` and nothing else. No token, no OAuth, no secret: the owner's
profile is public, so the GraphQL API answers for it unauthenticated. Nothing
expires — unlike `PSN_NPSSO`, there is no periodic re-paste chore.

Read via `process.env` at point of use, and `anilistConfigured()` reads the
environment **directly**, never inferring from a fetch result. That is the rule
`igdbConfigured()` and `psnConfigured()` both follow, and the reason they exist.

### The soft-failure contract

```
ANILIST_USERNAME unset            -> null   (checked FIRST; fetch never called)
network error, timeout            -> null
non-2xx, including 429            -> null
GraphQL `errors` in the body      -> null
malformed / unparsable JSON       -> null
request succeeded, empty list     -> []     (a real answer)
```

`null` and `[]` are different and the difference is the point: "the request
failed" and "this list is genuinely empty" are separate facts, and collapsing
them reports a confident zero when the truth is "we don't know". A GraphQL error
arrives as HTTP 200 with an `errors` array, so `response.ok` alone is not enough
here as it is for the REST clients.

The full test suite must pass with `ANILIST_USERNAME` unset, and
`tests/unit/anime-anilist-client.test.ts` enforces it by asserting `fetch` is
never CALLED — not merely that the result is empty.

### The run model

Copied in shape from the Games sync, which is the codebase's most
heavily-reasoned feature. Its own tables (`anime_sync_runs`,
`anime_sync_changes`) and its own commit: `db/games/sync.ts` types its patches
as `Partial<typeof games.$inferInsert>` and inserts into `games`, so
generalising it would mean a generic column-patching layer over arbitrary
schemas — exactly the speculative abstraction CLAUDE.md forbids, in the one
place where getting it wrong writes to the wrong table.

1. **Start** — check `anilistConfigured()` first and explicitly, fetch the whole
   list once, snapshot it to the run.
2. **Advance** — keyset chunking over `anime.id`, `CHUNK_SIZE = 50`.
   **Done is an EMPTY CHUNK, never `cursor >= total`.** `cursor` and `total` are
   display only. The comparison has two reproduced failure modes and is the
   defect, not a simplification. The chunk is larger than Games' 5 because a
   chunk here performs zero outbound requests — the list is already in the
   snapshot.
3. **Review** — four kinds: `link`, `field_update`, `new_anime`, and
   `series_hint`, which is advisory, applies nothing, and is staged
   **unselected** so it can never be approved by clicking through.
4. **Commit** — one transaction, `pg_advisory_xact_lock` keyed to the run, an
   exhaustive switch (not a computed key — the switch is what makes an arbitrary
   column name structurally impossible), and a SAVEPOINT-tolerant insert using
   `isUniqueViolation()`, which walks the `cause` chain because Drizzle wraps
   driver errors.

### Matching a show that has no AniList id

A show added by hand has no `anilist_media_id`, so the only way to link it is its
title. `src/server/anime/matching.ts` does that, and is deliberately far stricter
than the Games matcher, which accepts 0.70 similarity.

Anime breaks the assumption that lets Games be generous. "Shingeki no Kyojin" and
"Shingeki no Kyojin Season 2" are 85%+ similar by any string metric and are
DIFFERENT SHOWS. A wrong match in Games fills in a wrong cover; a wrong link here
lets the next sync overwrite one season's progress and status with another's,
indistinguishable from a real correction.

So there is a hard gate no score can override: `ordinalMarker` extracts the
season/part marker from each title, and a disagreement rejects the pair outright
— including a bare title against a numbered one. Past that gate, an exact
normalised match on either of AniList's titles links, then a Sørensen–Dice
similarity at or above `MATCH_FLOOR` (0.9). Otherwise nothing. An unlinked show
is a fine state; a wrongly linked one is data loss.

A match is never silent: it is staged as a `link` the owner approves, and the
review screen shows THEIR title beside AniList's, because "matched to #16498" is
not something anyone can check.

Media ids already claimed by another row are excluded before matching — and
claimed again within the walk itself, so two hand-added rows with the same title
cannot both match the same entry and collide on
`anime_owner_anilist_id_idx` at commit.

### What a sync may and may not change

`SYNCABLE_ANIME_FIELDS` is the whole list: status, progress, repeat count,
episodes, duration, studio, genre, cover. It deliberately excludes `notes` and
`series_id` — both are the owner's own and AniList has no opinion about either —
and `title_romaji`, which AniList almost never changes.

**A `null` from AniList means "AniList did not say", never "the value is zero".**
Every metadata proposal is gated on a non-null value; writing `null` as 0 would
erase a real number and shrink every total derived from it. Cover art is filled
only when MISSING, never replaced, or a churning AniList image would propose the
same swap forever.

**Progress only ever moves forward from a sync — except visibly.** A decrease is
staged as an ordinary `field_update` the owner can see, marked so the review
screen renders it in amber with "Moves your progress backwards." It is never
applied silently, and never blocked either: a real correction has to be possible.

Every field remains editable by hand, which is the opposite of the Games page
where Steam-owned fields render read-only. The difference is deliberate: AniList
PROPOSES rather than applies, so an owner edit is never silently overwritten and
there is nothing to protect the field from.

---

## The watch log

`anime_watch_log` holds one row per activity AniList recorded — usually an
episode finishing, sometimes a bare status change with no episode number.

**Log rows are written DIRECTLY, not staged for approval.** Everything else a
sync produces waits for a click because it proposes changing something the owner
might have set by hand. A log row proposes nothing: it is a dated fact about the
past with no owner-authored counterpart, so a review step would be asking the
owner to ratify reality. Trophies get exactly this carve-out in `psn-actions.ts`.

**A re-sync is an upsert**, keyed on the partial unique index
`(owner_id, anilist_activity_id) where not null` with `ON CONFLICT DO NOTHING`.
The feed is walked from its newest end every time, so without that index a second
sync would duplicate everything it had already seen. The predicate has to be
repeated in the conflict target, or Postgres cannot match the arbiter and raises
an error that names the clause rather than the index. The `where not null` half
also leaves room for hand-added entries, several of which must not collide.

**The import runs after the sync finishes, on BOTH exit paths** — after a commit,
and on the "Nothing to review" screen's way out. It has to be after, because a log
row needs an `anime.id` and the shows a run creates do not exist until the run is
applied. It has to be on both, because a run with no library changes is exactly
the case where new activity can still exist. It is best-effort and never fails a
sync: the library is already correct without it.

An activity for a show that is **not** in the library is skipped rather than
creating one. AniList's feed outlives a removed list entry, and inventing a
library row from a log line would resurrect a show the owner deleted.

**The watermark is not decoration.** AniList's activity retention is unknown, so
the Log tab names the oldest entry it holds and says the feed does not reach
further. A log starting in 2024 for someone who has watched since 2015 otherwise
reads exactly like missing data.

Entries are grouped by LOCAL day, not UTC — an episode finished at 11pm is part
of that evening, and bucketing by UTC would scatter one night's binge across two
headings for anyone west of Greenwich.

---

## Screens

| Route | What it is |
| --- | --- |
| `/anime` | Redirects to `/anime/library`. |
| `/anime/library` | The cover wall and the table view. Filters (status, series, search) are entirely client-side — every one is a pure re-render of data already loaded. |
| `/anime/series` | Every franchise, as a card with its span, its totals and the seasons in it. |
| `/anime/log` | The dated log, newest first, grouped by day, capped at 500 with the truncation stated. |
| `/anime/stats` | The dashboard. |
| `/anime/[id]` | One show. Every field inline-editable; a History section when the log has anything for it. |
| `/anime/series/[id]` | One franchise, with everything derived from its members. |
| `/anime/sync/[runId]` | The review screen. |

Every route has a `loading.tsx`, at the SEGMENT level. Next 16 does not prefetch
a dynamic route without one, and every route in this app is dynamic — so a
missing file costs both the skeleton and, invisibly, the warm navigation.

The sync entry point lives in **Settings → Anime → Sync**, matching where the
Games sync buttons live. When `ANILIST_USERNAME` is unset the button renders
disabled with a visible explanation naming the variable — never hidden, never
thrown.

---

## Known gaps, stated honestly

- **The AniList queries have never run against the live API.** The environment
  this module was built in rejects `graphql.anilist.co`, so every field name in
  `LIST_QUERY` and `ACTIVITY_QUERY` is from prior knowledge. The whole engine was
  verified end-to-end against a local stand-in answering at that hostname —
  client, shaping, chunked walk, staging, review, commit and the log's
  idempotency across two runs — which proves the plumbing and not the contract.
  Expect the query shapes to need correcting on first contact.
- **`MediaList.repeat` semantics are unconfirmed** — whether a third viewing is
  `repeat: 2` or `repeat: 3`. `runtime.ts` assumes it counts EXTRA viewings, and
  this scales every time-watched figure. Verify against real data and pin the
  test to an observed value.
- **`ListActivity` retention is unknown.** The log is only as complete as the
  feed; the watermark exists to say so rather than let it look like a bug.
- **Series grouping from `relations` will be partial.** Sequels chain cleanly;
  recaps, compilation films and side stories do not. That is why a `series_hint`
  is staged UNSELECTED with every member title listed for the owner to read, and
  why membership is editable from four directions — a manual pass is expected.
- **The airing-era chart plots only the years present**, so a gap between 1998
  and 2009 is one tick wide rather than eleven. Denser and free of empty-bar
  noise; it does understate a long absence.
