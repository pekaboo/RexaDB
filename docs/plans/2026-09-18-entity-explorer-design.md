# Entity Explorer & Relationships — Design Document

**Date:** 2026-09-18
**Status:** Approved (internal 5-person design review passed; 3 blockers resolved)
**Product area:** RexaDB Studio — schema intelligence & record navigation

## 1. Summary

Add two deeply integrated capabilities to RexaDB Studio:

1. **Relationships** — a relationship metadata layer that unions declared foreign keys with locally-stored *virtual relations* (business-convention FKs that were never declared in the database), plus a heuristic inference engine that proposes likely relations for user confirmation.
2. **Entity Explorer** — a global search + entity-page browser: search by any searchable column (e.g. a user's email), land on an entity page showing the full row, parent references, and every related table with counts; expand siblings inline (accordion), drill into children (stack navigation).

**Acceptance criterion (one sentence):** within 5 minutes, go from typing an email address to seeing three levels of related data for that user.

### Non-goals (v1)

- No DDL is ever generated from virtual relations. They live in local metadata only and never touch the target database.
- No data editing from Entity Explorer (read-only by mechanism, not convention).
- PostgreSQL only in v1; the layer must be dialect-agnostic so MySQL/MSSQL can follow.
- Composite-column relations are supported by the data model but not by the v1 UI.
- No auto-applied inference. Suggestions always land in a "pending confirmation" tray.

## 2. Positioning & prior art

Open-source landscape check (2026-09): DBeaver / Beekeeper / DbGate / ChartDB draw ER diagrams from declared FKs only. tbls supports YAML-declared relations without FK constraints but is a static doc generator. Datasette has row-level "who references this row" for SQLite. "Virtual foreign keys" exist only in commercial tools (DataGrip, DbSchema). **No open-source client combines manual implicit-FK annotation with an entity-centric related-data browser.** This is a genuine differentiator for RexaDB.

## 3. Architecture

```
                ┌───────────────────────────────────────────┐
                │   Relationship union layer                 │
                │   lib/db/relations/                        │
                │   ├─ relation-provider.ts  (dialect iface) │
                │   ├─ pg-provider.ts        (declared FKs   │
                │   │                        from cache)     │
                │   ├─ virtual-store.ts      (local SQLite)  │
                │   └─ merge.ts              (dedupe/conflict)│
                └───────────────┬───────────────┬───────────┘
                                │               │
              ┌─────────────────┘               └───────────────┐
              ▼                                                 ▼
   components/studio/database/                  components/studio/explorer/
   schema-diagram.tsx                           (search, entity page, stack)
   (adds dashed virtual edges)                  (new view, AG Grid based)
```

Key rule (review A1): the union layer exposes a dialect-agnostic `RelationProvider` interface. PG implementation reads declared FKs from the existing schema cache (`schemaCacheTables/Columns`) and virtual relations from local SQLite. A second database type = a new provider, not a rewrite.

### Data flow

Connection opens → schema pulled & cached (existing) → inference engine scans column profiles → suggestions appear in a pending tray → user accepts/edits/rejects → stored in `virtual_relations` → relationship union layer serves both the diagram and Entity Explorer in real time.

## 4. Local data model (SQLite via drizzle, `lib/db/schema.ts`)

```ts
virtual_relations = sqliteTable("virtual_relations", {
  id: integer primary key,
  connection_id: text not null,
  source_schema: text not null,
  source_table: text not null,
  source_columns: text not null,   // JSON array; v1 UI writes single-element arrays
  target_schema: text not null,
  target_table: text not null,
  target_columns: text not null,   // JSON array
  origin: text not null,           // 'manual' | 'inferred'
  label: text,                     // optional, e.g. "belongs to"
  created_at: integer not null,
  updated_at: integer not null,
}, (t) => ({
  uniq: uniqueIndex("vr_uniq").on(t.connection_id, t.source_schema, t.source_table,
    t.source_columns, t.target_schema, t.target_table, t.target_columns), // review A2
}));

searchable_columns = sqliteTable("searchable_columns", {
  id: integer primary key,
  connection_id: text not null,
  schema: text not null,
  table: text not null,
  column: text not null,
  enabled: integer not null default 1,
}, (t) => ({
  uniq: uniqueIndex("sc_uniq").on(t.connection_id, t.schema, t.table, t.column),
}));
```

Migration path: follow the existing `ensure-core-tables.ts` + `user-column-migrations.json` pattern.

**Conflict rule:** if a virtual relation duplicates a declared FK (same source/target/columns), the union layer keeps the declared one and surfaces the duplicate as a cleanup suggestion.

## 5. Inference engine (v1: one heuristic)

**Anti-garbage principle: nothing auto-applies. Suggestions wait for confirmation.**

- **H1 (high confidence):** column `X_id` / `XId` → table `X` (singular or plural) column `id` (or `uuid`). Requires: target table exists, types compatible (int↔int8, uuid↔uuid, text↔varchar), target column is PK or has a unique index.
- Future (not v1): many-to-many join-table detection, same-name column pairing.

**Verification action (manual, per suggestion):** sampled orphan check —

```sql
SELECT count(*) FROM (
  SELECT 1 FROM src
  WHERE src.col NOT IN (SELECT tgt.id FROM tgt)
  LIMIT 5000
);
```

Reports "orphan rate 0.3%" so the user confirms with data, not vibes.

Column profiling (types, PK/unique flags, sensitive-name flags) is computed once and shared by both the inference engine and the searchable-columns auto-picker (review A3 — one scanner, two consumers).

## 6. Relationships UI

- Schema diagram gains a second edge class: **dashed amber edges** for virtual relations (declared FKs stay solid). Legend included. Unconfirmed suggestions are hidden by default; toggle available (review C4).
- "Show only this table's neighbours" filter for large diagrams (review C4).
- **Relationships manager panel**: per-connection list of all relations (declared / virtual / origin), filterable; create/edit/delete virtual relations. Form skeleton reused from `add-fk-sheet.tsx`, but submission writes local metadata — never DDL. The existing `add-fk-sheet` (real constraints) remains a separate, parallel feature.

## 7. Entity Explorer

### 7.1 Global search (⌘K palette)

- Query strategy: per `(table, column)` in the enabled searchable set run `WHERE col ILIKE '%q%' LIMIT 5`. **Concurrency cap 4, per-query `statement_timeout` 2s, timed-out tables silently dropped and reported in the results footer (review B1).**
- If the input looks like an int/uuid, additionally run equality matches against numeric/uuid columns (index-friendly, instant).
- Default searchable set: PKs + short text columns with a unique index. Auto-pick **excludes** columns matching `password|secret|token|key|private` (reviews E4). Large tables must be added explicitly by the user.
- Results grouped by table, each hit shows *why* it matched (`users.email`) and the table's row-count magnitude (review C2).

### 7.2 Entity page

Route: `studio/[id]/explorer/[schema]/[table]?pk=<base64url(json-array)>`.

```
┌ User #1024  张三  zhang@x.com            [copy PK] [breadcrumb: users → orders → ◀]
├─ Fields card: all columns; long text truncated + expandable; JSON prettified;
│  bytea shown as hex badge (known trade-off: SELECT * with LIMIT 1 — review B3)
├─ 🔗 Parent chips: outgoing FK/virtual refs resolved to parent display value,
│  clickable both ways
├─ ▼ orders      ~1.2k (estimated) → on expand: exact count (timeout + cancel) + AG Grid
├─ ▶ payments    8 (exact)
└─ ▶ login_logs  ~15k (estimated)
```

- **Count strategy (review B2):** section headers show cheap `pg_class.reltuples` estimates first (pattern already used in `lib/db/advisor/checks/schema.ts`); exact `COUNT` runs only on expand, with statement timeout and cancellation.
- **Navigation stack:** clicking a row pushes a new entity page; breadcrumbs allow jumping back. If the target entity already exists in the stack, jump to it instead of pushing; drilling from a mid-stack node truncates the stale tail (browser-history semantics, review C1). Max depth 8.
- Large sections use AG Grid infinite scroll, not pagers (review C3).
- Display-field heuristic: first of `name/title/label/email/username`, else PK.

### 7.3 Read-only by mechanism (review E1 — blocker)

- Every Lens query passes the `lib/db/sql-guards.ts` read-only whitelist (the same mechanism proven by agent DB tools). No trust in "we only write SELECTs".
- All identifiers go through `quote-identifier` helpers; PK values are always parameterized via the existing `buildKeyConditions` pattern. No string concatenation into WHERE clauses, ever.
- Hard LIMIT ≤ 200 per page everywhere.

## 8. Backend surface

Server actions (matching existing studio patterns, e.g. `schema-introspection-actions.ts`):

- `getRelations(connectionId)` — merged union (declared + virtual), cached in memory, invalidated on writes
- `upsertVirtualRelation` / `deleteVirtualRelation`
- `suggestRelations(connectionId)` — run H1 over cached schema
- `verifyRelation(relationId)` — sampled orphan check
- `searchEntities(connectionId, query)` — bounded parallel search
- `getEntityCounts` / `getEntityRows` / `getEntityFields`

Future (M4): expose `entity_search` / `entity_get_related` in the agent tool registry (`tools/postgres`), unlocking AI-assisted "why is this user's data weird" workflows.

## 9. Error handling

| Failure | Behaviour |
|---|---|
| Connection dropped | Banner + retry; stack state preserved |
| Table dropped since cache (42P01) | Section shows "schema changed — refresh cache" action; page never blanks |
| Column missing (42703) | Same as above, scoped to section |
| RLS / permission denied on a table | Section shows "no access"; other sections unaffected (section-level isolation, review E3) |
| Search returns nothing | Hint that results may be filtered by RLS/permissions, not necessarily absent |
| Query timeout | Section/footer marks the table as timed-out; retry affordance |

## 10. Testing

- **Unit:** inference heuristics (fixture schemas incl. adversarial names), union dedupe/conflict rules, SQL builders (quoting, keyset pagination, search SQL), display-field heuristic, sensitive-column exclusion.
- **Integration (docker PG):** a deliberately FK-less e-commerce schema (`orders.user_id` with no constraint). Golden path: infer → accept → search email → entity page counts → drill into order → parent chip jumps back.
- **Manual E2E checklist** per milestone.

## 11. Milestones

| M | Scope | Exit criterion |
|---|---|---|
| M1 | Data model + union layer + RelationProvider abstraction + H1 inference + dashed edges on diagram | Virtual relation saved locally shows on diagram after refresh |
| M2 | Relationships manager panel + suggestion tray + verification action | Full CRUD of virtual relations, zero DDL emitted |
| M3 | Search palette + entity page (accordion + chips + stack + estimates) | Golden-path integration test green |
| M4 | Polish (display fields, JSON pretty, count UX, degradation) + agent tools | 5-minute acceptance criterion met on a real database |

## 12. Review record (2026-09-18, 5-person panel)

- **Blockers (all resolved in this document):**
  - A1 dialect-agnostic provider interface → §3
  - B1/B2 query-cost guards (timeouts, concurrency cap, estimate-first counts) → §7.1/§7.2
  - E1 mechanism-enforced read-only + parameterized keys → §7.3
- **Adopted yellows:** A2 unique index, A3 shared column profiler, C1 stack truncation, C4 neighbour filter + collapsed suggestions, D1 user-facing naming ("Entity Explorer" / "Relationships"), E4 sensitive-column exclusion.
- **Known trade-offs:** `SELECT *` single-row fetch (TOAST cost accepted); composite-column UI deferred; PG-only v1.
