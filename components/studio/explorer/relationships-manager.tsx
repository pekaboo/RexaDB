"use client";

/**
 * Relationships manager for the Entity Explorer: list all merged relations
 * (declared + virtual), create/edit/delete virtual relations (local metadata
 * only — never DDL), review H1 inference suggestions, and run sampled orphan
 * checks to verify a relation with data.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  deleteVirtualRelation,
  fetchAllTablesWithColumns,
  fetchMergedRelations,
  fetchRelationSuggestions,
  upsertVirtualRelation,
  verifyExplorerRelation,
  type ExplorerRelation,
  type RelationSuggestion,
} from "@/lib/api/actions-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertTriangle,
  BadgeCheck,
  Database,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";

type CachedColumn = {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string | null;
  is_primary: boolean;
};

type TableOption = { schema: string; table: string; columns: CachedColumn[] };

function relationSortKey(r: ExplorerRelation): string {
  return `${r.source.schema}.${r.source.table}.${r.source.column}`;
}

// ─── Relation editor ────────────────────────────────────────────────────

type EditorState = {
  sourceSchema: string;
  sourceTable: string;
  sourceColumn: string;
  targetSchema: string;
  targetTable: string;
  targetColumn: string;
  label: string;
};

function emptyEditor(tables: TableOption[]): EditorState {
  const first = tables[0];
  return {
    sourceSchema: first?.schema ?? "",
    sourceTable: first?.table ?? "",
    sourceColumn: first?.columns[0]?.column_name ?? "",
    targetSchema: first?.schema ?? "",
    targetTable: first?.table ?? "",
    targetColumn: first?.columns[0]?.column_name ?? "",
    label: "",
  };
}

function TableColumnPicker({
  label,
  tables,
  schema,
  table,
  column,
  onChange,
}: {
  label: string;
  tables: TableOption[];
  schema: string;
  table: string;
  column: string;
  onChange: (schema: string, table: string, column: string) => void;
}) {
  const tablesInSchema = useMemo(
    () => tables.filter((t) => t.schema === schema),
    [tables, schema],
  );
  const currentTable = useMemo(
    () => tablesInSchema.find((t) => t.table === table) ?? tablesInSchema[0],
    [tablesInSchema, table],
  );
  const columns = currentTable?.columns ?? [];

  return (
    <div className="flex flex-1 flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <div className="flex gap-1.5">
        <select
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs"
          value={schema}
          onChange={(e) => {
            const nextSchema = e.target.value;
            const firstTable = tables.find((t) => t.schema === nextSchema);
            onChange(nextSchema, firstTable?.table ?? "", firstTable?.columns[0]?.column_name ?? "");
          }}
        >
          {Array.from(new Set(tables.map((t) => t.schema))).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select
          className="h-8 min-w-0 flex-[2] rounded-md border border-border bg-background px-2 text-xs"
          value={currentTable?.table ?? ""}
          onChange={(e) => {
            const nextTable = e.target.value;
            const t = tablesInSchema.find((x) => x.table === nextTable);
            onChange(schema, nextTable, t?.columns[0]?.column_name ?? "");
          }}
        >
          {tablesInSchema.map((t) => (
            <option key={t.table} value={t.table}>{t.table}</option>
          ))}
        </select>
        <select
          className="h-8 min-w-0 flex-[2] rounded-md border border-border bg-background px-2 text-xs"
          value={column}
          onChange={(e) => onChange(schema, currentTable?.table ?? table, e.target.value)}
        >
          {columns.map((c) => (
            <option key={c.column_name} value={c.column_name}>
              {c.column_name}{c.is_primary ? " (PK)" : ""}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function RelationEditor({
  connectionString,
  tables,
  initial,
  onClose,
  onSaved,
}: {
  connectionString: string;
  tables: TableOption[];
  initial: EditorState;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [state, setState] = useState<EditorState>(initial);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!state.sourceTable || !state.sourceColumn || !state.targetTable || !state.targetColumn) {
      toast.error("Pick source and target table + column");
      return;
    }
    setSaving(true);
    try {
      const res = await upsertVirtualRelation(connectionString, {
        sourceSchema: state.sourceSchema,
        sourceTable: state.sourceTable,
        sourceColumns: [state.sourceColumn],
        targetSchema: state.targetSchema,
        targetTable: state.targetTable,
        targetColumns: [state.targetColumn],
        origin: "manual",
        label: state.label.trim() || null,
      });
      if (res.success) {
        toast.success("Virtual relation saved (local metadata only)");
        onSaved();
        onClose();
      } else {
        toast.error(res.error || "Failed to save");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-amber-500/40 bg-card p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Plus className="size-3.5 text-amber-500" />
        New virtual relation — stored locally, never emits DDL
      </div>
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <TableColumnPicker
          label="Source (child column)"
          tables={tables}
          schema={state.sourceSchema}
          table={state.sourceTable}
          column={state.sourceColumn}
          onChange={(schema, table, column) => setState((s) => ({ ...s, sourceSchema: schema, sourceTable: table, sourceColumn: column }))}
        />
        <div className="pb-1.5 text-muted-foreground">→</div>
        <TableColumnPicker
          label="Target (parent PK)"
          tables={tables}
          schema={state.targetSchema}
          table={state.targetTable}
          column={state.targetColumn}
          onChange={(schema, table, column) => setState((s) => ({ ...s, targetSchema: schema, targetTable: table, targetColumn: column }))}
        />
        <Input
          className="h-8 w-full md:w-36"
          placeholder="label (optional)"
          value={state.label}
          onChange={(e) => setState((s) => ({ ...s, label: e.target.value }))}
        />
        <div className="flex gap-1.5 pb-0.5">
          <Button size="sm" variant="default" disabled={saving} onClick={save}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <BadgeCheck className="size-3.5" />}
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Suggestion tray ────────────────────────────────────────────────────

function SuggestionRow({
  connectionString,
  suggestion,
  onHandled,
}: {
  connectionString: string;
  suggestion: RelationSuggestion;
  onHandled: () => void;
}) {
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ sampled: number; orphans: number; orphanRate: number } | null>(null);
  const [accepting, setAccepting] = useState(false);

  const accept = async () => {
    setAccepting(true);
    try {
      const res = await upsertVirtualRelation(connectionString, {
        sourceSchema: suggestion.source.schema,
        sourceTable: suggestion.source.table,
        sourceColumns: [suggestion.source.column],
        targetSchema: suggestion.target.schema,
        targetTable: suggestion.target.table,
        targetColumns: [suggestion.target.column],
        origin: "inferred",
      });
      if (res.success) {
        toast.success(`Accepted ${suggestion.source.table}.${suggestion.source.column} → ${suggestion.target.table}.${suggestion.target.column}`);
        onHandled();
      } else {
        toast.error(res.error || "Failed to accept");
      }
    } finally {
      setAccepting(false);
    }
  };

  const verify = async () => {
    setVerifying(true);
    try {
      const res = await verifyExplorerRelation(connectionString, {
        sourceSchema: suggestion.source.schema,
        sourceTable: suggestion.source.table,
        sourceColumn: suggestion.source.column,
        targetSchema: suggestion.target.schema,
        targetTable: suggestion.target.table,
        targetColumn: suggestion.target.column,
      });
      if (res.success && res.data) {
        setVerifyResult(res.data);
      } else {
        toast.error(res.error || "Verification failed");
      }
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-2.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Sparkles className="size-3.5 text-amber-500" />
        <span className="font-mono">
          {suggestion.source.schema}.{suggestion.source.table}
          <span className="font-semibold text-primary">.{suggestion.source.column}</span>
        </span>
        <span className="text-muted-foreground">→</span>
        <span className="font-mono">
          {suggestion.target.schema}.{suggestion.target.table}
          <span className="font-semibold text-primary">.{suggestion.target.column}</span>
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={verifying} onClick={verify}>
            {verifying ? <Loader2 className="size-3 animate-spin" /> : <Wand2 className="size-3" />}
            Verify
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-destructive hover:text-destructive" onClick={onHandled} title="Dismiss">
            <X className="size-3" />
          </Button>
          <Button size="sm" className="h-6 px-2 text-xs" disabled={accepting} onClick={accept}>
            {accepting ? <Loader2 className="size-3 animate-spin" /> : <BadgeCheck className="size-3" />}
            Accept
          </Button>
        </span>
      </div>
      <div className="mt-1 pl-6 text-[11px] text-muted-foreground">{suggestion.reason}</div>
      {verifyResult && (
        <div className={cn("mt-1 pl-6 text-[11px]", verifyResult.orphanRate <= 0.01 ? "text-emerald-500" : verifyResult.orphanRate <= 0.15 ? "text-amber-500" : "text-destructive")}>
          Orphan rate {(verifyResult.orphanRate * 100).toFixed(1)}% ({verifyResult.orphans}/{verifyResult.sampled} sampled values missing a parent)
        </div>
      )}
    </div>
  );
}

// ─── Main manager ───────────────────────────────────────────────────────

export function RelationshipsManager({ connectionString }: { connectionString: string }) {
  const [relations, setRelations] = useState<ExplorerRelation[]>([]);
  const [suggestions, setSuggestions] = useState<RelationSuggestion[]>([]);
  const [tables, setTables] = useState<TableOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [suggesting, setSuggesting] = useState(false);
  const [filter, setFilter] = useState("");
  const [showEditor, setShowEditor] = useState(false);
  const [editorInitial, setEditorInitial] = useState<EditorState | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [merged, columnsRes] = await Promise.all([
        fetchMergedRelations(connectionString),
        fetchAllTablesWithColumns(connectionString),
      ]);
      if (merged.success && merged.data) setRelations(merged.data.all);
      const cols: CachedColumn[] = (columnsRes as any)?.data ?? [];
      const byTable = new Map<string, TableOption>();
      for (const col of cols) {
        const key = `${col.table_schema}|${col.table_name}`;
        let t = byTable.get(key);
        if (!t) {
          t = { schema: col.table_schema, table: col.table_name, columns: [] };
          byTable.set(key, t);
        }
        t.columns.push(col);
      }
      setTables(Array.from(byTable.values()).sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`)));
    } finally {
      setLoading(false);
    }
  }, [connectionString]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const runSuggestions = useCallback(async () => {
    setSuggesting(true);
    try {
      const res = await fetchRelationSuggestions(connectionString);
      if (res.success && res.data) {
        setSuggestions(res.data);
        if (res.data.length === 0) toast.info("No new relation suggestions found");
      } else {
        toast.error(res.error || "Failed to compute suggestions");
      }
    } finally {
      setSuggesting(false);
    }
  }, [connectionString]);

  useEffect(() => {
    if (tables.length > 0 && suggestions.length === 0 && !suggesting) {
      runSuggestions();
    }
  }, [tables]); // eslint-disable-line react-hooks/exhaustive-deps

  const removeVirtual = async (r: ExplorerRelation) => {
    if (r.virtualId === undefined) return;
    const res = await deleteVirtualRelation(connectionString, r.virtualId);
    if (res.success) {
      toast.success("Virtual relation deleted");
      loadAll();
    } else {
      toast.error(res.error || "Failed to delete");
    }
  };

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return relations;
    return relations.filter((r) =>
      `${r.source.schema}.${r.source.table}.${r.source.column} ${r.target.schema}.${r.target.table}.${r.target.column}`.toLowerCase().includes(f),
    );
  }, [relations, filter]);

  const virtualCount = relations.filter((r) => r.origin === "virtual").length;
  const declaredCount = relations.filter((r) => r.origin === "declared").length;
  const duplicates = relations.filter((r) => r.duplicatesDeclared);

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Database className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Relationships</span>
        <span className="text-xs text-muted-foreground">
          {declaredCount} declared · {virtualCount} virtual
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 w-52 pl-7 text-xs"
              placeholder="Filter relations…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={suggesting}
            onClick={runSuggestions}
            title="Re-run inference (H1: X_id → table X PK)"
          >
            {suggesting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5 text-amber-500" />}
            Suggest
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditorInitial(emptyEditor(tables));
              setShowEditor(true);
            }}
          >
            <Plus className="size-3.5" />
            Add virtual
          </Button>
          <Button size="sm" variant="ghost" onClick={loadAll} title="Reload">
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>

      {duplicates.length > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-3.5 shrink-0" />
          {duplicates.length} virtual relation{duplicates.length > 1 ? "s" : ""} duplicate declared foreign keys — consider deleting the redundant virtual entr{duplicates.length > 1 ? "ies" : "y"}.
        </div>
      )}

      {showEditor && editorInitial && (
        <RelationEditor
          connectionString={connectionString}
          tables={tables}
          initial={editorInitial}
          onClose={() => setShowEditor(false)}
          onSaved={loadAll}
        />
      )}

      {suggestions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
            <Sparkles className="size-3.5 text-amber-500" />
            Suggestions ({suggestions.length}) — verify with data, then accept
          </div>
          {suggestions.slice(0, 50).map((s, i) => (
            <SuggestionRow
              key={`${s.source.schema}.${s.source.table}.${s.source.column}-${i}`}
              connectionString={connectionString}
              suggestion={s}
              onHandled={() => setSuggestions((prev) => prev.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1">
        {loading ? (
          <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading relations…
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
            No relations{filter ? " match the filter" : " found"}. Run suggestions or add virtual relations manually.
          </div>
        ) : (
          filtered.map((r) => (
            <div
              key={`${r.origin}-${r.virtualId ?? "d"}-${relationSortKey(r)}`}
              className="flex items-center gap-2 rounded-md border border-border/60 bg-card px-3 py-1.5 text-xs"
            >
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-medium",
                  r.origin === "declared" ? "bg-muted text-muted-foreground" : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                )}
              >
                {r.origin === "declared" ? "declared" : r.virtualOrigin === "inferred" ? "virtual·inferred" : "virtual·manual"}
              </span>
              <span className="truncate font-mono">
                {r.source.schema}.{r.source.table}
                <span className="font-semibold text-primary">.{r.source.column}</span>
              </span>
              <span className="text-muted-foreground">→</span>
              <span className="truncate font-mono">
                {r.target.schema}.{r.target.table}
                <span className="font-semibold text-primary">.{r.target.column}</span>
              </span>
              {r.label && <span className="text-muted-foreground">({r.label})</span>}
              {r.duplicatesDeclared && (
                <span className="text-[10px] text-amber-500" title="Duplicates a declared FK">dup</span>
              )}
              {r.origin === "virtual" && (
                <button
                  type="button"
                  className="ml-auto rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="Delete virtual relation"
                  onClick={() => removeVirtual(r)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
