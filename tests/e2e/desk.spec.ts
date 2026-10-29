import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Digits only: the mock extractor can mistake a hex-looking PO token for a SKU.
const tag = String(Math.floor(Math.random() * 900000) + 100000);
const PO = `PB-${tag}`;
const eml = (po: string, from = "mia@alderwick.example") => Buffer.from([`From: Mia <${from}>`, "To: orders@pennbridge.example", `Subject: Purchase order ${po}`, `Message-ID: <${po}-${randomUUID()}@e2e.example>`, "Content-Type: text/plain; charset=utf-8", "", `Hi team,`, `Please book PO ${po}: 2 packs of FB-0830-A2-100. Delivery to our MAIN address.`, "Thanks, Mia", ""].join("\r\n")).toString("base64");

async function apiLogin(request: APIRequestContext, email: string, password: string) {
  const res = await request.post("/api/auth/login", { data: { email, password } }); expect(res.ok()).toBeTruthy();
}
async function signIn(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.getByLabel("Email address").fill(email); await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
}
async function seedOrder(request: APIRequestContext, po: string) {
  await apiLogin(request, "reviewer@pennbridge.example", "reviewer-demo");
  const res = await request.post("/api/intake", { data: { filename: `${po}.eml`, mediaType: "message/rfc822", contentBase64: eml(po), channel: "email" } });
  expect(res.status()).toBe(202); const body = await res.json();
  await expect.poll(async () => (await (await request.get(`/api/orders/${body.orderId}`)).json()).order.status, { timeout: 40_000 }).not.toMatch(/^(received|parsing|extracted|validating)$/);
  return body.orderId as string;
}
const row = (page: Page, text: string) => page.locator("table.order-table tbody tr", { hasText: text });
const openOrder = async (page: Page, po: string) => { await page.getByLabel("Search orders").fill(po); await expect(row(page, po)).toHaveCount(1); await row(page, po).click(); await expect(page.getByRole("region", { name: "Order review" }).getByText(po).first()).toBeVisible(); };

