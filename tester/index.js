
import "dotenv/config";

import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  Events,
  EmbedBuilder
} from "discord.js";

import crypto from "crypto";

import {
  extractTransaction,
  extractInvoiceData,
  askAI
} from "./services/ai.js";

import {
  initFirebase,
  saveTransaction,
  saveInvoice,
  getInvoice,
  getNextInvoiceNumber
} from "./services/firebase.js";

import {
  addTransaction,
  addInvoice,
  getAllInvoices as getSheetInvoices,
  getAllTransactions as getSheetTransactions,
  searchInvoices as searchSheetInvoices
} from "./services/googleSheets.js";

import {
  calculateInvoice,
  createInvoiceFiles
} from "./services/invoice.js";

import {
  sendInvoiceEmail,
  sendMessageEmail
} from "./services/email.js";

/* ============================================================
   DISCORD BOT
============================================================ */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],

  partials: [
    Partials.Channel
  ]
});

/* ============================================================
   TEMPORARY INVOICE STORAGE
============================================================ */

const pendingInvoices = new Map();

/* ============================================================
   SECURITY
============================================================ */

function isAllowed(message) {
  if (
    message.guildId !==
    process.env.ALLOWED_GUILD_ID
  ) {
    return false;
  }

  if (
    message.channelId !==
    process.env.ALLOWED_CHANNEL_ID
  ) {
    return false;
  }

  if (!message.member) {
    return false;
  }

  if (
    !message.member.roles.cache.has(
      process.env.ALLOWED_ROLE_ID
    )
  ) {
    return false;
  }

  return true;
}

/* ============================================================
   ID
============================================================ */

function makeId() {
  return crypto.randomUUID();
}

/* ============================================================
   DATE HELPERS
============================================================ */

function dateToday() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

function formatDate(date) {
  return date
    .toISOString()
    .slice(0, 10);
}

function extractExplicitDate(text) {
  if (!text) {
    return null;
  }

  const match = text.match(
    /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/
  );

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(
    Date.UTC(
      year,
      month - 1,
      day
    )
  );

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return formatDate(date);
}

function detectRelativeDate(text) {
  if (!text) {
    return null;
  }

  const lower =
    text.toLowerCase();

  const today =
    new Date();

  if (/\btoday\b/.test(lower)) {
    return formatDate(today);
  }

  if (/\byesterday\b/.test(lower)) {
    const date =
      new Date(today);

    date.setDate(
      date.getDate() - 1
    );

    return formatDate(date);
  }

  if (/\btomorrow\b/.test(lower)) {
    const date =
      new Date(today);

    date.setDate(
      date.getDate() + 1
    );

    return formatDate(date);
  }

  return null;
}

function resolveDate(
  originalText,
  aiDate = null
) {
  const explicitDate =
    extractExplicitDate(
      originalText
    );

  if (explicitDate) {
    return explicitDate;
  }

  const relativeDate =
    detectRelativeDate(
      originalText
    );

  if (relativeDate) {
    return relativeDate;
  }

  if (
    aiDate &&
    /^\d{4}-\d{2}-\d{2}$/.test(
      aiDate
    )
  ) {
    return aiDate;
  }

  return dateToday();
}

function safeDate(
  value,
  originalText = ""
) {
  return resolveDate(
    originalText,
    value
  );
}

/* ============================================================
   COMPANY FINANCIAL SUMMARY
============================================================ */

async function companySummary() {
  const [
    transactions,
    invoices
  ] = await Promise.all([
    getSheetTransactions(),
    getSheetInvoices()
  ]);

  const paid = value =>
    String(value || "")
      .trim()
      .toLowerCase() ===
    "paid";

  const income =
    transactions
      .filter(
        t =>
          String(
            t.type || ""
          ).toLowerCase() ===
            "income" &&
          paid(t.status)
      )
      .reduce(
        (sum, t) =>
          sum +
          Number(
            t.amount || 0
          ),
        0
      );

  const expenses =
    transactions
      .filter(
        t =>
          String(
            t.type || ""
          ).toLowerCase() ===
            "expense" &&
          paid(t.status)
      )
      .reduce(
        (sum, t) =>
          sum +
          Number(
            t.amount || 0
          ),
        0
      );

  const invoiceRevenue =
    invoices
      .filter(i =>
        paid(i.status)
      )
      .reduce(
        (sum, i) =>
          sum +
          Number(
            i.total || 0
          ),
        0
      );

  return {
    source:
      "Google Sheets",

    totalTransactions:
      transactions.length,

    totalInvoices:
      invoices.length,

    recordedIncome:
      income,

    recordedExpenses:
      expenses,

    recordedProfit:
      income - expenses,

    paidInvoiceRevenue:
      invoiceRevenue,

    transactions:
      transactions.slice(-100),

    invoices:
      invoices.slice(-100)
  };
}

/* ============================================================
   CUSTOMER SEARCH
============================================================ */

function normalizeSearchText(
  value
) {
  return String(value || "")
    .toLowerCase()
    .replace(
      /[^a-z0-9]/g,
      ""
    );
}

async function getAllInvoices() {
  return getSheetInvoices();
}

