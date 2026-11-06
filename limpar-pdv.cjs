const D = require("node:sqlite").DatabaseSync;
const p = process.env.APPDATA + "/PontoCerto PDV/data/pdv.sqlite";
const db = new D(p);

try {
  db.exec("PRAGMA foreign_keys = ON");

  const admin = db.prepare(
    "SELECT id FROM users WHERE id=1 AND role=? AND active=1"
  ).get("ADMIN");

  const branch = db.prepare(
    "SELECT id FROM branches WHERE id=1 AND active=1"
  ).get();

  const state = db.prepare(
    "SELECT last_order_id FROM site_order_sync_state WHERE id=1"
  ).get();

  if (!admin || !branch || !state) {
    throw new Error("Administrador, filial ou marcador não encontrado.");
  }

  const cursor = state.last_order_id;
  db.exec("BEGIN IMMEDIATE");

  const deletions = [
    "DELETE FROM sale_payments",
    "DELETE FROM sale_items",
    "DELETE FROM sales",
    "DELETE FROM cash_movements",
    "DELETE FROM site_sale_items",
    "DELETE FROM site_sales",
    "DELETE FROM stock_movements",
    "DELETE FROM inventory_variants",
    "DELETE FROM inventory",
    "DELETE FROM promotions",
    "DELETE FROM product_variants",
    "DELETE FROM product_colors",
    "DELETE FROM products",
    "DELETE FROM brands",
    "DELETE FROM categories WHERE parent_id IS NOT NULL",
    "DELETE FROM categories WHERE parent_id IS NULL",
    "DELETE FROM customers",
    "DELETE FROM cash_sessions",
    "DELETE FROM sessions",
    "DELETE FROM site_sync_outbox",
    "DELETE FROM desktop_smoke_test"
  ];

  for (const sql of deletions) db.exec(sql);

  const fk = db.prepare("PRAGMA foreign_key_check").all();
  if (fk.length) throw new Error("Falha nas chaves estrangeiras.");

  if (!db.prepare(
    "SELECT id FROM users WHERE id=1 AND role=? AND active=1"
  ).get("ADMIN")) throw new Error("Administrador não preservado.");

  if (!db.prepare(
    "SELECT id FROM branches WHERE id=1 AND active=1"
  ).get()) throw new Error("Filial não preservada.");

  if (db.prepare(
    "SELECT last_order_id FROM site_order_sync_state WHERE id=1"
  ).get().last_order_id !== cursor) {
    throw new Error("Marcador de sincronização alterado.");
  }

  db.exec("COMMIT");

  console.log("LIMPEZA CONCLUÍDA!");
  console.log("Administrador e filial preservados.");
  console.log("Marcador de sincronização preservado:", cursor);
  console.log("Chaves estrangeiras: OK");

  for (const t of [
    "products", "product_variants", "product_colors", "brands",
    "categories", "inventory", "inventory_variants", "stock_movements",
    "sales", "sale_items", "sale_payments", "cash_sessions",
    "cash_movements", "customers", "site_sales", "site_sale_items",
    "sessions", "site_sync_outbox", "desktop_smoke_test"
  ]) {
    console.log(t + ": " +
      db.prepare("SELECT COUNT(*) AS n FROM " + t).get().n);
  }
} catch (e) {
  try { db.exec("ROLLBACK"); } catch {}
  console.error("LIMPEZA CANCELADA:", e.message);
  process.exitCode = 1;
} finally {
  db.close();
}
