import ExcelJS from "exceljs";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const templatePath = path.resolve(
  "./templates/aura-cloud-invoice.xlsx"
);

const outputDir = path.resolve("./output");

function money(value) {
  const number = Number(value || 0);

  return Number.isFinite(number)
    ? number
    : 0;
}

/*
============================================================
CREATE INVOICE FILES
============================================================
*/

export async function createInvoiceFiles(data) {
  if (!fs.existsSync(templatePath)) {
    throw new Error(
      "Invoice template not found: templates/aura-cloud-invoice.xlsx"
    );
  }

  fs.mkdirSync(outputDir, {
    recursive: true
  });

  const workbook = new ExcelJS.Workbook();

  await workbook.xlsx.readFile(
    templatePath
  );

  const sheet =
    workbook.getWorksheet(
      "Aura Cloud Invoice"
    ) || workbook.worksheets[0];

  if (!sheet) {
    throw new Error(
      "No worksheet found in invoice template."
    );
  }

  /*
  ============================================================
  SAFE CELL SETTER
  ============================================================
  */

  const set = (cell, value) => {
    sheet.getCell(cell).value =
      value ?? "";
  };

  /*
  ============================================================
  CUSTOMER INFORMATION
  ============================================================
  */

  set(
    "B5",
    data.customer?.name
  );

  set(
    "B6",
    data.customer?.email
  );

  set(
    "B7",
    data.customer?.company
  );

  set(
    "B8",
    data.customer?.address ||
      data.customer?.phone
  );

  /*
  ============================================================
  INVOICE INFORMATION
  ============================================================
  */

  // Invoice number is numeric only.
  const invoiceNumber = String(
    data.invoiceNumber || ""
  ).replace(/\D/g, "");

  set(
    "G4",
    invoiceNumber
  );

  set(
    "G5",
    data.purchaseDate
  );

  set(
    "G6",
    data.expiryDate
  );

  set(
    "G7",
    data.status
  );

  /*
  ============================================================
  PRODUCT / SERVICE
  ============================================================
  */

  set(
    "A12",
    data.description
  );

  set(
    "B12",
    data.quantity
  );

  set(
    "C12",
    data.billingCycle
  );

  set(
    "D12",
    data.unitPrice
  );

  set(
    "E12",
    data.discount
  );

  set(
    "F12",
    data.tax
  );

  set(
    "G12",
    data.lineTotal
  );

  /*
  ============================================================
  SUMMARY
  ============================================================
  */

  set(
    "G23",
    data.subtotal
  );

  set(
    "G24",
    data.tax
  );

  set(
    "G25",
    data.total
  );

  /*
  ============================================================
  FILE PATHS
  ============================================================
  */

  const xlsxPath = path.join(
    outputDir,
    `${invoiceNumber}.xlsx`
  );

  const pdfPath = path.join(
    outputDir,
    `${invoiceNumber}.pdf`
  );

  /*
  ============================================================
  WRITE EXCEL FILE
  ============================================================
  */

  await workbook.xlsx.writeFile(
    xlsxPath
  );

  /*
  ============================================================
  CONVERT EXCEL -> PDF
  ============================================================
  */

  try {
    await execFileAsync(
      "libreoffice",
      [
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        outputDir,
        xlsxPath
      ]
    );
  } catch (error) {
    console.error(
      "LibreOffice error:",
      error
    );

    throw new Error(
      "PDF conversion failed. Install LibreOffice and make sure the 'libreoffice' command is available in PATH."
    );
  }

  /*
  ============================================================
  VERIFY PDF
  ============================================================
  */

  if (!fs.existsSync(pdfPath)) {
    throw new Error(
      "PDF conversion completed but no PDF file was created."
    );
  }

  return {
    xlsxPath,
    pdfPath
  };
}

/*
============================================================
CALCULATE INVOICE
============================================================
*/

export function calculateInvoice(invoiceData) {
  const quantity = Math.max(
    1,
    money(invoiceData.quantity)
  );

  const unitPrice = money(
    invoiceData.unitPrice
  );

  const discount = Math.max(
    0,
    money(invoiceData.discount)
  );

  const tax = Math.max(
    0,
    money(invoiceData.tax)
  );

  // Price before discount/tax
  const subtotal = quantity * unitPrice;

  // Discount applies to the whole line
  const lineTotal = Math.max(
    0,
    subtotal - discount
  );

  // Final invoice total
  const total = lineTotal + tax;

  return {
    quantity,
    unitPrice,
    discount,
    tax,
    subtotal,
    lineTotal,
    total
  };
}