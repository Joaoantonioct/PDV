import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(ROOT, "data", "pdv.sqlite");

const db = new DatabaseSync(dbPath);

try {
  const user = db.prepare("SELECT username, password_hash FROM users WHERE username = ? COLLATE NOCASE").get("LDM");
  console.log("Usuário encontrado:", user);
  console.log("Hash da senha:", user.password_hash);
} catch (error) {
  console.error("Erro:", error);
} finally {
  db.close();
}
