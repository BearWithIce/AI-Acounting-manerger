import admin from "firebase-admin";
import fs from "fs";
import path from "path";

let db;

/* ============================================================
   FIREBASE INITIALIZATION
============================================================ */

export function initFirebase() {
  if (db) return db;

  const file =
    process.env.FIREBASE_SERVICE_ACCOUNT_FILE ||
    "./firebase-service-account.json";

  const serviceAccount = JSON.parse(
    fs.readFileSync(
      path.resolve(file),
      "utf8"
    )
  );

  if (!admin.apps.length) {
    admin.initializeApp({
      credential:
        admin.credential.cert(serviceAccount),

      databaseURL:
        process.env.FIREBASE_DATABASE_URL
    });
  }

  db = admin.database();

  return db;
}

/* ============================================================
   TRANSACTIONS
============================================================ */

export async function saveTransaction(
  id,
  data
) {
  await initFirebase()
    .ref(`transactions/${id}`)
    .set(data);
}

export async function getTransaction(
  id
) {
  const snapshot =
    await initFirebase()
      .ref(`transactions/${id}`)
      .once("value");

  return snapshot.exists()
    ? snapshot.val()
    : null;
}

export async function updateTransaction(
  id,
  patch
) {
  await initFirebase()
    .ref(`transactions/${id}`)
    .update(patch);
}

/* ============================================================
   INVOICES
============================================================ */

export async function saveInvoice(
  invoiceNumber,
  data
) {
  await initFirebase()
    .ref(`invoices/${invoiceNumber}`)
    .set(data);
}

export async function getInvoice(
  invoiceNumber
) {
  const snapshot =
    await initFirebase()
      .ref(`invoices/${invoiceNumber}`)
      .once("value");

  return snapshot.exists()
    ? snapshot.val()
    : null;
}

export async function updateInvoice(
  invoiceNumber,
  patch
) {
  await initFirebase()
    .ref(`invoices/${invoiceNumber}`)
    .update(patch);
}

/* ============================================================
   ORDERS
============================================================ */

export async function saveOrder(
  orderNumber,
  data
) {
  await initFirebase()
    .ref(`orders/${orderNumber}`)
    .set(data);
}

export async function getOrder(
  orderNumber
) {
  const snapshot =
    await initFirebase()
      .ref(`orders/${orderNumber}`)
      .once("value");

  return snapshot.exists()
    ? snapshot.val()
    : null;
}

export async function updateOrder(
  orderNumber,
  patch
) {
  await initFirebase()
    .ref(`orders/${orderNumber}`)
    .update(patch);
}

/* ============================================================
   DISCOUNT CODES
============================================================ */

export async function saveDiscountCode(
  code,
  data
) {
  await initFirebase()
    .ref(`discountCodes/${code}`)
    .set(data);
}

export async function getDiscountCode(
  code
) {
  const snapshot =
    await initFirebase()
      .ref(`discountCodes/${code}`)
      .once("value");

  return snapshot.exists()
    ? snapshot.val()
    : null;
}

/* ============================================================
   RENEWALS
============================================================ */

/*
Firebase structure:

renewals/
  RENEWAL-AURA-2026-000001-123456789/
    sourceOrderNumber
    discordUserId
    status
    ...
*/

export async function saveRenewal(
  renewalId,
  data
) {
  await initFirebase()
    .ref(`renewals/${renewalId}`)
    .set(data);
}

export async function getRenewal(
  renewalId
) {
  const snapshot =
    await initFirebase()
      .ref(`renewals/${renewalId}`)
      .once("value");

  return snapshot.exists()
    ? snapshot.val()
    : null;
}

export async function updateRenewal(
  renewalId,
  patch
) {
  await initFirebase()
    .ref(`renewals/${renewalId}`)
    .update(patch);
}

/* ============================================================
   ACCOUNTS
============================================================ */

/*
Firebase structure:

accounts/
  DISCORD_USER_ID/
    discordUserId
    discordUsername
    customer
    orderNumber
    serverName
    amount
    currency
    paymentStatus
    expiryDate
    lastInvoiceNumber
*/

export async function saveAccount(
  discordUserId,
  data
) {
  await initFirebase()
    .ref(`accounts/${discordUserId}`)
    .set(data);
}

export async function getAccount(
  discordUserId
) {
  const snapshot =
    await initFirebase()
      .ref(`accounts/${discordUserId}`)
      .once("value");

  return snapshot.exists()
    ? snapshot.val()
    : null;
}

export async function updateAccount(
  discordUserId,
  patch
) {
  await initFirebase()
    .ref(`accounts/${discordUserId}`)
    .update(patch);
}

