/**
 * Entity Explorer server actions.
 *
 * Backs the Entity Explorer view: global entity search, entity overview
 * (row + parent references + related-table counts), and paginated related
 * rows. Every query goes through `ensureReadOnlySql` (mechanism-enforced
 * read-only), identifiers are quoted via `quoteIdentifier`, and values are
 * always parameterized — no string concatenation into WHERE clauses.
 *
 * Query-cost guards (per design review B1/B2):
 *  - search: concurrency cap 4, per-table statement timeout 2s, timed-out
 *    tables dropped and reported; ILIKE skipped on tables with estimated
 *    rows > 2M unless explicitly enabled
 *  - counts: reltuples estimate first; exact COUNT only on expand, with a
 *    5s timeout + server-side cancellation
 */

import { ensureReadOnlySql } from "./sql-guards";
import { quotePgIdentifier } from "./quote-identifier";
import type { CachedColumnRow } from "./schema-cache-actions";
import {
  getMergedRelations,
  fetchColumnsForRelations,
  type MergedRelation,
} from "./relations";

const SEARCH_CONCURRENCY = 4;
const SEARCH_TIMEOUT_MS = 2_000;
const SEARCH_MAX_PER_TABLE = 5;
const SEARCH_MAX_TOTAL = 100;
const COUNT_TIMEOUT_MS = 5_000;
const RELATED_PAGE_SIZE = 100;
const ILIKE_ROW_ESTIMATE_LIMIT = 2_000_000;

const SENSITIVE_COLUMN_PATTERN = /(password|passwd|secret|token|api_?key|private)/i;

type PgClientModule = typeof import("./pg-client");

async function getPgClient(): Promise<PgClientModule> {
  return import("./pg-client");
}

/** Convert `?` placeholders to PostgreSQL `$n` style, in order. */
function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/** Execute a read-only query with a JS-side timeout + server-side cancel. */
async function executeReadOnlyWithTimeout(
  connectionString: string,
  sql: string,
  params: unknown[],
  timeoutMs: number,
): Promise<{ rows: Record<string, unknown>[] }> {
  const finalSql = toPgPlaceholders(sql);
  ensureReadOnlySql(finalSql);
  const { executeQuery, cancelQueryById } = await getPgClient();
  const queryId = `entity-explorer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      timedOut = true;
      cancelQueryById(queryId).catch(() => {});
      reject(new Error(`Query timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      executeQuery(connectionString, finalSql, params as any[], { queryId }),
      timeoutPromise,
    ]);
    return { rows: Array.isArray(result?.rows) ? result.rows : [] };
  } finally {
    if (timedOut) {
      cancelQueryById(queryId).catch(() => {});
    }
  }
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task();
    }
  });
  await Promise.all(workers);
}

// ─── Column / PK helpers ────────────────────────────────────────────────

export function getTableColumns(columns: CachedColumnRow[], schema: string, table: string): CachedColumnRow[] {
  return columns.filter(
    (c) => c.table_schema.toLowerCase() === schema.toLowerCase() && c.table_name.toLowerCase() === table.toLowerCase(),
  );
}

export function getTablePkColumns(columns: CachedColumnRow[], schema: string, table: string): CachedColumnRow[] {
  const cols = getTableColumns(columns, schema, table).filter((c) => c.is_primary);
  // Preserve catalog order — CachedColumnRow rows arrive ordered by ordinal
  // position, and .filter keeps that order.
  return cols;
}

/** Display-field heuristic: name/title/label/email/username/phone → first text column → PK. */
export function pickDisplayColumn(cols: CachedColumnRow[]): string | null {
  if (cols.length === 0) return null;
  const preference = ["name", "title", "label", "email", "username", "phone", "display_name", "full_name", "slug", "code"];
  const lower = new Map(cols.map((c) => [c.column_name.toLowerCase(), c]));
  for (const p of preference) {
    const hit = lower.get(p);
    if (hit) return hit.column_name;
  }
  const firstText = cols.find((c) => {
    const dt = String(c.data_type || "").toLowerCase();
    return dt.startsWith("text") || dt.startsWith("character") || dt.startsWith("varchar") || dt === "name";
  });
  if (firstText) return firstText.column_name;
  const pk = cols.find((c) => c.is_primary);
  return (pk ?? cols[0]).column_name;
}

