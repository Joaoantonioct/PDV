import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(ROOT, "data", "pdv.sqlite");

const db = new DatabaseSync(dbPath);

try {
  const users = db.prepare("SELECT id, username, name, role, active FROM users;").all();
  console.log("Usuários no banco:", users);

  const branches = db.prepare("SELECT id, name, active FROM branches;").all();
  console.log("\nUnidades no banco:", branches);
} catch (error) {
  console.error("Erro:", error);
} finally {
  db.close();
}
