import { DatabaseSync } from "node:sqlite";
import { scryptSync, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(ROOT, "data", "pdv.sqlite");

const db = new DatabaseSync(dbPath);

try {
  const username = "LDM";
  const newPassword = "123456789012"; // 12 caracteres como mínimo

  // Gerar hash da senha
  const salt = randomBytes(16);
  const hash = scryptSync(newPassword, salt, 64).toString("hex");
  const storedHash = `${salt.toString("hex")}:${hash}`;

  // Atualizar senha no banco
  const result = db.prepare("UPDATE users SET password_hash = ? WHERE username = ? COLLATE NOCASE")
    .run(storedHash, username);

  if (result.changes > 0) {
    console.log(`✅ Senha do usuário "${username}" redefinida com sucesso!`);
    console.log(`Nova senha: ${newPassword}`);
  } else {
    console.log(`❌ Usuário "${username}" não encontrado.`);
  }
} catch (error) {
  console.error("Erro:", error);
} finally {
  db.close();
}
