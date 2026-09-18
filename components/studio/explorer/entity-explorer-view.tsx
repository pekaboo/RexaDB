"use client";

/**
 * Entity Explorer view: global entity search (⌘K focus), entity pages with
 * accordion related-tables and stack-based drill-down navigation, plus the
 * Relationships manager (virtual relations + inference suggestions).
 *
 * Stack semantics (browser-history like): drilling into an entity already
 * present in the stack jumps to it instead of pushing a duplicate; drilling
 * from a mid-stack node truncates the stale tail. Max depth 8.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { searchEntities, fetchEffectiveSearchableColumns, type EntitySearchHit } from "@/lib/api/actions-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EntityPage, type EntityRef } from "./entity-page";
import { RelationshipsManager } from "./relationships-manager";
import {
  ChevronDown,
  ChevronRight,
  Compass,
  Loader2,
  Search,
  Settings2,
  Table2,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const MAX_STACK_DEPTH = 8;

function hitKey(hit: { schema: string; table: string; pkValues: Record<string, unknown> }): string {
  return `${hit.schema}.${hit.table}#${JSON.stringify(hit.pkValues)}`;
}

function refKey(ref: EntityRef): string {
  return `${ref.schema}.${ref.table}#${JSON.stringify(ref.pkValues)}`;
}

export function EntityExplorerView({
  connectionString,
  dbType,
}: {
  connectionString: string;
  dbType?: string;
}) {
  const [mode, setMode] = useState<"explore" | "relationships">("explore");
  const [term, setTerm] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<EntitySearchHit[] | null>(null);
  const [timedOutTables, setTimedOutTables] = useState<string[]>([]);
  const [stack, setStack] = useState<EntityRef[]>([]);
  const [stackIndex, setStackIndex] = useState(-1);
  // Main-table scoping: null = search every table's searchable columns;
  // a "schema|table" key restricts both the query and the visible scope
  // hint so the user always knows what they are matching against.
  const [mainTable, setMainTable] = useState<string | null>(null);
  const [searchableCols, setSearchableCols] = useState<Array<{ schema: string; table: string; column: string; kind: "eq" | "text" }>>([]);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestSearchRef = useRef<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  const isPgLike = dbType === "postgres" || dbType === undefined;

  // ⌘K / Ctrl+K focuses the search box
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Load the effective searchable-column set once per connection — feeds
  // the main-table picker and the scope hint.
  useEffect(() => {
    if (!connectionString) {
      setSearchableCols([]);
      setMainTable(null);
      return;
    }
    let cancelled = false;
    fetchEffectiveSearchableColumns(connectionString)
      .then((res) => {
        if (cancelled) return;
        if (res.success && Array.isArray(res.data)) setSearchableCols(res.data);
        else setSearchableCols([]);
      })
      .catch(() => {
        if (!cancelled) setSearchableCols([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionString]);

  // schema|table → its searchable columns (for the scope hint).
  const columnsByTable = useMemo(() => {
    const map = new Map<string, Array<{ schema: string; table: string; column: string; kind: "eq" | "text" }>>();
    for (const c of searchableCols) {
      const key = `${c.schema}|${c.table}`;
      const list = map.get(key) || [];
      list.push(c);
      map.set(key, list);
    }
    return map;
  }, [searchableCols]);

  const mainTableOptions = useMemo(
    () => Array.from(columnsByTable.keys()).sort((a, b) => a.split("|")[1].localeCompare(b.split("|")[1])),
    [columnsByTable],
  );

  const mainTableInfo = useMemo(() => {
    if (!mainTable) return null;
    const cols = columnsByTable.get(mainTable);
    if (!cols || cols.length === 0) return null;
    return { schema: cols[0].schema, table: cols[0].table, columns: cols };
  }, [mainTable, columnsByTable]);

  const runSearch = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length < 1) {
      setHits(null);
      setTimedOutTables([]);
      return;
    }
    setSearching(true);
    // Guard against stale responses overwriting newer results
    latestSearchRef.current = trimmed;
    const scope = mainTableInfo ? { schema: mainTableInfo.schema, table: mainTableInfo.table } : undefined;
    try {
      const res = await searchEntities(connectionString, trimmed, scope?.schema, scope?.table);
      if (latestSearchRef.current !== trimmed) return;
      if (res.success) {
        setHits(res.data ?? []);
        setTimedOutTables(res.timedOutTables ?? []);
      } else {
        toast.error(res.error || "Search failed");
      }
    } catch (err: unknown) {
      if (latestSearchRef.current === trimmed) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (latestSearchRef.current === trimmed) setSearching(false);
    }
  }, [connectionString, mainTableInfo]);

  // Debounced search
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (mode !== "explore") return;
    searchDebounceRef.current = setTimeout(() => {
      runSearch(term);
    }, 400);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [term, mode, runSearch]);

  const pushEntity = useCallback((ref: EntityRef) => {
    setStack((prev) => {
      const current = prev.slice(0, stackIndex + 1);
      const existingIdx = current.findIndex((r) => refKey(r) === refKey(ref));
      if (existingIdx >= 0) {
        setStackIndex(existingIdx);
        return prev;
      }
      if (current.length >= MAX_STACK_DEPTH) {
        toast.info(`Max drill depth (${MAX_STACK_DEPTH}) reached`);
        return prev;
      }
      const next = [...current, ref];
      setStackIndex(next.length - 1);
      return next;
    });
  }, [stackIndex]);

  const currentEntity = stackIndex >= 0 ? stack[stackIndex] : null;

  const groupedHits = useMemo(() => {
    if (!hits) return [];
    const groups = new Map<string, EntitySearchHit[]>();
    for (const hit of hits) {
      const key = `${hit.schema}.${hit.table}`;
      const list = groups.get(key) || [];
      list.push(hit);
      groups.set(key, list);
    }
    return Array.from(groups.entries());
  }, [hits]);

  if (!isPgLike) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        The Entity Explorer currently supports PostgreSQL connections.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {/* Main-table scope picker: choose the entity type first, then the
            search term is matched against THAT table's searchable columns. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 shrink-0 gap-1.5 text-xs font-medium">
              <Table2 className="size-3.5 text-muted-foreground" />
              <span className="max-w-[160px] truncate">{mainTableInfo ? mainTableInfo.table : "All tables"}</span>
              <ChevronDown className="size-3 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
            <DropdownMenuItem
              onClick={() => setMainTable(null)}
              className={cn("gap-2", !mainTable && "bg-accent")}
            >
              <Search className="size-3.5 text-muted-foreground" />
              All tables
            </DropdownMenuItem>
            {mainTableOptions.map((key) => {
              const cols = columnsByTable.get(key) ?? [];
              const label = key.split("|")[1];
              return (
                <DropdownMenuItem
                  key={key}
                  onClick={() => setMainTable(key === mainTable ? null : key)}
                  className={cn("gap-2", mainTable === key && "bg-accent")}
                  title={cols.map((c) => c.column).join(", ")}
                >
                  <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{label}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{cols.length}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="relative min-w-0 flex-1 max-w-xl">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            className="h-9 pl-8"
            placeholder={
              mainTableInfo
                ? `Match ${mainTableInfo.table}: ${mainTableInfo.columns.map((c) => c.column).join(" · ")}`
                : "Type to search across searchable columns — all tables (⌘K)"
            }
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
                runSearch(term);
              }
            }}
          />
          {term && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setTerm("");
                setHits(null);
                setStack([]);
                setStackIndex(-1);
              }}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        {searching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-border p-0.5">
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              mode === "explore" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setMode("explore")}
          >
            <Compass className="size-3.5" />
            Explore
          </button>
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              mode === "relationships" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setMode("relationships")}
          >
            <Settings2 className="size-3.5" />
            Relationships
          </button>
        </div>
      </div>

      {mode === "relationships" ? (
        <div className="min-h-0 flex-1">
          <RelationshipsManager connectionString={connectionString} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {/* Breadcrumb / stack path */}
          {stack.length > 0 && (
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
              {stack.map((ref, i) => (
                <span key={refKey(ref)} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight className="size-3 text-muted-foreground" />}
                  <button
                    type="button"
                    className={cn(
                      "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs",
                      i === stackIndex ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                    onClick={() => setStackIndex(i)}
                  >
                    <Table2 className="size-3" />
                    {ref.table}
                  </button>
                </span>
              ))}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-2 text-xs text-muted-foreground"
                onClick={() => {
                  setStack([]);
                  setStackIndex(-1);
                }}
              >
                Clear
              </Button>
            </div>
          )}

          <div className="p-4">
            {/* Search results */}
            {!currentEntity && (
              <div className="flex flex-col gap-4">
                {!hits && !searching && (
                  <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
                    <Search className="size-8 opacity-40" />
                    <div className="text-sm">Type to search across searchable columns</div>
                    <div className="max-w-md text-xs opacity-70">
                      Primary keys and non-sensitive text columns are searched by default. Huge tables are skipped
                      for ILIKE unless explicitly enabled. Configure coverage in Relationships.
                    </div>
                  </div>
                )}
                {hits && hits.length === 0 && !searching && (
                  <div className="flex flex-col items-center gap-1 py-12 text-center text-muted-foreground">
                    <div className="text-sm">No matches for “{term.trim()}”{mainTableInfo ? ` in ${mainTableInfo.table}` : ""}</div>
                    <div className="text-xs opacity-70">
                      Results may be filtered by RLS or permissions — absence here doesn&apos;t always mean the data doesn&apos;t exist.
                    </div>
                  </div>
                )}
                {timedOutTables.length > 0 && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                    Skipped slow tables (2s timeout): {timedOutTables.join(", ")}
                  </div>
                )}
                {groupedHits.map(([groupKey, groupHits]) => (
                  <div key={groupKey} className="rounded-lg border border-border bg-card">
                    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                      <Table2 className="size-3.5 text-muted-foreground" />
                      <span className="text-xs font-semibold">{groupKey}</span>
                      <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                        {groupHits.length} hit{groupHits.length > 1 ? "s" : ""}
                      </span>
                    </div>
                    <div className="divide-y divide-border/50">
                      {groupHits.map((hit) => (
                        <button
                          key={hitKey(hit)}
                          type="button"
                          className="flex w-full items-baseline gap-3 px-3 py-2 text-left text-xs hover:bg-accent/40"
                          onClick={() => pushEntity({ schema: hit.schema, table: hit.table, pkValues: hit.pkValues })}
                        >
                          <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">
                            {hit.column}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono">{hit.value}</span>
                          {hit.display && hit.display !== hit.value && (
                            <span className="max-w-48 truncate text-muted-foreground">{hit.display}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Current entity page */}
            {currentEntity && (
              <EntityPage
                key={refKey(currentEntity)}
                connectionString={connectionString}
                entity={currentEntity}
                onDrill={pushEntity}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
