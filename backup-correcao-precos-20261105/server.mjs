import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import QRCode from "qrcode";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(ROOT, "public");
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 750 * 1024;
const MAX_PRODUCT_GALLERY_DATA_LENGTH = 1_300_000;
const MAX_SITE_IMAGE_BYTES = 5 * 1024 * 1024;
const ROLES = new Set(["ADMIN", "MANAGER", "CASHIER"]);
const PAYMENT_METHODS = new Set(["CASH", "PIX", "DEBIT", "CREDIT", "OTHER"]);

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'MANAGER', 'CASHIER')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS brands (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    parent_id INTEGER,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES categories(id)
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sku TEXT UNIQUE COLLATE NOCASE,
    barcode TEXT UNIQUE,
    category TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
    min_stock INTEGER NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
    size_type TEXT,
    image_data TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS promotions (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    discount_basis_points INTEGER NOT NULL CHECK (discount_basis_points > 0 AND discount_basis_points < 10000),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS promotions_product_period
    ON promotions(product_id, starts_at, ends_at);
  CREATE TABLE IF NOT EXISTS site_sync_outbox (
    id INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    product_id INTEGER,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS site_order_receipts (
    order_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    payload_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS site_order_sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_order_id INTEGER NOT NULL DEFAULT 0 CHECK (last_order_id >= 0)
  );
  INSERT OR IGNORE INTO site_order_sync_state (id, last_order_id) VALUES (1, 0);
  CREATE TABLE IF NOT EXISTS site_sales (
    id INTEGER PRIMARY KEY,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    order_id TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL UNIQUE,
    payload_hash TEXT NOT NULL,
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS site_sale_items (
    id INTEGER PRIMARY KEY,
    site_sale_id INTEGER NOT NULL REFERENCES site_sales(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    variant_id INTEGER REFERENCES product_variants(id),
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0)
  );
  CREATE TABLE IF NOT EXISTS inventory (
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    PRIMARY KEY (branch_id, product_id)
  );
  CREATE TABLE IF NOT EXISTS product_colors (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    image_data TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (product_id, name)
  );
  CREATE TABLE IF NOT EXISTS product_variants (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    color_id INTEGER REFERENCES product_colors(id) ON DELETE CASCADE,
    size TEXT NOT NULL DEFAULT '',
    sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
    barcode TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (product_id, color_id, size)
  );
  CREATE TABLE IF NOT EXISTS inventory_variants (
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    PRIMARY KEY (branch_id, variant_id)
  );
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS cash_sessions (
    id INTEGER PRIMARY KEY,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    opening_cents INTEGER NOT NULL CHECK (opening_cents >= 0),
    closed_at TEXT,
    closing_cents INTEGER,
    CHECK (closing_cents IS NULL OR closing_cents >= 0)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_open_cash_per_branch
    ON cash_sessions(branch_id) WHERE closed_at IS NULL;
  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    cash_session_id INTEGER NOT NULL REFERENCES cash_sessions(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    customer_id INTEGER REFERENCES customers(id),
    subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
    discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
    status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'CANCELED')),
    cancel_reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    canceled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY,
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    product_id INTEGER REFERENCES products(id),
    variant_id INTEGER REFERENCES product_variants(id),
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0)
  );
  CREATE TABLE IF NOT EXISTS sale_payments (
    id INTEGER PRIMARY KEY,
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    method TEXT NOT NULL CHECK (method IN ('CASH', 'PIX', 'DEBIT', 'CREDIT', 'OTHER')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    received_cents INTEGER NOT NULL CHECK (received_cents >= amount_cents)
  );
  CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('IN', 'OUT', 'SALE', 'CANCEL', 'TRANSFER_IN', 'TRANSFER_OUT')),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    note TEXT NOT NULL DEFAULT '',
    sale_id INTEGER REFERENCES sales(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS cash_movements (
    id INTEGER PRIMARY KEY,
    cash_session_id INTEGER NOT NULL REFERENCES cash_sessions(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('IN', 'OUT')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    note TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sales_created_idx ON sales(created_at);
  CREATE INDEX IF NOT EXISTS sales_branch_created_idx ON sales(branch_id, created_at);
  CREATE INDEX IF NOT EXISTS stock_movements_created_idx ON stock_movements(created_at);
`;

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, encoded) {
  const [salt, expectedHex] = encoded.split(":");
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function requiredText(value, label, maxLength = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new HttpError(400, `${label} é obrigatório e deve ter até ${maxLength} caracteres.`);
  }
  return value.trim();
}

function optionalText(value, label, maxLength = 200) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new HttpError(400, `${label} deve ter até ${maxLength} caracteres.`);
  }
  return value.trim();
}

function normalizeDisplayName(value) {
  return value
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("pt-BR")
    .replace(/(^|[\s'’\-])(\p{L})/gu, (_, separator, letter) =>
      `${separator}${letter.toLocaleUpperCase("pt-BR")}`);
}

function productSizeType(...names) {
  const category = names.filter(Boolean).join(" ").normalize("NFD")
    .replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
  if (/\b(calcados?|sapatos?|tenis|sandalias?|chinelos?|botas?)\b/.test(category)) return "footwear";
  if (/\b(calcas?|jeans|leggings?|bermudas?|shorts?)\b/.test(category)) return "trousers";
  if (/\b(roup\w*|vestuario\w*|vestimenta\w*|vestid\w*|moda\w*|camis\w*|blus\w*|uniforme\w*|lingerie|biquini|jaqueta\w*|moletom|meia|cueca|sutia|saia\w*)\b/.test(category)) return "clothing";
  return null;
}

function productSizesForType(type) {
  if (type === "footwear") return Array.from({ length: 14 }, (_, index) => String(index + 33));
  if (type === "trousers") return Array.from({ length: 14 }, (_, index) => String(index * 2 + 34));
  if (type === "clothing") return ["PP", "P", "M", "G", "GG", "XGG"];
  return [];
}

function exactIdentifier(value, label, maxLength = 100) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new HttpError(400, `${label} inválido.`);
  }
  return value;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function cookieMap(request) {
  const result = {};
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function jsonBody(request) {
  return new Promise((resolveBody, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY_BYTES) {
        reject(new HttpError(413, "A requisição excedeu o tamanho permitido."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!data) return resolveBody({});
      try {
        const parsed = JSON.parse(data);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new HttpError(400, "O corpo da requisição deve ser um objeto JSON.");
        }
        resolveBody(parsed);
      } catch (error) {
        reject(error instanceof HttpError ? error : new HttpError(400, "JSON inválido."));
      }
    });
    request.on("error", reject);
  });
}

function money(value, label) {
  if (!isInteger(value)) throw new HttpError(400, `${label} deve ser um valor em centavos.`);
  return value;
}

function createApplication({
  dbPath = process.env.PDV_DB_PATH ?? resolve(ROOT, "data", "pdv.sqlite"),
  siteSyncUrl = process.env.PDV_SITE_SYNC_URL ?? "",
  siteSyncToken = process.env.PDV_SITE_SYNC_TOKEN ?? "",
  siteSyncBranchName = process.env.PDV_SITE_SYNC_BRANCH_NAME ?? "Unidade principal",
} = {}) {
  if (Boolean(siteSyncUrl) !== Boolean(siteSyncToken)) {
    throw new Error("Configure PDV_SITE_SYNC_URL e PDV_SITE_SYNC_TOKEN juntos.");
  }
  if (siteSyncUrl && siteSyncToken.length < 32) {
    throw new Error("PDV_SITE_SYNC_TOKEN deve ter pelo menos 32 caracteres.");
  }
  if (siteSyncUrl) {
    let parsedUrl;
    try {
      parsedUrl = new URL(siteSyncUrl);
    } catch {
      throw new Error("PDV_SITE_SYNC_URL não é uma URL válida.");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("PDV_SITE_SYNC_URL deve usar HTTP ou HTTPS.");
    }
    if (parsedUrl.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname)) {
      throw new Error("A sincronização fora do computador local exige HTTPS.");
    }
  }
  if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(schema);
  const variantColumns = db.prepare("PRAGMA table_info(product_variants)").all();
  if (!variantColumns.some((column) => column.name === "color_id")) {
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE product_variants_new (
          id INTEGER PRIMARY KEY,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          color_id INTEGER REFERENCES product_colors(id) ON DELETE CASCADE,
          size TEXT NOT NULL DEFAULT '',
          sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
          barcode TEXT NOT NULL UNIQUE,
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (product_id, color_id, size)
        );
        INSERT INTO product_variants_new (id, product_id, size, sku, barcode, active, created_at)
          SELECT id, product_id, size, sku, barcode, active, created_at FROM product_variants;
        DROP TABLE product_variants;
        ALTER TABLE product_variants_new RENAME TO product_variants;
        COMMIT;`);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length) throw new Error("A migração de variações deixou referências de banco inválidas.");
  }
  for (const table of ["sale_items", "site_sale_items"]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((column) => column.name === "variant_id")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN variant_id INTEGER REFERENCES product_variants(id)`);
    }
  }
  const transaction = (callback) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  function enqueueSiteEvent(eventType, payload) {
    if (!siteSyncUrl) return false;
    db.prepare(`INSERT INTO site_sync_outbox (event_id, product_id, event_type, payload)
      VALUES (?, ?, ?, ?)`).run(randomUUID(), payload.productId ?? null, eventType, JSON.stringify(payload));
    return true;
  }

  function siteApiUrl(endpoint) {
    const configuredUrl = new URL(siteSyncUrl);
    return new URL(`/api/pdv/${endpoint}`, configuredUrl.origin);
  }

  async function requestSiteApi(endpoint, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetch(siteApiUrl(endpoint), {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${siteSyncToken}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      throw new HttpError(503, `Não foi possível acessar a integração com o site: ${error.message}`);
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 503,
        result.message ?? result.error ?? `O site respondeu com HTTP ${response.status}.`);
    }
    return result;
  }

  function importSiteProduct(record) {
    const eventId = requiredText(record.eventId, "Identificador do evento", 100);
    const name = normalizeDisplayName(requiredText(record.name, "Nome do produto", 160));
    const sku = exactIdentifier(record.sku, "SKU");
    const barcode = exactIdentifier(record.barcode, "Código de barras");
    const category = normalizeDisplayName(optionalText(record.category, "Categoria", 80));
    const description = optionalText(record.description, "Descrição", 1000);
    const sizeType = record.sizeType ?? productSizeType(category) ?? "none";
    const priceCents = money(record.priceCents, "Preço");
    const imageData = imageFromSiteRecord(record.imageData);
    const quantity = record.quantity;
    if (!isInteger(quantity)) throw new HttpError(400, "A quantidade inicial deve ser um inteiro não negativo.");
    if (!Array.isArray(record.variants ?? [])) throw new HttpError(400, "A lista de tamanhos do produto é inválida.");
    if (!Array.isArray(record.colors ?? []) || (record.colors ?? []).length > 10) {
      throw new HttpError(400, "A lista de cores do produto é inválida.");
    }
    const colors = (record.colors ?? []).map((color) => {
      if (!color || typeof color !== "object" || Array.isArray(color)) {
        throw new HttpError(400, "Uma cor sincronizada é inválida.");
      }
      return {
        name: requiredText(color.name, "Cor", 50),
        imageData: imageFromSiteRecord(color.imageData),
      };
    });
    if (colors.some((color) => !color.imageData)
      || new Set(colors.map((color) => color.name.toLocaleLowerCase("pt-BR"))).size !== colors.length) {
      throw new HttpError(400, "Cada cor deve ter nome e imagem próprios.");
    }
    const variants = (record.variants ?? []).map((variant) => {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)
        || !isInteger(variant.quantity) || (variant.size !== null && variant.size !== undefined && typeof variant.size !== "string")) {
        throw new HttpError(400, "Uma variação de tamanho do produto é inválida.");
      }
      return {
        size: optionalText(variant.size, "Tamanho", 20),
        color: optionalText(variant.color, "Cor da variação", 50),
        sku: exactIdentifier(variant.sku, "SKU da variação"),
        barcode: exactIdentifier(variant.barcode, "Código de barras da variação"),
        quantity: variant.quantity,
      };
    });
    if (!["none", "clothing", "trousers", "footwear"].includes(sizeType)) {
      throw new HttpError(400, "O tipo de peça sincronizado é inválido.");
    }
    const combinations = variants.map((variant) =>
      `${variant.color.toLocaleLowerCase("pt-BR")}|${variant.size}`);
    if (new Set(combinations).size !== variants.length
      || (variants.length && variants.reduce((sum, variant) => sum + variant.quantity, 0) !== quantity)) {
      throw new HttpError(400, "O estoque total deve corresponder à soma dos tamanhos.");
    }
    if (variants.some((variant) => variant.color && !colors.some((color) =>
      color.name.toLocaleLowerCase("pt-BR") === variant.color.toLocaleLowerCase("pt-BR")))
      || colors.some((color) => !variants.some((variant) =>
        variant.color.toLocaleLowerCase("pt-BR") === color.name.toLocaleLowerCase("pt-BR")))) {
      throw new HttpError(400, "Cada variação deve corresponder a uma cor cadastrada.");
    }
    const branch = db.prepare("SELECT id FROM branches WHERE name = ? AND active = 1")
      .get(siteSyncBranchName);
    if (!branch) throw new HttpError(409, `A unidade "${siteSyncBranchName}" não foi encontrada no PDV.`);

    transaction(() => {
      const existing = db.prepare("SELECT id FROM products WHERE sku = ? COLLATE NOCASE").get(sku);
      if (existing) {
        const existingProduct = db.prepare("SELECT barcode FROM products WHERE id = ?").get(existing.id);
        if (existingProduct.barcode !== barcode) {
          throw new HttpError(409, `O SKU "${sku}" já pertence a outro produto no PDV.`);
        }
        db.prepare(`UPDATE products SET name = ?, description = ?, barcode = ?, category = ?, size_type = ?, price_cents = ?,
          image_data = COALESCE(?, image_data)
          WHERE id = ?`).run(name, description, barcode, category, sizeType, priceCents, imageData, existing.id);
        syncImportedVariants(existing.id, branch.id, variants, colors);
        return;
      }

      const created = db.prepare(`INSERT INTO products
        (name, description, sku, barcode, category, size_type, price_cents, cost_cents, min_stock, image_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?) RETURNING id`)
        .get(name, description, sku, barcode, category, sizeType, priceCents, imageData);
      db.prepare(`INSERT INTO inventory (branch_id, product_id, quantity)
        SELECT id, ?, 0 FROM branches WHERE active = 1`).run(created.id);
      db.prepare("UPDATE inventory SET quantity = ? WHERE branch_id = ? AND product_id = ?")
        .run(quantity, branch.id, created.id);
      syncImportedVariants(created.id, branch.id, variants, colors);
    });
    return eventId;
  }

  function syncImportedVariants(productId, branchId, variants, colors = []) {
    const colorIds = new Map();
    for (const color of colors) {
      const existing = db.prepare("SELECT id FROM product_colors WHERE product_id = ? AND name = ? COLLATE NOCASE")
        .get(productId, color.name);
      const saved = existing
        ? db.prepare("UPDATE product_colors SET image_data = ?, active = 1 WHERE id = ? RETURNING id")
          .get(color.imageData, existing.id)
        : db.prepare("INSERT INTO product_colors (product_id, name, image_data) VALUES (?, ?, ?) RETURNING id")
          .get(productId, color.name, color.imageData);
      colorIds.set(color.name.toLocaleLowerCase("pt-BR"), saved.id);
    }
    for (const variant of variants) {
      const existing = db.prepare("SELECT id, product_id FROM product_variants WHERE sku = ? COLLATE NOCASE")
        .get(variant.sku);
      if (existing && existing.product_id !== productId) {
        throw new HttpError(409, `O SKU "${variant.sku}" já pertence a outra variação.`);
      }
      const colorId = colorIds.get(variant.color.toLocaleLowerCase("pt-BR")) ?? null;
      const saved = existing
        ? db.prepare("UPDATE product_variants SET color_id = ?, size = ?, barcode = ?, active = 1 WHERE id = ? RETURNING id")
          .get(colorId, variant.size, variant.barcode, existing.id)
        : db.prepare(`INSERT INTO product_variants (product_id, color_id, size, sku, barcode)
          VALUES (?, ?, ?, ?, ?) RETURNING id`).get(productId, colorId, variant.size, variant.sku, variant.barcode);
      db.prepare(`INSERT OR IGNORE INTO inventory_variants (branch_id, variant_id, quantity)
        SELECT id, ?, 0 FROM branches`).run(saved.id);
      db.prepare("UPDATE inventory_variants SET quantity = ? WHERE branch_id = ? AND variant_id = ?")
        .run(variant.quantity, branchId, saved.id);
    }
  }

  async function syncSiteProducts() {
    if (!siteSyncUrl) return;
    try {
      const result = await requestSiteApi("products/pending");
      const records = Array.isArray(result) ? result : result.data ?? result.products;
      if (!Array.isArray(records)) throw new Error("O site retornou uma lista de produtos inválida.");
      for (const record of records) {
        try {
          const eventId = importSiteProduct(record);
          await requestSiteApi("products/ack", { method: "POST", body: { eventId } });
        } catch (error) {
          console.error("Falha ao importar produto do site:", error.message);
        }
      }
    } catch (error) {
      console.error("Falha ao consultar produtos pendentes do site:", error.message);
    }
  }

  function importSiteOrder(record) {
    const eventId = requiredText(record.eventId, "Identificador do evento", 100);
    const orderId = requiredText(record.orderId, "Identificador do pedido", 100);
    const createdAt = requiredText(record.createdAt, "Data do pedido", 100);
    const createdAtTime = Date.parse(createdAt);
    if (!Number.isFinite(createdAtTime)) {
      throw new HttpError(400, "A data do pedido do site é inválida.");
    }
    const createdAtSql = new Date(createdAtTime).toISOString().slice(0, 19).replace("T", " ");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) {
      throw new HttpError(400, "O identificador do pedido ou do evento é inválido.");
    }
    if (!Array.isArray(record.items) || record.items.length < 1 || record.items.length > 100) {
      throw new HttpError(400, "O pedido deve conter de 1 a 100 produtos.");
    }

    const totalCents = money(record.totalCents, "Total do pedido");
    const items = record.items.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new HttpError(400, "Item inválido no pedido do site.");
      }
      const sku = exactIdentifier(item.sku, "SKU");
      if (!isInteger(item.quantity, 1) || item.quantity > 10000) {
        throw new HttpError(400, "Quantidade inválida no pedido do site.");
      }
      const unitPriceCents = money(item.unitPriceCents, "Preço do item");
      const lineTotalCents = money(item.totalCents, "Total do item");
      if (!Number.isSafeInteger(unitPriceCents * item.quantity)
        || unitPriceCents * item.quantity !== lineTotalCents) {
        throw new HttpError(400, "O total de um item do pedido do site é inválido.");
      }
      return { sku, quantity: item.quantity, unitPriceCents, totalCents: lineTotalCents };
    });
    if (items.reduce((sum, item) => sum + item.totalCents, 0) !== totalCents) {
      throw new HttpError(400, "O total do pedido do site não corresponde aos itens.");
    }

    const quantities = new Map();
    for (const item of items) {
      quantities.set(item.sku, (quantities.get(item.sku) ?? 0) + item.quantity);
    }
    const legacyItems = [...quantities.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sku, quantity]) => ({ sku, quantity }));
    const payload = JSON.stringify({ orderId, createdAt, totalCents, items });
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    const legacyPayloadHash = createHash("sha256")
      .update(JSON.stringify({ orderId, items: legacyItems }))
      .digest("hex");
    const branch = db.prepare("SELECT id FROM branches WHERE name = ? AND active = 1")
      .get(siteSyncBranchName);
    if (!branch) throw new HttpError(409, `A unidade "${siteSyncBranchName}" não foi encontrada no PDV.`);

    transaction(() => {
      const existing = db.prepare("SELECT event_id, payload_hash FROM site_order_receipts WHERE order_id = ?")
        .get(orderId);
      let legacyReceipt = false;
      if (existing) {
        if (existing.event_id !== eventId) {
          throw new HttpError(409, "O pedido já foi recebido com dados diferentes.");
        }
        if (existing.payload_hash === payloadHash) {
          if (db.prepare("SELECT 1 FROM site_sales WHERE order_id = ?").get(orderId)) return;
          throw new HttpError(409, "O pedido foi recebido sem o registro de relatório correspondente.");
        }
        if (existing.payload_hash !== legacyPayloadHash) {
          throw new HttpError(409, "O pedido já foi recebido com dados diferentes.");
        }
        legacyReceipt = true;
      }
      if (!existing && db.prepare("SELECT 1 FROM site_order_receipts WHERE event_id = ?").get(eventId)) {
        throw new HttpError(409, "O evento já pertence a outro pedido.");
      }

      const quantitiesBySku = new Map(legacyItems.map((item) => [item.sku, item.quantity]));
      const products = [...quantitiesBySku.entries()].map(([sku, quantity]) => {
        const variant = db.prepare(`SELECT v.id, v.product_id, v.size, c.name AS color, iv.quantity AS stock
          FROM product_variants v JOIN inventory_variants iv ON iv.variant_id = v.id
          LEFT JOIN product_colors c ON c.id = v.color_id
          WHERE v.sku = ? COLLATE NOCASE AND v.active = 1 AND iv.branch_id = ?`).get(sku, branch.id);
        const product = variant
          ? db.prepare("SELECT id, name FROM products WHERE id = ? AND active = 1").get(variant.product_id)
          : db.prepare(`SELECT p.id, p.name, i.quantity AS stock
          FROM products p JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
          WHERE p.sku = ? COLLATE NOCASE AND p.active = 1`).get(branch.id, sku);
        if (!product) throw new HttpError(404, `Produto com SKU ${sku} não encontrado nesta unidade.`);
        const stock = variant?.stock ?? product.stock;
        if (!legacyReceipt && stock < quantity) {
          throw new HttpError(409, `Estoque insuficiente no PDV para ${product.name}${variant?.color ? ` na cor ${variant.color}` : ""}${variant?.size ? ` no tamanho ${variant.size}` : ""}.`);
        }
        return { sku, quantity, product, variant };
      });

      const siteUser = db.prepare("SELECT id FROM users WHERE active = 1 ORDER BY id LIMIT 1").get();
      if (!siteUser) throw new HttpError(409, "Cadastre um usuário ativo no PDV antes de importar pedidos do site.");

      if (!legacyReceipt) {
        const updateStock = db.prepare(`UPDATE inventory SET quantity = quantity - ?
          WHERE branch_id = ? AND product_id = ? AND quantity >= ?`);
        for (const product of products) {
          const changed = updateStock.run(product.quantity, branch.id, product.product.id, product.quantity);
          if (Number(changed.changes) !== 1) {
            throw new HttpError(409, `Estoque insuficiente no PDV para ${product.product.name}.`);
          }
          if (product.variant) {
            const changedVariant = db.prepare(`UPDATE inventory_variants SET quantity = quantity - ?
              WHERE branch_id = ? AND variant_id = ? AND quantity >= ?`)
              .run(product.quantity, branch.id, product.variant.id, product.quantity);
            if (Number(changedVariant.changes) !== 1) {
              throw new HttpError(409, `Estoque insuficiente no PDV para ${product.product.name}${product.variant.color ? ` na cor ${product.variant.color}` : ""}${product.variant.size ? ` no tamanho ${product.variant.size}` : ""}.`);
            }
          }
        }
      }

      const siteSaleId = Number(db.prepare(`INSERT INTO site_sales
        (branch_id, order_id, event_id, payload_hash, total_cents, created_at)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
        .get(branch.id, orderId, eventId, payloadHash, totalCents, createdAtSql).id);
      const productBySku = new Map(products.map((product) => [product.sku, product]));
      for (const item of items) {
        const { product, variant } = productBySku.get(item.sku);
        db.prepare(`INSERT INTO site_sale_items
          (site_sale_id, product_id, variant_id, product_name, quantity, unit_price_cents, total_cents)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(siteSaleId, product.id, variant?.id ?? null,
            product.name + (variant?.color || variant?.size
              ? ` (${[variant.color ? `Cor ${variant.color}` : "", variant.size ? `Tamanho ${variant.size}` : ""].filter(Boolean).join(", ")})`
              : ""),
            item.quantity, item.unitPriceCents, item.totalCents);
      }

      const movementNote = `Pedido pelo site ${orderId}${legacyReceipt ? " (registro histórico)" : ""}`;
      const insertMovement = db.prepare(`INSERT INTO stock_movements
        (branch_id, product_id, user_id, kind, quantity, note, created_at)
        VALUES (?, ?, ?, 'SALE', ?, ?, ?)`);
      for (const product of products) {
        insertMovement.run(
          branch.id,
          product.product.id,
          siteUser.id,
          product.quantity,
          movementNote,
          createdAtSql,
        );
      }

      if (legacyReceipt) {
        db.prepare(`UPDATE site_order_receipts SET payload_hash = ?, payload = ? WHERE order_id = ?`)
          .run(payloadHash, payload, orderId);
      } else {
        db.prepare(`INSERT INTO site_order_receipts (order_id, event_id, payload_hash, payload)
          VALUES (?, ?, ?, ?)`).run(orderId, eventId, payloadHash, payload);
      }
    });
    return { eventId, orderId };
  }

  async function syncSiteOrders() {
    if (!siteSyncUrl) return;
    try {
      const result = await requestSiteApi("site-orders/pending");
      const records = Array.isArray(result) ? result : result.data ?? result.orders;
      if (!Array.isArray(records)) throw new Error("O site retornou uma lista de pedidos inválida.");
      for (const record of records) {
        try {
          const imported = importSiteOrder(record);
          await requestSiteApi("site-orders/ack", {
            method: "POST",
            body: { eventId: imported.eventId },
          });
        } catch (error) {
          console.error("Falha ao importar pedido do site:", error.message);
        }
      }
    } catch (error) {
      console.error("Falha ao consultar pedidos do site:", error.message);
    }
    await syncSiteOrderHistory();
  }

  async function syncSiteOrderHistory() {
    try {
      const cursor = db.prepare("SELECT last_order_id FROM site_order_sync_state WHERE id = 1").get().last_order_id;
      const result = await requestSiteApi(`site-orders/history?afterId=${cursor}`);
      const records = Array.isArray(result) ? result : result.data;
      if (!Array.isArray(records) || !isInteger(result.nextCursor, cursor)) {
        throw new Error("O site retornou um histórico de pedidos inválido.");
      }
      if (records.length === 0) {
        if (result.nextCursor !== cursor) {
          throw new Error("O cursor do histórico avançou sem retornar pedidos.");
        }
        return;
      }
      if (result.nextCursor <= cursor) {
        throw new Error("O cursor do histórico de pedidos não avançou.");
      }

      for (const record of records) importSiteOrder(record);
      db.prepare("UPDATE site_order_sync_state SET last_order_id = ? WHERE id = 1")
        .run(result.nextCursor);
    } catch (error) {
      console.error("Falha ao reconciliar histórico de pedidos do site:", error.message);
    }
  }

  function enqueueStockDelta(branchId, productId, delta, reason, saleId = null, variantId = null) {
    if (!siteSyncUrl || !Number.isSafeInteger(delta) || delta === 0) return false;
    const branch = db.prepare("SELECT name FROM branches WHERE id = ?").get(branchId);
    if (!branch || branch.name !== siteSyncBranchName) return false;
    const product = variantId
      ? db.prepare("SELECT sku FROM product_variants WHERE id = ? AND product_id = ?").get(variantId, productId)
      : db.prepare("SELECT sku FROM products WHERE id = ?").get(productId);
    return enqueueSiteEvent("inventory.delta", {
      productId,
      variantId,
      sku: product?.sku ?? null,
      delta,
      reason,
      saleId,
    });
  }

  let syncingSite = false;
  async function flushSiteSync() {
    if (!siteSyncUrl || syncingSite) return;
    syncingSite = true;
    try {
      while (true) {
        const event = db.prepare(`SELECT e.id, e.event_id, e.event_type, e.payload, e.attempts
          FROM site_sync_outbox e
          WHERE e.next_attempt_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM site_sync_outbox previous
              WHERE previous.product_id IS e.product_id AND previous.id < e.id
            )
          ORDER BY e.id LIMIT 1`).get(Date.now());
        if (!event) break;
        try {
          const payload = JSON.parse(event.payload);
          if (payload.productId) {
            const product = payload.variantId
              ? db.prepare("SELECT sku FROM product_variants WHERE id = ? AND product_id = ?")
                .get(payload.variantId, payload.productId)
              : db.prepare("SELECT sku FROM products WHERE id = ?").get(payload.productId);
            if (!product?.sku) throw new Error("Defina um SKU correspondente no site para sincronizar este produto.");
            payload.sku = product.sku;
          }
          const isProductRegistration = event.event_type === "product.register";
          const response = await fetch(siteApiUrl(isProductRegistration ? "products" : "sync"), {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              Authorization: `Bearer ${siteSyncToken}`,
            },
            body: JSON.stringify(isProductRegistration
              ? { eventId: event.event_id, ...payload }
              : { eventId: event.event_id, type: event.event_type, payload }),
            signal: AbortSignal.timeout(10000),
          });
          const responseBody = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(responseBody.message ?? `O site respondeu com HTTP ${response.status}.`);
          }
          db.prepare("DELETE FROM site_sync_outbox WHERE id = ?").run(event.id);
        } catch (error) {
          const attempts = event.attempts + 1;
          const delay = Math.min(300000, 1000 * (2 ** Math.min(attempts, 8)));
          const message = error instanceof Error ? error.message.slice(0, 500) : "Falha desconhecida ao sincronizar.";
          db.prepare(`UPDATE site_sync_outbox SET attempts = ?, next_attempt_at = ?, last_error = ?
            WHERE id = ?`).run(attempts, Date.now() + delay, message, event.id);
          continue;
        }
      }
      await syncSiteProducts();
      await syncSiteOrders();
    } finally {
      syncingSite = false;
    }
  }

  const productColumns = db.prepare("PRAGMA table_info(products)").all();
  if (!productColumns.some((column) => column.name === "image_data")) {
    db.exec("ALTER TABLE products ADD COLUMN image_data TEXT");
  }
  if (!productColumns.some((column) => column.name === "condition")) {
    db.exec("ALTER TABLE products ADD COLUMN condition TEXT CHECK (condition IN ('novo', 'seminovo', 'brecho'))");
  }
  if (!productColumns.some((column) => column.name === "description")) {
    db.exec("ALTER TABLE products ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }
  if (!productColumns.some((column) => column.name === "size_type")) {
    db.exec("ALTER TABLE products ADD COLUMN size_type TEXT");
  }

  // Criar tabelas de marcas e categorias se não existirem
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  if (!tables.some((t) => t.name === "brands")) {
    db.exec(`
      CREATE TABLE brands (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
  if (!tables.some((t) => t.name === "categories")) {
    db.exec(`
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        parent_id INTEGER,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (parent_id) REFERENCES categories(id)
      )
    `);
  }

  // Adicionar colunas de brand_id e category_id à tabela products se não existirem
  if (!productColumns.some((column) => column.name === "brand_id")) {
    db.exec("ALTER TABLE products ADD COLUMN brand_id INTEGER REFERENCES brands(id)");
  }
  if (!productColumns.some((column) => column.name === "category_id")) {
    db.exec("ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES categories(id)");
  }

  function generatedSku(productId) {
    const base = `PDV-${String(productId).padStart(6, "0")}`;
    let sku = base;
    let suffix = 2;
    while (db.prepare("SELECT 1 FROM products WHERE sku = ?").get(sku)) {
      sku = `${base}-${suffix}`;
      suffix += 1;
    }
    return sku;
  }

  function generatedBarcode(productId) {
    if (productId > 9_999_999_999) throw new HttpError(409, "Não foi possível gerar um código de barras para este produto.");
    for (let prefix = 20; prefix <= 29; prefix += 1) {
      const base = `${prefix}${String(productId).padStart(10, "0")}`;
      const sum = [...base].reduce((total, digit, index) =>
        total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
      const barcode = `${base}${(10 - (sum % 10)) % 10}`;
      if (!db.prepare("SELECT 1 FROM products WHERE barcode = ?").get(barcode)) return barcode;
    }
    throw new HttpError(409, "Não foi possível gerar um código de barras exclusivo.");
  }

  transaction(() => {
    const legacyProducts = db.prepare("SELECT id, sku, barcode FROM products ORDER BY id").all();
    const updateCodes = db.prepare("UPDATE products SET sku = ?, barcode = ? WHERE id = ?");
    for (const product of legacyProducts) {
      updateCodes.run(
        product.sku ?? generatedSku(product.id),
        product.barcode ?? generatedBarcode(product.id),
        product.id,
      );
    }
  });

  function currentUser(request) {
    const token = cookieMap(request).pdv_session;
    if (!token) return null;
    const row = db.prepare(`
      SELECT u.id, u.username, u.name, u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
    `).get(hashToken(token), Date.now());
    if (!row) return null;
    const session = db.prepare("SELECT csrf_token FROM sessions WHERE token_hash = ?")
      .get(hashToken(token));
    return { ...row, csrfToken: session.csrf_token };
  }

  function requireUser(user) {
    if (!user) throw new HttpError(401, "Faça login para continuar.");
  }

  function requireRole(user, roles) {
    requireUser(user);
    if (!roles.includes(user.role)) throw new HttpError(403, "Você não tem permissão para esta ação.");
  }

  function branchOrThrow(branchId) {
    if (!isInteger(branchId, 1)) throw new HttpError(400, "Unidade inválida.");
    const branch = db.prepare("SELECT id, name FROM branches WHERE id = ? AND active = 1").get(branchId);
    if (!branch) throw new HttpError(404, "Unidade não encontrada.");
    return branch;
  }

  function cashOrThrow(branchId) {
    const cash = db.prepare("SELECT * FROM cash_sessions WHERE branch_id = ? AND closed_at IS NULL")
      .get(branchId);
    if (!cash) throw new HttpError(409, "Abra o caixa desta unidade antes de continuar.");
    return cash;
  }

  function cashSummary(sessionId) {
    const cash = db.prepare(`
      SELECT cs.*,
        COALESCE((SELECT SUM(sp.amount_cents) FROM sale_payments sp
          JOIN sales s ON s.id = sp.sale_id
          WHERE s.cash_session_id = cs.id AND sp.method = 'CASH'), 0) AS cash_sales_cents,
        COALESCE((SELECT SUM(CASE WHEN cm.kind = 'IN' THEN cm.amount_cents ELSE -cm.amount_cents END)
          FROM cash_movements cm WHERE cm.cash_session_id = cs.id), 0) AS movement_cents
      FROM cash_sessions cs WHERE cs.id = ?
    `).get(sessionId);
    const expectedCents = cash.opening_cents + cash.cash_sales_cents + cash.movement_cents;
    return { ...cash, expected_cents: expectedCents };
  }

  function imageFromBody(value) {
    if (value === null || value === undefined) return value;
    if (typeof value !== "string" || value.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 32) {
      throw new HttpError(413, "A imagem é muito grande. Escolha uma imagem menor.");
    }
    const match = value.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw new HttpError(400, "A imagem deve ser JPEG. Ela será ajustada automaticamente ao selecionar o arquivo.");
    const bytes = Buffer.from(match[1], "base64");
    if (bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== match[1]
      || bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new HttpError(400, "A imagem JPEG é inválida ou excede o tamanho permitido.");
    }
    return match[1];
  }

  function imageFromSiteRecord(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string" || value.length > Math.ceil(MAX_SITE_IMAGE_BYTES * 4 / 3) + 64) {
      throw new HttpError(413, "A imagem principal do site excede o limite permitido para o PDV.");
    }
    const match = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw new HttpError(400, "A imagem principal do site está em um formato inválido.");
    const [, mimeType, encoded] = match;
    const bytes = Buffer.from(encoded, "base64");
    const validSignature = mimeType === "image/jpeg"
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mimeType === "image/png"
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes.subarray(0, 4).toString("ascii") === "RIFF"
          && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (bytes.length > MAX_SITE_IMAGE_BYTES || bytes.toString("base64") !== encoded || !validSignature) {
      throw new HttpError(400, "A imagem principal do site é inválida ou muito grande.");
    }
    return value;
  }

  async function route(request, response) {
    const url = new URL(request.url, "http://localhost");
    const method = request.method;
    const path = url.pathname;
    const user = currentUser(request);
    const mutating = !["GET", "HEAD"].includes(method);
    const siteOrderEndpoint = path === "/api/site-orders";
    if (path.startsWith("/api/") && mutating && path !== "/api/auth/login" && path !== "/api/setup"
      && !siteOrderEndpoint) {
      requireUser(user);
      if (request.headers["x-csrf-token"] !== user.csrfToken) {
        throw new HttpError(403, "Token de segurança inválido. Atualize a página e tente novamente.");
      }
    }
    const body = mutating ? await jsonBody(request) : {};

    if (siteOrderEndpoint) {
      if (method !== "POST") throw new HttpError(405, "Método não permitido.");
      const providedToken = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
      const expectedToken = Buffer.from(siteSyncToken);
      const actualToken = Buffer.from(providedToken);
      if (!siteSyncToken || actualToken.length !== expectedToken.length
        || !timingSafeEqual(actualToken, expectedToken)) {
        throw new HttpError(401, "Acesso não autorizado.");
      }
      const imported = importSiteOrder(body);
      return sendJson(response, 200, { received: true, ...imported });
    }

    if (method === "GET" && path === "/api/status") {
      return sendJson(response, 200, {
        setupRequired: !db.prepare("SELECT 1 FROM users LIMIT 1").get(),
        siteSyncEnabled: Boolean(siteSyncUrl),
      });
    }

    if (method === "GET" && path === "/api/site-sync/status") {
      requireRole(user, ["ADMIN", "MANAGER"]);
      const state = db.prepare(`SELECT COUNT(*) AS pending,
        COALESCE(SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END), 0) AS failed
        FROM site_sync_outbox`).get();
      const lastError = db.prepare(`SELECT last_error FROM site_sync_outbox
        WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 1`).get();
      const lastEvent = db.prepare("SELECT created_at FROM site_sync_outbox ORDER BY id LIMIT 1").get();
      return sendJson(response, 200, {
        enabled: Boolean(siteSyncUrl),
        branchName: siteSyncBranchName,
        pending: state.pending,
        failed: state.failed,
        lastError: lastError?.last_error ?? null,
        oldestPendingAt: lastEvent?.created_at ?? null,
      });
    }

    if (method === "GET" && path === "/api/site-sync/products/unlinked") {
      requireRole(user, ["ADMIN", "MANAGER"]);
      if (!siteSyncUrl) throw new HttpError(409, "A sincronização com o site não está configurada.");
      return sendJson(response, 200, await requestSiteApi("products/review"));
    }

    if (method === "POST" && path === "/api/site-sync/products/link") {
      requireRole(user, ["ADMIN", "MANAGER"]);
      if (!siteSyncUrl) throw new HttpError(409, "A sincronização com o site não está configurada.");
      const siteProductId = body.productId;
      const localProductId = body.localProductId;
      if (!isInteger(siteProductId, 1) || !isInteger(localProductId, 1)) {
        throw new HttpError(400, "Selecione um produto local e um produto do site.");
      }
      const localProduct = db.prepare("SELECT sku, barcode FROM products WHERE id = ? AND active = 1")
        .get(localProductId);
      if (!localProduct) throw new HttpError(404, "Produto local não encontrado.");
      return sendJson(response, 200, await requestSiteApi("products/link", {
        method: "POST",
        body: { productId: siteProductId, sku: localProduct.sku, barcode: localProduct.barcode },
      }));
    }

    if (method === "POST" && path === "/api/site-sync/retry") {
      requireRole(user, ["ADMIN", "MANAGER"]);
      if (!siteSyncUrl) throw new HttpError(409, "A sincronização com o site não está configurada.");
      db.prepare("UPDATE site_sync_outbox SET next_attempt_at = 0").run();
      setTimeout(() => { void flushSiteSync(); }, 0);
      return sendJson(response, 202, { queued: true });
    }

    if (method === "POST" && path === "/api/site-sync/reconcile") {
      requireRole(user, ["ADMIN"]);
      if (!siteSyncUrl) throw new HttpError(409, "A sincronização com o site não está configurada.");
      const branch = db.prepare("SELECT id FROM branches WHERE name = ? AND active = 1")
        .get(siteSyncBranchName);
      if (!branch) throw new HttpError(409, `A unidade "${siteSyncBranchName}" não foi encontrada no PDV.`);
      const products = db.prepare(`SELECT p.id, p.sku, p.price_cents, i.quantity
        FROM products p JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
        WHERE p.active = 1 ORDER BY p.id`).all(branch.id);
      transaction(() => {
        for (const product of products) {
          enqueueSiteEvent("inventory.set", {
            productId: product.id,
            sku: product.sku,
            quantity: product.quantity,
            reason: "Conciliação inicial pelo PDV",
          });
          enqueueSiteEvent("product.price", {
            productId: product.id,
            sku: product.sku,
            priceCents: product.price_cents,
          });
        }
      });
      setTimeout(() => { void flushSiteSync(); }, 0);
      return sendJson(response, 202, { queued: products.length });
    }

    if (method === "POST" && path === "/api/setup") {
      const name = requiredText(body.name, "Nome", 100);
      const username = requiredText(body.username, "Usuário", 50);
      if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 200) {
        throw new HttpError(400, "A senha deve ter entre 12 e 200 caracteres.");
      }
      const branchName = optionalText(body.branchName, "Nome da unidade", 100) || "Unidade principal";
      const created = transaction(() => {
        if (db.prepare("SELECT 1 FROM users LIMIT 1").get()) {
          throw new HttpError(409, "A configuração inicial já foi concluída.");
        }
        const branch = db.prepare("INSERT INTO branches (name) VALUES (?) RETURNING id, name").get(branchName);
        const admin = db.prepare(`
          INSERT INTO users (username, name, password_hash, role)
          VALUES (?, ?, ?, 'ADMIN') RETURNING id, username, name, role
        `).get(username, name, hashPassword(body.password));
        return { branch, admin };
      });
      return sendJson(response, 201, { configured: true, user: created.admin });
    }

    if (method === "POST" && path === "/api/auth/login") {
      const username = requiredText(body.username, "Usuário", 50);
      if (typeof body.password !== "string" || body.password.length > 200) {
        throw new HttpError(401, "Usuário ou senha inválidos.");
      }
      const account = db.prepare(`
        SELECT id, username, name, password_hash, role FROM users
        WHERE username = ? COLLATE NOCASE AND active = 1
      `).get(username);
      if (!account || !verifyPassword(body.password, account.password_hash)) {
        throw new HttpError(401, "Usuário ou senha inválidos.");
      }
      const token = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(24).toString("base64url");
      db.prepare("INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)")
        .run(hashToken(token), account.id, csrfToken, Date.now() + SESSION_TTL_MS);
      const secure = process.env.PDV_COOKIE_SECURE === "true" ? "; Secure" : "";
      return sendJson(response, 200, {
        user: { id: account.id, username: account.username, name: account.name, role: account.role },
        csrfToken,
      }, {
        "Set-Cookie": `pdv_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
      });
    }

    if (method === "POST" && path === "/api/auth/logout") {
      const token = cookieMap(request).pdv_session;
      if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
      return sendJson(response, 200, { loggedOut: true }, {
        "Set-Cookie": "pdv_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      });
    }

    if (method === "POST" && path === "/api/auth/password") {
      requireUser(user);
      if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string"
        || body.newPassword.length < 12 || body.newPassword.length > 200) {
        throw new HttpError(400, "A nova senha deve ter entre 12 e 200 caracteres.");
      }
      const account = db.prepare("SELECT password_hash FROM users WHERE id = ? AND active = 1").get(user.id);
      if (!account || !verifyPassword(body.currentPassword, account.password_hash)) {
        throw new HttpError(403, "A senha atual está incorreta.");
      }
      const token = cookieMap(request).pdv_session;
      transaction(() => {
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
          .run(hashPassword(body.newPassword), user.id);
        db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
          .run(user.id, hashToken(token));
      });
      return sendJson(response, 200, { updated: true });
    }

    if (method === "GET" && path === "/api/me") {
      if (!user) return sendJson(response, 200, { authenticated: false });
      const branches = db.prepare("SELECT id, name FROM branches WHERE active = 1 ORDER BY name").all();
      const cash = db.prepare("SELECT id, branch_id, opened_at FROM cash_sessions WHERE closed_at IS NULL").all();
      return sendJson(response, 200, {
        authenticated: true,
        user: { id: user.id, username: user.username, name: user.name, role: user.role },
        csrfToken: user.csrfToken,
        branches,
        openCash: cash,
      });
    }

    requireUser(user);

    const imageMatch = path.match(/^\/api\/products\/(\d+)\/image$/);
    if (method === "GET" && imageMatch) {
      const product = db.prepare("SELECT image_data FROM products WHERE id = ? AND active = 1")
        .get(Number(imageMatch[1]));
      if (!product?.image_data) throw new HttpError(404, "Este produto não possui imagem.");
      const dataUrl = product.image_data.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
      const contentType = dataUrl?.[1] ?? "image/jpeg";
      const image = Buffer.from(dataUrl?.[2] ?? product.image_data, "base64");
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": image.length,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
      response.end(image);
      return;
    }

    if (method === "GET" && path === "/api/branches") {
      return sendJson(response, 200, db.prepare("SELECT id, name, active FROM branches ORDER BY name").all());
    }

    if (method === "GET" && path === "/api/brands") {
      return sendJson(response, 200, db.prepare("SELECT id, name, active FROM brands WHERE active = 1 ORDER BY name").all());
    }

    if (method === "POST" && path === "/api/brands") {
      requireRole(user, ["ADMIN", "MANAGER"]);
      const name = normalizeDisplayName(requiredText(body.name, "Nome da marca", 100));
      const existing = db.prepare("SELECT id FROM brands WHERE name = ? COLLATE NOCASE").get(name);
      if (existing) throw new HttpError(409, "Essa marca já está cadastrada.");
      const brand = db.prepare("INSERT INTO brands (name) VALUES (?) RETURNING id, name").get(name);
      return sendJson(response, 201, brand);
    }

    if (method === "GET" && path === "/api/categories") {
      const categories = db.prepare(`
        SELECT c.id, c.name, c.parent_id, p.name AS parent_name
        FROM categories c
        LEFT JOIN categories p ON p.id = c.parent_id
        WHERE c.active = 1
        ORDER BY c.name
      `).all();
      return sendJson(response, 200, categories);
    }

    if (method === "POST" && path === "/api/categories") {
      requireRole(user, ["ADMIN", "MANAGER"]);
      const name = normalizeDisplayName(requiredText(body.name, "Nome da categoria", 100));
      const parentId = body.parentId ? Number(body.parentId) : null;
      if (parentId && !db.prepare("SELECT id FROM categories WHERE id = ?").get(parentId)) {
        throw new HttpError(400, "Categoria pai não encontrada.");
      }
      const existing = db.prepare("SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND (parent_id IS NULL OR parent_id = ?)").get(name, parentId);
      if (existing) throw new HttpError(409, "Essa categoria já está cadastrada.");
      const category = db.prepare("INSERT INTO categories (name, parent_id) VALUES (?, ?) RETURNING id, name, parent_id").get(name, parentId);
      return sendJson(response, 201, category);
    }

    if (method === "GET" && path === "/api/promotions") {
      requireRole(user, ["ADMIN", "MANAGER"]);
      const promotions = db.prepare(`SELECT pr.id, pr.product_id, p.name AS product_name, p.sku,
        pr.discount_basis_points, pr.starts_at, pr.ends_at,
        CASE WHEN julianday(pr.starts_at) <= julianday('now') AND julianday(pr.ends_at) > julianday('now')
          THEN 'ACTIVE' WHEN julianday(pr.starts_at) > julianday('now') THEN 'SCHEDULED' ELSE 'ENDED' END AS status
        FROM promotions pr JOIN products p ON p.id = pr.product_id
        ORDER BY pr.starts_at DESC, p.name`).all();
      return sendJson(response, 200, promotions);
    }

    if (method === "POST" && path === "/api/promotions") {
      requireRole(user, ["ADMIN", "MANAGER"]);
      const productId = Number(body.productId);
      if (!isInteger(productId, 1)) throw new HttpError(400, "Produto inválido.");
      const discountBasisPoints = body.discountBasisPoints;
      if (!isInteger(discountBasisPoints, 1) || discountBasisPoints >= 10000) {
        throw new HttpError(400, "O desconto deve ser maior que 0% e menor que 100%.");
      }
      const startsAt = requiredText(body.startsAt, "Início da promoção", 40);
      const endsAt = requiredText(body.endsAt, "Fim da promoção", 40);
      const startsAtMs = Date.parse(startsAt);
      const endsAtMs = Date.parse(endsAt);
      if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs) || endsAtMs <= startsAtMs) {
        throw new HttpError(400, "Informe um período de promoção válido.");
      }
      const promotion = transaction(() => {
        const product = db.prepare("SELECT id, sku, price_cents FROM products WHERE id = ? AND active = 1")
          .get(productId);
        if (!product) throw new HttpError(404, "Produto não encontrado.");
        const overlap = db.prepare(`SELECT 1 FROM promotions
          WHERE product_id = ? AND starts_at < ? AND ends_at > ?`).get(productId, endsAt, startsAt);
        if (overlap) throw new HttpError(409, "Este produto já tem outra promoção nesse período.");
        const created = db.prepare(`INSERT INTO promotions
          (product_id, discount_basis_points, starts_at, ends_at)
          VALUES (?, ?, ?, ?) RETURNING id, product_id, discount_basis_points, starts_at, ends_at`)
          .get(productId, discountBasisPoints, new Date(startsAtMs).toISOString(), new Date(endsAtMs).toISOString());
        enqueueSiteEvent("promotion.upsert", {
          productId: product.id,
          promotionId: created.id,
          sku: product.sku,
          discountBasisPoints,
          startsAt: created.starts_at,
          endsAt: created.ends_at,
        });
        return created;
      });
      return sendJson(response, 201, promotion);
    }

    const promotionMatch = path.match(/^\/api\/promotions\/(\d+)$/);
    if (method === "DELETE" && promotionMatch) {
      requireRole(user, ["ADMIN", "MANAGER"]);
      const promotionId = Number(promotionMatch[1]);
      const result = transaction(() => {
        const promotion = db.prepare(`SELECT pr.id, pr.discount_basis_points, pr.starts_at, pr.ends_at, p.id AS product_id, p.sku
          FROM promotions pr JOIN products p ON p.id = pr.product_id WHERE pr.id = ?`).get(promotionId);
        if (!promotion) throw new HttpError(404, "Promoção não encontrada.");
        db.prepare("DELETE FROM promotions WHERE id = ?").run(promotionId);
        enqueueSiteEvent("promotion.cancel", {
          productId: promotion.product_id,
          promotionId: promotion.id,
          sku: promotion.sku,
        });
        return { canceled: true };
      });
      return sendJson(response, 200, result);
    }

    if (method === "POST" && path === "/api/branches") {
      requireRole(user, ["ADMIN"]);
      const name = requiredText(body.name, "Nome da unidade", 100);
      const branch = transaction(() => {
        const created = db.prepare("INSERT INTO branches (name) VALUES (?) RETURNING id, name, active").get(name);
        db.prepare("INSERT INTO inventory (branch_id, product_id, quantity) SELECT ?, id, 0 FROM products")
          .run(created.id);
        db.prepare("INSERT INTO inventory_variants (branch_id, variant_id, quantity) SELECT ?, id, 0 FROM product_variants")
          .run(created.id);
        return created;
      });
      return sendJson(response, 201, branch);
    }

    if (method === "GET" && path === "/api/products") {
      const branchId = Number(url.searchParams.get("branchId"));
      branchOrThrow(branchId);
      const query = `%${(url.searchParams.get("q") ?? "").trim().slice(0, 80)}%`;
      const products = db.prepare(`
        SELECT p.id, p.name, p.description, p.sku, p.barcode, p.category, p.size_type, p.brand_id, p.category_id,
          b.name AS brand_name, c.name AS category_name,
          p.price_cents AS regular_price_cents,
          COALESCE(ROUND(p.price_cents * (10000 - pr.discount_basis_points) / 10000.0), p.price_cents) AS price_cents,
          pr.discount_basis_points AS promo_discount_basis_points,
          p.min_stock, p.image_data IS NOT NULL AS has_image, i.quantity, p.active
        FROM products p
        JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
        LEFT JOIN brands b ON b.id = p.brand_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN promotions pr ON pr.product_id = p.id
          AND julianday(pr.starts_at) <= julianday('now') AND julianday(pr.ends_at) > julianday('now')
        WHERE p.active = 1 AND (p.name LIKE ? OR COALESCE(p.sku, '') LIKE ?
          OR COALESCE(p.barcode, '') LIKE ? OR p.category LIKE ?)
        ORDER BY p.name LIMIT 300
      `).all(branchId, query, query, query, query);
      return sendJson(response, 200, products.map((product) => ({
        ...product,
        variants: db.prepare(`SELECT v.id, v.size, v.sku, v.barcode, iv.quantity, c.name AS color
          FROM product_variants v JOIN inventory_variants iv ON iv.variant_id = v.id
          LEFT JOIN product_colors c ON c.id = v.color_id
          WHERE v.product_id = ? AND v.active = 1 AND iv.branch_id = ?
          ORDER BY v.size`).all(product.id, branchId),
        colors: db.prepare(`SELECT id, name, image_data AS imageData FROM product_colors
          WHERE product_id = ? AND active = 1 ORDER BY id`).all(product.id),
      })));
    }

    if (method === "POST" && path === "/api/products") {
      requireRole(user, ["ADMIN", "MANAGER"]);
      if (!siteSyncUrl) {
        throw new HttpError(409, "Configure a integração com o site para cadastrar produtos e gerar códigos compartilhados.");
      }
      const name = normalizeDisplayName(requiredText(body.name, "Nome do produto", 160));
      const description = requiredText(body.description, "Descrição", 1000);
      const branchId = Number(body.branchId);
      branchOrThrow(branchId);
      const price = money(body.priceCents, "Preço");
      const cost = money(body.costCents, "Custo");
      const imageData = imageFromBody(body.imageData);
      const submittedImages = body.images ?? (imageData ? [`data:image/jpeg;base64,${imageData}`] : []);
      if (!Array.isArray(submittedImages) || submittedImages.length < 1 || submittedImages.length > 10) {
        throw new HttpError(400, "Selecione de 1 a 10 imagens para a galeria do site.");
      }
      const siteImages = submittedImages.map((image) => {
        const encoded = imageFromBody(image);
        return `data:image/jpeg;base64,${encoded}`;
      });
      const colors = body.colors ?? [];
      if (!Array.isArray(colors) || colors.length > 10) {
        throw new HttpError(400, "Cadastre no máximo 10 cores por produto.");
      }
      const normalizedColors = colors.map((color) => {
        if (!color || typeof color !== "object" || Array.isArray(color)) {
          throw new HttpError(400, "Uma cor do produto é inválida.");
        }
        return {
          name: requiredText(color.name, "Nome da cor", 50),
          imageData: imageFromBody(color.imageData),
        };
      });
      if (normalizedColors.some((color) => !color.imageData)
        || new Set(normalizedColors.map((color) => color.name.toLocaleLowerCase("pt-BR"))).size !== normalizedColors.length) {
        throw new HttpError(400, "Cada cor deve ter um nome e uma imagem únicos.");
      }
      if (siteImages.reduce((total, image) => total + image.length, 0)
        + normalizedColors.reduce((total, color) => total + color.imageData.length, 0) > MAX_PRODUCT_GALLERY_DATA_LENGTH) {
        throw new HttpError(413, "O conjunto das imagens excede o limite de sincronização. Reduza a quantidade ou o tamanho.");
      }
      const primaryImage = siteImages[0] ? imageFromBody(siteImages[0]) : imageData;
      const minStock = body.minStock;
      const submittedQuantity = body.quantity;
      const hasSubmittedVariants = Array.isArray(body.variants) && body.variants.length > 0;
      if (!isInteger(minStock) || (!isInteger(submittedQuantity) && !hasSubmittedVariants)) {
        throw new HttpError(400, "Estoque mínimo e quantidade devem ser inteiros não negativos.");
      }
      const allocatedCodes = await requestSiteApi("identifiers", { method: "POST", body: {} });
      if (typeof allocatedCodes.sku !== "string" || !allocatedCodes.sku.trim() || allocatedCodes.sku.length > 100
        || typeof allocatedCodes.barcode !== "string" || !allocatedCodes.barcode.trim() || allocatedCodes.barcode.length > 100) {
        throw new HttpError(502, "O site não retornou um SKU e código de barras válidos; nenhum produto foi salvo.");
      }
      const sku = allocatedCodes.sku;
      const barcode = allocatedCodes.barcode;
      const condition = optionalText(body.condition, "Estado do produto", 20);
      const brandId = Number(body.brandId);
      const sizeType = requiredText(body.sizeType, "Tipo de peça", 20);
      if (!["none", "clothing", "trousers", "footwear"].includes(sizeType)) {
        throw new HttpError(400, "Selecione um tipo de peça válido.");
      }
      const parentCategoryId = Number(body.categoryId);
      const subcategoryId = body.subcategoryId ? Number(body.subcategoryId) : null;
      let categoryId = parentCategoryId;
      if (!isInteger(brandId, 1) || !db.prepare("SELECT id FROM brands WHERE id = ?").get(brandId)) {
        throw new HttpError(400, "Marca não encontrada.");
      }
      if (!isInteger(categoryId, 1) || !db.prepare("SELECT id FROM categories WHERE id = ?").get(categoryId)) {
        throw new HttpError(400, "Categoria não encontrada.");
      }
      if (subcategoryId) {
        if (!parentCategoryId
          || !db.prepare("SELECT id FROM categories WHERE id = ? AND parent_id = ?").get(subcategoryId, parentCategoryId)) {
          throw new HttpError(400, "A subcategoria não pertence à categoria selecionada.");
        }
        categoryId = subcategoryId;
      }
      const hasSizeVariants = sizeType !== "none";
      if (hasSizeVariants && !["novo", "seminovo", "brecho"].includes(condition)) {
        throw new HttpError(400, "Selecione o estado do produto.");
      }
      if (!hasSizeVariants && condition) throw new HttpError(400, "Estado do produto só se aplica a roupas e calçados.");
      if (db.prepare("SELECT 1 FROM categories WHERE parent_id = ? LIMIT 1").get(parentCategoryId) && !subcategoryId) {
        throw new HttpError(400, "Selecione uma subcategoria.");
      }
      if (!Array.isArray(body.variants ?? [])) throw new HttpError(400, "A lista de tamanhos é inválida.");
      const submittedVariants = body.variants ?? [];
      const allowedSizes = productSizesForType(sizeType);
      if (hasSizeVariants && submittedVariants.some((variant) => variant
        && typeof variant === "object" && !Array.isArray(variant)
        && typeof variant.size === "string" && !allowedSizes.includes(variant.size))) {
        throw new HttpError(400, "Selecione um dos tamanhos brasileiros disponíveis para o tipo de peça.");
      }
      const seenCombinations = new Set();
      const variants = submittedVariants.map((variant) => {
        if (!variant || typeof variant !== "object" || Array.isArray(variant)
          || (variant.size !== null && variant.size !== undefined && typeof variant.size !== "string")
          || (sizeType !== "none" && !allowedSizes.includes(variant.size))
          || (sizeType === "none" && (variant.size ?? "") !== "")
          || (normalizedColors.length && typeof variant.color !== "string")
          || !isInteger(variant.quantity)) {
          throw new HttpError(400, "Informe combinações de cor, tamanho e estoque válidas.");
        }
        const color = optionalText(variant.color, "Cor da variação", 50);
        if (normalizedColors.length && !normalizedColors.some((entry) =>
          entry.name.toLocaleLowerCase("pt-BR") === color.toLocaleLowerCase("pt-BR"))) {
          throw new HttpError(400, "Cada combinação deve usar uma cor cadastrada.");
        }
        const size = variant.size ?? "";
        const combination = `${color.toLocaleLowerCase("pt-BR")}|${size}`;
        if (seenCombinations.has(combination)) throw new HttpError(400, "Não repita a combinação de cor e tamanho.");
        seenCombinations.add(combination);
        return { color, size, quantity: variant.quantity };
      });
      if (hasSizeVariants && !variants.length) {
        throw new HttpError(400, hasSizeVariants
          ? "Cadastre pelo menos uma combinação com seu estoque."
          : "Este produto não aceita variações de tamanho.");
      }
      if (!hasSizeVariants && !normalizedColors.length && variants.length) {
        throw new HttpError(400, "Este produto não aceita variações sem cor.");
      }
      if (normalizedColors.some((color) => !variants.some((variant) =>
        variant.color.toLocaleLowerCase("pt-BR") === color.name.toLocaleLowerCase("pt-BR")))) {
        throw new HttpError(400, "Informe o estoque de cada cor cadastrada.");
      }
      const quantity = variants.length
        ? variants.reduce((sum, variant) => sum + variant.quantity, 0)
        : submittedQuantity;
      if (!isInteger(quantity)) throw new HttpError(400, "A soma do estoque por tamanho é inválida.");
      const sizedVariants = [];
      for (const variant of variants) {
        const codes = await requestSiteApi("identifiers", { method: "POST", body: {} });
        if (typeof codes.sku !== "string" || !codes.sku.trim() || codes.sku.length > 100
          || typeof codes.barcode !== "string" || !codes.barcode.trim() || codes.barcode.length > 100) {
          throw new HttpError(502, "O site não gerou identificadores válidos para cada tamanho.");
        }
        sizedVariants.push({ ...variant, sku: codes.sku, barcode: codes.barcode });
      }
      const product = transaction(() => {
        const result = db.prepare(`
          INSERT INTO products (name, description, sku, barcode, brand_id, category_id, size_type, price_cents, cost_cents, min_stock, condition)
          VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?) RETURNING id, name, description, sku, barcode, brand_id, category_id, size_type, price_cents, cost_cents, min_stock, condition
        `).get(name, description, brandId, categoryId, sizeType, price, cost, minStock, condition || null);
        db.prepare("UPDATE products SET sku = ?, barcode = ?, image_data = ? WHERE id = ?")
          .run(sku, barcode, primaryImage ?? null, result.id);
        const codes = db.prepare("SELECT sku, barcode FROM products WHERE id = ?").get(result.id);
        db.prepare(`
          INSERT INTO inventory (branch_id, product_id, quantity)
          SELECT id, ?, 0 FROM branches WHERE active = 1
        `).run(result.id);
        db.prepare("UPDATE inventory SET quantity = ? WHERE branch_id = ? AND product_id = ?")
          .run(quantity, branchId, result.id);
        const colorIds = new Map();
        for (const color of normalizedColors) {
          const createdColor = db.prepare(`INSERT INTO product_colors (product_id, name, image_data)
            VALUES (?, ?, ?) RETURNING id`).get(result.id, color.name, color.imageData);
          colorIds.set(color.name.toLocaleLowerCase("pt-BR"), createdColor.id);
        }
        for (const variant of sizedVariants) {
          const colorId = colorIds.get(variant.color.toLocaleLowerCase("pt-BR")) ?? null;
          const createdVariant = db.prepare(`INSERT INTO product_variants (product_id, color_id, size, sku, barcode)
            VALUES (?, ?, ?, ?, ?) RETURNING id`)
            .get(result.id, colorId, variant.size, variant.sku, variant.barcode);
          db.prepare(`INSERT INTO inventory_variants (branch_id, variant_id, quantity)
            SELECT id, ?, 0 FROM branches WHERE active = 1`).run(createdVariant.id);
          db.prepare("UPDATE inventory_variants SET quantity = ? WHERE branch_id = ? AND variant_id = ?")
            .run(variant.quantity, branchId, createdVariant.id);
        }
        if (quantity > 0) {
          db.prepare(`INSERT INTO stock_movements (branch_id, product_id, user_id, kind, quantity, note)
            VALUES (?, ?, ?, 'IN', ?, 'Estoque inicial')`).run(branchId, result.id, user.id, quantity);
        }
        if (siteSyncUrl) {
          const categoryName = db.prepare("SELECT name FROM categories WHERE id = ?").get(categoryId)?.name
            ?? optionalText(body.category, "Categoria", 80);
          const brandName = brandId
            ? db.prepare("SELECT name FROM brands WHERE id = ?").get(brandId)?.name ?? null
            : null;
          enqueueSiteEvent("product.register", {
            productId: result.id,
            name,
            category: categoryName,
            brand: brandName,
            sku,
            barcode,
            priceCents: price,
            costCents: cost,
            description,
            sizeType,
            condition: condition || null,
            quantity,
            variants: sizedVariants,
            colors: normalizedColors.map((color) => ({
              ...color,
              imageData: `data:image/jpeg;base64,${color.imageData}`,
            })),
            images: siteImages,
          });
        }
        return { ...result, ...codes, has_image: primaryImage !== null && primaryImage !== undefined, quantity };
      });
      return sendJson(response, 201, product);
    }

    const productMatch = path.match(/^\/api\/products\/(\d+)$/);
    if (method === "PUT" && productMatch) {
      requireRole(user, ["ADMIN", "MANAGER"]);
      const id = Number(productMatch[1]);
      const name = normalizeDisplayName(requiredText(body.name, "Nome do produto", 160));
      const description = requiredText(body.description, "Descrição", 1000);
      const price = money(body.priceCents, "Preço");
      const cost = money(body.costCents, "Custo");
      const sizeType = requiredText(body.sizeType, "Tipo de peça", 20);
      if (!["none", "clothing", "trousers", "footwear"].includes(sizeType)) {
        throw new HttpError(400, "Selecione um tipo de peça válido.");
      }
      const requestedSku = body.sku === undefined ? undefined : optionalText(body.sku, "SKU", 100);
      const imageData = body.imageData === undefined ? undefined : imageFromBody(body.imageData);
      const minStock = body.minStock;
      const condition = optionalText(body.condition, "Estado do produto", 20);
      const brandId = Number(body.brandId);
      const parentCategoryId = Number(body.categoryId);
      const subcategoryId = body.subcategoryId ? Number(body.subcategoryId) : null;
      let categoryId = parentCategoryId;
      if (!isInteger(brandId, 1) || !db.prepare("SELECT id FROM brands WHERE id = ?").get(brandId)) {
        throw new HttpError(400, "Marca não encontrada.");
      }
      if (!isInteger(categoryId, 1) || !db.prepare("SELECT id FROM categories WHERE id = ?").get(categoryId)) {
        throw new HttpError(400, "Categoria não encontrada.");
      }
      if (subcategoryId) {
        if (!parentCategoryId
          || !db.prepare("SELECT id FROM categories WHERE id = ? AND parent_id = ?").get(subcategoryId, parentCategoryId)) {
          throw new HttpError(400, "A subcategoria não pertence à categoria selecionada.");
        }
        categoryId = subcategoryId;
      }
      if (!isInteger(minStock)) throw new HttpError(400, "Estoque mínimo deve ser um inteiro não negativo.");
      const hasSizeVariants = sizeType !== "none";
      if (hasSizeVariants && !["novo", "seminovo", "brecho"].includes(condition)) {
        throw new HttpError(400, "Selecione o estado do produto.");
      }
      if (!hasSizeVariants && condition) throw new HttpError(400, "Estado do produto só se aplica a roupas e calçados.");
      if (db.prepare("SELECT 1 FROM categories WHERE parent_id = ? LIMIT 1").get(parentCategoryId) && !subcategoryId) {
        throw new HttpError(400, "Selecione uma subcategoria.");
      }
      const currentProduct = db.prepare("SELECT image_data, size_type FROM products WHERE id = ? AND active = 1").get(id);
      if (!currentProduct) throw new HttpError(404, "Produto não encontrado.");
      if (currentProduct.size_type && currentProduct.size_type !== sizeType) {
        throw new HttpError(400, "O tipo de peça não pode ser alterado após o cadastro do produto.");
      }
      if (!imageData && !currentProduct.image_data) throw new HttpError(400, "Adicione uma imagem para o produto.");
      transaction(() => {
        const existing = db.prepare("SELECT sku FROM products WHERE id = ? AND active = 1").get(id);
        if (!existing) throw new HttpError(404, "Produto não encontrado.");
        const sku = requestedSku || existing.sku;
        const update = db.prepare(`
          UPDATE products SET name = ?, sku = ?, brand_id = ?, category_id = ?, size_type = ?,
            description = CASE WHEN ? = 1 THEN ? ELSE description END,
            price_cents = ?, cost_cents = ?, min_stock = ?, condition = ?,
            image_data = CASE WHEN ? = 1 THEN ? ELSE image_data END
          WHERE id = ? AND active = 1
        `).run(name, sku, brandId, categoryId, sizeType,
          1, description,
          price, cost, minStock, condition || null,
          imageData === undefined ? 0 : 1, imageData ?? null, id);
        if (Number(update.changes) !== 1) throw new HttpError(404, "Produto não encontrado.");
        enqueueSiteEvent("product.price", {
          productId: id,
          sku,
          priceCents: price,
          costCents: cost,
          ...(description === undefined ? {} : { description }),
        });
      });
      return sendJson(response, 200, { updated: true });
    }

    if (method === "POST" && path === "/api/inventory/adjust") {
      requireRole(user, ["ADMIN", "MANAGER"]);
      const branchId = Number(body.branchId);
      const productId = Number(body.productId);
      branchOrThrow(branchId);
      if (!isInteger(productId, 1)) throw new HttpError(400, "Produto inválido.");
      if (!Number.isSafeInteger(body.delta) || body.delta === 0) {
        throw new HttpError(400, "A alteração de estoque deve ser um inteiro diferente de zero.");
      }
      const note = requiredText(body.note, "Motivo", 200);
      const inventory = transaction(() => {
        const row = db.prepare(`
          SELECT i.quantity FROM inventory i JOIN products p ON p.id = i.product_id
          WHERE i.branch_id = ? AND i.product_id = ? AND p.active = 1
        `).get(branchId, productId);
        if (!row) throw new HttpError(404, "Produto não encontrado nesta unidade.");
        if (db.prepare("SELECT 1 FROM product_variants WHERE product_id = ? AND active = 1 LIMIT 1").get(productId)) {
          throw new HttpError(409, "Ajuste o estoque selecionando o tamanho do produto.");
        }
        const quantity = row.quantity + body.delta;
        if (!isInteger(quantity)) throw new HttpError(409, "A saída excede o estoque disponível.");
        db.prepare("UPDATE inventory SET quantity = ? WHERE branch_id = ? AND product_id = ?")
          .run(quantity, branchId, productId);
        db.prepare(`INSERT INTO stock_movements (branch_id, product_id, user_id, kind, quantity, note)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(branchId, productId, user.id, body.delta > 0 ? "IN" : "OUT", Math.abs(body.delta), note);
        enqueueStockDelta(branchId, productId, body.delta, note);
        return { quantity };
      });
      return sendJson(response, 200, inventory);
    }

    if (method === "POST" && path === "/api/inventory/variant-adjust") {
      requireRole(user, ["ADMIN", "MANAGER"]);
      const branchId = Number(body.branchId);
      const variantId = Number(body.variantId);
      branchOrThrow(branchId);
      if (!isInteger(variantId, 1) || !Number.isSafeInteger(body.delta) || body.delta === 0) {
        throw new HttpError(400, "Tamanho e alteração de estoque inválidos.");
      }
      const note = requiredText(body.note, "Motivo", 200);
      const inventory = transaction(() => {
        const variant = db.prepare(`SELECT v.product_id, v.size, v.sku, c.name AS color, iv.quantity
          FROM product_variants v JOIN inventory_variants iv ON iv.variant_id = v.id
          LEFT JOIN product_colors c ON c.id = v.color_id
          WHERE v.id = ? AND v.active = 1 AND iv.branch_id = ?`).get(variantId, branchId);
        if (!variant) throw new HttpError(404, "Tamanho não encontrado nesta unidade.");
        const quantity = variant.quantity + body.delta;
        if (!isInteger(quantity)) throw new HttpError(409, "A saída excede o estoque disponível para este tamanho.");
        db.prepare("UPDATE inventory_variants SET quantity = ? WHERE branch_id = ? AND variant_id = ?")
          .run(quantity, branchId, variantId);
        db.prepare("UPDATE inventory SET quantity = quantity + ? WHERE branch_id = ? AND product_id = ?")
          .run(body.delta, branchId, variant.product_id);
        db.prepare(`INSERT INTO stock_movements (branch_id, product_id, user_id, kind, quantity, note)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(branchId, variant.product_id, user.id, body.delta > 0 ? "IN" : "OUT",
            Math.abs(body.delta), `${note}${variant.color ? ` · cor ${variant.color}` : ""}${variant.size ? ` · tamanho ${variant.size}` : ""}`);
        enqueueSiteEvent("inventory.delta", {
          productId: variant.product_id,
          variantId,
          sku: variant.sku,
          delta: body.delta,
          reason: `${note}${variant.color ? ` · cor ${variant.color}` : ""}${variant.size ? ` · tamanho ${variant.size}` : ""}`,
        });
        return { quantity };
      });
      return sendJson(response, 200, inventory);
    }

    if (method === "POST" && path === "/api/inventory/transfer") {
      requireRole(user, ["ADMIN", "MANAGER"]);
      const sourceBranchId = Number(body.sourceBranchId);
      const targetBranchId = Number(body.targetBranchId);
      const productId = Number(body.productId);
      const variantId = body.variantId === undefined || body.variantId === null || body.variantId === ""
        ? null : Number(body.variantId);
      const quantity = body.quantity;
      branchOrThrow(sourceBranchId);
      branchOrThrow(targetBranchId);
      if (sourceBranchId === targetBranchId) throw new HttpError(400, "A unidade de destino deve ser diferente da origem.");
      if (!isInteger(productId, 1) || !isInteger(quantity, 1)) {
        throw new HttpError(400, "Produto e quantidade devem ser inteiros válidos.");
      }
      if (variantId !== null && !isInteger(variantId, 1)) throw new HttpError(400, "Tamanho inválido.");
      const note = requiredText(body.note, "Motivo", 200);
      const result = transaction(() => {
        const hasVariants = Boolean(db.prepare("SELECT 1 FROM product_variants WHERE product_id = ? AND active = 1 LIMIT 1").get(productId));
        if (hasVariants !== (variantId !== null)) {
          throw new HttpError(409, hasVariants
            ? "Selecione o tamanho para transferir o estoque."
            : "Este produto não possui tamanhos cadastrados.");
        }
        const variant = variantId
          ? db.prepare(`SELECT v.id, v.size, v.sku, c.name AS color FROM product_variants v
            LEFT JOIN product_colors c ON c.id = v.color_id
            WHERE v.id = ? AND v.product_id = ? AND v.active = 1`)
            .get(variantId, productId)
          : null;
        if (variantId !== null && !variant) throw new HttpError(404, "Tamanho não encontrado.");
        const source = db.prepare(`
          SELECT quantity FROM inventory WHERE branch_id = ? AND product_id = ?
            AND EXISTS (SELECT 1 FROM products WHERE id = ? AND active = 1)
        `).get(sourceBranchId, productId, productId);
        const target = db.prepare("SELECT quantity FROM inventory WHERE branch_id = ? AND product_id = ?")
          .get(targetBranchId, productId);
        if (!source || !target) throw new HttpError(404, "Produto não encontrado em uma das unidades.");
        const sourceVariant = variant ? db.prepare("SELECT quantity FROM inventory_variants WHERE branch_id = ? AND variant_id = ?")
          .get(sourceBranchId, variant.id) : null;
        const targetVariant = variant ? db.prepare("SELECT quantity FROM inventory_variants WHERE branch_id = ? AND variant_id = ?")
          .get(targetBranchId, variant.id) : null;
        if (variant && (!sourceVariant || !targetVariant)) throw new HttpError(404, "Tamanho não encontrado em uma das unidades.");
        if ((variant ? sourceVariant.quantity : source.quantity) < quantity) {
          throw new HttpError(409, "Estoque insuficiente na unidade de origem.");
        }
        db.prepare("UPDATE inventory SET quantity = quantity - ? WHERE branch_id = ? AND product_id = ?")
          .run(quantity, sourceBranchId, productId);
        db.prepare("UPDATE inventory SET quantity = quantity + ? WHERE branch_id = ? AND product_id = ?")
          .run(quantity, targetBranchId, productId);
        if (variant) {
          db.prepare("UPDATE inventory_variants SET quantity = quantity - ? WHERE branch_id = ? AND variant_id = ?")
            .run(quantity, sourceBranchId, variant.id);
          db.prepare("UPDATE inventory_variants SET quantity = quantity + ? WHERE branch_id = ? AND variant_id = ?")
            .run(quantity, targetBranchId, variant.id);
        }
        db.prepare(`INSERT INTO stock_movements (branch_id, product_id, user_id, kind, quantity, note)
          VALUES (?, ?, ?, 'TRANSFER_OUT', ?, ?)`)
          .run(sourceBranchId, productId, user.id, quantity, `${note}${variant?.color ? ` · cor ${variant.color}` : ""}${variant?.size ? ` · tamanho ${variant.size}` : ""} · destino ${targetBranchId}`);
        db.prepare(`INSERT INTO stock_movements (branch_id, product_id, user_id, kind, quantity, note)
          VALUES (?, ?, ?, 'TRANSFER_IN', ?, ?)`)
          .run(targetBranchId, productId, user.id, quantity, `${note}${variant?.color ? ` · cor ${variant.color}` : ""}${variant?.size ? ` · tamanho ${variant.size}` : ""} · origem ${sourceBranchId}`);
        enqueueStockDelta(sourceBranchId, productId, -quantity, `Transferência: ${note}`, null, variant?.id ?? null);
        enqueueStockDelta(targetBranchId, productId, quantity, `Transferência: ${note}`, null, variant?.id ?? null);
        return {
          sourceQuantity: (variant ? sourceVariant.quantity : source.quantity) - quantity,
          targetQuantity: (variant ? targetVariant.quantity : target.quantity) + quantity,
        };
      });
      return sendJson(response, 200, result);
    }

    if (method === "GET" && path === "/api/customers") {
      const q = `%${(url.searchParams.get("q") ?? "").trim().slice(0, 80)}%`;
      return sendJson(response, 200, db.prepare(`
        SELECT id, name, phone, email FROM customers
        WHERE name LIKE ? OR phone LIKE ? OR email LIKE ?
        ORDER BY name LIMIT 300
      `).all(q, q, q));
    }

    if (method === "POST" && path === "/api/customers") {
      const name = requiredText(body.name, "Nome do cliente", 160);
      const phone = optionalText(body.phone, "Telefone", 40);
      const email = optionalText(body.email, "E-mail", 160);
      const customer = db.prepare(`
        INSERT INTO customers (name, phone, email) VALUES (?, ?, ?)
        RETURNING id, name, phone, email
      `).get(name, phone, email);
      return sendJson(response, 201, customer);
    }

    if (method === "POST" && path === "/api/cash/open") {
      const branchId = Number(body.branchId);
      branchOrThrow(branchId);
      const opening = money(body.openingCents, "Valor de abertura");
      const cash = db.prepare(`
        INSERT INTO cash_sessions (branch_id, user_id, opening_cents)
        VALUES (?, ?, ?) RETURNING id, branch_id, opened_at, opening_cents
      `).get(branchId, user.id, opening);
      return sendJson(response, 201, cash);
    }

    if (method === "GET" && path === "/api/cash") {
      const branchId = Number(url.searchParams.get("branchId"));
      branchOrThrow(branchId);
      const cash = db.prepare("SELECT id FROM cash_sessions WHERE branch_id = ? AND closed_at IS NULL")
        .get(branchId);
      if (!cash) return sendJson(response, 200, { open: false });
      const summary = cashSummary(cash.id);
      const movements = db.prepare(`
        SELECT kind, amount_cents, note, created_at FROM cash_movements
        WHERE cash_session_id = ? ORDER BY id DESC LIMIT 50
      `).all(cash.id);
      return sendJson(response, 200, { open: true, ...summary, movements });
    }

    if (method === "POST" && path === "/api/cash/movement") {
      const branchId = Number(body.branchId);
      branchOrThrow(branchId);
      const cash = cashOrThrow(branchId);
      if (!["IN", "OUT"].includes(body.kind)) throw new HttpError(400, "Tipo de movimentação inválido.");
      const amount = money(body.amountCents, "Valor");
      if (amount === 0) throw new HttpError(400, "O valor deve ser maior que zero.");
      const note = requiredText(body.note, "Descrição", 200);
      db.prepare(`INSERT INTO cash_movements (cash_session_id, user_id, kind, amount_cents, note)
        VALUES (?, ?, ?, ?, ?)`).run(cash.id, user.id, body.kind, amount, note);
      return sendJson(response, 201, { recorded: true });
    }

    if (method === "POST" && path === "/api/cash/close") {
      const branchId = Number(body.branchId);
      branchOrThrow(branchId);
      const cash = cashOrThrow(branchId);
      const counted = money(body.closingCents, "Valor contado no fechamento");
      const summary = cashSummary(cash.id);
      const updated = db.prepare(`
        UPDATE cash_sessions SET closed_at = CURRENT_TIMESTAMP, closing_cents = ?
        WHERE id = ? AND closed_at IS NULL
      `).run(counted, cash.id);
      if (Number(updated.changes) !== 1) throw new HttpError(409, "O caixa já foi fechado.");
      return sendJson(response, 200, {
        closed: true,
        expectedCents: summary.expected_cents,
        countedCents: counted,
        differenceCents: counted - summary.expected_cents,
      });
    }

    if (method === "POST" && path === "/api/payment-simulator/qr") {
      const reference = requiredText(body.reference, "Referência", 40);
      const amountCents = money(body.amountCents, "Total");
      const subtotalCents = money(body.subtotalCents, "Subtotal");
      const discountCents = money(body.discountCents, "Desconto");
      if (discountCents > subtotalCents || subtotalCents - discountCents !== amountCents) {
        throw new HttpError(400, "Subtotal, desconto e total da simulação não correspondem.");
      }
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) {
        throw new HttpError(400, "A simulação aceita de 1 a 20 produtos diferentes.");
      }
      const items = body.items.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new HttpError(400, "Item da simulação inválido.");
        }
        return {
          name: requiredText(item.name, "Produto", 60),
          quantity: isInteger(item.quantity, 1) ? item.quantity : null,
          unitPriceCents: money(item.unitPriceCents, "Preço do produto"),
        };
      });
      if (items.some((item) => item.quantity === null || item.quantity > 10000)) {
        throw new HttpError(400, "Quantidade inválida na simulação.");
      }
      const itemsSubtotalCents = items.reduce((sum, item) =>
        sum + item.unitPriceCents * item.quantity, 0);
      if (!Number.isSafeInteger(itemsSubtotalCents) || itemsSubtotalCents !== subtotalCents) {
        throw new HttpError(400, "Os itens não correspondem ao subtotal da simulação.");
      }
      if (!Array.isArray(body.payments) || body.payments.length < 1 || body.payments.length > 5) {
        throw new HttpError(400, "Informe as formas de pagamento da simulação.");
      }
      const payments = body.payments.map((payment) => {
        if (!payment || typeof payment !== "object" || !PAYMENT_METHODS.has(payment.method)) {
          throw new HttpError(400, "Forma de pagamento inválida na simulação.");
        }
        return { method: payment.method, amountCents: money(payment.amountCents, "Pagamento") };
      });
      if (payments.reduce((sum, payment) => sum + payment.amountCents, 0) !== amountCents) {
        throw new HttpError(400, "Os pagamentos devem corresponder ao total da simulação.");
      }
      const payload = JSON.stringify({
        tipo: "SIMULACAO_PDV_SEM_VALOR_REAL",
        aviso: "NAO_E_PIX_NAO_E_PAGAMENTO",
        referencia: reference,
        subtotalCentavos: subtotalCents,
        descontoCentavos: discountCents,
        totalCentavos: amountCents,
        produtos: items,
        pagamentos: payments,
      });
      let qrCode;
      try {
        qrCode = await QRCode.toDataURL(payload, { errorCorrectionLevel: "L", margin: 2, width: 280 });
      } catch (error) {
        if (error instanceof Error && error.message.includes("amount of data is too big")) {
          throw new HttpError(400, "Os dados da compra são grandes demais para o QR de teste.");
        }
        throw error;
      }
      return sendJson(response, 200, { qrCode, reference, simulated: true });
    }

    if (method === "POST" && path === "/api/sales") {
      const branchId = Number(body.branchId);
      branchOrThrow(branchId);
      const cash = cashOrThrow(branchId);
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
        throw new HttpError(400, "A venda deve conter de 1 a 100 itens.");
      }
      const customerId = body.customerId === null || body.customerId === undefined || body.customerId === ""
        ? null : Number(body.customerId);
      if (customerId !== null && (!isInteger(customerId, 1)
        || !db.prepare("SELECT 1 FROM customers WHERE id = ?").get(customerId))) {
        throw new HttpError(400, "Cliente inválido.");
      }
      const discount = money(body.discountCents ?? 0, "Desconto");
      const items = body.items.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new HttpError(400, "Item da venda inválido.");
        }
        const productId = Number(item.productId);
        const variantId = item.variantId === null || item.variantId === undefined ? null : Number(item.variantId);
        if (!isInteger(productId, 1) || !isInteger(item.quantity, 1) || item.quantity > 10000) {
          throw new HttpError(400, "Produto ou quantidade inválida.");
        }
        if (variantId !== null && !isInteger(variantId, 1)) throw new HttpError(400, "Tamanho do produto inválido.");
        const product = db.prepare(`
          SELECT p.id, p.name,
            COALESCE(ROUND(p.price_cents * (10000 - pr.discount_basis_points) / 10000.0), p.price_cents) AS price_cents,
            i.quantity AS stock
          FROM products p JOIN inventory i ON i.product_id = p.id AND i.branch_id = ?
            LEFT JOIN promotions pr ON pr.product_id = p.id
              AND julianday(pr.starts_at) <= julianday('now') AND julianday(pr.ends_at) > julianday('now')
            WHERE p.id = ? AND p.active = 1
        `).get(branchId, productId);
        if (!product) throw new HttpError(404, "Produto não encontrado nesta unidade.");
        const hasVariants = Boolean(db.prepare("SELECT 1 FROM product_variants WHERE product_id = ? AND active = 1 LIMIT 1").get(productId));
        let variant = null;
        if (hasVariants) {
          if (variantId === null) throw new HttpError(400, `Selecione o tamanho de ${product.name}.`);
          variant = db.prepare(`SELECT v.id, v.size, v.sku, c.name AS color, iv.quantity AS stock
            FROM product_variants v JOIN inventory_variants iv ON iv.variant_id = v.id
            LEFT JOIN product_colors c ON c.id = v.color_id
            WHERE v.id = ? AND v.product_id = ? AND v.active = 1 AND iv.branch_id = ?`)
            .get(variantId, productId, branchId);
          if (!variant) throw new HttpError(404, `Variação não encontrada para ${product.name}.`);
        } else if (variantId !== null) {
          throw new HttpError(400, `O produto ${product.name} não possui variações cadastradas.`);
        }
        const stock = variant?.stock ?? product.stock;
        if (stock < item.quantity) throw new HttpError(409, `Estoque insuficiente para ${product.name}${variant?.color ? ` na cor ${variant.color}` : ""}${variant?.size ? ` no tamanho ${variant.size}` : ""}.`);
        return {
          ...product,
          variantId: variant?.id ?? null,
          color: variant?.color ?? null,
          size: variant?.size ?? null,
          sku: variant?.sku ?? null,
          stock,
          quantity: item.quantity,
          totalCents: product.price_cents * item.quantity,
        };
      });
      const subtotal = items.reduce((sum, item) => sum + item.totalCents, 0);
      if (!Number.isSafeInteger(subtotal) || discount > subtotal) {
        throw new HttpError(400, "Desconto inválido.");
      }
      const total = subtotal - discount;
      if (total === 0) throw new HttpError(400, "O total da venda deve ser maior que zero.");
      if (!Array.isArray(body.payments) || body.payments.length < 1 || body.payments.length > 5) {
        throw new HttpError(400, "Informe de 1 a 5 formas de pagamento.");
      }
      const payments = body.payments.map((payment) => {
        if (!payment || typeof payment !== "object" || Array.isArray(payment)) {
          throw new HttpError(400, "Pagamento inválido.");
        }
        if (!PAYMENT_METHODS.has(payment.method)) throw new HttpError(400, "Forma de pagamento inválida.");
        const amount = money(payment.amountCents, "Valor do pagamento");
        const received = payment.method === "CASH"
          ? money(payment.receivedCents ?? amount, "Valor recebido")
          : amount;
        if (received < amount) throw new HttpError(400, "O valor recebido em dinheiro é menor que o pagamento.");
        return { method: payment.method, amount, received };
      });
      if (payments.reduce((sum, payment) => sum + payment.amount, 0) !== total) {
        throw new HttpError(400, "A soma dos pagamentos deve ser igual ao total da venda.");
      }

      const sale = transaction(() => {
        const inserted = db.prepare(`
          INSERT INTO sales (branch_id, cash_session_id, user_id, customer_id, subtotal_cents, discount_cents, total_cents)
          VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at
        `).get(branchId, cash.id, user.id, customerId, subtotal, discount, total);
        for (const item of items) {
          const changed = db.prepare(`
            UPDATE inventory SET quantity = quantity - ?
            WHERE branch_id = ? AND product_id = ? AND quantity >= ?
          `).run(item.quantity, branchId, item.id, item.quantity);
          if (Number(changed.changes) !== 1) throw new HttpError(409, `Estoque insuficiente para ${item.name}.`);
          if (item.variantId !== null) {
            const changedVariant = db.prepare(`UPDATE inventory_variants SET quantity = quantity - ?
              WHERE branch_id = ? AND variant_id = ? AND quantity >= ?`)
              .run(item.quantity, branchId, item.variantId, item.quantity);
            if (Number(changedVariant.changes) !== 1) {
                throw new HttpError(409, `Estoque insuficiente para ${item.name}${item.color ? ` na cor ${item.color}` : ""}${item.size ? ` no tamanho ${item.size}` : ""}.`);
            }
          }
          db.prepare(`INSERT INTO sale_items
            (sale_id, product_id, variant_id, product_name, quantity, unit_price_cents, total_cents)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(inserted.id, item.id, item.variantId,
              item.name + (item.color || item.size
                ? ` (${[item.color ? `Cor ${item.color}` : "", item.size ? `Tamanho ${item.size}` : ""].filter(Boolean).join(", ")})`
                : ""),
              item.quantity, item.price_cents, item.totalCents);
          db.prepare(`INSERT INTO stock_movements
            (branch_id, product_id, user_id, kind, quantity, note, sale_id)
            VALUES (?, ?, ?, 'SALE', ?, 'Venda', ?)`)
            .run(branchId, item.id, user.id, item.quantity, inserted.id);
          enqueueStockDelta(branchId, item.id, -item.quantity,
            item.color || item.size
              ? `Venda${item.color ? ` cor ${item.color}` : ""}${item.size ? ` tamanho ${item.size}` : ""}`
              : "Venda",
            inserted.id, item.variantId);
        }
        for (const payment of payments) {
          db.prepare(`INSERT INTO sale_payments (sale_id, method, amount_cents, received_cents)
            VALUES (?, ?, ?, ?)`).run(inserted.id, payment.method, payment.amount, payment.received);
        }
        return { id: inserted.id, createdAt: inserted.created_at };
      });
      const syncPending = db.prepare("SELECT COUNT(*) AS count FROM site_sync_outbox").get().count;
      return sendJson(response, 201, {
        ...sale,
        subtotalCents: subtotal,
        discountCents: discount,
        totalCents: total,
        siteSyncPending: syncPending,
      });
    }

    if (method === "GET" && path === "/api/sales") {
      const branchId = Number(url.searchParams.get("branchId"));
      branchOrThrow(branchId);
      const from = (url.searchParams.get("from") ?? "").slice(0, 10);
      const to = (url.searchParams.get("to") ?? "").slice(0, 10);
      const sales = db.prepare(`
        SELECT s.id, s.created_at, s.total_cents, s.status, u.name AS cashier,
          c.name AS customer
        FROM sales s JOIN users u ON u.id = s.user_id
        LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.branch_id = ?
          AND (? = '' OR date(s.created_at) >= date(?))
          AND (? = '' OR date(s.created_at) <= date(?))
        ORDER BY s.id DESC LIMIT 200
      `).all(branchId, from, from, to, to);
      return sendJson(response, 200, sales);
    }

    const saleMatch = path.match(/^\/api\/sales\/(\d+)$/);
    if (method === "GET" && saleMatch) {
      const saleId = Number(saleMatch[1]);
      const sale = db.prepare(`
        SELECT s.*, b.name AS branch_name, u.name AS cashier, c.name AS customer
        FROM sales s JOIN branches b ON b.id = s.branch_id
        JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.id = ?
      `).get(saleId);
      if (!sale) throw new HttpError(404, "Venda não encontrada.");
      sale.items = db.prepare("SELECT product_name, quantity, unit_price_cents, total_cents FROM sale_items WHERE sale_id = ?").all(saleId);
      sale.payments = db.prepare("SELECT method, amount_cents, received_cents FROM sale_payments WHERE sale_id = ?").all(saleId);
      return sendJson(response, 200, sale);
    }

    const cancelMatch = path.match(/^\/api\/sales\/(\d+)\/cancel$/);
    if (method === "POST" && cancelMatch) {
      requireRole(user, ["ADMIN", "MANAGER"]);
      const saleId = Number(cancelMatch[1]);
      const reason = requiredText(body.reason, "Motivo do cancelamento", 240);
      const result = transaction(() => {
        const sale = db.prepare("SELECT * FROM sales WHERE id = ?").get(saleId);
        if (!sale) throw new HttpError(404, "Venda não encontrada.");
        if (sale.status !== "COMPLETED") throw new HttpError(409, "Esta venda já foi cancelada.");
        const activeCash = db.prepare("SELECT id FROM cash_sessions WHERE id = ? AND closed_at IS NULL")
          .get(sale.cash_session_id);
        if (!activeCash) throw new HttpError(409, "Só é possível cancelar a venda enquanto o caixa correspondente estiver aberto.");
        const items = db.prepare("SELECT product_id, variant_id, quantity FROM sale_items WHERE sale_id = ?").all(saleId);
        for (const item of items) {
          if (item.product_id === null) continue;
          db.prepare("UPDATE inventory SET quantity = quantity + ? WHERE branch_id = ? AND product_id = ?")
            .run(item.quantity, sale.branch_id, item.product_id);
          if (item.variant_id !== null) {
            db.prepare("UPDATE inventory_variants SET quantity = quantity + ? WHERE branch_id = ? AND variant_id = ?")
              .run(item.quantity, sale.branch_id, item.variant_id);
          }
          db.prepare(`INSERT INTO stock_movements
            (branch_id, product_id, user_id, kind, quantity, note, sale_id)
            VALUES (?, ?, ?, 'CANCEL', ?, ?, ?)`)
            .run(sale.branch_id, item.product_id, user.id, item.quantity, reason, saleId);
          enqueueStockDelta(sale.branch_id, item.product_id, item.quantity, `Cancelamento: ${reason}`, saleId, item.variant_id);
        }
        const refundByMethod = db.prepare(`
          SELECT method, SUM(amount_cents) AS amount_cents
          FROM sale_payments WHERE sale_id = ?
          GROUP BY method ORDER BY method
        `).all(saleId);
        const cashAmount = refundByMethod.find((payment) => payment.method === "CASH")?.amount_cents ?? 0;
        if (cashAmount > 0) {
          db.prepare(`INSERT INTO cash_movements
            (cash_session_id, user_id, kind, amount_cents, note)
            VALUES (?, ?, 'OUT', ?, ?)`)
            .run(sale.cash_session_id, user.id, cashAmount, `Estorno de venda #${saleId}: ${reason}`);
        }
        db.prepare(`UPDATE sales SET status = 'CANCELED', cancel_reason = ?, canceled_at = CURRENT_TIMESTAMP
          WHERE id = ?`).run(reason, saleId);
        return {
          canceled: true,
          cashRefundCents: cashAmount,
          refundByMethod: refundByMethod.map((payment) => ({
            method: payment.method,
            amountCents: payment.amount_cents,
          })),
        };
      });
      return sendJson(response, 200, result);
    }

    if (method === "GET" && path === "/api/reports") {
      requireRole(user, ["ADMIN", "MANAGER"]);
      const branchId = Number(url.searchParams.get("branchId"));
      branchOrThrow(branchId);
      const from = (url.searchParams.get("from") ?? "").slice(0, 10);
      const to = (url.searchParams.get("to") ?? "").slice(0, 10);
      const validDate = (value) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
      };
      if ((from && !validDate(from)) || (to && !validDate(to))) {
        throw new HttpError(400, "Informe um período com datas válidas.");
      }
      if (from && to && from > to) throw new HttpError(400, "A data inicial não pode ser posterior à data final.");
      const filter = `
        s.branch_id = ?
        AND (? = '' OR date(s.created_at) >= date(?))
        AND (? = '' OR date(s.created_at) <= date(?))
      `;
      const parameters = [branchId, from, from, to, to];
      const totals = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END), 0) AS sale_count,
          COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN subtotal_cents ELSE 0 END), 0) AS subtotal_cents,
          COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN discount_cents ELSE 0 END), 0) AS discount_cents,
          COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN total_cents ELSE 0 END), 0) AS total_cents,
          COALESCE(SUM(CASE WHEN status = 'CANCELED' THEN 1 ELSE 0 END), 0) AS canceled_count,
          COALESCE(SUM(CASE WHEN status = 'CANCELED' THEN total_cents ELSE 0 END), 0) AS canceled_total_cents,
          COALESCE(AVG(CASE WHEN status = 'COMPLETED' THEN total_cents END), 0) AS average_ticket_cents,
          COALESCE(MAX(CASE WHEN status = 'COMPLETED' THEN total_cents END), 0) AS highest_sale_cents
        FROM sales s WHERE ${filter}
      `).get(...parameters);
      const siteFilter = `
        ss.branch_id = ?
        AND (? = '' OR date(ss.created_at) >= date(?))
        AND (? = '' OR date(ss.created_at) <= date(?))
      `;
      const siteTotals = db.prepare(`
        SELECT COUNT(*) AS site_order_count,
          COALESCE(SUM(total_cents), 0) AS site_order_total_cents
        FROM site_sales ss WHERE ${siteFilter}
      `).get(...parameters);
      const siteDaily = db.prepare(`
        SELECT date(ss.created_at) AS order_date, COUNT(*) AS order_count,
          COALESCE(SUM(ss.total_cents), 0) AS total_cents
        FROM site_sales ss WHERE ${siteFilter}
        GROUP BY date(ss.created_at) ORDER BY order_date
      `).all(...parameters);
      const siteSales = db.prepare(`
        SELECT ss.order_id, ss.created_at, ss.total_cents, COUNT(ssi.id) AS item_count
        FROM site_sales ss LEFT JOIN site_sale_items ssi ON ssi.site_sale_id = ss.id
        WHERE ${siteFilter}
        GROUP BY ss.id ORDER BY ss.created_at, ss.id
      `).all(...parameters);
      const siteSaleItems = db.prepare(`
        SELECT ss.order_id, ss.created_at, ssi.product_name, ssi.quantity,
          ssi.unit_price_cents, ssi.total_cents
        FROM site_sale_items ssi JOIN site_sales ss ON ss.id = ssi.site_sale_id
        WHERE ${siteFilter}
        ORDER BY ss.created_at, ss.id, ssi.id
      `).all(...parameters);
      const methods = db.prepare(`
        SELECT sp.method, s.status, SUM(sp.amount_cents) AS amount_cents,
          COUNT(DISTINCT s.id) AS sale_count
        FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
        WHERE ${filter}
        GROUP BY sp.method, s.status ORDER BY sp.method, s.status
      `).all(...parameters);
      const daily = db.prepare(`
        SELECT date(s.created_at) AS sale_date,
          SUM(CASE WHEN s.status = 'COMPLETED' THEN 1 ELSE 0 END) AS sale_count,
          COALESCE(SUM(CASE WHEN s.status = 'COMPLETED' THEN s.subtotal_cents ELSE 0 END), 0) AS subtotal_cents,
          COALESCE(SUM(CASE WHEN s.status = 'COMPLETED' THEN s.discount_cents ELSE 0 END), 0) AS discount_cents,
          COALESCE(SUM(CASE WHEN s.status = 'COMPLETED' THEN s.total_cents ELSE 0 END), 0) AS total_cents,
          SUM(CASE WHEN s.status = 'CANCELED' THEN 1 ELSE 0 END) AS canceled_count,
          COALESCE(SUM(CASE WHEN s.status = 'CANCELED' THEN s.total_cents ELSE 0 END), 0) AS canceled_total_cents
        FROM sales s WHERE ${filter}
        GROUP BY date(s.created_at) ORDER BY sale_date
      `).all(...parameters);
      const products = db.prepare(`
        SELECT 'PDV' AS channel, si.product_id, si.product_name, SUM(si.quantity) AS quantity,
          SUM(si.total_cents) AS item_total_cents, COUNT(DISTINCT s.id) AS sale_count
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE ${filter} AND s.status = 'COMPLETED'
        GROUP BY si.product_id, si.product_name
        UNION ALL
        SELECT 'SITE' AS channel, ssi.product_id, ssi.product_name, SUM(ssi.quantity) AS quantity,
          SUM(ssi.total_cents) AS item_total_cents, COUNT(DISTINCT ss.id) AS sale_count
        FROM site_sale_items ssi JOIN site_sales ss ON ss.id = ssi.site_sale_id
        WHERE ${siteFilter}
        GROUP BY ssi.product_id, ssi.product_name
        ORDER BY quantity DESC, item_total_cents DESC, product_name
      `).all(...parameters, ...parameters);
      const cashiers = db.prepare(`
        SELECT u.name AS cashier,
          SUM(CASE WHEN s.status = 'COMPLETED' THEN 1 ELSE 0 END) AS sale_count,
          COALESCE(SUM(CASE WHEN s.status = 'COMPLETED' THEN s.total_cents ELSE 0 END), 0) AS total_cents,
          SUM(CASE WHEN s.status = 'CANCELED' THEN 1 ELSE 0 END) AS canceled_count
        FROM sales s JOIN users u ON u.id = s.user_id
        WHERE ${filter}
        GROUP BY u.id, u.name ORDER BY total_cents DESC, u.name
      `).all(...parameters);
      const sales = db.prepare(`
        SELECT s.id, s.created_at, s.status, s.subtotal_cents, s.discount_cents, s.total_cents,
          s.cancel_reason, s.canceled_at, u.name AS cashier, c.name AS customer,
          (SELECT group_concat(sp.method, ', ') FROM sale_payments sp WHERE sp.sale_id = s.id) AS payment_methods
        FROM sales s JOIN users u ON u.id = s.user_id
        LEFT JOIN customers c ON c.id = s.customer_id
        WHERE ${filter} ORDER BY s.created_at, s.id
      `).all(...parameters);
      const saleItems = db.prepare(`
        SELECT s.id AS sale_id, s.created_at, s.status, si.product_name, si.quantity,
          si.unit_price_cents, si.total_cents
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE ${filter}
        ORDER BY s.created_at, s.id, si.id
      `).all(...parameters);
      const cashSessions = db.prepare(`
        SELECT cs.id, cs.opened_at, cs.closed_at, cs.opening_cents, cs.closing_cents, u.name AS cashier,
          cs.opening_cents
            + COALESCE((SELECT SUM(sp.amount_cents) FROM sale_payments sp
              JOIN sales s ON s.id = sp.sale_id
              WHERE s.cash_session_id = cs.id AND s.status = 'COMPLETED' AND sp.method = 'CASH'), 0)
            + COALESCE((SELECT SUM(CASE WHEN cm.kind = 'IN' THEN cm.amount_cents ELSE -cm.amount_cents END)
              FROM cash_movements cm WHERE cm.cash_session_id = cs.id), 0) AS expected_cents
        FROM cash_sessions cs JOIN users u ON u.id = cs.user_id
        WHERE cs.branch_id = ?
          AND (
            ((? = '' OR date(cs.opened_at) >= date(?)) AND (? = '' OR date(cs.opened_at) <= date(?)))
            OR (cs.closed_at IS NOT NULL
              AND (? = '' OR date(cs.closed_at) >= date(?))
              AND (? = '' OR date(cs.closed_at) <= date(?)))
          )
        ORDER BY cs.opened_at
      `).all(branchId, from, from, to, to, from, from, to, to);
      const cashMovements = db.prepare(`
        SELECT cm.created_at, cm.kind, cm.amount_cents, cm.note, u.name AS user_name, cs.id AS cash_session_id
        FROM cash_movements cm JOIN cash_sessions cs ON cs.id = cm.cash_session_id
        JOIN users u ON u.id = cm.user_id
        WHERE cs.branch_id = ?
          AND (? = '' OR date(cm.created_at) >= date(?))
          AND (? = '' OR date(cm.created_at) <= date(?))
        ORDER BY cm.created_at, cm.id
      `).all(...parameters);
      const stockMovements = db.prepare(`
        SELECT sm.created_at, sm.kind, sm.quantity, sm.note, p.name AS product_name,
          CASE WHEN site_sale.id IS NOT NULL THEN 'SITE' ELSE 'PDV' END AS source,
          CASE WHEN site_sale.id IS NOT NULL THEN 'Site' ELSE u.name END AS user_name,
          sm.sale_id
        FROM stock_movements sm JOIN products p ON p.id = sm.product_id
        JOIN users u ON u.id = sm.user_id
        LEFT JOIN site_sales site_sale
          ON site_sale.branch_id = sm.branch_id
          AND sm.note LIKE 'Pedido pelo site ' || site_sale.order_id || '%'
        WHERE sm.branch_id = ?
          AND (? = '' OR date(sm.created_at) >= date(?))
          AND (? = '' OR date(sm.created_at) <= date(?))
        ORDER BY sm.created_at, sm.id
      `).all(...parameters);
      const inventory = db.prepare(`
        SELECT p.name, p.sku, i.quantity, p.min_stock
        FROM products p JOIN inventory i ON i.product_id = p.id
        WHERE i.branch_id = ? AND p.active = 1
        ORDER BY p.name
      `).all(branchId);
      const lowStock = db.prepare(`
        SELECT p.id, p.name, p.min_stock, i.quantity
        FROM products p JOIN inventory i ON i.product_id = p.id
        WHERE i.branch_id = ? AND p.active = 1 AND i.quantity <= p.min_stock
        ORDER BY i.quantity, p.name LIMIT 100
      `).all(branchId);
      return sendJson(response, 200, {
        branch: branchOrThrow(branchId),
        from,
        to,
        ...totals,
        ...siteTotals,
        methods,
        daily,
        siteDaily,
        siteSales,
        siteSaleItems,
        products,
        cashiers,
        sales,
        saleItems,
        cashSessions,
        cashMovements,
        stockMovements,
        inventory,
        lowStock,
      });
    }

    if (method === "GET" && path === "/api/users") {
      requireRole(user, ["ADMIN"]);
      return sendJson(response, 200, db.prepare(`
        SELECT id, username, name, role, active, created_at FROM users ORDER BY name
      `).all());
    }

    if (method === "POST" && path === "/api/users") {
      requireRole(user, ["ADMIN"]);
      const name = requiredText(body.name, "Nome", 100);
      const username = requiredText(body.username, "Usuário", 50);
      if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 200) {
        throw new HttpError(400, "A senha deve ter entre 12 e 200 caracteres.");
      }
      if (!ROLES.has(body.role) || body.role === "ADMIN") {
        throw new HttpError(400, "Selecione o perfil gerente ou operador.");
      }
      const created = db.prepare(`
        INSERT INTO users (username, name, password_hash, role)
        VALUES (?, ?, ?, ?) RETURNING id, username, name, role, active
      `).get(username, name, hashPassword(body.password), body.role);
      return sendJson(response, 201, created);
    }

    const userMatch = path.match(/^\/api\/users\/(\d+)$/);
    if (method === "PATCH" && userMatch) {
      requireRole(user, ["ADMIN"]);
      const targetId = Number(userMatch[1]);
      if (targetId === user.id) throw new HttpError(400, "Não é possível desativar sua própria conta.");
      const active = body.active === true ? 1 : body.active === false ? 0 : null;
      if (active === null) throw new HttpError(400, "Estado do usuário inválido.");
      const update = db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active, targetId);
      if (Number(update.changes) === 0) throw new HttpError(404, "Usuário não encontrado.");
      return sendJson(response, 200, { updated: true });
    }

    throw new HttpError(404, "Rota não encontrada.");
  }

  const server = createServer(async (request, response) => {
    try {
      if (!request.url?.startsWith("/api/")) {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
        const file = resolve(PUBLIC_DIR, relative);
        if (file !== PUBLIC_DIR && !file.startsWith(`${PUBLIC_DIR}${sep}`)) {
          throw new HttpError(404, "Arquivo não encontrado.");
        }
        if (!existsSync(file)) throw new HttpError(404, "Arquivo não encontrado.");
        const contentTypes = {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".svg": "image/svg+xml",
        };
        response.writeHead(200, {
          "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
        });
        return createReadStream(file).pipe(response);
      }
      await route(request, response);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof HttpError) {
        return sendJson(response, error.status, { error: error.message });
      }
      if (error?.message?.includes("UNIQUE constraint failed")) {
        return sendJson(response, 409, { error: "Este valor já está cadastrado." });
      }
      console.error("Erro no servidor PDV:", error);
      return sendJson(response, 500, { error: "Erro interno. Consulte o log do servidor." });
    }
  });
  server.database = db;
  if (siteSyncUrl) {
    const syncTimer = setInterval(() => { void flushSiteSync(); }, 2000);
    syncTimer.unref();
    server.on("close", () => clearInterval(syncTimer));
  }
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envPath = resolve(ROOT, ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  const server = createApplication();
  const port = Number(process.env.PORT ?? 3000);
  const host = "0.0.0.0";
  server.listen(port, host, () => {
    console.log(`PDV escutando na porta ${port} em ${host}`);
    console.log("Banco SQLite:", process.env.PDV_DB_PATH ?? resolve(ROOT, "data", "pdv.sqlite"));
  });
}

export { createApplication };