// ─── Row estimates ──────────────────────────────────────────────────────

/** Guard: reject calls with no connection selected (tab can open before a
 * connection is picked in some flows). */
function ensureCs(connectionString: string): string {
  const cs = String(connectionString || "").trim();
  if (!cs) throw new Error("No database connection selected.");
  return cs;
}

export async function getRowEstimates(connectionString: string): Promise<Map<string, number>> {
  ensureCs(connectionString);
  const { rows } = await executeReadOnlyWithTimeout(
    connectionString,
    `SELECT n.nspname AS schema_name, c.relname AS table_name, c.reltuples::bigint AS est_rows
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r'
       AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`,
    [],
    5_000,
  );
  const map = new Map<string, number>();
  for (const row of rows) {
    const est = Number(row.est_rows);
    if (Number.isFinite(est) && est >= 0) {
      map.set(`${String(row.schema_name)}|${String(row.table_name)}`, est);
    }
  }
  return map;
}

// ─── Search ─────────────────────────────────────────────────────────────

export type SearchableColumn = {
  schema: string;
  table: string;
  column: string;
  data_type: string | null;
  is_primary: boolean;
  kind: "text" | "eq";
};

export type EntitySearchHit = {
  schema: string;
  table: string;
  column: string;
  value: string;
  pkValues: Record<string, unknown>;
  display: string | null;
};

async function getSearchableDeps() {
  const { db } = await import("./index");
  const { searchableColumns } = await import("./schema");
  const { eq } = await import("drizzle-orm");
  const { ensureCoreTables } = await import("./ensure-core-tables");
  await ensureCoreTables();
  return { db, searchableColumns, eq };
}

export async function getSearchableColumnConfig(connectionString: string): Promise<{ rows: Array<{ schema: string; table: string; column: string; enabled: boolean }> }> {
  const { db, searchableColumns, eq } = await getSearchableDeps();
  const { getConnectionIdentity } = await import("./relations");
  const identity = await getConnectionIdentity(connectionString);
  const rows = await db.select().from(searchableColumns).where(eq(searchableColumns.connectionString, identity));
  return {
    rows: rows.map((r: any) => ({
      schema: r.schemaName,
      table: r.tableName,
      column: r.columnName,
      enabled: Boolean(r.enabled),
    })),
  };
}

export async function saveSearchableColumnConfig(
  connectionString: string,
  entries: Array<{ schema: string; table: string; column: string; enabled: boolean }>,
): Promise<{ success: boolean; error?: string }> {
  const { db, searchableColumns, eq } = await getSearchableDeps();
  const { getConnectionIdentity } = await import("./relations");
  const identity = await getConnectionIdentity(connectionString);
  await db.delete(searchableColumns).where(eq(searchableColumns.connectionString, identity));
  const valid = (entries || []).filter((e) => e && e.schema && e.table && e.column);
  if (valid.length > 0) {
    await db.insert(searchableColumns).values(
      valid.map((e) => ({
        connectionString: identity,
        schemaName: e.schema,
        tableName: e.table,
        columnName: e.column,
        enabled: e.enabled !== false,
      })),
    );
  }
  return { success: true };
}

/**
 * Effective searchable set. Explicitly configured rows (if any exist)
 * replace the auto-picked defaults. Auto-pick: PK columns (equality) +
 * non-sensitive text columns (ILIKE). Sensitive column names are always
 * excluded from auto-pick.
 */
