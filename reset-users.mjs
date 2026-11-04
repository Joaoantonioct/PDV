import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(ROOT, "data", "pdv.sqlite");

const db = new DatabaseSync(dbPath);

try {
  // Desabilitar foreign keys temporariamente para poder apagar tudo
  db.prepare("PRAGMA foreign_keys = OFF;").run();
  console.log("Foreign keys desabilitadas temporariamente");

  // Apagar na ordem correta
  console.log("Iniciando reset do banco de dados...");

  // Site orders (sync)
  db.prepare("DELETE FROM site_sale_items;").run();
  console.log("✓ Itens de pedidos do site apagados");

  db.prepare("DELETE FROM site_sales;").run();
  console.log("✓ Pedidos do site apagados");

  // Vendas
  db.prepare("DELETE FROM sale_payments;").run();
  console.log("✓ Pagamentos de vendas apagados");

  db.prepare("DELETE FROM sale_items;").run();
  console.log("✓ Itens de venda apagados");

  db.prepare("DELETE FROM sales;").run();
  console.log("✓ Vendas apagadas");

  // Caixa
  db.prepare("DELETE FROM cash_sessions;").run();
  console.log("✓ Sessões de caixa apagadas");

  // Estoque
  db.prepare("DELETE FROM stock_movements;").run();
  console.log("✓ Movimentações de estoque apagadas");

  db.prepare("DELETE FROM inventory;").run();
  console.log("✓ Inventário apagado");

  // Sync state
  db.prepare("DELETE FROM site_order_receipts;").run();
  console.log("✓ Recibos de pedidos do site apagados");

  db.prepare("DELETE FROM site_sync_outbox;").run();
  console.log("✓ Fila de sincronização apagada");

  // Produtos e promoções
  db.prepare("DELETE FROM promotions;").run();
  console.log("✓ Promoções apagadas");

  const productsBefore = db.prepare("SELECT COUNT(*) as count FROM products;").get();
  db.prepare("DELETE FROM products;").run();
  console.log(`✓ Produtos apagados (${productsBefore.count} registros)`);

  // Clientes
  const customersBefore = db.prepare("SELECT COUNT(*) as count FROM customers;").get();
  db.prepare("DELETE FROM customers;").run();
  console.log(`✓ Clientes apagados (${customersBefore.count} registros)`);

  // Usuários
  const usersBefore = db.prepare("SELECT COUNT(*) as count FROM users;").get();
  db.prepare("DELETE FROM users;").run();
  console.log(`✓ Usuários apagados (${usersBefore.count} registros)`);

  // Unidades
  const branchesBefore = db.prepare("SELECT COUNT(*) as count FROM branches;").get();
  db.prepare("DELETE FROM branches;").run();
  console.log(`✓ Unidades apagadas (${branchesBefore.count} registros)`);

  console.log("\n✅ Reset concluído! Agora você pode criar uma nova loja e administrador no PDV.");

  // Reabilitar foreign keys
  db.prepare("PRAGMA foreign_keys = ON;").run();
  console.log("Foreign keys reabilitadas");
} catch (error) {
  console.error("Erro:", error);
} finally {
  db.close();
}
