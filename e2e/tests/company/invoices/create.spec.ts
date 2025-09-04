import { db, takeOrThrow } from "@test/db";
import { companiesFactory } from "@test/factories/companies";
import { companyContractorsFactory } from "@test/factories/companyContractors";
import { companyInvestorsFactory } from "@test/factories/companyInvestors";
import { equityGrantsFactory } from "@test/factories/equityGrants";
import { usersFactory } from "@test/factories/users";
import { fillDatePicker } from "@test/helpers";
import { login } from "@test/helpers/auth";
import { expect, type Page, test } from "@test/index";
import { subDays } from "date-fns";
import { desc, eq } from "drizzle-orm";
import {
  companies,
  companyContractors,
  expenseCategories,
  invoiceExpenses,
  invoiceLineItems,
  invoices,
  users,
} from "@/db/schema";

test.describe("invoice creation", () => {
  let company: typeof companies.$inferSelect;
  let contractorUser: typeof users.$inferSelect;
  let companyContractor: typeof companyContractors.$inferSelect;

  test.beforeEach(async () => {
    company = (
      await companiesFactory.createCompletedOnboarding({
        equityEnabled: true,
      })
    ).company;

    contractorUser = (
      await usersFactory.createWithBusinessEntity({
        zipCode: "22222",
        streetAddress: "1st St.",
      })
    ).user;

    companyContractor = (
      await companyContractorsFactory.create({
        companyId: company.id,
        userId: contractorUser.id,
        payRateInSubunits: 6000,
        equityPercentage: 20,
      })
    ).companyContractor;
  });

  test("considers the invoice year when calculating equity", async ({ page }) => {
    const companyInvestor = (await companyInvestorsFactory.create({ userId: contractorUser.id, companyId: company.id }))
      .companyInvestor;
    await equityGrantsFactory.createActive(
      {
        companyInvestorId: companyInvestor.id,
        sharePriceUsd: "300",
      },
      { year: 2021 },
    );

    await login(page, contractorUser, "/invoices/new");

    await page.getByPlaceholder("Description").fill("I worked on invoices");
    await page.getByLabel("Hours").fill("03:25");
    await expect(page.getByText("Total services$60")).toBeVisible();
    await expect(page.getByText("Swapped for equity (not paid in cash)$0")).toBeVisible();
    await expect(page.getByText("Net amount in cash$60")).toBeVisible();

    await fillDatePicker(page, "Date", "08/08/2021");
    await page.waitForTimeout(300);
    await page.getByLabel("Hours / Qty").fill("100:00");
    await page.waitForTimeout(300);
    await page.getByPlaceholder("Description").fill("I worked on invoices");

    await expect(page.getByText("Total services$6,000")).toBeVisible();
    await expect(page.getByText("Swapped for equity (not paid in cash)$1,200")).toBeVisible();
    await expect(page.getByText("Net amount in cash$4,800")).toBeVisible();

    await page.getByRole("button", { name: "Send invoice" }).click();
    await expect(page.locator("tbody")).toContainText(
      ["Invoice ID", "1", "Sent on", "Aug 8, 2021", "Amount", "$6,000", "Status", "Awaiting approval (0/2)"].join(""),
    );

    const invoice = await db.query.invoices
      .findFirst({ where: eq(invoices.companyId, company.id), orderBy: desc(invoices.id) })
      .then(takeOrThrow);
    expect(invoice.totalAmountInUsdCents).toBe(600000n);
    expect(invoice.cashAmountInCents).toBe(480000n);
    expect(invoice.equityAmountInCents).toBe(120000n);
    expect(invoice.equityPercentage).toBe(20);
  });

  test("allows creation of an invoice as an alumni", async ({ page }) => {
    await db
      .update(companyContractors)
      .set({ startedAt: subDays(new Date(), 365), endedAt: subDays(new Date(), 100) })
      .where(eq(companyContractors.id, companyContractor.id));

    await login(page, contractorUser, "/invoices/new");
    await page.getByPlaceholder("Description").fill("item name");
    await page.getByLabel("Hours / Qty").fill("01:00");
    await page.getByPlaceholder("Enter notes about your").fill("sent as alumni");
    await page.waitForTimeout(100);
    await page.getByRole("button", { name: "Send invoice" }).click();
    await expect(page.getByRole("cell", { name: "Awaiting approval (0/2)" })).toBeVisible();
  });

  test("does not show equity split if equity compensation is disabled", async ({ page }) => {
    await db.update(companies).set({ equityEnabled: false }).where(eq(companies.id, company.id));

    await login(page, contractorUser, "/invoices/new");
    await expect(page.getByText("Total")).toBeVisible();
    await expect(page.getByText("Swapped for equity")).not.toBeVisible();
  });

  test("creates an invoice with only expenses, no line items", async ({ page }) => {
    await db.insert(expenseCategories).values({
      companyId: company.id,
      name: "Office Supplies",
    });
    await login(page, contractorUser, "/invoices/new");

    await page.getByRole("button", { name: "Add expense" }).click();
    await page.locator('input[accept="application/pdf, image/*"]').setInputFiles({
      name: "receipt.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("test expense receipt"),
    });

    await page.getByLabel("Merchant").fill("Office Supplies Inc");
    await page.getByLabel("Amount").fill("45.99");

    await page.getByRole("button", { name: "Send invoice" }).click();
    await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();

    await expect(page.locator("tbody")).toContainText("$45.99");
    await expect(page.locator("tbody")).toContainText("Awaiting approval");

    const invoice = await db.query.invoices
      .findFirst({ where: eq(invoices.companyId, company.id), orderBy: desc(invoices.id) })
      .then(takeOrThrow);
    expect(invoice.totalAmountInUsdCents).toBe(4599n);
    const expense = await db.query.invoiceExpenses
      .findFirst({ where: eq(invoiceExpenses.invoiceId, invoice.id) })
      .then(takeOrThrow);
    expect(expense.totalAmountInCents).toBe(4599n);
  });

  test("allows adding multiple expense rows", async ({ page }) => {
    await db.insert(expenseCategories).values([
      { companyId: company.id, name: "Office Supplies" },
      { companyId: company.id, name: "Travel" },
    ]);
    await login(page, contractorUser, "/invoices/new");

    await page.getByRole("button", { name: "Add expense" }).click();
    await page.locator('input[accept="application/pdf, image/*"]').setInputFiles({
      name: "receipt1.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("first expense receipt"),
    });

    await page.getByLabel("Merchant").fill("Office Supplies Inc");
    await page.getByLabel("Amount").fill("25.50");

    await page.getByRole("button", { name: "Add expense" }).click();
    await page.locator('input[accept="application/pdf, image/*"]').setInputFiles({
      name: "receipt2.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("second expense receipt"),
    });

    const merchantInputs = page.getByLabel("Merchant");
    await merchantInputs.nth(1).fill("Travel Agency");

    const amountInputs = page.getByLabel("Amount");
    await amountInputs.nth(1).fill("150.75");

    await expect(page.getByText("Total expenses$176.25")).toBeVisible();

    await page.getByRole("button", { name: "Send invoice" }).click();
    await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();

    await expect(page.locator("tbody")).toContainText("$176.25");

    const invoice = await db.query.invoices
      .findFirst({ where: eq(invoices.companyId, company.id), orderBy: desc(invoices.id) })
      .then(takeOrThrow);
    expect(invoice.totalAmountInUsdCents).toBe(17625n);

    const expenses = await db.query.invoiceExpenses.findMany({
      where: eq(invoiceExpenses.invoiceId, invoice.id),
    });
    expect(expenses).toHaveLength(2);
    expect(expenses[0]?.totalAmountInCents).toBe(2550n);
    expect(expenses[1]?.totalAmountInCents).toBe(15075n);
  });

  test("shows legal details warning when tax information is not confirmed", async ({ page }) => {
    const userWithoutTax = (
      await usersFactory.create(
        {
          streetAddress: "123 Main St",
          zipCode: "12345",
          city: "Test City",
          state: "CA",
          countryCode: "US",
        },
        { withoutComplianceInfo: true },
      )
    ).user;

    await companyContractorsFactory.create({
      companyId: company.id,
      userId: userWithoutTax.id,
      payRateInSubunits: 5000,
    });

    await login(page, userWithoutTax);

    await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();
    await expect(page.getByText("Please provide your legal details before creating new invoices.")).toBeVisible();
  });

  test("shows alert when billing above default pay rate", async ({ page }) => {
    await login(page, contractorUser, "/invoices/new");

    await page.getByLabel("Hours").fill("2:00");
    await page.getByPlaceholder("Description").fill("Premium work");
    await expect(page.getByText("This invoice includes rates above your default")).not.toBeVisible();

    await page.getByLabel("Rate").fill("75");
    await expect(
      page.getByText("This invoice includes rates above your default of $60/hour. Please check before submitting."),
    ).toBeVisible();

    await page.getByLabel("Rate").fill("60");
    await expect(page.getByText("This invoice includes rates above your default")).not.toBeVisible();

    await db
      .update(companyContractors)
      .set({ payRateInSubunits: null })
      .where(eq(companyContractors.id, companyContractor.id));
    await page.reload();
    await expect(page.getByText("This invoice includes rates above your default")).not.toBeVisible();
  });

  test("supports decimal quantities", async ({ page }) => {
    await login(page, contractorUser, "/invoices/new");

    await page.getByLabel("Hours").fill("2.5");
    await page.getByPlaceholder("Description").fill("Development work with decimal quantities");
    await fillDatePicker(page, "Date", "12/15/2024");

    await expect(page.getByText("Total services$150")).toBeVisible();

    // contractor has 20% equity, so $150 * 0.8 = $120
    await expect(page.getByText("Net amount in cash$120")).toBeVisible();

    await page.getByRole("button", { name: "Send invoice" }).click();

    // wait for navigation to invoice list
    await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();

    await expect(page.locator("tbody")).toContainText("$150");

    const invoice = await db.query.invoices
      .findFirst({ where: eq(invoices.companyId, company.id), orderBy: desc(invoices.id) })
      .then(takeOrThrow);

    expect(invoice.totalAmountInUsdCents).toBe(15000n);

    const lineItem = await db.query.invoiceLineItems
      .findFirst({ where: eq(invoiceLineItems.invoiceId, invoice.id) })
      .then(takeOrThrow);

    expect(Number(lineItem.quantity)).toBe(2.5);
  });
});