test.describe.serial("Order desk", () => {
  let orderId = "";
  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: "http://127.0.0.1:3099" });
    orderId = await seedOrder(request, PO); await seedOrder(request, `PB-${Number(tag) + 1}`); await request.dispose();
  });

  test("login rejects a wrong password with a readable message, then signs in", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Email address").fill("reviewer@pennbridge.example"); await page.getByLabel("Password", { exact: true }).fill("not-the-password");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await signIn(page, "reviewer@pennbridge.example", "reviewer-demo");
    await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Settings" })).toHaveCount(0); // reviewers do not see Settings
  });

  test("server-side search narrows the queue and can be cleared", async ({ page }) => {
    await signIn(page, "reviewer@pennbridge.example", "reviewer-demo");
    await page.getByLabel("Search orders").fill(PO);
    await expect(row(page, PO)).toHaveCount(1); await expect(row(page, `PB-${Number(tag) + 1}`)).toHaveCount(0);
    await page.getByLabel("Search orders").fill(`NOPE-${tag}`);
    await expect(page.getByText("No orders match")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(row(page, `PB-${Number(tag) + 1}`)).toHaveCount(1);
    await page.getByLabel("Filter by status").selectOption("failed");
    await expect(row(page, PO)).toHaveCount(0);
  });

  test("confirm the suggested customer, keep match methods on save, add and remove a line with reasons", async ({ page }) => {
    await signIn(page, "reviewer@pennbridge.example", "reviewer-demo");
    await openOrder(page, PO);
    const review = page.getByRole("region", { name: "Order review" });
    const banner = review.getByRole("region", { name: "Suggested customer" });
    await expect(banner).toContainText("Suggested: Alderwick"); await expect(banner).toContainText("forged");
    await banner.getByRole("button", { name: "Confirm customer" }).click();
    await expect(banner).toHaveCount(0);
    await expect(review.locator(".order-fields select").first()).not.toHaveValue("");
    // Saving a plain edit must not flip exact-SKU matches to "manual".
    await review.getByLabel("Purchase order").fill(`${PO}-B`);
    await review.getByRole("button", { name: "Save changes" }).click();
    await expect(review.getByRole("heading", { name: `${PO}-B` })).toBeVisible();
    await expect(review.getByText(/exact sku/i).first()).toBeVisible(); await expect(review.getByText(/^manual ·/i)).toHaveCount(0);
    // Add a line (reason required).
    await review.getByRole("button", { name: "Add line" }).click();
    const add = page.getByRole("dialog", { name: "Add order line" });
    await add.getByLabel("Find in catalogue").fill("washer"); await add.getByRole("listbox").getByRole("button").first().click();
    await expect(add.getByRole("button", { name: "Add line" })).toBeDisabled();
    await add.getByLabel("Reason for adding this line").fill("E2E: customer phoned with an extra item");
    await add.getByRole("button", { name: "Add line" }).click();
    await expect(page.getByRole("status")).toContainText("Line added");
    await expect(review.locator("article.line-card")).toHaveCount(2);
    // Escape closes dialogs; remove the new line with a reason.
    await review.getByRole("button", { name: "Remove line 2" }).click();
    const remove = page.getByRole("dialog", { name: "Remove order line" }); await expect(remove).toBeVisible();
    await page.keyboard.press("Escape"); await expect(remove).toHaveCount(0);
    await review.getByRole("button", { name: "Remove line 2" }).click();
    await page.getByRole("dialog").getByLabel("Reason for removal").fill("E2E: added by mistake");
    await page.getByRole("dialog").getByRole("button", { name: "Remove line" }).click();
    await expect(review.locator("article.line-card")).toHaveCount(1);
    await expect(review.getByText("1 removed line")).toBeVisible();
  });

  test("approve, prepare the export and see its state machine", async ({ page }) => {
    await signIn(page, "reviewer@pennbridge.example", "reviewer-demo");
    await openOrder(page, `${PO}-B`);
    const review = page.getByRole("region", { name: "Order review" });
    await expect(review.getByRole("button", { name: "Approve order" })).toBeEnabled();
    await review.getByRole("button", { name: "Approve order" }).click();
    await expect(review.getByText(/Approved by/)).toBeVisible();
    const download = page.waitForEvent("download");
    await review.getByRole("button", { name: "Prepare export" }).click(); await download;
    const exportsPanel = review.getByRole("region", { name: "Exports" });
    await expect(exportsPanel.getByRole("list", { name: "Export progress" })).toContainText("Downloaded");
    await expect(exportsPanel.getByLabel("Odoo quotation you checked")).toBeVisible();
    // Void requires a reason.
    await exportsPanel.getByRole("button", { name: /Void export/ }).click();
    const dialog = page.getByRole("dialog", { name: "Void this export?" });
    await expect(dialog.getByRole("button", { name: "Void export" })).toBeDisabled();
    await dialog.getByLabel("Reason").fill("E2E: wrong file"); await dialog.getByRole("button", { name: "Void export" }).click();
    await expect(exportsPanel.getByText("Voided", { exact: true }).first()).toBeVisible();
  });

  test("admin creates a user who can then sign in and change their password", async ({ page, browser }) => {
    await signIn(page, "admin@pennbridge.example", "admin-demo");
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Add user" }).click();
    const email = `e2e-${tag.toLowerCase()}@pennbridge.example`;
    const dialog = page.getByRole("dialog", { name: "Add user" });
    await dialog.getByLabel("Email address").fill(email); await dialog.getByLabel("Full name").fill(`E2E Reviewer ${tag}`);
    await dialog.getByLabel("Temporary password").fill("short"); await dialog.getByRole("button", { name: "Create user" }).click();
    await expect(dialog.getByRole("alert")).toContainText(/12 characters/);
    await dialog.getByLabel("Temporary password").fill(`Tr1cky-${tag}-horse-stapler`); await dialog.getByRole("button", { name: "Create user" }).click();
    await expect(page.getByRole("row", { name: new RegExp(email) })).toBeVisible();
    const other = await browser.newPage();
    await signIn(other, email, `Tr1cky-${tag}-horse-stapler`);
    await other.getByRole("button", { name: new RegExp(`E2E Reviewer`) }).first().click();
    await other.getByRole("menuitem", { name: "Change password" }).click();
    await expect(other.getByRole("dialog", { name: "Change your password" })).toContainText("At least 12 characters");
    await other.keyboard.press("Escape"); await other.close();
  });

  test("sender mapping can be added and deleted", async ({ page }) => {
    await signIn(page, "admin@pennbridge.example", "admin-demo");
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Settings" }).click();
    await page.getByRole("tab", { name: "Sender mappings" }).click();
    const domain = `e2e-${tag.toLowerCase()}.example`;
    const form = page.locator(".mapping-form"); await form.locator("select").first().selectOption("domain"); await form.getByRole("textbox").fill(domain);
    await form.locator("select").nth(1).selectOption({ index: 1 });
    await page.getByRole("button", { name: "Add mapping" }).click();
    await expect(page.getByRole("row", { name: new RegExp(domain) })).toContainText("suggest only");
    await page.getByRole("button", { name: `Delete mapping ${domain}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete mapping" }).click();
    await expect(page.getByRole("row", { name: new RegExp(domain) })).toHaveCount(0);
  });

  test("data import dry run lists per-row errors, then a clean file allows apply", async ({ page }) => {
    await signIn(page, "admin@pennbridge.example", "admin-demo");
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Settings" }).click();
    await page.getByRole("tab", { name: "Data import" }).click();
    await page.getByLabel("What are you importing?").selectOption("products");
    await expect(page.locator(".template-cols")).toContainText("sku");
    const file = page.getByLabel("CSV file");
    await file.setInputFiles({ name: "bad.csv", mimeType: "text/csv", buffer: Buffer.from(`sku,description,selling_unit,list_price\nE2E-${tag}-1,Good widget,each,1.50\nE2E-${tag}-2,Bad widget,furlong,abc\n`) });
    await page.getByRole("button", { name: /Preview/ }).click();
    await expect(page.getByRole("heading", { name: /Preview/ })).toBeVisible();
    await expect(page.locator(".errors-table tbody tr").first()).toContainText("3");
    await expect(page.getByRole("button", { name: "Apply import" })).toBeDisabled();
    await file.setInputFiles({ name: "good.csv", mimeType: "text/csv", buffer: Buffer.from(`sku,description,selling_unit,list_price\nE2E-${tag}-1,Good widget,each,1.50\n`) });
    await page.getByRole("button", { name: /Preview/ }).click();
    await expect(page.locator(".count", { hasText: "To create" })).toContainText("1");
    await expect(page.getByRole("button", { name: "Apply import" })).toBeEnabled();
  });

  for (const width of [1280, 768]) test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, "admin@pennbridge.example", "admin-demo");
    await openOrder(page, `PB-${Number(tag) + 1}`);
    const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(1);
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Settings" }).click(); await page.getByRole("tab", { name: "Data import" }).click();
    expect(await overflow()).toBeLessThanOrEqual(1);
    await page.getByRole("tab", { name: "Users" }).click(); await expect(page.getByRole("button", { name: "Add user" })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(1);
  });
});
