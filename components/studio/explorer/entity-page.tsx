"use client";

/**
 * Entity page for the Entity Explorer: renders one entity (row) with its
 * fields card, outgoing parent-reference chips, and incoming related-table
 * accordion sections. Every section is independently fault-tolerant — one
 * bad section never blanks the page.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchEntityOverview,
  fetchRelatedRows,
  type EntityOverview,
  type ExplorerRelation,
} from "@/lib/api/actions-client";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  ChevronRight,
  Copy,
  Check,
  Database,
  KeyRound,
  Link2,
  Maximize2,
  Table2,
  AlertTriangle,
  Loader2,
  Users,
  WrapText,
} from "lucide-react";

export type EntityRef = {
  schema: string;
  table: string;
  pkValues: Record<string, unknown>;
};

function formatValue(raw: unknown): string {
  if (raw === null || raw === undefined) return "∅";
  if (typeof raw === "object") {
    try {
      const s = JSON.stringify(raw);
      return s.length > 512 ? `${s.slice(0, 512)}…` : s;
    } catch {
      return String(raw);
    }
  }
  const s = String(raw);
  return s.length > 512 ? `${s.slice(0, 512)}…` : s;
}

function isByteaLike(value: unknown, type: string | null | undefined): boolean {
  return BufferLikeCheck(value) || String(type || "").toLowerCase() === "bytea";
}

/** Try to pretty-print a value as JSON — objects, arrays, or JSON stored in
 * text columns. Returns null when the value is not JSON-parseable. */
function tryPrettyJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

const VALUE_EXPAND_THRESHOLD = 80;

/** Full-value viewer for long cell values (JSON blobs etc.): pretty-print,
 * copy, and wrap toggle. */