async function findCustomersInQuestion(
  question
) {
  const invoices =
    await getAllInvoices();

  const questionNormalized =
    normalizeSearchText(
      question
    );

  const customers = [];

  for (
    const invoice of invoices
  ) {
    const name =
      invoice.customer?.name ||
      invoice.clientName ||
      invoice.customerName ||
      "";

    if (!name) {
      continue;
    }

    const normalizedName =
      normalizeSearchText(
        name
      );

    if (!normalizedName) {
      continue;
    }

    if (
      questionNormalized.includes(
        normalizedName
      )
    ) {
      const alreadyExists =
        customers.some(
          customer =>
            normalizeSearchText(
              customer.name
            ) ===
            normalizedName
        );

      if (!alreadyExists) {
        customers.push({
          name,
          invoices: []
        });
      }
    }
  }

  for (
    const customer of customers
  ) {
    const normalizedName =
      normalizeSearchText(
        customer.name
      );

    customer.invoices =
      invoices.filter(
        invoice => {
          const invoiceName =
            invoice.customer?.name ||
            invoice.clientName ||
            invoice.customerName ||
            "";

          return (
            normalizeSearchText(
              invoiceName
            ) ===
            normalizedName
          );
        }
      );
  }

  return customers;
}

/* ============================================================
   CUSTOMER ANALYSIS
============================================================ */

function createCustomerAnalysis(
  customer
) {
  const invoices =
    customer.invoices || [];

  const minecraftInvoices =
    invoices.filter(
      invoice => {
        const description =
          String(
            invoice.description || ""
          ).toLowerCase();

        const service =
          String(
            invoice.service || ""
          ).toLowerCase();

        const combined =
          `${description} ${service}`;

        return combined.includes(
          "minecraft"
        );
      }
    );

  const unpaidMinecraftInvoices =
    minecraftInvoices.filter(
      invoice => {
        const status =
          String(
            invoice.status || ""
          )
            .trim()
            .toLowerCase();

        return (
          status === "unpaid" ||
          status === "pending"
        );
      }
    );

  const unpaidMinecraftValue =
    unpaidMinecraftInvoices.reduce(
      (
        total,
        invoice
      ) => {
        const quantity =
          Math.max(
            1,
            Number(
              invoice.quantity ?? 1
            )
          );

        const unitPrice =
          Number(
            invoice.unitPrice ?? 0
          );

        const invoiceTotal =
          Number(
            invoice.total ?? 0
          );

        const value =
          invoiceTotal > 0
            ? invoiceTotal
            : quantity *
              unitPrice;

        return total + value;
      },
      0
    );

  const unpaidInvoices =
    invoices.filter(
      invoice => {
        const status =
          String(
            invoice.status || ""
          )
            .trim()
            .toLowerCase();

        return (
          status === "unpaid" ||
          status === "pending"
        );
      }
    );

  const totalOutstanding =
    unpaidInvoices.reduce(
      (
        total,
        invoice
      ) =>
        total +
        Number(
          invoice.total ??
          invoice.unitPrice ??
          0
        ),
      0
    );

  const records =
    invoices.map(
      invoice => ({
        invoiceNumber:
          invoice.invoiceNumber ||
          null,

        customer:
          invoice.customer?.name ||
          invoice.clientName ||
          invoice.customerName ||
          null,

        description:
          invoice.description ||
          "",

        service:
          invoice.service ||
          "",

        quantity:
          invoice.quantity ??
          1,

        billingCycle:
          invoice.billingCycle ||
          "",

        unitPrice:
          invoice.unitPrice ??
          0,

        discount:
          invoice.discount ??
          0,

        tax:
          invoice.tax ??
          0,

        total:
          invoice.total ??
          0,

        currency:
          invoice.currency ||
          "LKR",

        status:
          invoice.status ||
          "",

        purchaseDate:
          invoice.purchaseDate ||
          "",

        expiryDate:
          invoice.expiryDate ||
          "",

        createdAt:
          invoice.createdAt ||
          ""
      })
    );

  return {
    customerName:
      customer.name,

    totalInvoices:
      invoices.length,

    minecraftServerInvoices:
      minecraftInvoices.length,

    unpaidMinecraftServers:
      unpaidMinecraftInvoices.length,

    unpaidMinecraftValue,

    totalUnpaidInvoices:
      unpaidInvoices.length,

    totalOutstanding,

    currency:
      unpaidMinecraftInvoices[0]
        ?.currency ||
      invoices[0]?.currency ||
      "LKR",

    invoices:
      records,

    minecraftInvoices:
      minecraftInvoices.map(
        invoice => ({
          invoiceNumber:
            invoice.invoiceNumber ||
            null,

          description:
            invoice.description ||
            "",

          service:
            invoice.service ||
            "",

          quantity:
            invoice.quantity ??
            1,

          unitPrice:
            invoice.unitPrice ??
            0,

          total:
            invoice.total ??
            0,

          currency:
            invoice.currency ||
            "LKR",

          status:
            invoice.status ||
            "",

          purchaseDate:
            invoice.purchaseDate ||
            "",

          expiryDate:
            invoice.expiryDate ||
            ""
        })
      ),

    unpaidMinecraftInvoices:
      unpaidMinecraftInvoices.map(
        invoice => ({
          invoiceNumber:
            invoice.invoiceNumber ||
            null,

          description:
            invoice.description ||
            "",

          service:
            invoice.service ||
            "",

          quantity:
            invoice.quantity ??
            1,

          unitPrice:
            invoice.unitPrice ??
            0,

          total:
            invoice.total ??
            0,

          currency:
            invoice.currency ||
            "LKR",

          status:
            invoice.status ||
            "",

          purchaseDate:
            invoice.purchaseDate ||
            "",

          expiryDate:
            invoice.expiryDate ||
            ""
        })
      )
  };
}

/* ============================================================
   LOCAL CUSTOMER ANSWER
============================================================ */