export async function computeSearchableColumns(connectionString: string): Promise<SearchableColumn[]> {
  ensureCs(connectionString);
  const [config, columns] = await Promise.all([
    getSearchableColumnConfig(connectionString),
    fetchColumnsForRelations(connectionString),
  ]);

  if (config.rows.length > 0) {
    const out: SearchableColumn[] = [];
    for (const row of config.rows) {
      if (row.enabled === false) continue;
      const col = columns.find(
        (c) =>
          c.table_schema.toLowerCase() === row.schema.toLowerCase() &&
          c.table_name.toLowerCase() === row.table.toLowerCase() &&
          c.column_name.toLowerCase() === row.column.toLowerCase(),
      );
      const dt = String(col?.data_type || "text").toLowerCase();
      out.push({
        schema: col ? col.table_schema : row.schema,
        table: col ? col.table_name : row.table,
        column: col ? col.column_name : row.column,
        data_type: col?.data_type ?? null,
        is_primary: Boolean(col?.is_primary),
        kind: isTextType(dt) ? "text" : "eq",
      });
    }
    return out;
  }

  const byTable = new Map<string, CachedColumnRow[]>();
  for (const col of columns) {
    const key = `${col.table_schema}|${col.table_name}`;
    const list = byTable.get(key) || [];
    list.push(col);
    byTable.set(key, list);
  }

  const out: SearchableColumn[] = [];
  for (const [key, cols] of byTable) {
    const [schema, table] = key.split("|");
    const pk = pickTablePk(cols);
    if (pk) {
      out.push({ schema, table, column: pk.column_name, data_type: pk.data_type, is_primary: true, kind: "eq" });
    }
    for (const col of cols) {
      if (col.is_primary) continue;
      const dt = String(col.data_type || "").toLowerCase();
      if (!isTextType(dt)) continue;
      if (SENSITIVE_COLUMN_PATTERN.test(col.column_name)) continue;
      out.push({ schema, table, column: col.column_name, data_type: col.data_type, is_primary: false, kind: "text" });
    }
  }
  return out;
}

function pickTablePk(cols: CachedColumnRow[]): CachedColumnRow | null {
  const pks = cols.filter((c) => c.is_primary);
  if (pks.length === 1) return pks[0];
  return null;
}

function isTextType(dt: string): boolean {
  return dt.startsWith("text") || dt.startsWith("character varying") || dt.startsWith("varchar") || dt.startsWith("char") || dt === "name" || dt === "citext";
}

function isIntType(dt: string): boolean {
  return ["smallint", "integer", "bigint", "int", "int2", "int4", "int8", "serial", "bigserial"].includes(dt.replace(/\(\d+\)/g, "").trim());
}

