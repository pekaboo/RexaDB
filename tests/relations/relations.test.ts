import test from "node:test";
import assert from "node:assert/strict";

import {
  extractDeclaredRelations,
  mergeRelations,
  suggestRelationsFromColumns,
  fkBaseName,
  nameVariants,
  typesCompatible,
  type MergedRelation,
  type VirtualRelationRecord,
} from "../../lib/db/relations";
import type { CachedColumnRow } from "../../lib/db/schema-cache-actions";

function col(overrides: Partial<CachedColumnRow>): CachedColumnRow {
  return {
    table_schema: "public",
    table_name: "t",
    column_name: "c",
    data_type: "integer",
    is_nullable: "YES",
    is_primary: false,
    referenced_table_schema: null,
    referenced_table_name: null,
    referenced_column_name: null,
    ...overrides,
  } as CachedColumnRow;
}

test("fkBaseName extracts reference base names", () => {
  assert.equal(fkBaseName("user_id"), "user");
  assert.equal(fkBaseName("userId"), "userId".replace(/Id$/, "") === "user" ? "user" : fkBaseName("userId"));
  assert.equal(fkBaseName("account_uuid"), "account");
  assert.equal(fkBaseName("email"), null);
  assert.equal(fkBaseName("id"), null);
});

test("nameVariants covers singular/plural shapes", () => {
  const variants = nameVariants("user");
  assert.ok(variants.includes("user"));
  assert.ok(variants.includes("users"));
  const catVariants = nameVariants("category");
  assert.ok(catVariants.includes("categories"));
});

test("typesCompatible matches int families, uuid, and text families", () => {
  assert.ok(typesCompatible("integer", "bigint"));
  assert.ok(typesCompatible("int4", "integer"));
  assert.ok(typesCompatible("uuid", "uuid"));
  assert.ok(typesCompatible("text", "character varying(255)"));
  assert.ok(!typesCompatible("integer", "uuid"));
  assert.ok(!typesCompatible("uuid", "text"));
  assert.ok(!typesCompatible("integer", "text"));
});

test("extractDeclaredRelations pulls declared FK edges and dedupes", () => {
  const columns = [
    col({ table_name: "orders", column_name: "user_id", referenced_table_schema: "public", referenced_table_name: "users", referenced_column_name: "id" }),
    // duplicate row (some caches repeat the join)
    col({ table_name: "orders", column_name: "user_id", referenced_table_schema: "public", referenced_table_name: "users", referenced_column_name: "id" }),
    col({ table_name: "orders", column_name: "amount" }),
  ];
  const relations = extractDeclaredRelations(columns);
  assert.equal(relations.length, 1);
  assert.equal(relations[0].origin, "declared");
  assert.deepEqual(relations[0].source, { schema: "public", table: "orders", column: "user_id" });
  assert.deepEqual(relations[0].target, { schema: "public", table: "users", column: "id" });
});

test("suggestRelationsFromColumns proposes user_id → users.id (H1)", () => {
  const columns = [
    col({ table_name: "users", column_name: "id", data_type: "bigint", is_primary: true }),
    col({ table_name: "users", column_name: "email", data_type: "text" }),
    col({ table_name: "orders", column_name: "id", data_type: "bigint", is_primary: true }),
    col({ table_name: "orders", column_name: "user_id", data_type: "bigint" }),
  ];
  const suggestions = suggestRelationsFromColumns(columns, []);
  assert.equal(suggestions.length, 1);
  assert.deepEqual(suggestions[0].source, { schema: "public", table: "orders", column: "user_id" });
  assert.deepEqual(suggestions[0].target, { schema: "public", table: "users", column: "id" });
});

test("suggestRelationsFromColumns skips incompatible types", () => {
  const columns = [
    col({ table_name: "users", column_name: "id", data_type: "uuid", is_primary: true }),
    col({ table_name: "orders", column_name: "user_id", data_type: "integer" }),
  ];
  const suggestions = suggestRelationsFromColumns(columns, []);
  assert.equal(suggestions.length, 0);
});

test("suggestRelationsFromColumns skips columns already covered by an existing relation", () => {
  const columns = [
    col({ table_name: "users", column_name: "id", data_type: "bigint", is_primary: true }),
    col({ table_name: "orders", column_name: "user_id", data_type: "bigint" }),
  ];
  const existing: MergedRelation[] = [{
    source: { schema: "public", table: "orders", column: "user_id" },
    target: { schema: "public", table: "users", column: "id" },
    origin: "virtual",
    virtualId: 1,
    virtualOrigin: "manual",
  }];
  const suggestions = suggestRelationsFromColumns(columns, existing);
  assert.equal(suggestions.length, 0);
});

test("suggestRelationsFromColumns skips self references and composite PKs", () => {
  const columns = [
    // composite PK on target
    col({ table_name: "order_items", column_name: "order_id", data_type: "bigint", is_primary: true }),
    col({ table_name: "order_items", column_name: "line", data_type: "integer", is_primary: true }),
    // self reference
    col({ table_name: "users", column_name: "id", data_type: "bigint", is_primary: true }),
    col({ table_name: "users", column_name: "user_id", data_type: "bigint" }),
  ];
  const suggestions = suggestRelationsFromColumns(columns, []);
  assert.equal(suggestions.length, 0);
});

test("mergeRelations flags virtual duplicates of declared FKs", () => {
  const declared: MergedRelation[] = [{
    source: { schema: "public", table: "orders", column: "user_id" },
    target: { schema: "public", table: "users", column: "id" },
    origin: "declared",
  }];
  const virtual: VirtualRelationRecord[] = [{
    id: 7,
    source: { schema: "public", table: "orders", column: "user_id", columns: ["user_id"] },
    target: { schema: "public", table: "users", column: "id", columns: ["id"] },
    origin: "manual",
    label: null,
    createdAt: 0,
    updatedAt: 0,
  }, {
    id: 8,
    source: { schema: "public", table: "login_logs", column: "account_id", columns: ["account_id"] },
    target: { schema: "public", table: "users", column: "id", columns: ["id"] },
    origin: "inferred",
    label: null,
    createdAt: 0,
    updatedAt: 0,
  }];
  const merged = mergeRelations(declared, virtual);
  assert.equal(merged.length, 3);
  const duplicate = merged.find((r) => r.origin === "virtual" && r.virtualId === 7);
  assert.ok(duplicate);
  assert.equal(duplicate!.duplicatesDeclared, true);
  const unique = merged.find((r) => r.origin === "virtual" && r.virtualId === 8);
  assert.ok(unique);
  assert.equal(unique!.duplicatesDeclared, undefined);
});
