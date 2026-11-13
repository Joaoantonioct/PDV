import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApplication } from "../server.mjs";

test("configuração, autenticação, venda, estoque, cancelamento e fechamento do caixa", async (context) => {
  let nextIdentifier = 0;
  let publishedPayload = null;
  const site = createServer(async (request, response) => {
    let data = "";
    request.setEncoding("utf8");
    for await (const chunk of request) data += chunk;
    const body = data ? JSON.parse(data) : {};
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/pdv/identifiers") {
      nextIdentifier += 1;
      const base = `20${String(nextIdentifier).padStart(10, "0")}`;
      const sum = [...base].reduce((total, digit, index) =>
        total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
      return response.end(JSON.stringify({
        sku: `PDV-${String(nextIdentifier).padStart(6, "0")}`,
        barcode: `${base}${(10 - (sum % 10)) % 10}`,
      }));
    }
    if (request.url === "/api/pdv/products/pending") return response.end(JSON.stringify([]));
    if (request.url === "/api/pdv/publications") {
      publishedPayload = body;
      response.statusCode = 201;
      return response.end(JSON.stringify({ received: true, duplicate: false, publicationId: 7 }));
    }
    response.end(JSON.stringify({ received: true, eventId: body.eventId }));
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const server = createApplication({
    dbPath: ":memory:",
    siteSyncUrl: `http://127.0.0.1:${site.address().port}/api/pdv/sync`,
    siteSyncToken: "a".repeat(64),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    server.database.close();
    await new Promise((resolve, reject) => site.close((error) => error ? reject(error) : resolve()));
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  let csrf = "";
  const request = async (path, { method = "GET", body, authenticated = true } = {}) => {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (authenticated && cookie) {
      headers.Cookie = cookie;
      headers["X-CSRF-Token"] = csrf;
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    return { response, payload };
  };

  const status = await request("/api/status", { authenticated: false });
  assert.equal(status.payload.setupRequired, true);

  const setup = await request("/api/setup", {
    method: "POST",
    authenticated: false,
    body: {
      name: "Pessoa Administradora",
      username: "admin",
      password: "senha-local-segura-123",
      branchName: "Loja Centro",
    },
  });
  assert.equal(setup.response.status, 201);

  const login = await request("/api/auth/login", {
    method: "POST",
    authenticated: false,
    body: { username: "admin", password: "senha-local-segura-123" },
  });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.getSetCookie()[0].split(";")[0];
  csrf = login.payload.csrfToken;

  const unauthenticatedQr = await request("/api/payment-simulator/qr", {
    method: "POST",
    authenticated: false,
    body: { reference: "TESTE-1", amountCents: 100, subtotalCents: 100, discountCents: 0 },
  });
  assert.equal(unauthenticatedQr.response.status, 401);

  const secondBranch = await request("/api/branches", {
    method: "POST",
    body: { name: "Loja Norte" },
  });
  assert.equal(secondBranch.response.status, 201);

  const brand = await request("/api/brands", {
    method: "POST",
    body: { name: "  mARCA   de bRINQUEDOS " },
  });
  assert.equal(brand.response.status, 201);
  assert.equal(brand.payload.name, "Marca De Brinquedos");
  const category = await request("/api/categories", {
    method: "POST",
    body: { name: "  BRINQUEDOS " },
  });
  assert.equal(category.response.status, 201);
  assert.equal(category.payload.name, "Brinquedos");
  const subcategory = await request("/api/categories", {
    method: "POST",
    body: { name: "  BONECAS   E JOGOS ", parentId: category.payload.id },
  });
  assert.equal(subcategory.response.status, 201);
  assert.equal(subcategory.payload.name, "Bonecas E Jogos");
  assert.equal(subcategory.payload.parent_id, category.payload.id);

  const missingCsrf = await fetch(`${baseUrl}/api/cash/open`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ branchId: 1, openingCents: 1000 }),
  });
  assert.equal(missingCsrf.status, 403);

  const productDescription = "Descrição detalhada do produto. ".repeat(32).slice(0, 1000);
  const product = await request("/api/products", {
    method: "POST",
    body: {
      branchId: 1, name: "cAFÉ", category: "Bebidas",
      brandId: brand.payload.id, categoryId: category.payload.id, sizeType: "none",
      subcategoryId: subcategory.payload.id,
      priceCents: 1250, costCents: 700, minStock: 1, quantity: 5,
      description: productDescription,
      imageData: "data:image/jpeg;base64,/9j/2Q==",
    },
  });
  assert.equal(product.response.status, 201);
  assert.equal(product.payload.name, "Café");
  assert.equal(product.payload.category_id, subcategory.payload.id);
  assert.equal(product.payload.size_type, "none");
  assert.equal(product.payload.quantity, 5);
  assert.equal(product.payload.sku, "PDV-000001");
  assert.match(product.payload.barcode, /^2\d{12}$/);
  const barcodeDigits = [...product.payload.barcode].map(Number);
  const barcodeSum = barcodeDigits.slice(0, 12).reduce((sum, digit, index) =>
    sum + digit * (index % 2 === 0 ? 1 : 3), 0);
  assert.equal(barcodeDigits[12], (10 - (barcodeSum % 10)) % 10);
  assert.equal(product.payload.has_image, true);
  assert.equal(product.payload.description, productDescription);
  assert.equal(server.database.prepare("SELECT description FROM products WHERE id = ?").get(product.payload.id).description, productDescription);
  const productList = await request("/api/products?branchId=1");
  assert.equal(productList.payload.find((item) => item.id === product.payload.id).description, productDescription);
  const publicationEventId = "f31f1e7a-d7d5-47a2-9fd8-6530a552a5ef";
  const publication = await request("/api/publications", {
    method: "POST",
    body: {
      eventId: publicationEventId,
      title: "Look da semana",
      description: "Camiseta para combinar",
      productSkus: [product.payload.sku],
    },
  });
  assert.equal(publication.response.status, 201);
  assert.equal(publication.payload.publicationId, 7);
  assert.equal(publishedPayload.eventId, publicationEventId);
  assert.deepEqual(publishedPayload.productSkus, [product.payload.sku]);
  const deniedPublication = await request("/api/publications", {
    method: "POST",
    authenticated: false,
    body: {
      eventId: "f31f1e7a-d7d5-47a2-9fd8-6530a552a5ef",
      title: "Sem sessão",
      productSkus: [product.payload.sku],
    },
  });
  assert.equal(deniedPublication.response.status, 401);
  const incompleteProduct = await request("/api/products", {
    method: "POST",
    body: { branchId: 1, name: "Produto incompleto", priceCents: 500 },
  });
  assert.equal(incompleteProduct.response.status, 400);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM products").get().count, 1);
  const mismatchedSizeProduct = await request("/api/products", {
    method: "POST",
    body: {
      branchId: 1,
      name: "Blusa com tamanho de calça",
      description: "Descrição válida.",
      brandId: brand.payload.id,
      categoryId: category.payload.id,
      subcategoryId: subcategory.payload.id,
      sizeType: "trousers",
      condition: "novo",
      priceCents: 500,
      costCents: 200,
      minStock: 0,
      quantity: 1,
      variants: [{ size: "M", quantity: 1 }],
      imageData: "data:image/jpeg;base64,/9j/2Q==",
    },
  });
  assert.equal(mismatchedSizeProduct.response.status, 400);
  assert.match(mismatchedSizeProduct.payload.error, /tamanhos brasileiros/i);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM products").get().count, 1);
  const trousersProduct = await request("/api/products", {
    method: "POST",
    body: {
      branchId: 1,
      name: "Calça tamanho 34",
      description: "Calça com grade numérica.",
      brandId: brand.payload.id,
      categoryId: category.payload.id,
      subcategoryId: subcategory.payload.id,
      sizeType: "trousers",
      condition: "novo",
      priceCents: 500,
      costCents: 200,
      minStock: 0,
      quantity: 0,
      variants: [{ size: "34", quantity: 1 }],
      imageData: "data:image/jpeg;base64,/9j/2Q==",
    },
  });
  assert.equal(trousersProduct.response.status, 201);
  assert.equal(trousersProduct.payload.quantity, 1);
  assert.equal(trousersProduct.payload.size_type, "trousers");
  assert.equal(server.database.prepare("SELECT size_type FROM products WHERE id = ?")
    .get(trousersProduct.payload.id).size_type, "trousers");
  assert.equal(server.database.prepare("SELECT size FROM product_variants WHERE product_id = ?")
    .get(trousersProduct.payload.id).size, "34");
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM products").get().count, 2);
  const missingImageProduct = await request("/api/products", {
    method: "POST",
    body: {
      branchId: 1,
      name: "Produto sem imagem",
      description: "Descrição válida.",
      brandId: 1,
      categoryId: 1,
      subcategoryId: subcategory.payload.id,
      sizeType: "none",
      priceCents: 500,
      costCents: 200,
      minStock: 0,
      quantity: 0,
    },
  });
  assert.equal(missingImageProduct.response.status, 400);
  assert.match(missingImageProduct.payload.error, /imagens/i);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM products").get().count, 2);
  const updatedDescription = "x".repeat(1000);
  const updatedProduct = await request(`/api/products/${product.payload.id}`, {
    method: "PUT",
    body: {
      name: product.payload.name,
      brandId: brand.payload.id,
      categoryId: category.payload.id,
      subcategoryId: subcategory.payload.id,
      sizeType: "none",
      priceCents: 1250,
      costCents: 700,
      minStock: 1,
      description: updatedDescription,
    },
  });
  assert.equal(updatedProduct.response.status, 200);
  assert.equal(server.database.prepare("SELECT description FROM products WHERE id = ?").get(product.payload.id).description, updatedDescription);
  const productWithoutDescription = await request(`/api/products/${product.payload.id}`, {
    method: "PUT",
    body: {
      name: product.payload.name,
      brandId: brand.payload.id,
      categoryId: category.payload.id,
      subcategoryId: subcategory.payload.id,
      sizeType: "none",
      priceCents: 1250,
      costCents: 700,
      minStock: 1,
    },
  });
  assert.equal(productWithoutDescription.response.status, 400);
  assert.equal(server.database.prepare("SELECT description FROM products WHERE id = ?").get(product.payload.id).description, updatedDescription);
  const tooLongDescription = await request("/api/products", {
    method: "POST",
    body: { branchId: 1, name: "Descrição longa", priceCents: 100, description: `${productDescription}x` },
  });
  assert.equal(tooLongDescription.response.status, 400);
  const salesBeforeQr = server.database.prepare("SELECT COUNT(*) AS count FROM sales").get().count;
  const stockBeforeQr = server.database.prepare(
    "SELECT quantity FROM inventory WHERE branch_id = ? AND product_id = ?",
  ).get(1, product.payload.id).quantity;
  const cashMovementsBeforeQr = server.database.prepare("SELECT COUNT(*) AS count FROM cash_movements").get().count;
  const simulationQr = await request("/api/payment-simulator/qr", {
    method: "POST",
    body: {
      reference: "TESTE-1",
      amountCents: 2500,
      subtotalCents: 2500,
      discountCents: 0,
      items: [{ name: "Café", quantity: 2, unitPriceCents: 1250 }],
      payments: [{ method: "PIX", amountCents: 2500 }],
    },
  });
  assert.equal(simulationQr.response.status, 200);
  assert.match(simulationQr.payload.qrCode, /^data:image\/png;base64,/);
  assert.equal(simulationQr.payload.simulated, true);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM sales").get().count, salesBeforeQr);
  assert.equal(server.database.prepare(
    "SELECT quantity FROM inventory WHERE branch_id = ? AND product_id = ?",
  ).get(1, product.payload.id).quantity, stockBeforeQr);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM cash_movements").get().count, cashMovementsBeforeQr);
  const invalidSimulation = await request("/api/payment-simulator/qr", {
    method: "POST",
    body: {
      reference: "TESTE-2",
      amountCents: 2400,
      subtotalCents: 2500,
      discountCents: 0,
      items: [{ name: "Café", quantity: 2, unitPriceCents: 1250 }],
      payments: [{ method: "PIX", amountCents: 2400 }],
    },
  });
  assert.equal(invalidSimulation.response.status, 400);
  const imageResponse = await fetch(`${baseUrl}/api/products/1/image`, {
    headers: { Cookie: cookie },
  });
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/jpeg");
  assert.deepEqual([...new Uint8Array(await imageResponse.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9]);
  const invalidImage = await request("/api/products", {
    method: "POST",
    body: { branchId: 1, name: "Imagem inválida", priceCents: 100, imageData: "data:image/svg+xml;base64,abc" },
  });
  assert.equal(invalidImage.response.status, 400);
  const secondBranchInventory = await request("/api/products?branchId=2");
  assert.equal(secondBranchInventory.payload[0].quantity, 0);

  const opened = await request("/api/cash/open", {
    method: "POST",
    body: { branchId: 1, openingCents: 1000 },
  });
  assert.equal(opened.response.status, 201);

  const sale = await request("/api/sales", {
    method: "POST",
    body: {
      branchId: 1,
      items: [{ productId: product.payload.id, quantity: 2 }],
      discountCents: 100,
      payments: [{ method: "CASH", amountCents: 2400, receivedCents: 2500 }],
    },
  });
  assert.equal(sale.response.status, 201);
  assert.equal(sale.payload.totalCents, 2400);

  const productsAfterSale = await request("/api/products?branchId=1");
  assert.equal(productsAfterSale.payload[0].quantity, 3);

  const report = await request("/api/reports?branchId=1");
  assert.equal(report.payload.sale_count, 1);
  assert.equal(report.payload.total_cents, 2400);
  assert.equal(report.payload.average_ticket_cents, 2400);
  assert.equal(report.payload.highest_sale_cents, 2400);
  assert.equal(report.payload.methods.find((row) => row.method === "CASH").amount_cents, 2400);
  assert.equal(report.payload.daily.length, 1);
  assert.equal(report.payload.products[0].product_name, "Café");
  assert.equal(report.payload.products[0].quantity, 2);
  assert.equal(report.payload.cashiers[0].sale_count, 1);
  assert.equal(report.payload.sales[0].id, sale.payload.id);
  assert.equal(report.payload.saleItems[0].sale_id, sale.payload.id);
  assert.equal(report.payload.cashSessions[0].expected_cents, 3400);
  assert.equal(report.payload.stockMovements.some((movement) => movement.kind === "SALE"), true);
  assert.equal(report.payload.inventory[0].quantity, 3);

  const invalidReportDate = await request("/api/reports?branchId=1&from=2026-02-30");
  assert.equal(invalidReportDate.response.status, 400);
  const invertedReportPeriod = await request("/api/reports?branchId=1&from=2026-02-02&to=2026-02-01");
  assert.equal(invertedReportPeriod.response.status, 400);

  const canceled = await request(`/api/sales/${sale.payload.id}/cancel`, {
    method: "POST",
    body: { reason: "Erro de lançamento" },
  });
  assert.equal(canceled.response.status, 200);
  assert.equal(canceled.payload.cashRefundCents, 2400);
  assert.deepEqual(canceled.payload.refundByMethod, [{ method: "CASH", amountCents: 2400 }]);
  const cashAfterCancel = await request("/api/cash?branchId=1");
  assert.equal(cashAfterCancel.payload.expected_cents, 1000);
  assert.equal(cashAfterCancel.payload.movements[0].kind, "OUT");
  assert.equal(cashAfterCancel.payload.movements[0].amount_cents, 2400);
  const duplicateCancel = await request(`/api/sales/${sale.payload.id}/cancel`, {
    method: "POST",
    body: { reason: "Tentativa duplicada" },
  });
  assert.equal(duplicateCancel.response.status, 409);

  const productsAfterCancel = await request("/api/products?branchId=1");
  assert.equal(productsAfterCancel.payload[0].quantity, 5);
  const reportAfterCancel = await request("/api/reports?branchId=1");
  assert.equal(reportAfterCancel.payload.sale_count, 0);
  assert.equal(reportAfterCancel.payload.canceled_count, 1);
  assert.equal(reportAfterCancel.payload.canceled_total_cents, 2400);
  assert.equal(reportAfterCancel.payload.saleItems[0].status, "CANCELED");
  assert.equal(reportAfterCancel.payload.methods.find((row) => row.method === "CASH").status, "CANCELED");

  const splitSale = await request("/api/sales", {
    method: "POST",
    body: {
      branchId: 1,
      items: [{ productId: product.payload.id, quantity: 2 }],
      payments: [
        { method: "PIX", amountCents: 1000 },
        { method: "CASH", amountCents: 1500, receivedCents: 1500 },
      ],
    },
  });
  assert.equal(splitSale.response.status, 201);

  const transfer = await request("/api/inventory/transfer", {
    method: "POST",
    body: {
      sourceBranchId: 1,
      targetBranchId: 2,
      productId: product.payload.id,
      quantity: 2,
      note: "Reposição entre lojas",
    },
  });
  assert.equal(transfer.response.status, 200);
  assert.equal(transfer.payload.sourceQuantity, 1);
  assert.equal(transfer.payload.targetQuantity, 2);

  const thirdBranch = await request("/api/branches", {
    method: "POST",
    body: { name: "Loja Sul" },
  });
  assert.equal(thirdBranch.response.status, 201);
  const thirdBranchInventory = await request("/api/products?branchId=3");
  assert.equal(thirdBranchInventory.payload[0].quantity, 0);

  const closed = await request("/api/cash/close", {
    method: "POST",
    body: { branchId: 1, closingCents: 2500 },
  });
  assert.equal(closed.response.status, 200);
  assert.equal(closed.payload.differenceCents, 0);
  const reportDay = new Date().toISOString().slice(0, 10);
  const previousDay = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  server.database.prepare("UPDATE cash_sessions SET opened_at = ? WHERE id = ?")
    .run(`${previousDay} 12:00:00`, opened.payload.id);
  const closedSessionReport = await request(`/api/reports?branchId=1&from=${reportDay}&to=${reportDay}`);
  assert.equal(closedSessionReport.payload.cashSessions.some((session) => session.id === opened.payload.id), true);

  const badPasswordChange = await request("/api/auth/password", {
    method: "POST",
    body: { currentPassword: "senha-errada", newPassword: "outra-senha-segura-123" },
  });
  assert.equal(badPasswordChange.response.status, 403);
  const passwordChange = await request("/api/auth/password", {
    method: "POST",
    body: { currentPassword: "senha-local-segura-123", newPassword: "outra-senha-segura-123" },
  });
  assert.equal(passwordChange.response.status, 200);
  const oldPasswordLogin = await request("/api/auth/login", {
    method: "POST",
    authenticated: false,
    body: { username: "admin", password: "senha-local-segura-123" },
  });
  assert.equal(oldPasswordLogin.response.status, 401);
  const newPasswordLogin = await request("/api/auth/login", {
    method: "POST",
    authenticated: false,
    body: { username: "admin", password: "outra-senha-segura-123" },
  });
  assert.equal(newPasswordLogin.response.status, 200);

  const duplicateSetup = await request("/api/setup", {
    method: "POST",
    authenticated: false,
    body: {
      name: "Outra pessoa",
      username: "other",
      password: "senha-local-segura-123",
    },
  });
  assert.equal(duplicateSetup.response.status, 409);

  const coloredProduct = await request("/api/products", {
    method: "POST",
    body: {
      branchId: 1,
      name: "Calça em duas cores",
      description: "Variações de cor com estoque separado.",
      category: "Bebidas",
      brandId: brand.payload.id,
      categoryId: category.payload.id,
      subcategoryId: subcategory.payload.id,
      sizeType: "trousers",
      condition: "novo",
      priceCents: 500,
      costCents: 200,
      minStock: 0,
      quantity: 3,
      imageData: "data:image/jpeg;base64,/9j/2Q==",
      colors: [
        { name: "Preta", imageData: "data:image/jpeg;base64,/9j/2Q==" },
        { name: "Azul", imageData: "data:image/jpeg;base64,/9j/2Q==" },
      ],
      variants: [
        { color: "Preta", size: "34", quantity: 1 },
        { color: "Azul", size: "34", quantity: 2 },
      ],
    },
  });
  assert.equal(coloredProduct.response.status, 201);
  const coloredProductList = await request("/api/products?branchId=1");
  const listedColoredProduct = coloredProductList.payload.find((item) => item.id === coloredProduct.payload.id);
  assert.deepEqual(listedColoredProduct.colors.map((color) => color.name), ["Preta", "Azul"]);
  assert.deepEqual(listedColoredProduct.variants.map(({ color, size, quantity }) => ({ color, size, quantity })), [
    { color: "Preta", size: "34", quantity: 1 },
    { color: "Azul", size: "34", quantity: 2 },
  ]);
  const colorSaleCash = await request("/api/cash/open", {
    method: "POST",
    body: { branchId: 1, openingCents: 0 },
  });
  assert.equal(colorSaleCash.response.status, 201);
  const colorSale = await request("/api/sales", {
    method: "POST",
    body: {
      branchId: 1,
      items: [{ productId: coloredProduct.payload.id, variantId: listedColoredProduct.variants[1].id, quantity: 1 }],
      discountCents: 0,
      payments: [{ method: "CASH", amountCents: 500, receivedCents: 500 }],
    },
  });
  assert.equal(colorSale.response.status, 201);
  assert.equal(server.database.prepare("SELECT product_name FROM sale_items WHERE sale_id = ?")
    .get(colorSale.payload.id).product_name, "Calça Em Duas Cores (Cor Azul, Tamanho 34)");
});

test("exige integração central antes de cadastrar um produto", async (context) => {
  const server = createApplication({
    dbPath: ":memory:",
    siteSyncUrl: "",
    siteSyncToken: "",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.database.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const setupResponse = await fetch(`${baseUrl}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Pessoa Administradora",
      username: "admin",
      password: "senha-local-segura-123",
    }),
  });
  assert.equal(setupResponse.status, 201);
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "senha-local-segura-123" }),
  });
  const login = await loginResponse.json();
  const cookie = loginResponse.headers.getSetCookie()[0].split(";")[0];
  const response = await fetch(`${baseUrl}/api/products`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-CSRF-Token": login.csrfToken,
    },
    body: JSON.stringify({
      branchId: 1,
      name: "Sem integração",
      priceCents: 500,
      quantity: 0,
    }),
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Configure a integração com o site/);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM products").get().count, 0);
});

test("migra produtos existentes sem alterar seus dados ou códigos já cadastrados", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "pdv-migration-"));
  const dbPath = join(directory, "legacy.sqlite");
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      sku TEXT UNIQUE COLLATE NOCASE,
      barcode TEXT UNIQUE,
      category TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL,
      cost_cents INTEGER NOT NULL DEFAULT 0,
      min_stock INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO products (id, name, sku, barcode, category, price_cents)
    VALUES (41, 'Produto legado', NULL, NULL, 'Geral', 500);
    INSERT INTO products (id, name, sku, barcode, category, price_cents)
    VALUES (42, 'Código mantido', 'MEU-SKU', '7890000000000', 'Geral', 700);
  `);
  legacyDb.close();

  const server = createApplication({
    dbPath,
    siteSyncUrl: "",
    siteSyncToken: "",
  });
  context.after(() => {
    server.database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const columns = server.database.prepare("PRAGMA table_info(products)").all();
  assert.ok(columns.some((column) => column.name === "image_data"));
  assert.ok(columns.some((column) => column.name === "description"));
  assert.equal(server.database.prepare("SELECT description FROM products WHERE id = 41").get().description, "");
  const generated = server.database.prepare("SELECT sku, barcode FROM products WHERE id = 41").get();
  assert.equal(generated.sku, "PDV-000041");
  assert.match(generated.barcode, /^2\d{12}$/);
  const preserved = server.database.prepare("SELECT sku, barcode FROM products WHERE id = 42").get();
  assert.equal(preserved.sku, "MEU-SKU");
  assert.equal(preserved.barcode, "7890000000000");
});

test("sincroniza estoque, preços e promoções pela fila persistente", async (context) => {
  const events = [];
  const siteMainImageData = "data:image/jpeg;base64,/9j/2Q==";
  let allocationCount = 0;
  let failAllocation = false;
  let pendingProducts = [
    {
      eventId: "site-event-collision",
      name: "Produto diferente",
      category: "Geral",
      sku: "LEGACY-001",
      barcode: "7890000000024",
      priceCents: 500,
      quantity: 3,
      imageData: null,
    },
    {
      eventId: "site-event-1",
      name: "Importado do site",
      description: "Descrição recebida do site.",
      category: "Geral",
      sku: "SITE-002",
      barcode: "7890000000017",
      priceCents: 725,
      quantity: 7,
      imageData: siteMainImageData,
    },
  ];
  let pendingSiteOrders = [];
  let siteOrderHistory = [];
  let siteOrderAckAttempts = 0;
  let importAcknowledgements = 0;
  let linkRequest;
  const site = createServer((request, response) => {
    let data = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { data += chunk; });
    request.on("end", () => {
      const body = data ? JSON.parse(data) : {};
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/pdv/identifiers") {
        allocationCount += 1;
        if (failAllocation) {
          response.writeHead(503);
          return response.end(JSON.stringify({ message: "Site indisponível." }));
        }
        const base = `21${String(allocationCount).padStart(10, "0")}`;
        const sum = [...base].reduce((total, digit, index) =>
          total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
        return response.end(JSON.stringify({
          sku: `SITE-${String(allocationCount).padStart(3, "0")}`,
          barcode: `${base}${(10 - (sum % 10)) % 10}`,
        }));
      }
      if (request.url === "/api/pdv/products/pending") {
        return response.end(JSON.stringify({ data: pendingProducts }));
      }
      if (request.url === "/api/pdv/products/ack") {
        importAcknowledgements += 1;
        if (importAcknowledgements === 1) {
          response.writeHead(503);
          return response.end(JSON.stringify({ message: "Tente novamente." }));
        }
        pendingProducts = pendingProducts.filter((record) => record.eventId !== body.eventId);
        return response.end(JSON.stringify({ acknowledged: true }));
      }
      if (request.url === "/api/pdv/site-orders/pending") {
        return response.end(JSON.stringify({ data: pendingSiteOrders }));
      }
      if (request.url.startsWith("/api/pdv/site-orders/history")) {
        const afterId = Number(new URL(request.url, "http://site").searchParams.get("afterId"));
        const data = afterId < siteOrderHistory.length ? siteOrderHistory.slice(afterId) : [];
        return response.end(JSON.stringify({
          data,
          nextCursor: data.length ? siteOrderHistory.length : afterId,
        }));
      }
      if (request.url === "/api/pdv/site-orders/ack") {
        siteOrderAckAttempts += 1;
        if (siteOrderAckAttempts === 1) {
          response.writeHead(503);
          return response.end(JSON.stringify({ message: "Tente novamente." }));
        }
        pendingSiteOrders = pendingSiteOrders.filter((record) => record.eventId !== body.eventId);
        return response.end(JSON.stringify({ acknowledged: true }));
      }
      if (request.url === "/api/pdv/products/review") {
        return response.end(JSON.stringify({ data: [{ id: 61, name: "Produto correspondente", linked: false }] }));
      }
      if (request.url === "/api/pdv/products/link") {
        linkRequest = body;
        return response.end(JSON.stringify({ linked: true }));
      }
      events.push({
        path: request.url,
        authorization: request.headers.authorization,
        body,
      });
      response.end(JSON.stringify({ received: true }));
    });
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const syncToken = "a".repeat(64);
  const server = createApplication({
    dbPath: ":memory:",
    siteSyncUrl: `http://127.0.0.1:${site.address().port}/api/pdv/sync`,
    siteSyncToken: syncToken,
    siteSyncBranchName: "Unidade principal",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.database.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve, reject) => site.close((error) => error ? reject(error) : resolve()));
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  let csrf = "";
  const request = async (path, body, method = "POST") => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie, "X-CSRF-Token": csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, payload: await response.json() };
  };
  const setup = await request("/api/setup", {
    name: "Pessoa Administradora",
    username: "admin",
    password: "senha-local-segura-123",
    branchName: "Unidade principal",
  });
  assert.equal(setup.response.status, 201);
  const legacyProductId = Number(server.database.prepare(`INSERT INTO products
    (name, sku, barcode, category, price_cents) VALUES (?, ?, ?, ?, ?)`)
    .run("Produto legado", "LEGACY-001", "7890000000031", "Legado", 250).lastInsertRowid);
  server.database.prepare("INSERT INTO inventory (branch_id, product_id, quantity) VALUES (1, ?, ?)")
    .run(legacyProductId, 12);
  const siteOrder = {
    eventId: "10b0ff00-0000-4000-8000-000000000001",
    orderId: "10b0ff00-0000-4000-8000-000000000002",
    createdAt: "2026-10-25T12:30:00+00:00",
    totalCents: 750,
    items: [{ sku: "LEGACY-001", quantity: 3, unitPriceCents: 250, totalCents: 750 }],
  };
  const legacyOrder = {
    eventId: "10b0ff00-0000-4000-8000-000000000003",
    orderId: "10b0ff00-0000-4000-8000-000000000004",
    createdAt: "2026-10-24T12:30:00+00:00",
    totalCents: 500,
    items: [{ sku: "LEGACY-001", quantity: 2, unitPriceCents: 250, totalCents: 500 }],
  };
  server.database.prepare("UPDATE inventory SET quantity = quantity - 2 WHERE branch_id = 1 AND product_id = ?")
    .run(legacyProductId);
  const legacyPayload = JSON.stringify({
    orderId: legacyOrder.orderId,
    items: [{ sku: "LEGACY-001", quantity: 2 }],
  });
  server.database.prepare(`INSERT INTO site_order_receipts (order_id, event_id, payload_hash, payload)
    VALUES (?, ?, ?, ?)`).run(
    legacyOrder.orderId,
    legacyOrder.eventId,
    createHash("sha256").update(legacyPayload).digest("hex"),
    legacyPayload,
  );
  siteOrderHistory = [siteOrder];
  const unauthenticatedSiteOrder = await fetch(`${baseUrl}/api/site-orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(siteOrder),
  });
  assert.equal(unauthenticatedSiteOrder.status, 401);
  const applySiteOrder = () => fetch(`${baseUrl}/api/site-orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${syncToken}`,
    },
    body: JSON.stringify(siteOrder),
  });
  assert.equal((await applySiteOrder()).status, 200);
  assert.equal((await applySiteOrder()).status, 200);
  assert.equal(server.database.prepare("SELECT quantity FROM inventory WHERE branch_id = 1 AND product_id = ?")
    .get(legacyProductId).quantity, 7);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM site_sales").get().count, 1);
  assert.equal(server.database.prepare("SELECT total_cents FROM site_sales WHERE order_id = ?")
    .get(siteOrder.orderId).total_cents, 750);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM site_sale_items").get().count, 1);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM sales").get().count, 0);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM cash_movements").get().count, 0);
  assert.deepEqual({ ...server.database.prepare(`SELECT kind, quantity, note FROM stock_movements
    WHERE product_id = ?`).get(legacyProductId) }, {
    kind: "SALE",
    quantity: 3,
    note: `Pedido pelo site ${siteOrder.orderId}`,
  });
  const invalidSiteOrder = await fetch(`${baseUrl}/api/site-orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${syncToken}` },
    body: JSON.stringify({ ...siteOrder, totalCents: 1 }),
  });
  assert.equal(invalidSiteOrder.status, 400);
  assert.equal(server.database.prepare("SELECT quantity FROM inventory WHERE branch_id = 1 AND product_id = ?")
    .get(legacyProductId).quantity, 7);
  siteOrderHistory = [siteOrder, legacyOrder];
  pendingSiteOrders = [siteOrder];
  const login = await request("/api/auth/login", {
    username: "admin",
    password: "senha-local-segura-123",
  });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.getSetCookie()[0].split(";")[0];
  csrf = login.payload.csrfToken;

  const secondBranch = await request("/api/branches", { name: "Loja Norte" });
  assert.equal(secondBranch.response.status, 201);
  const brand = await request("/api/brands", { name: "Marca de produto" });
  assert.equal(brand.response.status, 201);
  const category = await request("/api/categories", { name: "Geral" });
  assert.equal(category.response.status, 201);

  const product = await request("/api/products", {
    branchId: 1,
    name: "Produto vinculado",
    description: "Descrição sincronizada do PDV.",
    brandId: brand.payload.id,
    categoryId: category.payload.id,
    sizeType: "none",
    sku: "WEB-001",
    category: "Geral",
    priceCents: 1000,
    costCents: 500,
    minStock: 1,
    quantity: 5,
    colors: [{ name: "Preta", imageData: "data:image/jpeg;base64,/9j/2Q==" }],
    variants: [{ color: "Preta", size: null, quantity: 5 }],
    images: ["data:image/jpeg;base64,/9j/2Q==", "data:image/jpeg;base64,/9j/2Q=="],
  });
  assert.equal(product.response.status, 201);
  assert.equal(product.payload.sku, "SITE-001");
  assert.equal(allocationCount, 2);
  const candidates = await request("/api/site-sync/products/unlinked", undefined, "GET");
  assert.deepEqual(candidates.payload, { data: [{ id: 61, name: "Produto correspondente", linked: false }] });
  const linked = await request("/api/site-sync/products/link", {
    productId: 61,
    localProductId: product.payload.id,
  });
  assert.equal(linked.response.status, 200);
  assert.deepEqual(linkRequest, {
    productId: 61,
    sku: product.payload.sku,
    barcode: product.payload.barcode,
  });
  failAllocation = true;
  const countBeforeFailedCreate = server.database.prepare("SELECT COUNT(*) AS count FROM products").get().count;
  const failedCreate = await request("/api/products", {
    branchId: 1,
    name: "Não deve ser salvo",
    description: "Cadastro pendente de identificadores.",
    brandId: brand.payload.id,
    categoryId: category.payload.id,
    sizeType: "none",
    category: "Geral",
    priceCents: 500,
    costCents: 200,
    minStock: 0,
    quantity: 0,
    images: ["data:image/jpeg;base64,/9j/2Q=="],
  });
  assert.equal(failedCreate.response.status, 503);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM products").get().count, countBeforeFailedCreate);
  failAllocation = false;

  const waitForEvents = async (count) => {
    const deadline = Date.now() + 5000;
    while (events.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const pending = server.database.prepare("SELECT event_type, payload, attempts, last_error FROM site_sync_outbox").all();
    assert.ok(events.length >= count, `Esperava ${count} eventos de sincronização; recebidos ${events.length}; pendentes ${JSON.stringify(pending)}.`);
  };
  await waitForEvents(1);
  assert.ok(events.every((event) => event.authorization === `Bearer ${syncToken}`));
  assert.equal(events[0].path, "/api/pdv/products");
  assert.equal(events[0].body.name, "Produto Vinculado");
  assert.equal(events[0].body.description, "Descrição sincronizada do PDV.");
  assert.equal(events[0].body.category, "Geral");
  assert.equal(events[0].body.sku, "SITE-001");
  assert.equal(events[0].body.barcode, product.payload.barcode);
  assert.equal(events[0].body.priceCents, 1000);
  assert.equal(events[0].body.quantity, 5);
  assert.equal(events[0].body.images.length, 2);
  assert.equal(events[0].body.productId, product.payload.id);
  assert.equal(events[0].body.colors[0].imageData, "data:image/jpeg;base64,/9j/2Q==");
  assert.ok(events[0].body.eventId);

  const importDeadline = Date.now() + 7000;
  while (importAcknowledgements < 2 && Date.now() < importDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(importAcknowledgements >= 2, "A confirmação do produto importado deve ser repetida após falhar.");
  while (siteOrderAckAttempts < 2 && Date.now() < importDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(siteOrderAckAttempts >= 2, "A confirmação do pedido deve ser repetida após falhar.");
  assert.deepEqual(pendingSiteOrders, []);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM site_order_receipts").get().count, 2);
  assert.equal(server.database.prepare("SELECT last_order_id FROM site_order_sync_state WHERE id = 1")
    .get().last_order_id, 2);
  const siteReport = await request("/api/reports?branchId=1", undefined, "GET");
  assert.equal(siteReport.response.status, 200);
  assert.equal(siteReport.payload.sale_count, 0);
  assert.equal(siteReport.payload.total_cents, 0);
  assert.equal(siteReport.payload.site_order_count, 2);
  assert.equal(siteReport.payload.site_order_total_cents, 1250);
  assert.equal(siteReport.payload.siteDaily.length, 2);
  assert.equal(siteReport.payload.siteSales.find((order) => order.order_id === siteOrder.orderId).total_cents, 750);
  assert.equal(siteReport.payload.siteSaleItems.length, 2);
  assert.equal(siteReport.payload.products.find((row) => row.channel === "SITE").quantity, 5);
  assert.equal(siteReport.payload.methods.length, 0);
  assert.equal(siteReport.payload.cashSessions.length, 0);
  assert.equal(siteReport.payload.cashMovements.length, 0);
  assert.equal(siteReport.payload.stockMovements.find((movement) => movement.note.includes(siteOrder.orderId)).user_name, "Site");
  const filteredSiteReport = await request(
    "/api/reports?branchId=1&from=2026-10-25&to=2026-10-25",
    undefined,
    "GET",
  );
  assert.equal(filteredSiteReport.payload.site_order_count, 1);
  assert.equal(filteredSiteReport.payload.site_order_total_cents, 750);
  const imported = server.database.prepare(`SELECT p.id, p.name, p.description, p.image_data, i.quantity
    FROM products p JOIN inventory i ON i.product_id = p.id AND i.branch_id = 1
    WHERE p.sku = ?`).get("SITE-002");
  assert.ok(imported);
  assert.equal(imported.name, "Importado Do Site");
  assert.equal(imported.description, "Descrição recebida do site.");
  assert.equal(imported.quantity, 7);
  assert.equal(imported.image_data, siteMainImageData);
  const legacyProduct = server.database.prepare(`SELECT p.name, p.barcode, p.category, p.price_cents, i.quantity
    FROM products p JOIN inventory i ON i.product_id = p.id AND i.branch_id = 1
    WHERE p.id = ?`).get(legacyProductId);
  assert.deepEqual({ ...legacyProduct }, {
    name: "Produto legado",
    barcode: "7890000000031",
    category: "Legado",
    price_cents: 250,
    quantity: 7,
  });
  assert.deepEqual(pendingProducts.map((record) => record.eventId), ["site-event-collision"]);
  assert.equal(server.database.prepare(`SELECT quantity FROM inventory
    WHERE branch_id = 2 AND product_id = ?`).get(imported.id).quantity, 0);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM products WHERE sku = 'SITE-002'").get().count, 1);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM site_sync_outbox WHERE event_type = 'product.register'").get().count, 0);

  const now = new Date();
  const promotion = await request("/api/promotions", {
    productId: product.payload.id,
    discountBasisPoints: 2000,
    startsAt: new Date(now.getTime() - 60000).toISOString(),
    endsAt: new Date(now.getTime() + 3600000).toISOString(),
  });
  assert.equal(promotion.response.status, 201);
  await waitForEvents(2);
  const products = await request("/api/products?branchId=1", undefined, "GET");
  const registeredProduct = products.payload.find((item) => item.id === product.payload.id);
  assert.equal(registeredProduct.price_cents, 800);
  assert.equal(registeredProduct.regular_price_cents, 1000);

  const opened = await request("/api/cash/open", { branchId: 1, openingCents: 0 });
  assert.equal(opened.response.status, 201);
  const productVariantId = server.database.prepare("SELECT id FROM product_variants WHERE product_id = ?")
    .get(product.payload.id).id;
  const sale = await request("/api/sales", {
    branchId: 1,
    items: [{ productId: product.payload.id, variantId: productVariantId, quantity: 1 }],
    payments: [{ method: "CASH", amountCents: 800, receivedCents: 800 }],
  });
  assert.equal(sale.response.status, 201);
  assert.equal(sale.payload.totalCents, 800);
  await waitForEvents(3);
  assert.equal(events[2].body.type, "inventory.delta");
  assert.equal(events[2].body.payload.delta, -1);
  const outboxDeadline = Date.now() + 5000;
  while (server.database.prepare("SELECT COUNT(*) AS count FROM site_sync_outbox").get().count > 0
    && Date.now() < outboxDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM site_sync_outbox").get().count, 0);
});

test("registra vendas offline e sincroniza o estoque quando o site volta", async (context) => {
  let siteAvailable = false;
  const receivedEvents = [];
  const site = createServer(async (request, response) => {
    let data = "";
    request.setEncoding("utf8");
    for await (const chunk of request) data += chunk;
    const body = data ? JSON.parse(data) : {};
    response.setHeader("Content-Type", "application/json");

    if (request.url === "/api/pdv/products/pending") {
      return response.end(JSON.stringify({ data: [] }));
    }
    if (request.url === "/api/pdv/site-orders/pending") {
      return response.end(JSON.stringify({ data: [] }));
    }
    if (request.url.startsWith("/api/pdv/site-orders/history")) {
      const afterId = Number(new URL(request.url, "http://site").searchParams.get("afterId"));
      return response.end(JSON.stringify({ data: [], nextCursor: afterId }));
    }
    if (request.url === "/api/pdv/sync") {
      if (!siteAvailable) {
        response.writeHead(503);
        return response.end(JSON.stringify({ message: "Site temporariamente indisponível." }));
      }
      receivedEvents.push(body);
    }
    return response.end(JSON.stringify({ received: true }));
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const server = createApplication({
    dbPath: ":memory:",
    siteSyncUrl: `http://127.0.0.1:${site.address().port}/api/pdv/sync`,
    siteSyncToken: "a".repeat(64),
    siteSyncBranchName: "Unidade principal",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.database.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve, reject) => site.close((error) => error ? reject(error) : resolve()));
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  let csrf = "";
  const request = async (path, body, method = "POST") => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie, "X-CSRF-Token": csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, payload: await response.json() };
  };

  const setup = await request("/api/setup", {
    name: "Pessoa Administradora",
    username: "admin",
    password: "senha-local-segura-123",
    branchName: "Unidade principal",
  });
  assert.equal(setup.response.status, 201);
  const login = await request("/api/auth/login", {
    username: "admin",
    password: "senha-local-segura-123",
  });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.getSetCookie()[0].split(";")[0];
  csrf = login.payload.csrfToken;

  const productId = Number(server.database.prepare(`
    INSERT INTO products (name, sku, barcode, category, price_cents)
    VALUES ('Produto local', 'PDV-000123', '2000000000123', 'Geral', 500)
  `).run().lastInsertRowid);
  server.database.prepare("INSERT INTO inventory (branch_id, product_id, quantity) VALUES (1, ?, 5)")
    .run(productId);
  const opened = await request("/api/cash/open", { branchId: 1, openingCents: 0 });
  assert.equal(opened.response.status, 201);

  const sale = await request("/api/sales", {
    branchId: 1,
    items: [{ productId, quantity: 2 }],
    payments: [{ method: "CASH", amountCents: 1000, receivedCents: 1000 }],
  });
  assert.equal(sale.response.status, 201);
  assert.equal(server.database.prepare("SELECT quantity FROM inventory WHERE branch_id = 1 AND product_id = ?")
    .get(productId).quantity, 3);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM sales").get().count, 1);
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM site_sync_outbox").get().count, 1);
  const queuedEventId = server.database.prepare("SELECT event_id FROM site_sync_outbox LIMIT 1").get().event_id;

  const waitUntil = async (predicate, message) => {
    const deadline = Date.now() + 8000;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(predicate(), message);
  };
  await waitUntil(
    () => server.database.prepare("SELECT attempts FROM site_sync_outbox LIMIT 1").get()?.attempts > 0,
    "A falha de conexão não foi registrada na fila local.",
  );
  siteAvailable = true;
  await waitUntil(() => receivedEvents.length === 1, "A fila não foi enviada quando o site voltou.");

  assert.equal(receivedEvents[0].eventId, queuedEventId);
  assert.equal(receivedEvents[0].type, "inventory.delta");
  assert.equal(receivedEvents[0].payload.sku, "PDV-000123");
  assert.equal(receivedEvents[0].payload.delta, -2);
  assert.equal(receivedEvents[0].payload.reason, "Venda");
  await waitUntil(
    () => server.database.prepare("SELECT COUNT(*) AS count FROM site_sync_outbox").get().count === 0,
    "O evento confirmado pelo site não foi removido da fila.",
  );
  assert.equal(server.database.prepare("SELECT COUNT(*) AS count FROM site_sync_outbox").get().count, 0);
});
