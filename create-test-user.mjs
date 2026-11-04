import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(ROOT, "data", "pdv.sqlite");

const db = new DatabaseSync(dbPath);

try {
  // Desabilitar foreign keys temporariamente
  db.exec("PRAGMA foreign_keys = OFF");

  // Criar unidade
  const branch = db.prepare("INSERT INTO branches (name) VALUES (?) RETURNING id, name").get("Loja Teste");
  console.log("✓ Unidade criada:", branch);

  // Criar usuário
  const username = "admin";
  const name = "Administrador Teste";
  const password = "123456789012"; // 12 caracteres

  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64).toString("hex");
  const storedHash = `${salt.toString("hex")}:${hash}`;

  const user = db.prepare("INSERT INTO users (username, name, password_hash, role) VALUES (?, ?, ?, 'ADMIN') RETURNING id, username, name, role").get(username, name, storedHash);
  console.log("✓ Usuário criado:", user);

  // Reabilitar foreign keys
  db.exec("PRAGMA foreign_keys = ON");

  console.log("\n✅ Setup concluído!");
  console.log("Usuário:", username);
  console.log("Senha:", password);
  console.log("Role: ADMIN");
} catch (error) {
  console.error("Erro:", error);
} finally {
  db.close();
}
