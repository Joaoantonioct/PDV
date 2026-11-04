import { scryptSync, timingSafeEqual } from "node:crypto";

const password = "123456789012";
const storedHash = "553f4b4ab97ff7c9f13f9e5ff0f03468:802fcfca96918a9099136d4db1a929c2e7b1712ab594a62270445bef062fbb9d7933a9d40a00a3b329a67997671a8b7cc4765e8073cd47d9c3af545f6330ee5b";

const [salt, expectedHex] = storedHash.split(":");
console.log("Salt:", salt);
console.log("Expected hash:", expectedHex);

// Teste 1: salt como string
try {
  const actual1 = scryptSync(password, salt, 64);
  const expected1 = Buffer.from(expectedHex, "hex");
  const result1 = actual1.length === expected1.length && timingSafeEqual(actual1, expected1);
  console.log("Teste 1 (salt como string):", result1);
} catch (error) {
  console.log("Teste 1 erro:", error.message);
}

// Teste 2: salt como Buffer hex
try {
  const saltBuffer = Buffer.from(salt, "hex");
  const actual2 = scryptSync(password, saltBuffer, 64);
  const expected2 = Buffer.from(expectedHex, "hex");
  const result2 = actual2.length === expected2.length && timingSafeEqual(actual2, expected2);
  console.log("Teste 2 (salt como Buffer hex):", result2);
} catch (error) {
  console.log("Teste 2 erro:", error.message);
}
