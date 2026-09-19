/**
 * Relationship union layer for the Entity Explorer.
 *
 * Unions two sources of truth about table relationships:
 *  1. Declared foreign keys — introspected from the schema cache
 *     (CachedColumnRow.referenced_* fields).
 *  2. Virtual relations — business-convention FKs that were never declared
 *     in the database. Stored in local SQLite metadata only. NEVER generates
 *     DDL against the target database.
 *
 * Also hosts the H1 inference heuristic: column `X_id` → table `X` primary
 * key, with type compatibility. Suggestions are proposals only — they are
 * never auto-applied; the user accepts them explicitly (stored with
 * origin='inferred') or creates relations manually (origin='manual').
 */

import type { CachedColumnRow } from "./schema-cache-actions";

// ─── Types ──────────────────────────────────────────────────────────────

export type RelationEndpoint = {
  schema: string;
  table: string;
  column: string;
};

export type MergedRelation = {
  /** source (child, FK side) → target (parent, referenced side) */
  source: RelationEndpoint;
  target: RelationEndpoint;
  origin: "declared" | "virtual";
  /** present when origin === "virtual" */
  virtualId?: number;
  virtualOrigin?: "manual" | "inferred";
  label?: string | null;
  /**
   * True when a virtual relation duplicates a declared FK
   * (same endpoints). Declared wins in the union; the duplicate is
   * surfaced so the UI can suggest cleanup.
   */
  duplicatesDeclared?: boolean;
};

export type RelationSuggestion = {
  source: RelationEndpoint;
  target: RelationEndpoint;
  confidence: "high";
  reason: string;
};

export type VirtualRelationInput = {
  sourceSchema: string;
  sourceTable: string;
  sourceColumns: string[];
  targetSchema: string;
  targetTable: string;
  targetColumns: string[];
  origin?: "manual" | "inferred";
  label?: string | null;
};

export type VirtualRelationRecord = {
  id: number;
  source: RelationEndpoint & { columns: string[] };
  target: RelationEndpoint & { columns: string[] };
  origin: "manual" | "inferred";
  label: string | null;
  createdAt: number;
  updatedAt: number;
};

// ─── Declared FK extraction (pure) ──────────────────────────────────────

