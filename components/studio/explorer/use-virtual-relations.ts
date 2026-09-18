"use client";

/**
 * Fetches virtual (business-convention) relations for a connection, for
 * rendering amber edges on the schema diagram. Refreshed on an interval so
 * edits made in the Entity Explorer's Relationships tab propagate without
 * a manual reload.
 */

import { useEffect, useState } from "react";
import { fetchMergedRelations, type ExplorerRelation } from "@/lib/api/actions-client";

export function useVirtualRelations(connectionString: string | null | undefined) {
  const [relations, setRelations] = useState<Array<{
    source: { schema: string; table: string; column: string };
    target: { schema: string; table: string; column: string };
  }> | null>(null);

  useEffect(() => {
    if (!connectionString) {
      setRelations(null);
      return;
    }
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetchMergedRelations(connectionString);
        if (cancelled) return;
        if (res.success && res.data) {
          const virtual = (res.data.all as ExplorerRelation[])
            .filter((r) => r.origin === "virtual" && !r.duplicatesDeclared)
            .map((r) => ({ source: r.source, target: r.target }));
          setRelations(virtual);
        } else if (!cancelled) {
          setRelations([]);
        }
      } catch {
        if (!cancelled) setRelations([]);
      }
    };

    load();
    const interval = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [connectionString]);

  return relations;
}