/* ============================================================
   NUMBER PARSER
============================================================ */

function parseAuraNumber(
  value
) {
  const match =
    /^AURA-(\d{4})-(\d{6})$/.exec(
      String(value || "")
    );

  if (!match) {
    return null;
  }

  const year =
    Number(match[1]);

  const number =
    Number(match[2]);

  if (
    !Number.isSafeInteger(year) ||
    !Number.isSafeInteger(number)
  ) {
    return null;
  }

  return {
    year,
    number
  };
}

/* ============================================================
   FIND LATEST INVOICE NUMBER
============================================================ */

async function getLatestInvoiceNumber(
  year
) {
  const database =
    initFirebase();

  const snapshot =
    await database
      .ref("invoices")
      .once("value");

  const data =
    snapshot.val() || {};

  let latestNumber = 0;

  for (
    const [key, value]
    of Object.entries(data)
  ) {

    let parsed =
      parseAuraNumber(key);

    if (!parsed) {
      parsed =
        parseAuraNumber(
          value?.invoiceNumber
        );
    }

    if (!parsed) {
      continue;
    }

    if (
      parsed.year !== year
    ) {
      continue;
    }

    if (
      parsed.number >
      latestNumber
    ) {
      latestNumber =
        parsed.number;
    }
  }

  return latestNumber;
}

/* ============================================================
   FIND LATEST ORDER NUMBER
============================================================ */

async function getLatestOrderNumber(
  year
) {
  const database =
    initFirebase();

  const snapshot =
    await database
      .ref("orders")
      .once("value");

  const data =
    snapshot.val() || {};

  let latestNumber = 0;

  for (
    const [key, value]
    of Object.entries(data)
  ) {

    let parsed =
      parseAuraNumber(key);

    if (!parsed) {
      parsed =
        parseAuraNumber(
          value?.orderNumber
        );
    }

    if (!parsed) {
      continue;
    }

    if (
      parsed.year !== year
    ) {
      continue;
    }

    if (
      parsed.number >
      latestNumber
    ) {
      latestNumber =
        parsed.number;
    }
  }

  return latestNumber;
}

/* ============================================================
   NEXT INVOICE NUMBER
============================================================ */

export async function getNextInvoiceNumber() {

  const database =
    initFirebase();

  const year =
    new Date().getFullYear();

  const latestInvoice =
    await getLatestInvoiceNumber(
      year
    );

  const counterRef =
    database.ref(
      `counters/invoices/${year}`
    );

  const result =
    await counterRef.transaction(
      current => {

        const currentNumber =
          Number(current) || 0;

        return Math.max(
          currentNumber,
          latestInvoice
        ) + 1;

      }
    );

  if (
    !result.committed
  ) {
    throw new Error(
      "Failed to generate invoice number."
    );
  }

  const number =
    Number(
      result.snapshot.val()
    );

  if (
    !Number.isSafeInteger(
      number
    )
  ) {
    throw new Error(
      "Invalid invoice counter value."
    );
  }

  return (
    `AURA-${year}-` +
    String(number).padStart(
      6,
      "0"
    )
  );
}

/* ============================================================
   NEXT ORDER NUMBER
============================================================ */

export async function getNextOrderNumber() {

  const database =
    initFirebase();

  const year =
    new Date().getFullYear();

  const latestOrder =
    await getLatestOrderNumber(
      year
    );

  const counterRef =
    database.ref(
      `counters/orders/${year}`
    );

  const result =
    await counterRef.transaction(
      current => {

        const currentNumber =
          Number(current) || 0;

        return Math.max(
          currentNumber,
          latestOrder
        ) + 1;

      }
    );

  if (
    !result.committed
  ) {
    throw new Error(
      "Failed to generate order number."
    );
  }

  const number =
    Number(
      result.snapshot.val()
    );

  if (
    !Number.isSafeInteger(
      number
    )
  ) {
    throw new Error(
      "Invalid order counter value."
    );
  }

  return (
    `AURA-${year}-` +
    String(number).padStart(
      6,
      "0"
    )
  );
}

/* ============================================================
   COMPANY DATA
============================================================ */

export async function getCompanyData() {

  const database =
    initFirebase();

  const [
    transactionsSnap,
    invoicesSnap
  ] = await Promise.all([

    database
      .ref("transactions")
      .once("value"),

    database
      .ref("invoices")
      .once("value")

  ]);

  return {

    transactions:
      transactionsSnap.val() || {},

    invoices:
      invoicesSnap.val() || {}

  };
}