function localCustomerAnswer(
  analysis,
  question
) {
  const {
    customerName,
    unpaidMinecraftServers,
    unpaidMinecraftValue,
    totalInvoices,
    totalUnpaidInvoices,
    totalOutstanding,
    currency,
    unpaidMinecraftInvoices
  } = analysis;

  const lower =
    question.toLowerCase();

  if (
    lower.includes(
      "minecraft"
    ) &&
    (
      lower.includes(
        "non-paid"
      ) ||
      lower.includes(
        "non paid"
      ) ||
      lower.includes(
        "unpaid"
      ) ||
      lower.includes(
        "not paid"
      ) ||
      lower.includes(
        "how many"
      ) ||
      lower.includes(
        "quantity"
      ) ||
      lower.includes(
        "worth"
      )
    )
  ) {
    if (
      unpaidMinecraftServers ===
      0
    ) {
      return [
        `**No unpaid Minecraft server records were found for ${customerName}.**`,
        "",
        `Based on the verified Aura Cloud invoice records, there are **0 unpaid Minecraft servers** for this customer.`,
        "",
        `**Total invoices checked:** ${totalInvoices}`
      ].join("\n");
    }

    const invoiceLines =
      unpaidMinecraftInvoices.map(
        invoice => {
          const quantity =
            Math.max(
              1,
              Number(
                invoice.quantity ??
                1
              )
            );

          const unitPrice =
            Number(
              invoice.unitPrice ??
              0
            );

          const invoiceTotal =
            Number(
              invoice.total ??
              0
            );

          const value =
            (
              invoiceTotal > 0
                ? invoiceTotal
                : quantity *
                  unitPrice
            ).toLocaleString();

          return [
            `**Invoice:** \`${invoice.invoiceNumber || "Unknown"}\``,
            `**Server:** ${invoice.description || invoice.service || "Minecraft server"}`,
            `**Quantity:** ${invoice.quantity ?? 1}`,
            `**Value:** ${value} ${invoice.currency || currency}`,
            `**Status:** ${invoice.status}`
          ].join("\n");
        }
      );

    return [
      `# 📊 Unpaid Minecraft Server — ${customerName}`,
      "",
      "Based on Aura Cloud's verified invoice records:",
      "",
      `**Quantity of unpaid Minecraft servers:** ${unpaidMinecraftServers}`,
      `**Recorded outstanding value:** ${unpaidMinecraftValue.toLocaleString()} ${currency}`,
      "",
      ...invoiceLines,
      "",
      "**Note:** The value above is the amount recorded in Aura Cloud's invoices. It is not an independent market valuation."
    ].join("\n");
  }

  if (
    lower.includes(
      "unpaid"
    ) ||
    lower.includes(
      "outstanding"
    ) ||
    lower.includes(
      "owe"
    ) ||
    lower.includes(
      "payment"
    )
  ) {
    return [
      `# 📊 ${customerName} — Payment Status`,
      "",
      `**Total invoices:** ${totalInvoices}`,
      `**Unpaid/Pending invoices:** ${totalUnpaidInvoices}`,
      `**Total outstanding:** ${totalOutstanding.toLocaleString()} ${currency}`,
      "",
      "These figures are calculated from the verified invoice records."
    ].join("\n");
  }

  return [
    `# 📊 ${customerName}`,
    "",
    `**Total invoices:** ${totalInvoices}`,
    `**Unpaid/Pending invoices:** ${totalUnpaidInvoices}`,
    `**Outstanding amount:** ${totalOutstanding.toLocaleString()} ${currency}`,
    `**Unpaid Minecraft servers:** ${unpaidMinecraftServers}`,
    `**Unpaid Minecraft value:** ${unpaidMinecraftValue.toLocaleString()} ${currency}`,
    "",
    "These figures are based only on the customer's recorded Aura Cloud invoices."
  ].join("\n");
}

/* ============================================================
   AI RESPONSE FORMATTER
============================================================ */

function formatAIResponse(
  text
) {
  if (!text) {
    return "";
  }

  let result =
    String(text)
      .replace(/\r/g, "")
      .replace(
        /```(?:markdown)?/gi,
        ""
      )
      .replace(
        /```/g,
        ""
      )
      .replace(
        /^\s*\*[-•]\s+/gm,
        ""
      )
      .replace(
        /^\s*\*{3,}\s+/gm,
        ""
      )
      .trim();

  result =
    result
      .replace(
        /^\s*#{4,}\s*/gm,
        "### "
      )
      .replace(
        /\n{3,}/g,
        "\n\n"
      );

  return result;
}

function cleanAndReply(
  message,
  text
) {
  const formatted =
    formatAIResponse(text);

  return message.reply(
    formatted ||
    "No analysis was returned."
  );
}

/* ============================================================
   BOT READY
============================================================ */

client.once(
  Events.ClientReady,
  async () => {
    try {
      await initFirebase();

      console.log(
        `Aura Cloud Manager Bot online as ${client.user.tag}`
      );

      console.log(
        "Firebase Realtime Database initialized."
      );
    } catch (error) {
      console.error(
        "Firebase startup error:",
        error
      );
    }
  }
);

/* ============================================================
   MESSAGE COMMANDS
============================================================ */

