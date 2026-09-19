/**
 * Base export / import — bundle everything that makes up one database
 * workspace ("base") into a single self-contained JSON file:
 *
 *   connection row (credentials embedded), connection settings (incl. AI
 *   key, themes, keybindings), dashboards, notes, open tabs, table tags,
 *   snippets, AI chats + messages, virtual relations and searchable-column
 *   config (identity-keyed → portable across machines), plus a
 * client-injected focus-selection payload (localStorage, not server state).
 *
 * Import remaps all ids (connection, tabs, chats, snippets) so re-importing
 * the same bundle never collides. Passwords travel inside the file — the
 * export UI warns about that.
 */

import { eq, inArray } from "drizzle-orm";

export const BASE_BUNDLE_FORMAT = "rexadb-base";
export const BASE_BUNDLE_VERSION = 1;

type Row = Record<string, unknown>;

async function deps() {
  const { db } = await import("./index");
  const {
    connections, connectionSettings, dashboardState, noteState,
    tableTags, openTabs, snippets, aiChats, aiChatMessages,
    virtualRelations, searchableColumns,
  } = await import("./schema");
  const { ensureCoreTables } = await import("./ensure-core-tables");
  await ensureCoreTables();
  return {
    db, connections, connectionSettings, dashboardState, noteState,
    tableTags, openTabs, snippets, aiChats, aiChatMessages,
    virtualRelations, searchableColumns,
  };
}

export async function exportBase(
  connectionId: number,
): Promise<{ success: boolean; error?: string; data?: unknown }> {
  if (!Number.isFinite(Number(connectionId))) {
    return { success: false, error: "connectionId is required." };
  }
  const d = await deps();
  const [conn] = await d.db.select().from(d.connections).where(eq(d.connections.id, Number(connectionId)));
  if (!conn) return { success: false, error: "Connection not found." };

  const { getConnectionIdentity } = await import("./relations");
  let identity = "";
  try {
    identity = await getConnectionIdentity(conn.connectionString);
  } catch {
    identity = "";
  }

  const [settings] = await d.db.select().from(d.connectionSettings).where(eq(d.connectionSettings.connectionId, conn.id));
  const [dashboards] = await d.db.select().from(d.dashboardState).where(eq(d.dashboardState.connectionId, conn.id));
  const [notes] = await d.db.select().from(d.noteState).where(eq(d.noteState.connectionId, conn.id));
  const tags = await d.db.select().from(d.tableTags).where(eq(d.tableTags.connectionId, conn.id));
  const tabs = await d.db.select().from(d.openTabs).where(eq(d.openTabs.connectionId, conn.id));
  const snips = await d.db.select().from(d.snippets).where(eq(d.snippets.connectionId, conn.id));
  const chats = await d.db.select().from(d.aiChats).where(eq(d.aiChats.connectionId, conn.id));
  const chatIds = chats.map((c: Row) => String(c.id));
  const messages = chatIds.length
    ? await d.db.select().from(d.aiChatMessages).where(inArray(d.aiChatMessages.chatId, chatIds))
    : [];
  const virtual = identity
    ? await d.db.select().from(d.virtualRelations).where(eq(d.virtualRelations.connectionString, identity))
    : [];
  const searchable = identity
    ? await d.db.select().from(d.searchableColumns).where(eq(d.searchableColumns.connectionString, identity))
    : [];

  return {
    success: true,
    data: {
      format: BASE_BUNDLE_FORMAT,
      version: BASE_BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      connection: conn,
      connectionSettings: settings ?? null,
      dashboardState: dashboards ?? null,
      noteState: notes ?? null,
      tableTags: tags,
      openTabs: tabs,
      snippets: snips,
      aiChats: chats,
      aiChatMessages: messages,
      virtualRelations: virtual,
      searchableColumns: searchable,
      focus: null, // client injects localStorage focus before saving the file
    },
  };
}

function rand(): string {
  return Math.random().toString(36).slice(2, 8);
}