/** Extract declared FK relations from cached column rows (pure function). */
export function extractDeclaredRelations(columns: CachedColumnRow[]): MergedRelation[] {
  const out: MergedRelation[] = [];
  const seen = new Set<string>();
  for (const col of columns) {
    const refSchema = col.referenced_table_schema;
    const refTable = col.referenced_table_name;
    const refColumn = col.referenced_column_name;
    if (!refSchema || !refTable || !refColumn) continue;
    const key = `${col.table_schema}|${col.table_name}|${col.column_name}|${refSchema}|${refTable}|${refColumn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: { schema: col.table_schema, table: col.table_name, column: col.column_name },
      target: { schema: refSchema, table: refTable, column: refColumn },
      origin: "declared",
    });
  }
  return out;
}

// ─── Virtual relation store (local SQLite) ──────────────────────────────

function relationKey(r: {
  sourceSchema: string; sourceTable: string; sourceColumns: string[];
  targetSchema: string; targetTable: string; targetColumns: string[];
}): string {
  return [
    r.sourceSchema, r.sourceTable, JSON.stringify([...r.sourceColumns].sort()),
    r.targetSchema, r.targetTable, JSON.stringify([...r.targetColumns].sort()),
  ].join("|");
}

async function requireConnectionString(connectionString: string): Promise<string> {
  const cs = String(connectionString || "").trim();
  if (!cs) throw new Error("No database connection selected.");
  return cs;
}

// ─── Stable connection identity ─────────────────────────────────────────

/**
 * Virtual relations are semantic metadata about a DATABASE, not about a
 * particular connection entry. The same database is reachable under
 * different hosts/ports/params (tunnel vs direct, keychain password vs
 * URL password), so keying metadata by the raw connection string makes
 * it vanish whenever the connection entry changes. PostgreSQL exposes a
 * cluster-stable `system_identifier`; combined with the database name it
 * identifies the target regardless of how we connected. Falls back to
 * host:port:db parsing when the identity query cannot run (retried after
 * 60s in case the database was merely unreachable).
 */
const identityCache = new Map<string, { key: string; expiresAt: number }>();

export async function getConnectionIdentity(connectionString: string): Promise<string> {
  const cs = String(connectionString || "").trim();
  if (!cs) return "";
  const hit = identityCache.get(cs);
  if (hit && (hit.expiresAt === 0 || Date.now() < hit.expiresAt)) return hit.key;

  let key = "";
  try {
    const { executeQuery } = await import("./pg-client");
    const query = executeQuery(cs, "SELECT current_database() AS db, system_identifier AS sid FROM pg_control_system()", [], { queryId: "relations.identity" })
      .catch(() => null) as Promise<{ rows: Array<{ db?: string; sid?: string | bigint }> } | null>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 5_000);
    });
    const winner = await Promise.race([query, timeout]);
    if (timer) clearTimeout(timer);
    const rows = winner?.rows;
    const sid = rows?.[0]?.sid;
    const db = rows?.[0]?.db;
    if (sid && db) key = `pgsys:${sid}:${db}`;
  } catch {
    // fall through to host-based key
  }

  let expiresAt = 0;
  if (!key) {
    try {
      const u = new URL(cs);
      key = `pghost:${u.hostname}:${u.port || "5432"}:${u.pathname.replace(/^\//, "")}`;
    } catch {
      key = `csraw:${cs}`;
    }
    expiresAt = Date.now() + 60_000; // retry the real identity later
  }
  identityCache.set(cs, { key, expiresAt });
  return key;
}

async function getDeps() {
  const { db } = await import("./index");
  const { virtualRelations } = await import("./schema");
  const { eq, and } = await import("drizzle-orm");
  const { ensureCoreTables } = await import("./ensure-core-tables");
  await ensureCoreTables();
  return { db, virtualRelations, eq, and };
}

function toRecord(row: {
  id: number;
  sourceSchema: string;
  sourceTable: string;
  sourceColumns: string;
  targetSchema: string;
  targetTable: string;
  targetColumns: string;
  origin: string;
  label: string | null;
  createdAt: number;
  updatedAt: number;
}): VirtualRelationRecord {
  let sourceColumns: string[] = [];
  let targetColumns: string[] = [];
  try { sourceColumns = JSON.parse(row.sourceColumns) || []; } catch { sourceColumns = []; }
  try { targetColumns = JSON.parse(row.targetColumns) || []; } catch { targetColumns = []; }
  return {
    id: row.id,
    source: {
      schema: row.sourceSchema,
      table: row.sourceTable,
      column: sourceColumns[0] ?? "",
      columns: sourceColumns,
    },
    target: {
      schema: row.targetSchema,
      table: row.targetTable,
      column: targetColumns[0] ?? "",
      columns: targetColumns,
    },
    origin: row.origin === "inferred" ? "inferred" : "manual",
    label: row.label,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listVirtualRelations(connectionString: string): Promise<VirtualRelationRecord[]> {
  const { db, virtualRelations, eq } = await getDeps();
  const identity = await getConnectionIdentity(await requireConnectionString(connectionString));
  const rows = await db.select().from(virtualRelations).where(eq(virtualRelations.connectionString, identity));
  return rows.map(toRecord).sort((a, b) =>
    `${a.source.schema}.${a.source.table}`.localeCompare(`${b.source.schema}.${b.source.table}`));
}

export async function upsertVirtualRelation(
  connectionString: string,
  input: VirtualRelationInput,
): Promise<{ success: boolean; error?: string; data?: VirtualRelationRecord }> {
  const srcCols = (input.sourceColumns || []).map(String).filter(Boolean);
  const tgtCols = (input.targetColumns || []).map(String).filter(Boolean);
  if (!input.sourceSchema || !input.sourceTable || srcCols.length === 0) {
    return { success: false, error: "Source schema, table and at least one column are required." };
  }
  if (!input.targetSchema || !input.targetTable || tgtCols.length === 0) {
    return { success: false, error: "Target schema, table and at least one column are required." };
  }
  if (srcCols.length !== tgtCols.length) {
    return { success: false, error: "Source and target column counts must match." };
  }

  const { db, virtualRelations, eq, and } = await getDeps();
  const identity = await getConnectionIdentity(await requireConnectionString(connectionString));
  const now = Date.now();
  const origin: "manual" | "inferred" = input.origin === "inferred" ? "inferred" : "manual";
  const values = {
    connectionString: identity,
    sourceSchema: input.sourceSchema,
    sourceTable: input.sourceTable,
    sourceColumns: JSON.stringify(srcCols),
    targetSchema: input.targetSchema,
    targetTable: input.targetTable,
    targetColumns: JSON.stringify(tgtCols),
    origin,
    label: input.label ?? null,
    updatedAt: now,
  };

  const existing = await db
    .select()
    .from(virtualRelations)
    .where(and(
      eq(virtualRelations.connectionString, identity),
      eq(virtualRelations.sourceSchema, input.sourceSchema),
      eq(virtualRelations.sourceTable, input.sourceTable),
      eq(virtualRelations.sourceColumns, JSON.stringify(srcCols)),
      eq(virtualRelations.targetSchema, input.targetSchema),
      eq(virtualRelations.targetTable, input.targetTable),
      eq(virtualRelations.targetColumns, JSON.stringify(tgtCols)),
    ));

  let row;
  if (existing.length > 0) {
    const updated = await db
      .update(virtualRelations)
      .set({ label: input.label ?? null, origin: values.origin, updatedAt: now })
      .where(eq(virtualRelations.id, existing[0].id))
      .returning();
    row = updated[0];
  } else {
    const inserted = await db
      .insert(virtualRelations)
      .values({ ...values, createdAt: now })
      .returning();
    row = inserted[0];
  }
  return { success: true, data: toRecord(row) };
}

export async function deleteVirtualRelation(connectionString: string, id: number): Promise<{ success: boolean; error?: string }> {
  const { db, virtualRelations, eq, and } = await getDeps();
  const identity = await getConnectionIdentity(await requireConnectionString(connectionString));
  await db.delete(virtualRelations).where(and(
    eq(virtualRelations.connectionString, identity),
    eq(virtualRelations.id, id),
  ));
  return { success: true };
}

/**
 * One-time migration: rows written before identity keying landed are
 * keyed by raw connection URLs. Rewrite them to identity keys so they
 * surface under every connection entry that reaches the same database.
 * Unreachable databases are skipped and retried on the next boot.
 */
export async function migrateVirtualRelationKeysToIdentity(): Promise<{ migrated: number; skipped: number }> {
  const { db, virtualRelations, eq } = await getDeps();
  const rows = await db.selectDistinct({ cs: virtualRelations.connectionString }).from(virtualRelations);
  let migrated = 0;
  let skipped = 0;
  for (const { cs } of rows) {
    if (cs.startsWith("pgsys:") || cs.startsWith("pghost:") || cs.startsWith("csraw:")) continue;
    let identity: string;
    try {
      identity = await getConnectionIdentity(cs);
    } catch {
      skipped++;
      continue;
    }
    if (!identity || identity === cs || identity.startsWith("csraw:")) {
      skipped++;
      continue;
    }
    try {
      await db.update(virtualRelations).set({ connectionString: identity }).where(eq(virtualRelations.connectionString, cs));
      migrated++;
    } catch {
      // Unique-index collision: the same relation already exists under the
      // identity key — the raw-keyed duplicate loses.
      await db.delete(virtualRelations).where(eq(virtualRelations.connectionString, cs));
      migrated++;
    }
  }
  return { migrated, skipped };
}

// ─── Union layer ────────────────────────────────────────────────────────

/**
 * Merge declared FK relations with virtual relations. Declared wins on
 * endpoint collision; the duplicate virtual relation is flagged with
 * `duplicatesDeclared` so the UI can suggest cleanup.
 */
export function mergeRelations(
  declared: MergedRelation[],
  virtual: VirtualRelationRecord[],
): MergedRelation[] {
  const declaredKeys = new Set(declared.map((r) => relationKey({
    sourceSchema: r.source.schema, sourceTable: r.source.table, sourceColumns: [r.source.column],
    targetSchema: r.target.schema, targetTable: r.target.table, targetColumns: [r.target.column],
  })));
  const out: MergedRelation[] = [...declared];
  for (const v of virtual) {
    const asMerged: MergedRelation = {
      source: { schema: v.source.schema, table: v.source.table, column: v.source.column },
      target: { schema: v.target.schema, table: v.target.table, column: v.target.column },
      origin: "virtual",
      virtualId: v.id,
      virtualOrigin: v.origin,
      label: v.label,
    };
    const key = relationKey({
      sourceSchema: v.source.schema, sourceTable: v.source.table, sourceColumns: v.source.columns,
      targetSchema: v.target.schema, targetTable: v.target.table, targetColumns: v.target.columns,
    });
    if (declaredKeys.has(key)) {
      asMerged.duplicatesDeclared = true;
    }
    out.push(asMerged);
  }
  return out;
}

/** Cached columns accessor (schema cache first, live introspection fallback). */
export async function fetchColumnsForRelations(connectionString: string): Promise<CachedColumnRow[]> {
  const { fetchAllTablesWithColumns } = await import("./actions-core");
  const result = await fetchAllTablesWithColumns(connectionString, { cacheMaxAgeMs: 5 * 60_000 });
  if (result?.success && Array.isArray(result.data)) return result.data as CachedColumnRow[];
  return [];
}

export type MergedRelationsResult = {
  declared: MergedRelation[];
  virtual: MergedRelation[];
  all: MergedRelation[];
  duplicates: MergedRelation[];
};

export async function getMergedRelations(connectionString: string): Promise<MergedRelationsResult> {
  await requireConnectionString(connectionString);
  const [columns, virtual] = await Promise.all([
    fetchColumnsForRelations(connectionString),
    listVirtualRelations(connectionString),
  ]);
  const declared = extractDeclaredRelations(columns);
  const all = mergeRelations(declared, virtual);
  const virtualMerged = all.filter((r) => r.origin === "virtual");
  return {
    declared,
    virtual: virtualMerged,
    all,
    duplicates: virtualMerged.filter((r) => r.duplicatesDeclared),
  };
}

// ─── Inference engine (H1) ──────────────────────────────────────────────

const INT_TYPES = new Set(["smallint", "integer", "bigint", "int", "int2", "int4", "int8", "serial", "bigserial", "smallserial"]);
const UUID_TYPES = new Set(["uuid"]);
const TEXT_TYPES = new Set(["text", "character varying", "varchar", "character", "char", "name"]);

function normalizeType(dt: string | null): string {
  return String(dt || "").toLowerCase().trim().replace(/\(\d+(,\d+)?\)/g, "").trim();
}

export function typesCompatible(a: string | null, b: string | null): boolean {
  const ta = normalizeType(a);
  const tb = normalizeType(b);
  if (!ta || !tb) return false;
  if (ta === tb) return true;
  if (INT_TYPES.has(ta) && INT_TYPES.has(tb)) return true;
  if (UUID_TYPES.has(ta) && UUID_TYPES.has(tb)) return true;
  if (TEXT_TYPES.has(ta) && TEXT_TYPES.has(tb)) return true;
  return false;
}

/** user → users, users → user, categories → category (best-effort pluralization). */
export function nameVariants(name: string): string[] {
  const n = name.toLowerCase();
  const out = new Set<string>([n]);
  if (n.endsWith("ies")) out.add(`${n.slice(0, -3)}y`);
  if (n.endsWith("ses")) out.add(n.slice(0, -2));
  if (n.endsWith("es")) out.add(n.slice(0, -2));
  if (n.endsWith("s")) out.add(n.slice(0, -1));
  if (n.endsWith("y")) out.add(`${n.slice(0, -1)}ies`);
  out.add(`${n}s`);
  out.add(`${n}es`);
  return Array.from(out);
}

/** Extract the base name from an FK-ish column name: user_id → user. */
export function fkBaseName(columnName: string): string | null {
  const n = columnName.toLowerCase();
  const m = n.match(/^(.+?)(_?id|_?uuid|_?key)$/);
  if (!m) return null;
  const base = m[1];
  return base && base.length >= 2 ? base : null;
}

export type ColumnIndex = {
  /** `${schema}|${table}` → rows */
  byTable: Map<string, CachedColumnRow[]>;
  /** `${schema}|${table}` → PK column rows (ordered) */
  pkByTable: Map<string, CachedColumnRow[]>;
  /** `${schema}|${table}` → table name variants for reverse lookup */
  tableNames: Array<{ schema: string; table: string }>;
};

export function buildColumnIndex(columns: CachedColumnRow[]): ColumnIndex {
  const byTable = new Map<string, CachedColumnRow[]>();
  const pkByTable = new Map<string, CachedColumnRow[]>();
  const tableNames: Array<{ schema: string; table: string }> = [];
  for (const col of columns) {
    const key = `${col.table_schema}|${col.table_name}`;
    let rows = byTable.get(key);
    if (!rows) {
      rows = [];
      byTable.set(key, rows);
      tableNames.push({ schema: col.table_schema, table: col.table_name });
    }
    rows.push(col);
    if (col.is_primary) {
      let pk = pkByTable.get(key);
      if (!pk) { pk = []; pkByTable.set(key, pk); }
      pk.push(col);
    }
  }
  return { byTable, pkByTable, tableNames };
}

/**
 * H1 heuristic: for every column named `X_id` / `XId` / `X_uuid` / `X_key`
 * that is NOT already part of a declared FK or an existing virtual
 * relation, propose `source.X_id → <table matching X>.<pk>` when a
 * candidate table exists, its PK is a single column, and types are
 * compatible.
 *
 * Pure function — suggestions are returned, never stored.
 */
export function suggestRelationsFromColumns(
  columns: CachedColumnRow[],
  existing: MergedRelation[],
): RelationSuggestion[] {
  const index = buildColumnIndex(columns);

  // Fast lookup: variant name (lowercased) → tables with that name
  const tablesByName = new Map<string, Array<{ schema: string; table: string }>>();
  for (const t of index.tableNames) {
    const lower = t.table.toLowerCase();
    let list = tablesByName.get(lower);
    if (!list) { list = []; tablesByName.set(lower, list); }
    list.push(t);
  }

  const existingKeys = new Set(existing.map((r) =>
    `${r.source.schema}|${r.source.table}|${r.source.column}`));

  const suggestions: RelationSuggestion[] = [];
  const suggestedKeys = new Set<string>();

  for (const t of index.tableNames) {
    const rows = index.byTable.get(`${t.schema}|${t.table}`) || [];
    for (const col of rows) {
      if (col.is_primary) continue;
      // Skip columns that already participate in any relation (declared or virtual)
      if (existingKeys.has(`${t.schema}|${t.table}|${col.column_name}`)) continue;
      if (col.referenced_table_name) continue;

      const base = fkBaseName(col.column_name);
      if (!base) continue;

      for (const variant of nameVariants(base)) {
        const candidates = tablesByName.get(variant);
        if (!candidates || candidates.length === 0) continue;

        for (const cand of candidates) {
          // Never self-reference from a plain X_id on the X table itself
          // (e.g. users.user_id → users is usually a different pattern).
          if (cand.schema === t.schema && cand.table === t.table) continue;

          const pk = index.pkByTable.get(`${cand.schema}|${cand.table}`);
          if (!pk || pk.length !== 1) continue;
          const pkCol = pk[0];
          if (!typesCompatible(col.data_type, pkCol.data_type)) continue;

          const key = `${t.schema}|${t.table}|${col.column_name}|${cand.schema}|${cand.table}|${pkCol.column_name}`;
          if (suggestedKeys.has(key)) continue;
          suggestedKeys.add(key);

          suggestions.push({
            source: { schema: t.schema, table: t.table, column: col.column_name },
            target: { schema: cand.schema, table: cand.table, column: pkCol.column_name },
            confidence: "high",
            reason: `Column "${col.column_name}" looks like a reference to "${cand.table}" (${pkCol.column_name}), types compatible (${normalizeType(col.data_type)} ↔ ${normalizeType(pkCol.data_type)})`,
          });
        }
      }
    }
  }

  return suggestions;
}

export async function suggestRelations(connectionString: string): Promise<{ success: boolean; data?: RelationSuggestion[]; error?: string }> {
  try {
    await requireConnectionString(connectionString);
    const merged = await getMergedRelations(connectionString);
    const columns = await fetchColumnsForRelations(connectionString);
    return { success: true, data: suggestRelationsFromColumns(columns, merged.all) };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

// ─── Verification (sampled orphan check) ────────────────────────────────

/**
 * Sampled orphan check for a proposed relation: what fraction of sampled
 * non-null source values has no matching parent row? Uses a bounded
 * sample so it stays cheap on large tables.
 */
export async function verifyRelation(
  connectionString: string,
  input: { sourceSchema: string; sourceTable: string; sourceColumn: string; targetSchema: string; targetTable: string; targetColumn: string },
): Promise<{ success: boolean; data?: { sampled: number; orphans: number; orphanRate: number }; error?: string }> {
  try {
    await requireConnectionString(connectionString);
    const { executeQuery } = await import("./pg-client");
    const { quotePgIdentifier } = await import("./quote-identifier");
    const srcCol = quotePgIdentifier(input.sourceColumn);
    const tgtCol = quotePgIdentifier(input.targetColumn);
    const srcTable = `${quotePgIdentifier(input.sourceSchema)}.${quotePgIdentifier(input.sourceTable)}`;
    const tgtTable = `${quotePgIdentifier(input.targetSchema)}.${quotePgIdentifier(input.targetTable)}`;

    const sql = `
      WITH sample AS (
        SELECT ${srcCol} AS v FROM ${srcTable}
        WHERE ${srcCol} IS NOT NULL
        LIMIT 5000
      )
      SELECT
        count(*)::int AS sampled,
        count(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM ${tgtTable} t WHERE t.${tgtCol} = sample.v
        ))::int AS orphans
      FROM sample`;

    // Mechanism-enforced read-only: same guard as every other query.
    const { ensureReadOnlySql } = await import("./sql-guards");
    ensureReadOnlySql(sql);

    const result = await executeQuery(connectionString, sql);
    const row = result?.rows?.[0] || { sampled: 0, orphans: 0 };
    const sampled = Number(row.sampled) || 0;
    const orphans = Number(row.orphans) || 0;
    return {
      success: true,
      data: {
        sampled,
        orphans,
        orphanRate: sampled > 0 ? orphans / sampled : 0,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