function ValueDetailDialog({
  open,
  onOpenChange,
  title,
  type,
  raw,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  type?: string | null;
  raw: unknown;
}) {
  const full = useMemo(() => {
    if (raw === null || raw === undefined) return "∅";
    if (typeof raw === "object") {
      try {
        return JSON.stringify(raw, null, 2);
      } catch {
        return String(raw);
      }
    }
    return String(raw);
  }, [raw]);

  const pretty = useMemo(() => tryPrettyJson(full), [full]);
  const [prettyMode, setPrettyMode] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const effective = prettyMode && pretty ? pretty : full;

  // Reset transient state when a different value is opened.
  useEffect(() => {
    if (open) {
      setPrettyMode(Boolean(pretty));
      setCopied(false);
    }
  }, [open, pretty]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-[min(720px,90vw)] flex-col gap-0 p-0">
        <DialogHeader className="flex-row items-center gap-2 border-b border-border px-4 py-3">
          <DialogTitle className="font-mono text-sm">{title}</DialogTitle>
          {type && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{type}</span>}
          <span className="ml-auto text-[10px] text-muted-foreground">{effective.length.toLocaleString()} chars</span>
        </DialogHeader>
        <div className="flex items-center gap-1.5 border-b border-border px-4 py-2">
          {pretty && (
            <Button variant={prettyMode ? "secondary" : "outline"} size="sm" className="h-7 text-xs" onClick={() => setPrettyMode((v) => !v)}>
              {prettyMode ? "Formatted" : "Pretty"}
            </Button>
          )}
          <Button variant={wrap ? "secondary" : "outline"} size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setWrap((v) => !v)}>
            <WrapText className="size-3" />
            Wrap
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7 gap-1.5 text-xs"
            onClick={() => {
              void navigator.clipboard.writeText(effective).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <pre
          className={cn(
            "min-h-0 flex-1 overflow-auto bg-muted/30 p-4 font-mono text-xs leading-relaxed",
            wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
          )}
        >
          {effective}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

function BufferLikeCheck(value: unknown): boolean {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return true;
  return typeof Uint8Array !== "undefined" && value instanceof Uint8Array;
}

function pkSignature(ref: EntityRef): string {
  return `${ref.schema}.${ref.table}#${JSON.stringify(ref.pkValues)}`;
}

function countLabel(count: number | null, estimate: number | null): string {
  if (count !== null) return count.toLocaleString();
  if (estimate !== null && estimate >= 0) return `~${estimate.toLocaleString()}`;
  return "?";
}

function relationName(r: ExplorerRelation): string {
  return `${r.source.schema}.${r.source.table}.${r.source.column} → ${r.target.schema}.${r.target.table}.${r.target.column}`;
}

// ─── Related rows accordion section ─────────────────────────────────────

// The overview response does not carry the pkValues snapshot; attach it on
// the client so accordion sections can build child queries. We extend the
// EntityOverview type locally for this purpose.
type OverviewWithPk = EntityOverview & { pkValuesSnapshot?: Record<string, unknown> };

type RelatedSectionProps = {
  connectionString: string;
  overview: OverviewWithPk;
  sectionIndex: number;
  onDrill: (ref: EntityRef) => void;
  onViewValue?: (column: string, type: string | null, value: unknown) => void;
};

function RelatedSection({ connectionString, overview, sectionIndex, onDrill, onViewValue }: RelatedSectionProps) {
  const section = overview.incoming[sectionIndex];
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<Array<{ name: string; type: string | null; isPrimary: boolean }>>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const childPkColumns = useMemo(() => columns.filter((c) => c.isPrimary).map((c) => c.name), [columns]);
  const pkSnapshot = overview.pkValuesSnapshot;

  const load = useCallback(async (offset: number, replace: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchRelatedRows(
        connectionString,
        overview.schema,
        overview.table,
        pkSnapshot!,
        {
          schema: section.relation.source.schema,
          table: section.relation.source.table,
          column: section.relation.source.column,
          parentColumn: section.relation.target.column,
        },
        offset,
      );
      if (res.success && res.data) {
        setRows((prev) => (replace ? res.data!.rows : [...prev, ...res.data!.rows]));
        setColumns(res.data.columns);
        setTotal(res.data.total);
        setHasMore(res.data.rows.length >= 100 && (res.data.total === null || offset + res.data.rows.length < res.data.total));
      } else {
        setError(res.error || "Failed to load rows");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connectionString, overview.schema, overview.table, section.relation, pkSnapshot]);

  useEffect(() => {
    if (open && rows.length === 0 && !loading && !error) {
      load(0, true);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayCount = section.count ?? section.tableEstimate; // eslint-disable-line @typescript-eslint/no-unused-vars
  const isEstimate = section.count === null && section.tableEstimate !== null && section.tableEstimate >= 0;

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
      >
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <Table2 className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-sm">{section.relation.source.table}</span>
        <span className="text-xs text-muted-foreground truncate">
          via {section.relation.source.column}
          {section.relation.origin === "virtual" && (
            <span className="ml-1.5 text-amber-500 dark:text-amber-400" title={`Virtual relation (${section.relation.virtualOrigin})${section.relation.label ? ` — ${section.relation.label}` : ""}`}>◇</span>
          )}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {section.countError && <span className="text-[11px] text-destructive" title={section.countError}>count failed</span>}
          <span className={cn("rounded-full px-2 py-0.5 text-xs tabular-nums", isEstimate ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary")}>
            {countLabel(section.count, isEstimate ? null : section.tableEstimate)}
            {isEstimate ? " est." : ""}
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-border">
          {loading && rows.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading rows…
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 px-3 py-4 text-sm text-destructive">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <div>
                <div>{error}</div>
                <button type="button" className="mt-1 text-xs underline" onClick={() => load(0, true)}>Retry</button>
              </div>
            </div>
          )}
          {!error && rows.length === 0 && !loading && (
            <div className="px-3 py-6 text-sm text-muted-foreground">No rows.</div>
          )}
          {rows.length > 0 && (
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                  <tr>
                    {columns.map((c) => (
                      <th key={c.name} className="whitespace-nowrap px-3 py-1.5 text-left font-medium text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          {c.name}
                          {c.isPrimary && <span title="Primary key"><KeyRound className="inline size-3 text-amber-500" /></span>}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const childPk: Record<string, unknown> = {};
                    for (const pkc of childPkColumns) childPk[pkc] = row[pkc];
                    const drillable = childPkColumns.length > 0 && Object.values(childPk).every((v) => v !== undefined);
                    return (
                      <tr
                        key={i}
                        className={cn("border-t border-border/50 hover:bg-accent/40", drillable && "cursor-pointer")}
                        onClick={() => drillable && onDrill({ schema: section.relation.source.schema, table: section.relation.source.table, pkValues: childPk })}
                        title={drillable ? "Open entity page" : undefined}
                      >
                        {columns.map((c) => (
                          <td key={c.name} className="max-w-64 truncate px-3 py-1.5 tabular-nums" title={formatValue(row[c.name])}>
                            {formatValue(row[c.name])}
                            {formatValue(row[c.name]).length > VALUE_EXPAND_THRESHOLD && onViewValue && (
                              <button
                                type="button"
                                className="ml-1 inline-flex translate-y-0.5 items-center rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:bg-muted hover:opacity-100"
                                title="View full value"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onViewValue(c.name, c.type, row[c.name]);
                                }}
                              >
                                <Maximize2 className="size-3" />
                              </button>
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {(hasMore || loading) && (
                <div className="flex justify-center border-t border-border/50 py-2">
                  <button
                    type="button"
                    disabled={loading}
                    className="text-xs text-muted-foreground underline disabled:opacity-50"
                    onClick={() => load(rows.length, false)}
                  >
                    {loading ? "Loading…" : `Load more${total !== null ? ` (${rows.length}/${total.toLocaleString()})` : ""}`}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Entity page ────────────────────────────────────────────────────────

type EntityPageProps = {
  connectionString: string;
  entity: EntityRef;
  onDrill: (ref: EntityRef) => void;
};

// The overview response does not carry the pkValues snapshot; attach it on
// the client so accordion sections can build child queries. We extend the
// EntityOverview type locally for this purpose.
export function EntityPage({ connectionString, entity, onDrill }: EntityPageProps) {
  const [overview, setOverview] = useState<OverviewWithPk | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [valueDetail, setValueDetail] = useState<{ column: string; type: string | null; value: unknown } | null>(null);

  const entityKey = useMemo(() => pkSignature(entity), [entity]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setOverview(null);
    fetchEntityOverview(connectionString, entity.schema, entity.table, entity.pkValues)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) {
          setOverview({ ...res.data, pkValuesSnapshot: entity.pkValues });
        } else {
          setError(res.error || "Failed to load entity");
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionString, entityKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-10 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading {entity.schema}.{entity.table}…
      </div>
    );
  }

  if (error || !overview) {
    return (
      <div className="flex flex-col items-start gap-2 px-4 py-10 text-sm text-destructive">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4" /> {error}
        </div>
        <div className="text-xs text-muted-foreground">
          If the table was dropped or renamed, refresh the schema and try again. If this is an RLS-protected table, the row may be filtered from your role.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <Database className="size-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{overview.schema}</span>
        <ChevronRight className="size-3 text-muted-foreground" />
        <Table2 className="size-4 text-primary" />
        <span className="text-base font-semibold">{overview.table}</span>
        {overview.displayValue && (
          <span className="rounded-md bg-primary/10 px-2 py-0.5 text-sm text-primary">{overview.displayValue}</span>
        )}
        <span className="text-xs text-muted-foreground font-mono">
          {overview.pkColumns.map((c) => `${c}=${formatValue(overview.row?.[c])}`).join(" ")}
        </span>
        {overview.rowError && (
          <span className="ml-auto flex items-center gap-1 text-xs text-destructive" title={overview.rowError}>
            <AlertTriangle className="size-3.5" /> row load failed
          </span>
        )}
      </div>

      {/* Outgoing parent chips */}
      {overview.outgoing.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {overview.outgoing.map((out, i) => {
            const clickable = out.parentPkValues !== null;
            return (
              <button
                key={i}
                type="button"
                disabled={!clickable}
                onClick={() => clickable && onDrill({ schema: out.relation.target.schema, table: out.relation.target.table, pkValues: out.parentPkValues! })}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs transition-colors",
                  clickable ? "hover:border-primary/50 hover:bg-accent/40" : "opacity-60",
                )}
                title={relationName(out.relation)}
              >
                <Link2 className="size-3 text-muted-foreground" />
                <span className="text-muted-foreground">{out.relation.source.column} →</span>
                <span className="font-medium">{out.relation.target.table}</span>
                {out.parentDisplay && <span className="text-primary">{out.parentDisplay}</span>}
                {out.error && <span title={out.error} className="inline-flex"><AlertTriangle className="size-3 text-destructive" /></span>}
                {out.relation.origin === "virtual" && <span className="text-amber-500 dark:text-amber-400" title="Virtual relation">◇</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Fields card */}
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
          Fields ({overview.columns.length})
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-0 p-1 md:grid-cols-2 xl:grid-cols-3">
          {overview.columns.map((col) => (
            <div key={col.name} className="flex items-baseline gap-2 border-b border-border/40 px-2 py-1.5 last:border-b-0">
              <span className="w-40 shrink-0 truncate font-mono text-xs text-muted-foreground" title={col.name}>
                {col.name}
                {col.isPrimary && <KeyRound className="ml-1 inline size-3 text-amber-500" />}
              </span>
              <span className="min-w-0 flex-1 break-all font-mono text-xs" title={String(overview.row?.[col.name] ?? "")}>
                {overview.row ? formatValue(overview.row[col.name]) : "—"}
                {overview.row && isByteaLike(overview.row[col.name], col.type) && (
                  <span className="ml-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">hex</span>
                )}
                {overview.row && formatValue(overview.row[col.name]).length > VALUE_EXPAND_THRESHOLD && (
                  <button
                    type="button"
                    className="ml-1 inline-flex translate-y-0.5 items-center rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:bg-muted hover:opacity-100"
                    title="View full value"
                    onClick={() =>
                      setValueDetail({ column: col.name, type: col.type, value: overview.row?.[col.name] })
                    }
                  >
                    <Maximize2 className="size-3" />
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Incoming related tables */}
      <div className="flex items-center gap-2 px-1">
        <Users className="size-4 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">
          Related tables ({overview.incoming.length})
        </span>
      </div>
      {overview.incoming.length === 0 && (
        <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          No tables reference this entity yet. Add virtual relations in the Relationships tab to build the graph.
        </div>
      )}
      <div className="flex flex-col gap-2">
        {overview.incoming.map((_, i) => (
          <RelatedSection
            key={i}
            connectionString={connectionString}
            overview={overview}
            sectionIndex={i}
            onDrill={onDrill}
            onViewValue={(column, type, value) => setValueDetail({ column, type, value })}
          />
        ))}
      </div>

      <ValueDetailDialog
        open={valueDetail !== null}
        onOpenChange={(o) => {
          if (!o) setValueDetail(null);
        }}
        title={valueDetail ? `${entity.table}.${valueDetail.column}` : ""}
        type={valueDetail?.type}
        raw={valueDetail?.value}
      />
    </div>
  );
}

export { formatValue, pkSignature };