function isUuidType(dt: string): boolean {
  return dt.trim() === "uuid";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function searchEntities(
  connectionString: string,
  term: string,
  options?: { schema?: string; table?: string },
): Promise<{ success: boolean; data?: EntitySearchHit[]; error?: string; timedOutTables?: string[] }> {
  const trimmed = String(term || "").trim();
  if (!trimmed || trimmed.length < 1) return { success: true, data: [] };
  ensureCs(connectionString);

  // Warm the connection pool FIRST, with its own generous budget — a cold
  // pool (fresh TCP + auth, possibly via the libpqcompat proxy path) can
  // take seconds to establish, and that latency must not eat the per-table
  // query budget (it produced bogus "skipped slow table" reports on tiny
  // tables when the pool happened to be cold).
  await executeReadOnlyWithTimeout(connectionString, "SELECT 1", [], 10_000).catch(() => {});

  let filtered = await computeSearchableColumns(connectionString);
  if (options?.schema) {
    filtered = filtered.filter((s) => s.schema.toLowerCase() === options.schema!.toLowerCase());
  }
  if (options?.table) {
    filtered = filtered.filter((s) => s.table.toLowerCase() === options.table!.toLowerCase());
  }
  if (filtered.length === 0) return { success: true, data: [] };

  const looksLikeInt = /^-?\d+$/.test(trimmed);
  const looksLikeUuid = UUID_RE.test(trimmed);
  const ilikeParam = `%${trimmed}%`;

  // Group by table for one query per table
  const byTable = new Map<string, SearchableColumn[]>();
  for (const col of filtered) {
    const key = `${col.schema}|${col.table}`;
    const list = byTable.get(key) || [];
    list.push(col);
    byTable.set(key, list);
  }

  // Cheap size gate: skip ILIKE on huge tables (unless the searchable set
  // was explicitly configured, in which case the user opted in).
  const explicitlyConfigured = (await getSearchableColumnConfig(connectionString)).rows.length > 0;
  // Scoped search (a main table was picked) gets a longer budget: the user
  // explicitly wants THIS table searched, so allow big seq scans.
  const perTableTimeoutMs = options?.table ? 10_000 : SEARCH_TIMEOUT_MS;
  let estimates = new Map<string, number>();
  if (!explicitlyConfigured) {
    try {
      estimates = await getRowEstimates(connectionString);
    } catch {
      estimates = new Map();
    }
  }

  const columnsCache = await fetchColumnsForRelations(connectionString);
  const hits: EntitySearchHit[] = [];
  const timedOutTables: string[] = [];

  const tasks = Array.from(byTable.entries()).map(([key, cols]) => async () => {
    if (hits.length >= SEARCH_MAX_TOTAL) return;
    const [schema, table] = key.split("|");
    const tableCols = getTableColumns(columnsCache, schema, table);
    const pkCols = getTablePkColumns(columnsCache, schema, table);
    const displayCol = pickDisplayColumn(tableCols);

    const textCols = cols.filter((c) => c.kind === "text");
    const eqCols = cols.filter((c) => c.kind === "eq" || (looksLikeInt && isIntType(String(c.data_type || ""))) || (looksLikeUuid && isUuidType(String(c.data_type || ""))));

    const est = estimates.get(key);
    const allowIlike = explicitlyConfigured || est === undefined || est < ILIKE_ROW_ESTIMATE_LIMIT;

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (allowIlike && textCols.length > 0 && trimmed.length >= 2) {
      conditions.push(
        textCols.map((c) => `CAST(${quotePgIdentifier(c.column)} AS TEXT) ILIKE ?`).join(" OR "),
      );
      textCols.forEach(() => params.push(ilikeParam));
    }
    if (eqCols.length > 0) {
      const eqVal = looksLikeInt ? trimmed.replace(/[^0-9-]/g, "") : looksLikeUuid ? trimmed.toLowerCase() : null;
      if (eqVal !== null) {
        conditions.push(
          eqCols.map((c) => `CAST(${quotePgIdentifier(c.column)} AS TEXT) = ?`).join(" OR "),
        );
        eqCols.forEach(() => params.push(eqVal));
      } else if (eqCols.some((c) => isTextType(String(c.data_type || "").toLowerCase()))) {
        // Exact text match on PK-ish text columns (cheap equality)
        const textEqCols = eqCols.filter((c) => isTextType(String(c.data_type || "").toLowerCase()));
        conditions.push(
          textEqCols.map((c) => `CAST(${quotePgIdentifier(c.column)} AS TEXT) = ?`).join(" OR "),
        );
        textEqCols.forEach(() => params.push(trimmed));
      }
    }
    if (conditions.length === 0) return;

    const selectCols = Array.from(new Set([
      ...pkCols.map((c) => quotePgIdentifier(c.column_name)),
      displayCol ? quotePgIdentifier(displayCol) : null,
      ...textCols.map((c) => quotePgIdentifier(c.column)),
    ].filter(Boolean) as string[]));

    const sql = `SELECT ${selectCols.join(", ")} FROM ${quotePgIdentifier(schema)}.${quotePgIdentifier(table)} WHERE ${conditions.join(" OR ")} LIMIT ${SEARCH_MAX_PER_TABLE}`;

    try {
      const { rows } = await executeReadOnlyWithTimeout(connectionString, sql, params, perTableTimeoutMs);
      for (const row of rows) {
        if (hits.length >= SEARCH_MAX_TOTAL) return;
        let matchedColumn = "";
        let matchedValue = "";
        for (const c of [...textCols, ...eqCols]) {
          const raw = row[c.column];
          if (raw === null || raw === undefined) continue;
          const strVal = String(raw);
          if (strVal.toLowerCase().includes(trimmed.toLowerCase())) {
            matchedColumn = c.column;
            matchedValue = strVal.length > 200 ? `${strVal.slice(0, 200)}…` : strVal;
            break;
          }
        }
        if (!matchedColumn && eqCols.length > 0) {
          matchedColumn = eqCols[0].column;
          const raw = row[eqCols[0].column];
          matchedValue = raw === null || raw === undefined ? "" : String(raw);
        }
        const pkValues: Record<string, unknown> = {};
        for (const pk of pkCols) pkValues[pk.column_name] = row[pk.column_name];
        hits.push({
          schema,
          table,
          column: matchedColumn,
          value: matchedValue,
          pkValues,
          display: displayCol && row[displayCol] !== undefined && row[displayCol] !== null ? String(row[displayCol]) : null,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timed out")) {
        timedOutTables.push(`${schema}.${table}`);
      }
    }
  });

  await runWithConcurrency(tasks, SEARCH_CONCURRENCY);

  return { success: true, data: hits, timedOutTables };
}

// ─── Entity overview ────────────────────────────────────────────────────

export type RelatedTableSection = {
  relation: MergedRelation;
  /** reltuples-based estimate of the child table size (null when unknown) */
  tableEstimate: number | null;
  /** exact count when the child table is small enough to count cheaply */
  count: number | null;
  countError: string | null;
};

export type ParentReference = {
  relation: MergedRelation;
  parentPkValues: Record<string, unknown> | null;
  parentDisplay: string | null;
  error: string | null;
};

export type EntityOverview = {
  schema: string;
  table: string;
  pkColumns: string[];
  columns: Array<{ name: string; type: string | null; isPrimary: boolean; nullable: boolean }>;
  row: Record<string, unknown> | null;
  displayColumn: string | null;
  displayValue: string | null;
  rowError: string | null;
  incoming: RelatedTableSection[];
  outgoing: ParentReference[];
};

function pkConditionsAndValues(
  pkCols: CachedColumnRow[],
  pkValues: Record<string, unknown>,
): { conditions: string[]; values: unknown[] } | null {
  const conditions: string[] = [];
  const values: unknown[] = [];
  for (const pk of pkCols) {
    const val = pkValues?.[pk.column_name];
    if (val === undefined) return null;
    if (val === null) {
      conditions.push(`${quotePgIdentifier(pk.column_name)} IS NULL`);
    } else {
      conditions.push(`${quotePgIdentifier(pk.column_name)} = ?`);
      values.push(val);
    }
  }
  return conditions.length > 0 ? { conditions, values } : null;
}

export async function getEntityOverview(
  connectionString: string,
  schema: string,
  table: string,
  pkValues: Record<string, unknown>,
): Promise<{ success: boolean; data?: EntityOverview; error?: string }> {
  try {
    ensureCs(connectionString);
    const [columnsCache, merged] = await Promise.all([
      fetchColumnsForRelations(connectionString),
      getMergedRelations(connectionString),
    ]);

    const tableCols = getTableColumns(columnsCache, schema, table);
    if (tableCols.length === 0) {
      return { success: false, error: `Table ${schema}.${table} not found in schema cache. Refresh the schema and try again.` };
    }
    const pkCols = getTablePkColumns(columnsCache, schema, table);
    if (pkCols.length === 0) {
      return { success: false, error: `Table ${schema}.${table} has no primary key — the Entity Explorer needs a PK to address rows.` };
    }

    const kv = pkConditionsAndValues(pkCols, pkValues || {});
    if (!kv) {
      return { success: false, error: "Missing primary key values." };
    }

    const displayColumn = pickDisplayColumn(tableCols);
    const tableRef = `${quotePgIdentifier(schema)}.${quotePgIdentifier(table)}`;
    const sql = `SELECT * FROM ${tableRef} WHERE ${kv.conditions.join(" AND ")} LIMIT 1`;

    let row: Record<string, unknown> | null = null;
    let rowError: string | null = null;
    try {
      const result = await executeReadOnlyWithTimeout(connectionString, sql, kv.values, 5_000);
      row = result.rows[0] ?? null;
    } catch (err: unknown) {
      rowError = err instanceof Error ? err.message : String(err);
    }

    const incomingRelations = merged.all.filter(
      (r) => r.target.schema.toLowerCase() === schema.toLowerCase() && r.target.table.toLowerCase() === table.toLowerCase(),
    );
    const outgoingRelations = merged.all.filter(
      (r) => r.source.schema.toLowerCase() === schema.toLowerCase() && r.source.table.toLowerCase() === table.toLowerCase(),
    );

    const estimates = await getRowEstimates(connectionString).catch(() => new Map<string, number>());

    const exactCountThreshold = 200_000;
    const incoming: RelatedTableSection[] = await Promise.all(
      incomingRelations.map(async (relation) => {
        const key = `${relation.source.schema}|${relation.source.table}`;
        const est = estimates.get(key) ?? null;
        const childPk = getTablePkColumns(columnsCache, relation.source.schema, relation.source.table);
        // For incoming relations the value lives on the ENTITY row at the
        // parent-side column (relation.target.column), e.g. users.id = 1
        // fans out to orders WHERE orders.user_id = 1.
        const parentVal = row ? row[relation.target.column] : undefined;
        let count: number | null = null;
        let countError: string | null = null;
        const worthExactCount =
          row !== null &&
          parentVal !== undefined &&
          parentVal !== null &&
          childPk.length > 0 &&
          (est === null || est < exactCountThreshold);
        if (worthExactCount) {
          try {
            const countSql = `SELECT count(*)::int AS c FROM ${quotePgIdentifier(relation.source.schema)}.${quotePgIdentifier(relation.source.table)} WHERE ${quotePgIdentifier(relation.source.column)} = ?`;
            const result = await executeReadOnlyWithTimeout(connectionString, countSql, [parentVal], COUNT_TIMEOUT_MS);
            count = Number(result.rows[0]?.c) || 0;
          } catch (err: unknown) {
            countError = err instanceof Error ? err.message : String(err);
          }
        }
        return { relation, tableEstimate: est, count, countError };
      }),
    );

    const outgoing: ParentReference[] = await Promise.all(
      outgoingRelations.map(async (relation) => {
        if (!row) return { relation, parentPkValues: null, parentDisplay: null, error: null };
        const parentVal = row[relation.source.column];
        if (parentVal === null || parentVal === undefined) {
          return { relation, parentPkValues: null, parentDisplay: null, error: null };
        }
        try {
          const parentPkCols = getTablePkColumns(columnsCache, relation.target.schema, relation.target.table);
          const parentDisplayCol = pickDisplayColumn(getTableColumns(columnsCache, relation.target.schema, relation.target.table));
          const selectParts = Array.from(new Set([
            ...(parentPkCols.length > 0 ? parentPkCols.map((c) => quotePgIdentifier(c.column_name)) : [quotePgIdentifier(relation.target.column)]),
            parentDisplayCol ? quotePgIdentifier(parentDisplayCol) : null,
          ].filter(Boolean) as string[]));
          const parentSql = `SELECT ${selectParts.join(", ")} FROM ${quotePgIdentifier(relation.target.schema)}.${quotePgIdentifier(relation.target.table)} WHERE ${quotePgIdentifier(relation.target.column)} = ? LIMIT 1`;
          const result = await executeReadOnlyWithTimeout(connectionString, parentSql, [parentVal], COUNT_TIMEOUT_MS);
          const prow = result.rows[0] ?? null;
          const parentPkValues: Record<string, unknown> = {};
          if (prow) {
            if (parentPkCols.length > 0) {
              for (const pkc of parentPkCols) parentPkValues[pkc.column_name] = prow[pkc.column_name];
            } else {
              parentPkValues[relation.target.column] = prow[relation.target.column];
            }
          }
          return {
            relation,
            parentPkValues: Object.keys(parentPkValues).length > 0 ? parentPkValues : null,
            parentDisplay: prow && parentDisplayCol && prow[parentDisplayCol] !== null && prow[parentDisplayCol] !== undefined
              ? String(prow[parentDisplayCol])
              : null,
            error: null,
          };
        } catch (err: unknown) {
          return { relation, parentPkValues: null, parentDisplay: null, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );

    const data: EntityOverview = {
      schema,
      table,
      pkColumns: pkCols.map((c) => c.column_name),
      columns: tableCols.map((c) => ({
        name: c.column_name,
        type: c.data_type,
        isPrimary: Boolean(c.is_primary),
        nullable: String(c.is_nullable ?? "YES").toUpperCase() === "YES",
      })),
      row,
      displayColumn,
      displayValue: row && displayColumn && row[displayColumn] !== null && row[displayColumn] !== undefined
        ? String(row[displayColumn])
        : null,
      rowError,
      incoming,
      outgoing,
    };
    return { success: true, data };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

// ─── Related rows (expand) ──────────────────────────────────────────────

export async function getRelatedRows(
  connectionString: string,
  schema: string,
  table: string,
  pkValues: Record<string, unknown>,
  target: { schema: string; table: string; column: string; parentColumn: string },
  offset: number,
): Promise<{ success: boolean; data?: { rows: Record<string, unknown>[]; total: number | null; totalError: string | null; columns: Array<{ name: string; type: string | null; isPrimary: boolean }> }; error?: string }> {
  try {
    ensureCs(connectionString);
    const columnsCache = await fetchColumnsForRelations(connectionString);
    const pkCols = getTablePkColumns(columnsCache, schema, table);
    if (pkCols.length === 0) {
      return { success: false, error: `Table ${schema}.${table} has no primary key.` };
    }
    const kv = pkConditionsAndValues(pkCols, pkValues || {});
    if (!kv) return { success: false, error: "Missing primary key values." };

    // The fan-out value lives on the ENTITY row at the parent-side column
    // (relation.target.column), e.g. users.id = 1 → orders WHERE user_id = 1.
    const entityRow = await executeReadOnlyWithTimeout(
      connectionString,
      `SELECT ${quotePgIdentifier(target.parentColumn)} AS v FROM ${quotePgIdentifier(schema)}.${quotePgIdentifier(table)} WHERE ${kv.conditions.join(" AND ")} LIMIT 1`,
      kv.values,
      5_000,
    );
    const parentVal = entityRow.rows[0]?.v;
    if (parentVal === null || parentVal === undefined) {
      return { success: true, data: { rows: [], total: 0, totalError: null, columns: [] } };
    }

    const childTableRef = `${quotePgIdentifier(target.schema)}.${quotePgIdentifier(target.table)}`;
    const childCols = getTableColumns(columnsCache, target.schema, target.table);
    const childPk = getTablePkColumns(columnsCache, target.schema, target.table);
    const orderBy = childPk.length > 0
      ? `ORDER BY ${childPk.map((c) => quotePgIdentifier(c.column_name)).join(", ")}`
      : "";
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));

    const rowsSql = `SELECT * FROM ${childTableRef} WHERE ${quotePgIdentifier(target.column)} = ? ${orderBy} LIMIT ${RELATED_PAGE_SIZE} OFFSET ${safeOffset}`;
    const rowsResult = await executeReadOnlyWithTimeout(connectionString, rowsSql, [parentVal], COUNT_TIMEOUT_MS);

    let total: number | null = null;
    let totalError: string | null = null;
    try {
      const countSql = `SELECT count(*)::int AS c FROM ${childTableRef} WHERE ${quotePgIdentifier(target.column)} = ?`;
      const countResult = await executeReadOnlyWithTimeout(connectionString, countSql, [parentVal], COUNT_TIMEOUT_MS);
      total = Number(countResult.rows[0]?.c) || 0;
    } catch (err: unknown) {
      totalError = err instanceof Error ? err.message : String(err);
    }

    return {
      success: true,
      data: {
        rows: rowsResult.rows,
        total,
        totalError,
        columns: childCols.map((c) => ({ name: c.column_name, type: c.data_type, isPrimary: Boolean(c.is_primary) })),
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