test.describe("invoice PDF import", () => {
  let company: typeof companies.$inferSelect;
  let contractorUser: typeof users.$inferSelect;

  async function createDataTransferHandle(page: Page, files: { name: string; type: string; bytes: number[] }[]) {
    return page.evaluateHandle((files) => {
      const dt = new DataTransfer();
      files.forEach(({ name, type, bytes }) => {
        const file = new File([new Uint8Array(bytes)], name, { type });
        dt.items.add(file);
      });
      return dt;
    }, files);
  }

  test.beforeEach(async () => {
    company = (
      await companiesFactory.createCompletedOnboarding({
        equityEnabled: false,
      })
    ).company;

    contractorUser = (
      await usersFactory.createWithBusinessEntity({
        zipCode: "22222",
        streetAddress: "1st St.",
      })
    ).user;

    await companyContractorsFactory.create({
      companyId: company.id,
      userId: contractorUser.id,
      payRateInSubunits: 10000, // $100/hour
    });
  });

  test("shows Import from PDF button and successfully parses invoice", async ({ page }) => {
    await login(page, contractorUser, "/invoices/new");

    // Check that Import from PDF button is visible
    const importButton = page.getByRole("button", { name: "Import from PDF" });
    await expect(importButton).toBeVisible();

    // Mock the API response
    await page.route("**/api/invoices/parse-pdf", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          invoiceNumber: "INV-PDF-001",
          invoiceDate: "2024-03-20",
          lineItems: [
            {
              description: "Development Services",
              quantity: 10, // 10 hours
              rate: 100,
            },
          ],
          notes: "March 2024 work",
        }),
      });
    });

    // Simulate PDF drop
    const dropTarget = page.locator("body");
    const dataTransfer = await createDataTransferHandle(page, [
      {
        name: "invoice.pdf",
        type: "application/pdf",
        bytes: Array.from(Buffer.from("Invoice content")),
      },
    ]);

    await dropTarget.dispatchEvent("drop", { dataTransfer });
    await page.waitForTimeout(1000);

    // Verify fields are populated
    await expect(page.getByLabel("Invoice ID")).toHaveValue("INV-PDF-001");
    await expect(page.getByPlaceholder("Description").first()).toHaveValue("Development Services");
    await expect(page.getByLabel("Hours / Qty").first()).toHaveValue("10:00");
    await expect(page.getByLabel("Rate").first()).toHaveValue("100");

    // Submit the invoice
    await page.getByRole("button", { name: "Send invoice" }).click();
    await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();

    // Verify in database
    const invoice = await db.query.invoices
      .findFirst({ where: eq(invoices.companyId, company.id), orderBy: desc(invoices.id) })
      .then(takeOrThrow);
    expect(invoice.invoiceNumber).toBe("INV-PDF-001");
    expect(invoice.totalAmountInUsdCents).toBe(100000n); // $1000
  });

  test("validates PDF file type and size", async ({ page }) => {
    await login(page, contractorUser, "/invoices/new");
    await page.waitForLoadState("networkidle");

    const dropTarget = page.locator("body");

    // Test non-PDF file
    const txtTransfer = await createDataTransferHandle(page, [
      {
        name: "document.txt",
        type: "text/plain",
        bytes: Array.from(Buffer.from("Text file")),
      },
    ]);

    await dropTarget.dispatchEvent("drop", { dataTransfer: txtTransfer });
    await page.waitForTimeout(500);

    // Check for error message
    const dropError = page.getByText("Please drop a PDF file");
    const selectError = page.getByText("Please select a PDF file");
    const dropErrorVisible = await dropError.isVisible().catch(() => false);
    const selectErrorVisible = await selectError.isVisible().catch(() => false);
    expect(dropErrorVisible || selectErrorVisible).toBeTruthy();

    // Dismiss error if visible
    const dismissButton = page.getByRole("button", { name: "Dismiss" });
    if (await dismissButton.isVisible().catch(() => false)) {
      await dismissButton.click();
    }

    // Test oversized PDF (>10MB)
    const largeTransfer = await createDataTransferHandle(page, [
      {
        name: "large.pdf",
        type: "application/pdf",
        bytes: Array.from(Buffer.alloc(11 * 1024 * 1024)), // 11MB
      },
    ]);

    await dropTarget.dispatchEvent("drop", { dataTransfer: largeTransfer });
    await expect(page.getByText(/File size exceeds.*10.*MB limit/u)).toBeVisible();
    await page.getByRole("button", { name: "Dismiss" }).click();
  });

  test("shows error for non-invoice PDF content", async ({ page }) => {
    await login(page, contractorUser, "/invoices/new");
    await page.waitForLoadState("networkidle");

    // Mock API response for non-invoice PDF
    await page.route("**/api/invoices/parse-pdf", async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: "This PDF doesn't appear to contain invoice data. Please upload a valid invoice PDF.",
        }),
      });
    });

    const dropTarget = page.locator("body");
    const dataTransfer = await createDataTransferHandle(page, [
      {
        name: "manual.pdf",
        type: "application/pdf",
        bytes: Array.from(Buffer.from("User manual")),
      },
    ]);

    await dropTarget.dispatchEvent("drop", { dataTransfer });
    await page.waitForTimeout(1000);

    // Check for error message
    const errorAlert = page.locator('[role="alert"]').filter({ hasText: "invoice data" });
    const errorText = page.getByText(
      "This PDF doesn't appear to contain invoice data. Please upload a valid invoice PDF.",
    );

    try {
      await expect(errorAlert.or(errorText)).toBeVisible({ timeout: 5000 });
    } catch {
      const anyError = page.getByText(/invoice data/iu);
      await expect(anyError).toBeVisible();
    }

    // Dismiss error if exists
    const dismissButton = page.getByRole("button", { name: "Dismiss" });
    if (await dismissButton.isVisible().catch(() => false)) {
      await dismissButton.click();
    }
  });
});