client.on(
  Events.MessageCreate,
  async message => {
    try {
      /* Ignore bots */

      if (
        message.author.bot
      ) {
        return;
      }

      /* ======================================================
         HELP
      ====================================================== */

      if (
        message.content
          .trim()
          .toLowerCase() ===
        "!help"
      ) {
        const helpEmbed =
          new EmbedBuilder()
            .setTitle(
              "🤖 Aura Cloud Manager Bot"
            )
            .setDescription(
              "Management and accounting commands for Aura Cloud Hosting."
            )
            .addFields(
              {
                name:
                  "💰 !in — Record Transaction",

                value:
                  "`!in <explanation>`\n\n" +
                  "Example:\n" +
                  "`!in Client paid 21000 LKR on 2026-08-20 for VPS hosting by bank transfer`"
              },

              {
                name:
                  "📄 !inv — Create Invoice",

                value:
                  "`!inv <explanation>`\n\n" +
                  "Example:\n" +
                  "`!inv Client purchased Minecraft hosting for 5000 LKR monthly and paid today`"
              },

              {
                name:
                  "📤 !ap — Send Invoice",

                value:
                  "`!ap @user <invoice-number>`\n\n" +
                  "or\n\n" +
                  "`!ap email@example.com <invoice-number>`\n\n" +
                  "Example:\n" +
                  "`!ap @Client AURA-2026-000001`"
              },

              {
                name:
                  "💬 !msg — Message a Discord User",

                value:
                  "`!msg @user <message>`\n\n" +
                  "or\n\n" +
                  "`!msg USER_ID <message>`\n\n" +
                  "The message can contain spaces, line breaks, mentions, emojis, Markdown and special characters. Formatting is preserved."
              },

              {
                name:
                  "📧 !email — Send Email",

                value:
                  "`!email email@example.com <message>`\n\n" +
                  "Example:\n" +
                  "`!email client@example.com Your invoice is ready.`"
              },

              {
                name:
                  "📊 !tell — Ask Aura AI",

                value:
                  "`!tell <question>`\n\n" +
                  "Examples:\n\n" +
                  "`!tell What is the company status?`\n" +
                  "`!tell How much revenue do we have?`\n" +
                  "`!tell How many unpaid Minecraft servers does pixelDreamescapes have?`\n" +
                  "`!tell What does pixelDreamescapes owe us?`\n" +
                  "`!tell Explain order AURA-2026-000001`"
              }
            )
            .setFooter({
              text:
                "Management commands require the authorized Aura Cloud role."
            })
            .setTimestamp();

        await message.reply({
          embeds: [
            helpEmbed
          ]
        });

        return;
      }

      /* ======================================================
         SECURITY
      ====================================================== */

      if (
        !isAllowed(message)
      ) {
        return;
      }

      /*
       * Keep the ORIGINAL Discord message.
       *
       * Do not use trim(), split(/\s+/), or join(" ")
       * for !msg because those destroy formatting.
       */

      const rawContent =
        message.content;

      const content =
        rawContent.trim();

      /* ======================================================
         !in
         RECORD TRANSACTION
      ====================================================== */

      if (
        content === "!in" ||
        content.startsWith(
          "!in "
        )
      ) {
        const explanation =
          content
            .slice(3)
            .trim();

        if (!explanation) {
          return message.reply(
            "❌ Please explain the transaction after `!in`."
          );
        }

        try {
          await message.channel.send(
            "🤖 Aura AI is processing the transaction..."
          );

          const extracted =
            await extractTransaction(
              explanation
            );

          if (
            extracted.amount ===
              null ||
            extracted.amount ===
              undefined ||
            Number.isNaN(
              Number(
                extracted.amount
              )
            )
          ) {
            return message.reply(
              "❌ I could not identify the transaction amount. Please include the amount clearly."
            );
          }

          const transactionDate =
            resolveDate(
              explanation,
              extracted.date
            );

          const transaction = {
            ...extracted,

            id:
              makeId(),

            createdAt:
              new Date().toISOString(),

            date:
              transactionDate,

            recordedBy: {
              userId:
                message.author.id,

              username:
                message.author.tag
            },

            originalExplanation:
              explanation
          };

          await Promise.all([
            saveTransaction(
              transaction.id,
              transaction
            ),

            addTransaction(
              transaction
            )
          ]);

          return message.reply(
            `# 💰 Transaction Added

**Transaction ID:** \`${transaction.id}\`
**Type:** ${transaction.type}
**Amount:** ${transaction.amount} ${transaction.currency || "LKR"}
**Service:** ${transaction.service || "Not specified"}
**Payment Method:** ${transaction.paymentMethod || "Not specified"}
**Status:** ${transaction.status || "unknown"}
**Transaction Date:** ${transactionDate}
**Created At:** ${transaction.createdAt}
✅ Saved to Firebase Realtime Database.
✅ Saved to Google Sheets.`
          );
        } catch (error) {
          console.error(
            "Transaction error:",
            error
          );

          return message.reply(
            `❌ Transaction failed: ${error.message}`
          );
        }
      }

      /* ======================================================
         !inv
         CREATE INVOICE
      ====================================================== */

      if (
        content === "!inv" ||
        content.startsWith(
          "!inv "
        )
      ) {
        const explanation =
          content
            .slice(4)
            .trim();

        if (!explanation) {
          return message.reply(
            "❌ Please explain the invoice after `!inv`."
          );
        }

        try {
          await message.channel.send(
            "🤖 Aura AI is preparing the invoice draft..."
          );

          const extracted =
            await extractInvoiceData(
              explanation
            );

          extracted.purchaseDate =
            resolveDate(
              explanation,
              extracted.purchaseDate
            );

          const pendingId =
            makeId();

          pendingInvoices.set(
            pendingId,
            {
              ...extracted,

              originalExplanation:
                explanation,

              requestedBy:
                message.author.id,

              createdAt:
                Date.now()
            }
          );

          const button =
            new ButtonBuilder()
              .setCustomId(
                `create_invoice:${pendingId}`
              )
              .setLabel(
                "Create Invoice"
              )
              .setStyle(
                ButtonStyle.Primary
              );

          const row =
            new ActionRowBuilder()
              .addComponents(
                button
              );

          return message.reply({
            content:
              `# 📄 Invoice Draft

**Description:** ${extracted.description || "Not specified"}
**Quantity:** ${extracted.quantity || 1}
**Unit Price:** ${extracted.currency || "LKR"} ${extracted.unitPrice ?? 0}
**Discount:** ${extracted.currency || "LKR"} ${extracted.discount ?? 0}
**Tax:** ${extracted.currency || "LKR"} ${extracted.tax ?? 0}
**Status:** ${extracted.status || "Pending"}
**Purchase Date:** ${extracted.purchaseDate}

Click the button below to add client information and create the final invoice.`,

            components: [
              row
            ]
          });
        } catch (error) {
          console.error(
            "Invoice draft error:",
            error
          );

          return message.reply(
            `❌ Invoice draft failed: ${error.message}`
          );
        }
      }

      /* ======================================================
         !ap
         SEND INVOICE
      ====================================================== */

      if (
        content === "!ap" ||
        content.startsWith(
          "!ap "
        )
      ) {
        const parts =
          content.split(
            /\s+/
          );

        if (
          parts.length < 3
        ) {
          return message.reply(
            "❌ Usage: `!ap @user AURA-2026-000001` or `!ap email@example.com AURA-2026-000001`"
          );
        }

        const target =
          parts[1];

        const invoiceNumber =
          parts[2].toUpperCase();

        const invoice =
          await getInvoice(
            invoiceNumber
          );

        if (!invoice) {
          return message.reply(
            "❌ Invoice not found."
          );
        }

        const pdfPath =
          invoice.pdfPath ||
          `./output/${invoiceNumber}.pdf`;

        try {
          /* Discord user */

          if (
            message.mentions.users.size
          ) {
            const user =
              message.mentions.users.first();

            await user.send({
              content:
                `# Aura Cloud Hosting Invoice

Invoice Number: **${invoiceNumber}**

Please find your invoice attached.`,

              files: [
                new AttachmentBuilder(
                  pdfPath
                )
              ]
            });

            return message.reply(
              `✅ Invoice sent to ${user.tag}.`
            );
          }

          /* Email */

          if (
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
              target
            )
          ) {
            await sendInvoiceEmail(
              target,
              invoiceNumber,
              pdfPath
            );

            return message.reply(
              `✅ Invoice emailed to ${target}.`
            );
          }

          return message.reply(
            "❌ Please mention a Discord user or provide a valid email address."
          );
        } catch (error) {
          console.error(
            "Invoice sending error:",
            error
          );

          return message.reply(
            `❌ Could not send invoice: ${error.message}`
          );
        }
      }

      /* ======================================================
         !msg — SEND DISCORD MESSAGE

         THIS VERSION SUPPORTS:

         !msg @user hello

         !msg @user hello     bro

         !msg @user hello
         bro

         !msg @user @someone
         ⚠️ **Warning**

         !msg USER_ID hello

         !msg !msg @user hello

         Everything after the target user is preserved.
      ====================================================== */

      if (
        /^!msg(?:[\s\t]+|$)/i.test(
          rawContent
        )
      ) {
        /*
         * Remove the command itself.
         *
         * We use the original message instead of
         * content.trim() so formatting is not destroyed.
         */

        let msgContent =
          rawContent.replace(
            /^!msg\b/i,
            ""
          );

        /*
         * Allow accidental/repeated !msg commands.
         *
         * Example:

         * !msg !msg @user hello
         *
         * becomes:

         * @user hello
         */

        while (
          /^\s*!msg\b/i.test(
            msgContent
          )
        ) {
          msgContent =
            msgContent.replace(
              /^\s*!msg\b/i,
              ""
            );
        }

        /*
         * Find the FIRST valid Discord mention or
         * numeric Discord user ID.
         *
         * Supported:
         *
         * <@123456789012345678>
         * <@!123456789012345678>
         * 123456789012345678
         */

        const targetMatch =
          msgContent.match(
            /^\s*(<@!?(\d{17,20})>|(\d{17,20}))([\s\S]*)$/i
          );

        if (
          !targetMatch
        ) {
          return message.reply(
            "❌ Usage: `!msg @user <message>` or `!msg USER_ID <message>`"
          );
        }

        /*
         * Discord ID from the target.
         */

        const targetId =
          targetMatch[2] ||
          targetMatch[3];

        /*
         * Everything after the target is kept.

         * IMPORTANT:
         *
         * We DO NOT:
         *
         * - split()
         * - join()
         * - trim()
         * - collapse spaces
         * - remove new lines
         *
         * This preserves the actual message.
         */

        let text =
          targetMatch[4];

        /*
         * The first whitespace character is only
         * the separator between the user and message.
         *
         * Remove that separator only.
         *
         * If the user intentionally puts multiple
         * spaces after the mention, the remaining
         * spaces are preserved.
         */

        if (
          text.startsWith(" ") ||
          text.startsWith("\t") ||
          text.startsWith("\r") ||
          text.startsWith("\n")
        ) {
          text =
            text.slice(1);
        }

        /*
         * Check that a message actually exists.
         *
         * Do NOT use text.trim() here because we want
         * to preserve the original message.
         */

        if (
          text.length === 0
        ) {
          return message.reply(
            "❌ Please provide a message to send."
          );
        }

        try {
          /*
           * Fetch the Discord user.
           */

          const user =
            await client.users.fetch(
              targetId
            );

          /*
           * Send EXACTLY what was written after
           * the target user.
           *
           * Discord Markdown, mentions, emojis,
           * line breaks, multiple spaces and
           * special characters are preserved.
           */

          await user.send({
            content: text
          });

          return message.reply(
            `✅ Message sent to **${user.tag}**.`
          );
        } catch (error) {
          console.error(
            "Discord message error:",
            error
          );

          return message.reply(
            `❌ Could not send the message: ${error.message}`
          );
        }
      }

      /* ======================================================
         !email
         SEND EMAIL
      ====================================================== */

      if (
        content === "!email" ||
        content.startsWith(
          "!email "
        )
      ) {
        const match =
          content.match(
            /^!email\s+(\S+)\s+([\s\S]+)$/i
          );

        if (!match) {
          return message.reply(
            "❌ Usage: `!email email@example.com <message>`"
          );
        }

        const emailAddress =
          match[1].trim();

        const emailMessage =
          match[2].trim();

        if (
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
            emailAddress
          )
        ) {
          return message.reply(
            "❌ Please provide a valid email address."
          );
        }

        try {
          await sendMessageEmail(
            emailAddress,
            emailMessage
          );

          return message.reply(
            `✅ Email sent to **${emailAddress}**.`
          );
        } catch (error) {
          console.error(
            "Email send error:",
            error
          );

          return message.reply(
            `❌ Could not send the email: ${error.message}`
          );
        }
      }

      /* ======================================================
         !tell
         AI / CUSTOMER / COMPANY ANALYSIS
      ====================================================== */

      if (
        content === "!tell" ||
        content.startsWith(
          "!tell "
        )
      ) {
        const question =
          content
            .slice(5)
            .trim();

        if (!question) {
          return message.reply(
            "❌ Please ask a question after `!tell`."
          );
        }

        try {
          /* ==================================================
             DIRECT INVOICE LOOKUP
          ================================================== */

          const orderMatch =
            question.match(
              /AURA-\d{4}-\d{6}/i
            );

          if (
            orderMatch
          ) {
            const invoiceNumber =
              orderMatch[0]
                .toUpperCase();

            const sheetMatches =
              await searchSheetInvoices(
                invoiceNumber
              );

            const invoice =
              sheetMatches.find(
                item =>
                  String(
                    item.invoiceNumber ||
                    ""
                  ).toUpperCase() ===
                  invoiceNumber
              );

            if (!invoice) {
              return message.reply(
                `❌ Order ${invoiceNumber} was not found.`
              );
            }

            try {
              const answer =
                await askAI(
                  `The company owner asked:

"${question}"

Here is the VERIFIED invoice record:

${JSON.stringify(
  invoice,
  null,
  2
)}

Answer using ONLY this invoice.

Include relevant:

- Customer information
- Service
- Price
- Payment status
- Dates
- Invoice total

Do not invent anything.`,

                  "You are the private AI manager for Aura Cloud Hosting. Only use verified invoice data."
                );

              return cleanAndReply(
                message,
                answer
              );
            } catch {
              return message.reply(
                [
                  `# 📄 Invoice ${invoiceNumber}`,
                  "",
                  `**Customer:** ${
                    invoice.customer?.name ||
                    invoice.clientName ||
                    "Not specified"
                  }`,
                  `**Description:** ${
                    invoice.description ||
                    "Not specified"
                  }`,
                  `**Quantity:** ${
                    invoice.quantity ??
                    1
                  }`,
                  `**Unit Price:** ${
                    invoice.unitPrice ??
                    0
                  } ${
                    invoice.currency ||
                    "LKR"
                  }`,
                  `**Total:** ${
                    invoice.total ??
                    0
                  } ${
                    invoice.currency ||
                    "LKR"
                  }`,
                  `**Status:** ${
                    invoice.status ||
                    "Unknown"
                  }`,
                  `**Purchase Date:** ${
                    invoice.purchaseDate ||
                    "Not specified"
                  }`,
                  `**Expiry Date:** ${
                    invoice.expiryDate ||
                    "Not specified"
                  }`
                ].join("\n")
              );
            }
          }

          /* ==================================================
             CUSTOMER LOOKUP
          ================================================== */

          const customers =
            await findCustomersInQuestion(
              question
            );

          if (
            customers.length >
            0
          ) {
            for (
              const customer of
              customers
            ) {
              const analysis =
                createCustomerAnalysis(
                  customer
                );

              const localAnswer =
                localCustomerAnswer(
                  analysis,
                  question
                );

              const lowerQuestion =
                question.toLowerCase();

              const isFactQuestion =
                lowerQuestion.includes(
                  "how many"
                ) ||
                lowerQuestion.includes(
                  "quantity"
                ) ||
                lowerQuestion.includes(
                  "unpaid"
                ) ||
                lowerQuestion.includes(
                  "non-paid"
                ) ||
                lowerQuestion.includes(
                  "non paid"
                ) ||
                lowerQuestion.includes(
                  "worth"
                ) ||
                lowerQuestion.includes(
                  "owe"
                ) ||
                lowerQuestion.includes(
                  "outstanding"
                );

              if (
                isFactQuestion
              ) {
                return message.reply(
                  localAnswer
                );
              }

              try {
                const answer =
                  await askAI(
                    `The company owner asked:

"${question}"

IMPORTANT:

This is a CUSTOMER-SPECIFIC question.

Customer:

${analysis.customerName}

Use ONLY the verified invoices below.

Do not use the company's overall financial totals.

Do not use other customers.

Do not invent servers, prices, payments, or services.

VERIFIED CUSTOMER DATA:

${JSON.stringify(
  analysis,
  null,
  2
)}

Answer the owner's question accurately.

If the question asks about Minecraft servers:

- Count only invoices whose description/service actually contains Minecraft.
- Do not count unrelated products as Minecraft servers.
- For unpaid servers, count only Minecraft invoices whose status is Unpaid or Pending.
- Use the invoice total/unit price from the actual record.
- Mention the invoice number when useful.

Clearly distinguish invoice value from market value.`,

                    "You are Aura Cloud Hosting's private customer-accounting AI. You MUST use only the supplied customer's verified records. Never invent information."
                  );

                return cleanAndReply(
                  message,
                  answer
                );
              } catch (
                aiError
              ) {
                console.error(
                  "Customer AI analysis unavailable:",
                  aiError.message
                );

                return message.reply(
                  localAnswer
                );
              }
            }
          }

          /* ==================================================
             COMPANY ANALYSIS
          ================================================== */

          const summary =
            await companySummary();

          try {
            const answer =
              await askAI(
                `The company owner asked:

"${question}"

Here is VERIFIED Aura Cloud accounting data:

${JSON.stringify(
  summary,
  null,
  2
)}

Analyze the company.

You can discuss:

- Revenue
- Expenses
- Profit
- Number of invoices
- Recent transactions
- Financial trends
- Business recommendations

Clearly separate verified facts from recommendations.

Never invent financial numbers.`,

                "You are the private AI business manager for Aura Cloud Hosting. Use only verified accounting data."
              );

            return cleanAndReply(
              message,
              answer
            );
          } catch (
            aiError
          ) {
            console.error(
              "AI company analysis unavailable:",
              aiError.message
            );

            const income =
              Number(
                summary.recordedIncome ||
                0
              );

            const expenses =
              Number(
                summary.recordedExpenses ||
                0
              );

            const profit =
              Number(
                summary.recordedProfit ||
                income -
                  expenses
              );

            const paidInvoiceRevenue =
              Number(
                summary.paidInvoiceRevenue ||
                0
              );

            let performance =
              "There is not enough financial data to determine the company's overall performance.";

            if (
              income > 0 &&
              expenses > 0 &&
              profit > 0
            ) {
              performance =
                "The company is currently operating at a profit based on the recorded paid transactions.";
            }

            if (
              income > 0 &&
              expenses > 0 &&
              profit < 0
            ) {
              performance =
                "The company is currently operating at a loss based on the recorded paid transactions.";
            }

            if (
              income > 0 &&
              expenses === 0
            ) {
              performance =
                "Income has been recorded, but no paid expenses are currently included in the transaction summary.";
            }

            if (
              income === 0 &&
              expenses > 0
            ) {
              performance =
                "Expenses have been recorded, but no paid income is currently included in the transaction summary.";
            }

            const currency =
              summary.transactions
                ?.find(
                  transaction =>
                    transaction.currency
                )
                ?.currency ||

              summary.invoices
                ?.find(
                  invoice =>
                    invoice.currency
                )
                ?.currency ||

              "LKR";

            const recommendation =
              profit < 0
                ? "Review recurring infrastructure costs and identify services that are not generating enough revenue."

                : profit > 0
                  ? "Continue monitoring expenses and focus on services producing sustainable recurring revenue."

                  : "Continue recording all income and expenses so the company's financial performance can be tracked accurately.";

            return message.reply(
              `# 📊 Aura Cloud Company Analysis

**Overall Performance:** ${performance}

## 💰 Financial Summary

**Recorded Income:** ${income.toLocaleString()} ${currency}

**Recorded Expenses:** ${expenses.toLocaleString()} ${currency}

**Recorded Profit:** ${profit.toLocaleString()} ${currency}

**Paid Invoice Revenue:** ${paidInvoiceRevenue.toLocaleString()} ${currency}

## 📁 Company Records

**Total Invoices:** ${summary.totalInvoices}

**Total Transactions:** ${summary.totalTransactions}

## 💡 Recommendation

${recommendation}

⚠️ AI analysis is temporarily unavailable. The figures above are calculated directly from the verified accounting records.`
            );
          }
        } catch (
          error
        ) {
          console.error(
            "Company analysis error:",
            error
          );

          return message.reply(
            "❌ Unable to retrieve the requested accounting data. Please check Firebase configuration."
          );
        }
      }
    } catch (
      error
    ) {
      console.error(
        "Message command error:",
        error
      );
    }
  }
);