function toDate(v: unknown): Date | undefined {
  if (v === null || v === undefined) return undefined;
  const d = new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function importBase(
  bundle: Record<string, unknown>,
): Promise<{ success: boolean; error?: string; data?: { connectionId: number; connectionString: string } }> {
  if (!bundle || bundle.format !== BASE_BUNDLE_FORMAT) {
    return { success: false, error: "Not a RexaDB base bundle." };
  }
  if (Number(bundle.version) > BASE_BUNDLE_VERSION) {
    return { success: false, error: `Bundle version ${bundle.version} is newer than this app supports.` };
  }
  const connIn = bundle.connection as Row | undefined;
  if (!connIn || !connIn.connectionString) {
    return { success: false, error: "Bundle has no connection." };
  }
  const d = await deps();

  // Connection row: new id, dedupe name, revive timestamp-mode fields.
  const existing = await d.db.select().from(d.connections);
  const baseName = String(connIn.name || "Imported base");
  const nameExists = new Set(existing.map((c: Row) => String(c.name)));
  let name = baseName;
  for (let i = 2; nameExists.has(name); i++) name = `${baseName} (${i})`;
  const { id: _drop, createdAt, lastActive, ...connRest } = connIn as Row & { id?: unknown };
  const [newConn] = await d.db
    .insert(d.connections)
    .values({
      ...(connRest as any),
      name,
      createdAt: toDate(createdAt) ?? new Date(),
      lastActive: toDate(lastActive) ?? null,
    } as any)
    .returning();
  const newId = newConn.id;

  // Open tabs: regenerate text ids, remap active tab reference.
  const tabIdMap = new Map<string, string>();
  const tabsIn = (bundle.openTabs as Row[] | undefined) ?? [];
  for (const t of tabsIn) {
    const oldId = String(t.id);
    tabIdMap.set(oldId, `${oldId}-${rand()}`);
  }
  if (tabsIn.length > 0) {
    await d.db.insert(d.openTabs).values(
      tabsIn.map((t) => ({
        id: tabIdMap.get(String(t.id))!,
        connectionId: newId,
        type: String(t.type ?? "table"),
        name: String(t.name ?? ""),
        schema: (t.schema as string) ?? null,
        query: (t.query as string) ?? null,
        order: Number(t.order ?? 0),
        pinned: Boolean(t.pinned),
      })),
    );
  }

  // Connection settings: remap connectionId + activeTabId.
  const settingsIn = bundle.connectionSettings as Row | null | undefined;
  if (settingsIn) {
    const { connectionId: _c, activeTabId, ...rest } = settingsIn;
    await d.db.insert(d.connectionSettings).values({
      ...(rest as any),
      connectionId: newId,
      activeTabId: activeTabId ? (tabIdMap.get(String(activeTabId)) ?? null) : null,
    } as any);
  }

  // Dashboard + note state: keyed by connection only.
  const dashIn = bundle.dashboardState as Row | null | undefined;
  if (dashIn) {
    await d.db.insert(d.dashboardState).values({
      connectionId: newId,
      dashboardsJson: String(dashIn.dashboardsJson ?? "[]"),
      foldersJson: String(dashIn.foldersJson ?? "[]"),
      updatedAt: Number(dashIn.updatedAt ?? Date.now()),
    });
  }
  const noteIn = bundle.noteState as Row | null | undefined;
  if (noteIn) {
    await d.db.insert(d.noteState).values({
      connectionId: newId,
      notesJson: String(noteIn.notesJson ?? "[]"),
      updatedAt: Number(noteIn.updatedAt ?? Date.now()),
    });
  }

  // Table tags: rows without meaningful ids.
  const tagsIn = (bundle.tableTags as Row[] | undefined) ?? [];
  if (tagsIn.length > 0) {
    await d.db.insert(d.tableTags).values(
      tagsIn.map((t) => ({
        connectionId: newId,
        tableName: String(t.tableName),
        tagName: String(t.tagName),
      })),
    );
  }

  // Snippets: regenerate ids, drop folder references (folders are global
  // and may not exist on the target machine — snippets land at root).
  const snipsIn = (bundle.snippets as Row[] | undefined) ?? [];
  if (snipsIn.length > 0) {
    await d.db.insert(d.snippets).values(
      snipsIn.map((s) => ({
        id: `${String(s.id)}-${rand()}`,
        connectionId: newId,
        folderId: null,
        name: String(s.name),
        query: String(s.query),
        createdAt: Number(s.createdAt ?? Date.now()),
        isShared: false,
        sharedEntryId: null,
      })),
    );
  }

  // AI chats + messages: regenerate ids, remap chatId, drop user refs.
  const chatsIn = (bundle.aiChats as Row[] | undefined) ?? [];
  const chatIdMap = new Map<string, string>();
  for (const c of chatsIn) chatIdMap.set(String(c.id), `${String(c.id)}-${rand()}`);
  if (chatsIn.length > 0) {
    await d.db.insert(d.aiChats).values(
      chatsIn.map((c) => ({
        id: chatIdMap.get(String(c.id))!,
        connectionId: newId,
        userId: null,
        title: String(c.title ?? "Imported chat"),
        createdAt: Number(c.createdAt ?? Date.now()),
        updatedAt: Number(c.updatedAt ?? Date.now()),
      })),
    );
  }
  const msgsIn = (bundle.aiChatMessages as Row[] | undefined) ?? [];
  if (msgsIn.length > 0) {
    await d.db.insert(d.aiChatMessages).values(
      msgsIn
        .filter((m) => chatIdMap.has(String(m.chatId)))
        .map((m) => ({
          id: `${String(m.id)}-${rand()}`,
          chatId: chatIdMap.get(String(m.chatId))!,
          role: (m.role as "user" | "assistant" | "system" | "tool") ?? "user",
          content: String(m.content ?? ""),
          metaJson: (m.metaJson as string) ?? null,
          timestamp: Number(m.timestamp ?? Date.now()),
        })),
    );
  }

  // Virtual relations + searchable-column config: identity keys are
  // machine-independent — insert verbatim, skipping unique losers.
  const virtualIn = (bundle.virtualRelations as Row[] | undefined) ?? [];
  for (const r of virtualIn) {
    try {
      const { id: _i, ...rest } = r;
      await d.db.insert(d.virtualRelations).values(rest as any);
    } catch {
      // duplicate of an already-present relation — skip
    }
  }
  const searchableIn = (bundle.searchableColumns as Row[] | undefined) ?? [];
  if (searchableIn.length > 0) {
    await d.db.insert(d.searchableColumns).values(
      searchableIn.map((s: Row) => {
        const { id: _i, ...rest } = s;
        return rest as any;
      }),
    );
  }

  return { success: true, data: { connectionId: newId, connectionString: newConn.connectionString } };
}
