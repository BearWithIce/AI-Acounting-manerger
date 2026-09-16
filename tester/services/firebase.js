import admin from "firebase-admin";
import fs from "fs";
import path from "path";

let db;

export function initFirebase() {
  if (db) return db;

  const file = process.env.FIREBASE_SERVICE_ACCOUNT_FILE || "./firebase-service-account.json";
  const serviceAccount = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }

  db = admin.database();
  return db;
}

export async function saveTransaction(id, data) {
  await initFirebase().ref(`transactions/${id}`).set(data);
}

export async function getTransaction(id) {
  const snapshot = await initFirebase().ref(`transactions/${id}`).once("value");
  return snapshot.exists() ? snapshot.val() : null;
}

export async function saveInvoice(invoiceNumber, data) {
  await initFirebase().ref(`invoices/${invoiceNumber}`).set(data);
}

export async function getInvoice(invoiceNumber) {
  const snapshot = await initFirebase().ref(`invoices/${invoiceNumber}`).once("value");
  return snapshot.exists() ? snapshot.val() : null;
}

export async function getNextInvoiceNumber() {
  const ref = initFirebase().ref("counters/invoice");
  const result = await ref.transaction(current => (current || 0) + 1);
  const number = result.snapshot.val();
  const year = new Date().getFullYear();
  return `AURA-${year}-${String(number).padStart(6, "0")}`;
}

export async function getCompanyData() {
  const database = initFirebase();
  const [transactionsSnap, invoicesSnap] = await Promise.all([
    database.ref("transactions").once("value"),
    database.ref("invoices").once("value")
  ]);

  return {
    transactions: transactionsSnap.val() || {},
    invoices: invoicesSnap.val() || {}
  };
}