/* ============================================================
   BUTTONS AND MODALS
============================================================ */

client.on(
  Events.InteractionCreate,
  async interaction => {
    try {
      /* ========================================================
         INVOICE BUTTON
      ======================================================== */

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          "create_invoice:"
        )
      ) {
        const pendingId =
          interaction.customId
            .split(":")[1];

        const draft =
          pendingInvoices.get(
            pendingId
          );

        if (!draft) {
          return interaction.reply({
            content:
              "❌ This invoice draft expired. Please create a new invoice with `!inv`.",
            ephemeral:
              true
          });
        }

        if (
          interaction.user.id !==
          draft.requestedBy
        ) {
          return interaction.reply({
            content:
              "❌ Only the user who created this invoice can complete it.",
            ephemeral:
              true
          });
        }

        const modal =
          new ModalBuilder()
            .setCustomId(
              `invoice_modal:${pendingId}`
            )
            .setTitle(
              "Aura Cloud Client Details"
            );

        const nameInput =
          new TextInputBuilder()
            .setCustomId(
              "name"
            )
            .setLabel(
              "Client Name"
            )
            .setStyle(
              TextInputStyle.Short
            )
            .setRequired(
              true
            );

        const emailInput =
          new TextInputBuilder()
            .setCustomId(
              "email"
            )
            .setLabel(
              "Client Email (Optional)"
            )
            .setStyle(
              TextInputStyle.Short
            )
            .setRequired(
              false
            );

        const phoneInput =
          new TextInputBuilder()
            .setCustomId(
              "phone"
            )
            .setLabel(
              "Client Phone (Optional)"
            )
            .setStyle(
              TextInputStyle.Short
            )
            .setRequired(
              false
            );

        const companyInput =
          new TextInputBuilder()
            .setCustomId(
              "company"
            )
            .setLabel(
              "Company (Optional)"
            )
            .setStyle(
              TextInputStyle.Short
            )
            .setRequired(
              false
            );

        const addressInput =
          new TextInputBuilder()
            .setCustomId(
              "address"
            )
            .setLabel(
              "Address (Optional)"
            )
            .setStyle(
              TextInputStyle.Paragraph
            )
            .setRequired(
              false
            );

        modal.addComponents(
          new ActionRowBuilder()
            .addComponents(
              nameInput
            ),

          new ActionRowBuilder()
            .addComponents(
              emailInput
            ),

          new ActionRowBuilder()
            .addComponents(
              phoneInput
            ),

          new ActionRowBuilder()
            .addComponents(
              companyInput
            ),

          new ActionRowBuilder()
            .addComponents(
              addressInput
            )
        );

        return interaction.showModal(
          modal
        );
      }

      /* ========================================================
         INVOICE MODAL SUBMIT
      ======================================================== */

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(
          "invoice_modal:"
        )
      ) {
        await interaction.deferReply();

        const pendingId =
          interaction.customId
            .split(":")[1];

        const draft =
          pendingInvoices.get(
            pendingId
          );

        if (!draft) {
          return interaction.editReply(
            "❌ This invoice draft expired."
          );
        }

        if (
          interaction.user.id !==
          draft.requestedBy
        ) {
          return interaction.editReply(
            "❌ You are not authorized to complete this invoice."
          );
        }

        try {
          const customer = {
            name:
              interaction.fields
                .getTextInputValue(
                  "name"
                )
                .trim(),

            email:
              interaction.fields
                .getTextInputValue(
                  "email"
                )
                .trim(),

            phone:
              interaction.fields
                .getTextInputValue(
                  "phone"
                )
                .trim(),

            company:
              interaction.fields
                .getTextInputValue(
                  "company"
                )
                .trim(),

            address:
              interaction.fields
                .getTextInputValue(
                  "address"
                )
                .trim()
          };

          const invoiceNumber =
            await getNextInvoiceNumber();

          const totals =
            calculateInvoice(
              draft
            );

          const purchaseDate =
            safeDate(
              draft.purchaseDate,
              draft.originalExplanation
            );

          const invoice = {
            ...draft,

            invoiceNumber,

            customer,

            ...totals,

            purchaseDate,

            expiryDate:
              draft.expiryDate ||
              "",

            createdAt:
              new Date().toISOString(),

            createdBy: {
              userId:
                interaction.user.id,

              username:
                interaction.user.tag
            }
          };

          const {
            xlsxPath,
            pdfPath
          } =
            await createInvoiceFiles(
              invoice
            );

          invoice.xlsxPath =
            xlsxPath;

          invoice.pdfPath =
            pdfPath;

          await Promise.all([
            saveInvoice(
              invoiceNumber,
              invoice
            ),

            addInvoice(
              invoice
            )
          ]);

          pendingInvoices.delete(
            pendingId
          );

          return interaction.editReply({
            content:
              `# 📄 Invoice Created Successfully

**Invoice Number:** \`${invoiceNumber}\`

**Client:** ${customer.name}

**Total:** ${invoice.currency || "LKR"} ${Number(invoice.total || 0).toLocaleString()}

**Status:** ${invoice.status}

**Purchase Date:** ${invoice.purchaseDate}

**Expiry Date:** ${invoice.expiryDate || "Not specified"}

✅ Saved to Firebase Realtime Database.

✅ Saved to Google Sheets.`,

            files: [
              new AttachmentBuilder(
                pdfPath,
                {
                  name:
                    `${invoiceNumber}.pdf`
                }
              )
            ]
          });
        } catch (
          error
        ) {
          console.error(
            "Invoice creation error:",
            error
          );

          return interaction.editReply(
            `❌ Failed to create invoice: ${error.message}`
          );
        }
      }
    } catch (
      error
    ) {
      console.error(
        "Interaction error:",
        error
      );

      if (
        interaction.deferred ||
        interaction.replied
      ) {
        try {
          await interaction.editReply(
            "❌ An unexpected error occurred."
          );
        } catch {}
      } else {
        try {
          await interaction.reply({
            content:
              "❌ An unexpected error occurred.",
            ephemeral:
              true
          });
        } catch {}
      }
    }
  }
);

/* ============================================================
   START BOT
============================================================ */

if (
  !process.env.DISCORD_TOKEN
) {
  console.error(
    "❌ DISCORD_TOKEN is missing from .env"
  );

  process.exit(1);
}

client.login(
  process.env.DISCORD_TOKEN
);

