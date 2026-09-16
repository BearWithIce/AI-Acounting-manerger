import crypto from "crypto";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder
} from "discord.js";

import {
  getNextOrderNumber,
  getNextInvoiceNumber,
  saveOrder,
  getOrder,
  updateOrder,
  saveDiscountCode,
  getDiscountCode,
  saveInvoice
} from "./firebase.js";

import {
  calculateInvoice,
  createInvoiceFiles
} from "./invoice.js";

import {
  addInvoice,
  addTransaction,
  addOrder
} from "./googleSheets.js";

import {
  sendOrderOtp,
  sendInvoiceEmail
} from "./email.js";

/* ============================================================
   CONFIGURATION
============================================================ */

const OTP_TTL_MS = 10 * 60 * 1000;
const ORDER_TTL_MS = 24 * 60 * 60 * 1000;

const ADMIN_VERIFICATION_CHANNEL_ID =
  "1483657607712346202";

const ADMIN_VERIFICATION_ROLE_IDS = [
  "1455830550333100062",
  "1455830590195761250",
  "1455830592515215545"
];

/* ============================================================
   PAYMENT METHODS
============================================================ */

const PAYMENTS = {
  paypal: {
    label: "PayPal",
    emoji: "💙",
    detail: () =>
      process.env.PAYPAL_EMAIL ||
      "PAYPAL_EMAIL_NOT_SET"
  },

  bank: {
    label: "Bank Transfer",
    emoji: "🏦",
    detail: () =>
      "BOC KOLLUPITIYA\n" +
      "R.P.D.DHARMANI\n" +
      "84408902"
  },

  card: {
    label: "Credit / Debit Card",
    emoji: "💳",
    detail: () =>
      process.env.CARD_PAYMENT_TEXT ||
      "Credit/debit card payment will be set up later."
  },

  ezcash: {
    label: "eZ Cash",
    emoji: "📱",
    detail: () =>
      "0768080448"
  }
};

/* ============================================================
   ADMIN MESSAGE PERMISSION
============================================================ */

function isAdminMessage(message) {
  return Boolean(
    message.guildId === process.env.ALLOWED_GUILD_ID &&
    message.channelId === process.env.ALLOWED_CHANNEL_ID &&
    message.member?.roles?.cache?.has(
      process.env.ALLOWED_ROLE_ID
    )
  );
}

/* ============================================================
   ADMIN VERIFICATION PERMISSION
============================================================ */

function isVerificationAdmin(interaction) {
  if (!interaction.guildId) {
    return false;
  }

  if (
    process.env.ALLOWED_GUILD_ID &&
    interaction.guildId !== process.env.ALLOWED_GUILD_ID
  ) {
    return false;
  }

  return ADMIN_VERIFICATION_ROLE_IDS.some(
    roleId =>
      interaction.member?.roles?.cache?.has(roleId)
  );
}

/* ============================================================
   HELPERS
============================================================ */

function normalizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase();
}

function money(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? Math.max(0, number)
    : 0;
}

function currencyOf(order) {
  return String(order?.currency || "LKR").toUpperCase() === "USD"
    ? "USD"
    : "LKR";
}

function formatMoney(value, currency = "LKR") {
  return `${currency} ${money(value).toLocaleString()}`;
}

function generateOtp() {
  return String(
    crypto.randomInt(100000, 1000000)
  );
}

function hashOtp(code) {
  return crypto
    .createHash("sha256")
    .update(String(code))
    .digest("hex");
}

/* ============================================================
   RENEWAL ID
============================================================ */

function generateRenewalId(orderNumber) {
  return `RENEW-${orderNumber}-${Date.now()}`;
}

/* ============================================================
   SERVER NAME
============================================================ */

function getServerName(order) {
  return (
    order.serverName ||
    order.server ||
    order.serviceName ||
    `Hosting Server - ${order.orderNumber}`
  );
}

/* ============================================================
   DISCOUNT EXPIRY PARSER
============================================================ */

function parseDuration(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();

  if (!raw) {
    return null;
  }

  const dateMatch = raw.match(
    /^(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ t](\d{1,2}):(\d{2}))?$/
  );

  if (dateMatch) {
    const [
      ,
      year,
      month,
      day,
      hour = "23",
      minute = "59"
    ] = dateMatch;

    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      59,
      999
    );

    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return date.toISOString();
  }

  const relative = raw.match(
    /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/
  );

  if (!relative) {
    return null;
  }

  const amount = Number(relative[1]);
  const unit = relative[2];

  let multiplier = 60 * 1000;

  if (
    /^(h|hr|hrs|hour|hours)$/.test(unit)
  ) {
    multiplier = 60 * 60 * 1000;
  } else if (
    /^(d|day|days)$/.test(unit)
  ) {
    multiplier = 24 * 60 * 60 * 1000;
  } else if (
    /^(w|week|weeks)$/.test(unit)
  ) {
    multiplier = 7 * 24 * 60 * 60 * 1000;
  }

  return new Date(
    Date.now() + amount * multiplier
  ).toISOString();
}

/* ============================================================
   DISCOUNT VALUE PARSER
============================================================ */

function parseDiscountValue(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    return null;
  }

  const percent = raw.match(
    /^(\d+(?:\.\d+)?)\s*%$/
  );

  if (percent) {
    const amount = Number(percent[1]);

    if (amount <= 0 || amount > 100) {
      return null;
    }

    return {
      type: "percent",
      value: amount
    };
  }

  const fixed = raw.match(
    /^(\d+(?:\.\d+)?)\s*(?:lkr|rs)?$/i
  );

  if (fixed) {
    const amount = Number(fixed[1]);

    if (amount <= 0) {
      return null;
    }

    return {
      type: "fixed",
      value: amount
    };
  }

  return null;
}

/* ============================================================
   APPLY DISCOUNT
============================================================ */

async function applyDiscount(order, code) {
  if (!code) {
    return {
      valid: false,
      discount: 0,
      message: "No discount code used."
    };
  }

  const coupon = await getDiscountCode(
    normalizeCode(code)
  );

  if (!coupon) {
    return {
      valid: false,
      discount: 0,
      message: "Discount code not found."
    };
  }

  if (
    coupon.expiresAt &&
    new Date(coupon.expiresAt).getTime() <= Date.now()
  ) {
    return {
      valid: false,
      discount: 0,
      message: "Discount code has expired."
    };
  }

  if (coupon.active === false) {
    return {
      valid: false,
      discount: 0,
      message: "Discount code is disabled."
    };
  }

  const subtotal = money(order.price);

  let discount = 0;

  if (coupon.type === "percent") {
    discount =
      subtotal *
      (Number(coupon.value) / 100);
  } else {
    discount = Number(coupon.value || 0);
  }

  discount = Math.min(
    subtotal,
    Math.max(0, discount)
  );

  const currency = currencyOf(order);

  return {
    valid: true,
    discount,
    coupon,
    message:
      coupon.type === "percent"
        ? `${coupon.code}: ${coupon.value}% off`
        : `${coupon.code}: ${currency} ${Number(
            coupon.value
          ).toLocaleString()} off`
  };
}

/* ============================================================
   SPECIFICATION DISPLAY
============================================================ */

function specsText(order) {
  const currency = currencyOf(order);

  return [
    `RAM: **${order.ram || "Not specified"}**`,
    `Disk: **${order.disk || "Not specified"}**`,
    `CPU: **${order.cpu || "Not specified"}**`,
    `Location: **${order.location || "Not specified"}**`,
    `Price: **${formatMoney(
      order.price,
      currency
    )}**`
  ].join("\n");
}

/* ============================================================
   CUSTOMER CONTINUE BUTTON
============================================================ */

function buildBuyButton(orderId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `buy_start:${orderId}`
        )
        .setLabel("Continue order")
        .setStyle(ButtonStyle.Primary)
    );
}

/* ============================================================
   BUY OTP BUTTON
============================================================ */

function buildOtpButton(orderId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `buy_otp:${orderId}`
        )
        .setLabel("Enter OTP")
        .setStyle(ButtonStyle.Success)
    );
}

/* ============================================================
   RENEWAL OTP BUTTON
============================================================ */

function buildRenewOtpButton(renewalId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `renew_otp:${renewalId}`
        )
        .setLabel("Enter OTP")
        .setStyle(ButtonStyle.Success)
    );
}

/* ============================================================
   BUY PAYMENT BUTTONS
============================================================ */

function buildPaymentButtons(orderId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `buy_pay:${orderId}:paypal`
        )
        .setLabel(PAYMENTS.paypal.label)
        .setEmoji(PAYMENTS.paypal.emoji)
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId(
          `buy_pay:${orderId}:bank`
        )
        .setLabel(PAYMENTS.bank.label)
        .setEmoji(PAYMENTS.bank.emoji)
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId(
          `buy_pay:${orderId}:card`
        )
        .setLabel(PAYMENTS.card.label)
        .setEmoji(PAYMENTS.card.emoji)
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId(
          `buy_pay:${orderId}:ezcash`
        )
        .setLabel(PAYMENTS.ezcash.label)
        .setEmoji(PAYMENTS.ezcash.emoji)
        .setStyle(ButtonStyle.Success)
    );
}

/* ============================================================
   RENEWAL PAYMENT BUTTONS
============================================================ */

function buildRenewPaymentButtons(renewalId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `renew_pay:${renewalId}:paypal`
        )
        .setLabel(PAYMENTS.paypal.label)
        .setEmoji(PAYMENTS.paypal.emoji)
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId(
          `renew_pay:${renewalId}:bank`
        )
        .setLabel(PAYMENTS.bank.label)
        .setEmoji(PAYMENTS.bank.emoji)
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId(
          `renew_pay:${renewalId}:card`
        )
        .setLabel(PAYMENTS.card.label)
        .setEmoji(PAYMENTS.card.emoji)
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId(
          `renew_pay:${renewalId}:ezcash`
        )
        .setLabel(PAYMENTS.ezcash.label)
        .setEmoji(PAYMENTS.ezcash.emoji)
        .setStyle(ButtonStyle.Success)
    );
}

/* ============================================================
   PAY BILL BUTTON
============================================================ */

function buildRenewPayBillButton(renewalId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `renew_paybill:${renewalId}`
        )
        .setLabel("Pay Bill")
        .setEmoji("💳")
        .setStyle(ButtonStyle.Success)
    );
}

/* ============================================================
   ADMIN VERIFY BUTTON
============================================================ */

function buildAdminVerifyButton(orderId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `order_verify:${orderId}`
        )
        .setLabel("Verify payment")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success)
    );
}

/* ============================================================
   ADMIN REJECT BUTTON
============================================================ */

function buildAdminRejectButton(orderId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `order_reject:${orderId}`
        )
        .setLabel("Reject / needs checking")
        .setEmoji("⚠️")
        .setStyle(ButtonStyle.Danger)
    );
}

/* ============================================================
   ADMIN RENEWAL VERIFY BUTTON
============================================================ */

function buildRenewAdminVerifyButton(renewalId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `renew_verify:${renewalId}`
        )
        .setLabel("Verify renewal payment")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success)
    );
}

/* ============================================================
   ADMIN RENEWAL REJECT BUTTON
============================================================ */

function buildRenewAdminRejectButton(renewalId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `renew_reject:${renewalId}`
        )
        .setLabel("Reject / needs checking")
        .setEmoji("⚠️")
        .setStyle(ButtonStyle.Danger)
    );
}

/* ============================================================
   SEND ADMIN VERIFICATION ALERT - BUY
============================================================ */

async function sendAdminVerificationAlert(
  interaction,
  order
) {
  const channel =
    await interaction.client.channels.fetch(
      ADMIN_VERIFICATION_CHANNEL_ID
    );

  if (
    !channel ||
    !channel.isTextBased()
  ) {
    throw new Error(
      `Admin verification channel ${ADMIN_VERIFICATION_CHANNEL_ID} could not be opened.`
    );
  }

  const roleMentions =
    ADMIN_VERIFICATION_ROLE_IDS
      .map(id => `<@&${id}>`)
      .join(" ");

  const currency = currencyOf(order);

  const total = money(
    order.total ??
      (
        money(order.price) -
        money(order.discount)
      )
  );

  const embed =
    new EmbedBuilder()
      .setTitle(
        "Payment verification required"
      )
      .setDescription(
        "A customer has completed the order process and selected a payment method.\n\n" +
        "Check the payment before clicking **Verify payment**."
      )
      .addFields(
        {
          name: "Order number",
          value: `\`${order.orderNumber}\``,
          inline: true
        },
        {
          name: "Discord customer",
          value: `<@${order.discordUserId}>`,
          inline: true
        },
        {
          name: "Discord username",
          value:
            order.discordUsername ||
            "Unknown",
          inline: true
        },
        {
          name: "Customer name",
          value:
            order.customer?.name ||
            "Not provided",
          inline: true
        },
        {
          name: "Email",
          value:
            order.customer?.email ||
            "Missing",
          inline: true
        },
        {
          name: "Currency",
          value: currency,
          inline: true
        },
        {
          name: "Payment method",
          value:
            order.paymentMethod ||
            "Not selected",
          inline: true
        },
        {
          name: "Amount to verify",
          value:
            formatMoney(total, currency),
          inline: true
        },
        {
          name: "Specifications",
          value: specsText(order),
          inline: false
        },
        {
          name: "Discount",
          value:
            order.discountCode
              ? `${order.discountCode} — ${formatMoney(
                  order.discount,
                  currency
                )} off`
              : "None",
          inline: true
        },
        {
          name: "How to verify",
          value:
            "1. Check the payment.\n" +
            "2. Confirm the amount and order number match.\n" +
            "3. Click **Verify payment** if correct.\n" +
            "4. The bot will automatically generate the invoice and save the accounting records.\n" +
            "5. Click **Reject / needs checking** if payment is not correct.",
          inline: false
        }
      )
      .setTimestamp();

  const sent =
    await channel.send({
      content: roleMentions,
      embeds: [embed],
      components: [
        buildAdminVerifyButton(
          order.orderNumber
        ),
        buildAdminRejectButton(
          order.orderNumber
        )
      ]
    });

  await updateOrder(
    order.orderNumber,
    {
      adminVerificationChannelId:
        ADMIN_VERIFICATION_CHANNEL_ID,

      adminVerificationMessageId:
        sent.id,

      adminAlertSentAt:
        new Date().toISOString(),

      status:
        "awaiting_admin_verification"
    }
  );

  return sent;
}

/* ============================================================
   SEND ADMIN VERIFICATION ALERT - RENEWAL
============================================================ */

async function sendRenewalVerificationAlert(
  client,
  renewal
) {
  const channel =
    await client.channels.fetch(
      ADMIN_VERIFICATION_CHANNEL_ID
    );

  if (
    !channel ||
    !channel.isTextBased()
  ) {
    throw new Error(
      "Renewal verification channel could not be opened."
    );
  }

  const roleMentions =
    ADMIN_VERIFICATION_ROLE_IDS
      .map(id => `<@&${id}>`)
      .join(" ");

  const currency =
    currencyOf(renewal);

  const embed =
    new EmbedBuilder()
      .setTitle(
        "🔄 Renewal payment verification required"
      )
      .setDescription(
        "A customer has requested a server renewal and selected a payment method.\n\n" +
        "Check the payment before verifying the renewal."
      )
      .addFields(
        {
          name: "Renewal ID",
          value: `\`${renewal.renewalId}\``,
          inline: false
        },
        {
          name: "Previous order",
          value: `\`${renewal.orderNumber}\``,
          inline: true
        },
        {
          name: "Customer",
          value:
            `<@${renewal.discordUserId}>`,
          inline: true
        },
        {
          name: "Username",
          value:
            renewal.discordUsername ||
            "Unknown",
          inline: true
        },
        {
          name: "Email",
          value:
            renewal.customer?.email ||
            "Missing",
          inline: true
        },
        {
          name: "Currency",
          value: currency,
          inline: true
        },
        {
          name: "Amount",
          value:
            formatMoney(
              renewal.total,
              currency
            ),
          inline: true
        },
        {
          name: "Payment method",
          value:
            renewal.paymentMethod ||
            "Unknown",
          inline: true
        },
        {
          name: "Server",
          value:
            getServerName(renewal),
          inline: true
        },
        {
          name: "Specifications",
          value:
            specsText(renewal),
          inline: false
        },
        {
          name: "Current expiry",
          value:
            renewal.previousExpiryDate ||
            "Not recorded",
          inline: true
        },
        {
          name: "Verification",
          value:
            "Check the payment manually. No receipt upload is required. If the payment is correct, click **Verify renewal payment**.",
          inline: false
        }
      )
      .setTimestamp();

  const sent =
    await channel.send({
      content: roleMentions,
      embeds: [embed],
      components: [
        buildRenewAdminVerifyButton(
          renewal.renewalId
        ),
        buildRenewAdminRejectButton(
          renewal.renewalId
        )
      ]
    });

  await saveOrder(
    renewal.renewalId,
    {
      ...renewal,
      adminVerificationChannelId:
        ADMIN_VERIFICATION_CHANNEL_ID,
      adminVerificationMessageId:
        sent.id,
      adminAlertSentAt:
        new Date().toISOString(),
      status:
        "awaiting_admin_verification"
    }
  );

  return sent;
}

/* ============================================================
   FIND RENEWAL
============================================================ */

async function getRenewal(renewalId) {
  return getOrder(renewalId);
}

/* ============================================================
   RENEWAL EXPIRY CALCULATOR
============================================================ */

function calculateRenewalExpiry(order, now = new Date()) {
  let baseDate = now;

  if (order.expiryDate) {
    const previous =
      new Date(order.expiryDate);

    if (
      !Number.isNaN(previous.getTime()) &&
      previous.getTime() > now.getTime()
    ) {
      baseDate = previous;
    }
  }

  const billing =
    String(
      order.billingCycle ||
      order.duration ||
      "30 days"
    )
      .trim()
      .toLowerCase();

  const match =
    billing.match(
      /^(\d+(?:\.\d+)?)\s*(day|days|d|week|weeks|w|month|months|year|years|y)$/
    );

  if (!match) {
    const next =
      new Date(baseDate);

    next.setDate(
      next.getDate() + 30
    );

    return next.toISOString();
  }

  const amount =
    Number(match[1]);

  const unit =
    match[2];

  const next =
    new Date(baseDate);

  if (
    /^(day|days|d)$/.test(unit)
  ) {
    next.setDate(
      next.getDate() + amount
    );
  } else if (
    /^(week|weeks|w)$/.test(unit)
  ) {
    next.setDate(
      next.getDate() +
      amount * 7
    );
  } else if (
    /^(month|months)$/.test(unit)
  ) {
    next.setMonth(
      next.getMonth() + amount
    );
  } else if (
    /^(year|years|y)$/.test(unit)
  ) {
    next.setFullYear(
      next.getFullYear() + amount
    );
  }

  return next.toISOString();
}

/* ============================================================
   FINALIZE / VERIFY ORDER
============================================================ */

async function finalizeOrder(
  orderNumber,
  adminUser,
  sourceInteraction = null,
  client = null
) {
  const current =
    await getOrder(orderNumber);

  if (!current) {
    throw new Error(
      "Order not found."
    );
  }

  if (
    current.status ===
    "confirmed"
  ) {
    return {
      alreadyConfirmed: true,
      order: current,
      invoiceNumber:
        current.invoiceNumber
    };
  }

  if (!current.customer?.email) {
    throw new Error(
      "Customer email is missing."
    );
  }

  if (
    current.status !==
      "payment_selected" &&
    current.status !==
      "awaiting_admin_verification"
  ) {
    throw new Error(
      "This order has not completed email verification and payment selection yet."
    );
  }

  const invoiceNumber =
    current.invoiceNumber ||
    await getNextInvoiceNumber();

  const totals =
    calculateInvoice({
      quantity: 1,
      unitPrice: money(
        current.price
      ),
      discount: money(
        current.discount
      ),
      tax: 0
    });

  const now =
    new Date().toISOString();

  const invoice = {
    ...current,

    invoiceNumber,

    description:
      `Aura Cloud Hosting - ${current.location} hosting` +
      (
        current.discountCode
          ? ` (Coupon: ${current.discountCode})`
          : ""
      ),

    quantity: 1,

    billingCycle:
      current.billingCycle ||
      "",

    unitPrice:
      money(current.price),

    discount:
      money(current.discount),

    tax: 0,

    total:
      totals.total,

    lineTotal:
      totals.lineTotal,

    subtotal:
      totals.subtotal,

    currency:
      currencyOf(current),

    status:
      "Paid",

    purchaseDate:
      now.slice(0, 10),

    expiryDate:
      current.expiryDate ||
      "",

    createdAt:
      current.createdAt ||
      now,

    confirmedAt:
      now,

    confirmedBy: {
      userId:
        adminUser.id,
      username:
        adminUser.tag ||
        adminUser.username ||
        "Unknown"
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

  await saveOrder(
    orderNumber,
    {
      ...current,
      ...invoice,

      status:
        "confirmed",

      paymentVerified:
        true,

      paymentVerifiedAt:
        now,

      paymentVerifiedBy: {
        userId:
          adminUser.id,
        username:
          adminUser.tag ||
          adminUser.username ||
          "Unknown"
      }
    }
  );

  await saveInvoice(
    invoiceNumber,
    invoice
  );

  await addOrder({
    ...invoice,
    orderNumber
  });

  await addInvoice(
    invoice
  );

  await addTransaction({
    id:
      orderNumber,

    type:
      "income",

    amount:
      invoice.total,

    currency:
      invoice.currency,

    description:
      `Payment for ${orderNumber} / ${invoice.invoiceNumber}`,

    service:
      `Hosting - ${current.location}`,

    paymentMethod:
      current.paymentMethod ||
      "Unknown",

    status:
      "paid",

    date:
      invoice.purchaseDate,

    createdAt:
      now
  });

  let emailSent =
    true;

  try {
    await sendInvoiceEmail(
      invoice.customer.email,
      invoice.invoiceNumber,
      pdfPath
    );
  } catch (error) {
    emailSent =
      false;

    console.error(
      "Invoice email failed:",
      error
    );
  }

  /* ==========================================================
     DM INVOICE TO CUSTOMER
  ========================================================== */

  let discordDmSent =
    false;

  try {
    const discordClient =
      client ||
      sourceInteraction?.client;

    if (discordClient) {
      const user =
        await discordClient.users.fetch(
          invoice.discordUserId
        );

      await user.send({
        content:
          `✅ **Payment verified!**\n\n` +
          `Your Aura Cloud hosting order **${invoice.orderNumber}** has been confirmed.\n` +
          `Invoice: **${invoice.invoiceNumber}**\n` +
          `Amount: **${formatMoney(
            invoice.total,
            invoice.currency
          )}**\n\n` +
          `Your invoice is attached below.`,

        files: [
          new AttachmentBuilder(
            pdfPath,
            {
              name:
                `${invoice.invoiceNumber}.pdf`
            }
          )
        ]
      });

      discordDmSent =
        true;
    }
  } catch (error) {
    console.error(
      "Customer invoice DM failed:",
      error
    );
  }

  /* ==========================================================
     UPDATE ADMIN MESSAGE
  ========================================================== */

  try {
    if (
      current.adminVerificationChannelId &&
      current.adminVerificationMessageId
    ) {
      const discordClient =
        client ||
        sourceInteraction?.client;

      if (discordClient) {
        const channel =
          await discordClient.channels.fetch(
            current.adminVerificationChannelId
          );

        if (
          channel?.isTextBased()
        ) {
          const alertMessage =
            await channel.messages.fetch(
              current.adminVerificationMessageId
            );

          await alertMessage.edit({
            content:
              `✅ Payment verified by <@${adminUser.id}>`,

            embeds: [
              new EmbedBuilder()
                .setTitle(
                  "Order verified successfully"
                )
                .setDescription(
                  "Payment was verified and the order was completed."
                )
                .addFields(
                  {
                    name: "Order",
                    value:
                      `\`${orderNumber}\``,
                    inline: true
                  },
                  {
                    name: "Invoice",
                    value:
                      `\`${invoice.invoiceNumber}\``,
                    inline: true
                  },
                  {
                    name: "Customer",
                    value:
                      `<@${invoice.discordUserId}>`,
                    inline: true
                  },
                  {
                    name: "Amount",
                    value:
                      formatMoney(
                        invoice.total,
                        invoice.currency
                      ),
                    inline: true
                  },
                  {
                    name: "Payment",
                    value:
                      invoice.paymentMethod ||
                      "Unknown",
                    inline: true
                  },
                  {
                    name: "Invoice email",
                    value:
                      emailSent
                        ? "Sent"
                        : "Failed",
                    inline: true
                  },
                  {
                    name: "Invoice Discord DM",
                    value:
                      discordDmSent
                        ? "Sent"
                        : "Failed",
                    inline: true
                  }
                )
                .setTimestamp()
            ],

            components: []
          });
        }
      }
    }
  } catch (error) {
    console.error(
      "Could not update admin verification message:",
      error
    );
  }

  return {
    alreadyConfirmed: false,
    order: invoice,
    invoiceNumber,
    xlsxPath,
    pdfPath,
    emailSent,
    discordDmSent
  };
}

/* ============================================================
   FINALIZE / VERIFY RENEWAL
============================================================ */

async function finalizeRenewal(
  renewalId,
  adminUser,
  client
) {
  const renewal =
    await getRenewal(
      renewalId
    );

  if (!renewal) {
    throw new Error(
      "Renewal not found."
    );
  }

  if (
    renewal.status ===
      "confirmed" ||
    renewal.paymentVerified ===
      true
  ) {
    return {
      alreadyConfirmed: true,
      renewal,
      invoiceNumber:
        renewal.invoiceNumber
    };
  }

  if (
    renewal.status !==
      "payment_selected" &&
    renewal.status !==
      "awaiting_admin_verification"
  ) {
    throw new Error(
      "This renewal is not waiting for payment verification."
    );
  }

  if (!renewal.customer?.email) {
    throw new Error(
      "Customer email is missing from the original order."
    );
  }

  const invoiceNumber =
    renewal.invoiceNumber ||
    await getNextInvoiceNumber();

  const currency =
    currencyOf(renewal);

  const totals =
    calculateInvoice({
      quantity: 1,

      unitPrice:
        money(renewal.price),

      discount: 0,

      tax: 0
    });

  const now =
    new Date().toISOString();

  const newExpiryDate =
    calculateRenewalExpiry(
      renewal.sourceOrder ||
      renewal
    );

  const invoice = {
    ...renewal,

    invoiceNumber,

    orderNumber:
      renewal.orderNumber,

    renewalId,

    renewalOfOrderNumber:
      renewal.orderNumber,

    description:
      `Aura Cloud Hosting - Renewal for ${getServerName(
        renewal
      )}`,

    quantity: 1,

    billingCycle:
      renewal.billingCycle ||
      "30 days",

    unitPrice:
      money(renewal.price),

    discount: 0,

    tax: 0,

    subtotal:
      totals.subtotal,

    lineTotal:
      totals.lineTotal,

    total:
      totals.total,

    currency,

    status:
      "Paid",

    purchaseDate:
      now.slice(0, 10),

    previousExpiryDate:
      renewal.previousExpiryDate ||
      "",

    expiryDate:
      newExpiryDate,

    createdAt:
      renewal.createdAt ||
      now,

    confirmedAt:
      now,

    confirmedBy: {
      userId:
        adminUser.id,

      username:
        adminUser.tag ||
        adminUser.username ||
        "Unknown"
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

  /* ==========================================================
     SAVE RENEWAL
  ========================================================== */

  await saveOrder(
    renewalId,
    {
      ...renewal,
      ...invoice,

      status:
        "confirmed",

      paymentVerified:
        true,

      paymentVerifiedAt:
        now,

      paymentVerifiedBy: {
        userId:
          adminUser.id,

        username:
          adminUser.tag ||
          adminUser.username ||
          "Unknown"
      }
    }
  );

  /* ==========================================================
     SAVE INVOICE
  ========================================================== */

  await saveInvoice(
    invoiceNumber,
    invoice
  );

  /* ==========================================================
     UPDATE ORIGINAL ACCOUNT / ORDER AS PAID
  ========================================================== */

  const originalOrder =
    await getOrder(
      renewal.orderNumber
    );

  if (originalOrder) {
    await updateOrder(
      renewal.orderNumber,
      {
        accountStatus:
          "paid",

        paymentStatus:
          "paid",

        lastPaymentStatus:
          "paid",

        lastPaymentDate:
          now,

        lastRenewalId:
          renewalId,

        lastRenewalInvoiceNumber:
          invoiceNumber,

        lastRenewalAmount:
          invoice.total,

        lastRenewalCurrency:
          currency,

        renewedAt:
          now,

        expiryDate:
          newExpiryDate,

        currentExpiryDate:
          newExpiryDate,

        updatedAt:
          now
      }
    );
  }

  /* ==========================================================
     GOOGLE SHEETS - RENEWAL ORDER
  ========================================================== */

  await addOrder({
    ...invoice,

    orderNumber:
      renewal.orderNumber,

    renewalId,

    orderType:
      "renewal"
  });

  /* ==========================================================
     GOOGLE SHEETS - INVOICE
  ========================================================== */

  await addInvoice(
    invoice
  );

  /* ==========================================================
     GOOGLE SHEETS - TRANSACTION
  ========================================================== */

  await addTransaction({
    id:
      renewalId,

    type:
      "income",

    amount:
      invoice.total,

    currency,

    description:
      `Renewal payment for ${renewal.orderNumber} / ${invoice.invoiceNumber}`,

    service:
      `Hosting Renewal - ${renewal.location}`,

    paymentMethod:
      renewal.paymentMethod ||
      "Unknown",

    status:
      "paid",

    date:
      invoice.purchaseDate,

    createdAt:
      now
  });

  /* ==========================================================
     EMAIL INVOICE
  ========================================================== */

  let emailSent =
    true;

  try {
    await sendInvoiceEmail(
      invoice.customer.email,
      invoice.invoiceNumber,
      pdfPath
    );
  } catch (error) {
    emailSent =
      false;

    console.error(
      "Renewal invoice email failed:",
      error
    );
  }

  /* ==========================================================
     DM INVOICE
  ========================================================== */

  let discordDmSent =
    false;

  try {
    const user =
      await client.users.fetch(
        renewal.discordUserId
      );

    await user.send({
      content:
        `✅ **Renewal payment verified!**\n\n` +
        `Your Aura Cloud server has been renewed.\n\n` +
        `Previous order: **${renewal.orderNumber}**\n` +
        `Renewal ID: **${renewalId}**\n` +
        `Invoice: **${invoiceNumber}**\n` +
        `Amount: **${formatMoney(
          invoice.total,
          currency
        )}**\n` +
        `New expiry: **${new Date(
          newExpiryDate
        ).toLocaleString()}**\n\n` +
        `Your invoice is attached below.`,

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

    discordDmSent =
      true;
  } catch (error) {
    console.error(
      "Renewal invoice DM failed:",
      error
    );
  }

  /* ==========================================================
     UPDATE ADMIN MESSAGE
  ========================================================== */

  try {
    if (
      renewal.adminVerificationChannelId &&
      renewal.adminVerificationMessageId
    ) {
      const channel =
        await client.channels.fetch(
          renewal.adminVerificationChannelId
        );

      if (
        channel?.isTextBased()
      ) {
        const message =
          await channel.messages.fetch(
            renewal.adminVerificationMessageId
          );

        await message.edit({
          content:
            `✅ Renewal payment verified by <@${adminUser.id}>`,

          embeds: [
            new EmbedBuilder()
              .setTitle(
                "Renewal verified successfully"
              )
              .setDescription(
                "The customer's renewal payment has been verified."
              )
              .addFields(
                {
                  name: "Previous order",
                  value:
                    `\`${renewal.orderNumber}\``,
                  inline: true
                },
                {
                  name: "Renewal",
                  value:
                    `\`${renewalId}\``,
                  inline: true
                },
                {
                  name: "Invoice",
                  value:
                    `\`${invoiceNumber}\``,
                  inline: true
                },
                {
                  name: "Customer",
                  value:
                    `<@${renewal.discordUserId}>`,
                  inline: true
                },
                {
                  name: "Amount",
                  value:
                    formatMoney(
                      invoice.total,
                      currency
                    ),
                  inline: true
                },
                {
                  name: "New expiry",
                  value:
                    new Date(
                      newExpiryDate
                    ).toLocaleString(),
                  inline: true
                },
                {
                  name: "Email invoice",
                  value:
                    emailSent
                      ? "Sent"
                      : "Failed",
                  inline: true
                },
                {
                  name: "Discord invoice",
                  value:
                    discordDmSent
                      ? "Sent"
                      : "Failed",
                  inline: true
                }
              )
              .setTimestamp()
          ],

          components: []
        });
      }
    }
  } catch (error) {
    console.error(
      "Could not update renewal admin message:",
      error
    );
  }

  return {
    alreadyConfirmed: false,
    renewal: invoice,
    invoiceNumber,
    xlsxPath,
    pdfPath,
    emailSent,
    discordDmSent,
    newExpiryDate
  };
}

/* ============================================================
   REGISTER /BUY AND /RENEW
============================================================ */

export async function registerBuyCommand(
  client
) {
  if (
    !client.user ||
    !process.env.ALLOWED_GUILD_ID
  ) {
    return;
  }

  const buyCommand =
    new SlashCommandBuilder()
      .setName("buy")
      .setDescription(
        "Create a hosting order for a Discord user"
      )

      .addUserOption(option =>
        option
          .setName("user")
          .setDescription(
            "Customer to order for"
          )
          .setRequired(true)
      )

      .addStringOption(option =>
        option
          .setName("ram")
          .setDescription(
            "RAM specification, e.g. 4GB"
          )
          .setRequired(true)
      )

      .addStringOption(option =>
        option
          .setName("disk")
          .setDescription(
            "Disk specification, e.g. 50GB NVMe"
          )
          .setRequired(true)
      )

      .addStringOption(option =>
        option
          .setName("cpu")
          .setDescription(
            "CPU specification, e.g. 2 vCore"
          )
          .setRequired(true)
      )

      .addStringOption(option =>
        option
          .setName("location")
          .setDescription(
            "Server location"
          )
          .setRequired(true)
      )

      .addNumberOption(option =>
        option
          .setName("price")
          .setDescription(
            "Price in the selected currency"
          )
          .setMinValue(0)
          .setRequired(true)
      )

      .addStringOption(option =>
        option
          .setName("currency")
          .setDescription(
            "Currency for this order"
          )
          .setRequired(true)
          .addChoices(
            {
              name: "LKR",
              value: "LKR"
            },
            {
              name: "USD",
              value: "USD"
            }
          )
      );

  const renewCommand =
    new SlashCommandBuilder()
      .setName("renew")
      .setDescription(
        "Renew your existing Aura Cloud hosting server"
      )
      .addStringOption(option =>
        option
          .setName("order")
          .setDescription(
            "Your previous order number"
          )
          .setRequired(true)
      );

  const rest =
    new REST({
      version: "10"
    }).setToken(
      process.env.DISCORD_TOKEN
    );

  await rest.put(
    Routes.applicationGuildCommands(
      client.user.id,
      process.env.ALLOWED_GUILD_ID
    ),
    {
      body: [
        buyCommand.toJSON(),
        renewCommand.toJSON()
      ]
    }
  );

  console.log(
    "✅ /buy and /renew commands registered."
  );
}

/* ============================================================
   HANDLE /RENEW COMMAND
============================================================ */

export async function handleRenewSlashCommand(
  interaction
) {
  if (
    !interaction.isChatInputCommand() ||
    interaction.commandName !== "renew"
  ) {
    return false;
  }

  if (
    interaction.guildId !==
    process.env.ALLOWED_GUILD_ID
  ) {
    await interaction.reply({
      content:
        "❌ This command is not available in this server.",
      ephemeral: true
    });

    return true;
  }

  const orderNumber =
    interaction.options.getString(
      "order",
      true
    ).trim();

  const order =
    await getOrder(
      orderNumber
    );

  if (!order) {
    await interaction.reply({
      content:
        "❌ I could not find that order number.",
      ephemeral: true
    });

    return true;
  }

  /* ==========================================================
     OWNERSHIP CHECK
  ========================================================== */

  if (
    order.discordUserId !==
    interaction.user.id
  ) {
    await interaction.reply({
      content:
        "❌ You can only renew an order belonging to your own Discord account.",
      ephemeral: true
    });

    return true;
  }

  /* ==========================================================
     MUST BE CONFIRMED
  ========================================================== */

  if (
    order.status !== "confirmed" &&
    order.paymentVerified !== true
  ) {
    await interaction.reply({
      content:
        "❌ This order has not been completed yet, so it cannot be renewed.",
      ephemeral: true
    });

    return true;
  }

  if (
    !order.customer?.email
  ) {
    await interaction.reply({
      content:
        "❌ This order does not have a customer email saved. Please contact Aura Cloud support.",
      ephemeral: true
    });

    return true;
  }

  const renewalId =
    generateRenewalId(
      orderNumber
    );

  const otp =
    generateOtp();

  const otpHash =
    hashOtp(otp);

  const otpExpiresAt =
    new Date(
      Date.now() +
      OTP_TTL_MS
    ).toISOString();

  const renewal = {
    renewalId,

    orderNumber,

    discordUserId:
      order.discordUserId,

    discordUsername:
      order.discordUsername ||
      interaction.user.tag,

    customer:
      order.customer,

    serverName:
      getServerName(order),

    ram:
      order.ram,

    disk:
      order.disk,

    cpu:
      order.cpu,

    location:
      order.location,

    price:
      money(
        order.renewalPrice ??
        order.price
      ),

    currency:
      currencyOf(order),

    discount:
      0,

    total:
      money(
        order.renewalPrice ??
        order.price
      ),

    billingCycle:
      order.billingCycle ||
      "30 days",

    previousExpiryDate:
      order.expiryDate ||
      order.currentExpiryDate ||
      "",

    sourceOrder:
      order,

    otpHash,

    otpExpiresAt,

    otpAttempts:
      0,

    status:
      "otp_pending",

    createdAt:
      new Date().toISOString()
  };

  await saveOrder(
    renewalId,
    renewal
  );

  /* ==========================================================
     SEND OTP
  ========================================================== */

  try {
    await sendOrderOtp(
      order.customer.email,
      renewalId,
      otp
    );
  } catch (error) {
    console.error(
      "Renewal OTP email failed:",
      error
    );

    await updateOrder(
      renewalId,
      {
        status:
          "cancelled",
        otpHash:
          null,
        otpExpiresAt:
          null
      }
    );

    await interaction.reply({
      content:
        "❌ I could not send the renewal verification email. Please try again later.",
      ephemeral: true
    });

    return true;
  }

  /* ==========================================================
     DM CUSTOMER
  ========================================================== */

  try {
    const user =
      interaction.user;

    const embed =
      new EmbedBuilder()
        .setTitle(
          "🔄 Aura Cloud Server Renewal"
        )
        .setDescription(
          "Your renewal request has been created.\n\n" +
          `A 6-digit verification code was sent to **${order.customer.email}**.\n\n` +
          "Open the button below and enter the OTP."
        )
        .addFields(
          {
            name: "Previous order",
            value:
              `\`${orderNumber}\``,
            inline: true
          },
          {
            name: "Renewal ID",
            value:
              `\`${renewalId}\``,
            inline: true
          },
          {
            name: "Server",
            value:
              getServerName(order),
            inline: false
          },
          {
            name: "Specifications",
            value:
              specsText(renewal),
            inline: false
          },
          {
            name: "Current expiry",
            value:
              order.expiryDate ||
              order.currentExpiryDate ||
              "Not recorded",
            inline: true
          },
          {
            name: "Renewal amount",
            value:
              formatMoney(
                renewal.total,
                renewal.currency
              ),
            inline: true
          },
          {
            name: "OTP expires",
            value:
              "10 minutes",
            inline: true
          }
        )
        .setTimestamp();

    await user.send({
      embeds: [embed],
      components: [
        buildRenewOtpButton(
          renewalId
        )
      ]
    });

    await interaction.reply({
      content:
        "✅ Renewal started. I sent a verification button to your Discord DMs.",
      ephemeral: true
    });
  } catch (error) {
    console.error(
      "Renewal DM failed:",
      error
    );

    await interaction.reply({
      content:
        "❌ I could not DM you. Please enable Discord DMs from server members and run `/renew` again.",
      ephemeral: true
    });
  }

  return true;
}

/* ============================================================
   BUY + RENEW BUTTONS / MODALS
============================================================ */

export async function handleBuyInteraction(
  interaction
) {
  if (
    !interaction.isButton() &&
    !interaction.isModalSubmit()
  ) {
    return false;
  }

  const customId =
    interaction.customId || "";

  const supported =
    customId.startsWith("buy_") ||
    customId.startsWith("order_verify:") ||
    customId.startsWith("order_reject:") ||
    customId.startsWith("renew_");

  if (!supported) {
    return false;
  }

  /* ==========================================================
     RENEWAL ADMIN VERIFY / REJECT
  ========================================================== */

  if (
    customId.startsWith(
      "renew_verify:"
    ) ||
    customId.startsWith(
      "renew_reject:"
    )
  ) {
    if (
      !interaction.isButton()
    ) {
      return true;
    }

    if (
      !isVerificationAdmin(
        interaction
      )
    ) {
      await interaction.reply({
        content:
          "❌ You do not have permission to verify renewals.",
        ephemeral: true
      });

      return true;
    }

    const renewalId =
      customId.split(":")[1];

    const renewal =
      await getRenewal(
        renewalId
      );

    if (!renewal) {
      await interaction.reply({
        content:
          "❌ Renewal not found.",
        ephemeral: true
      });

      return true;
    }

    if (
      customId.startsWith(
        "renew_reject:"
      )
    ) {
      await updateOrder(
        renewalId,
        {
          status:
            "payment_needs_checking",

          paymentVerificationRejectedAt:
            new Date().toISOString(),

          paymentVerificationRejectedBy: {
            userId:
              interaction.user.id,

            username:
              interaction.user.tag ||
              interaction.user.username
          }
        }
      );

      await interaction.update({
        content:
          `⚠️ Renewal **${renewalId}** was marked as needing checking by <@${interaction.user.id}>.`,

        embeds: [],

        components: []
      });

      return true;
    }

    await interaction.deferUpdate();

    try {
      const result =
        await finalizeRenewal(
          renewalId,
          interaction.user,
          interaction.client
        );

      if (
        result.alreadyConfirmed
      ) {
        await interaction.followUp({
          content:
            `ℹ️ This renewal was already confirmed with invoice **${result.invoiceNumber}**.`,

          ephemeral: true
        });

        return true;
      }

      await interaction.followUp({
        content:
          `✅ **Renewal verified successfully**\n\n` +
          `Renewal: **${renewalId}**\n` +
          `Previous order: **${renewal.orderNumber}**\n` +
          `Invoice: **${result.invoiceNumber}**\n` +
          `Customer: <@${renewal.discordUserId}>\n` +
          `Total: **${formatMoney(
            result.renewal.total,
            result.renewal.currency
          )}**\n` +
          `New expiry: **${new Date(
            result.newExpiryDate
          ).toLocaleString()}**\n\n` +
          `Firebase and Google Sheets were updated.`,

        files: [
          new AttachmentBuilder(
            result.pdfPath,
            {
              name:
                `${result.invoiceNumber}.pdf`
            }
          )
        ],

        ephemeral: true
      });
    } catch (error) {
      console.error(
        "Renewal verification failed:",
        error
      );

      await interaction.followUp({
        content:
          `❌ Could not verify renewal **${renewalId}**: ${error.message}`,

        ephemeral: true
      });
    }

    return true;
  }

  /* ==========================================================
     RENEWAL CUSTOMER FLOW
  ========================================================== */

  if (
    customId.startsWith("renew_")
  ) {
    const parts =
      customId.split(":");

    const action =
      parts[0];

    const renewalId =
      parts[1];

    const renewal =
      await getRenewal(
        renewalId
      );

    if (!renewal) {
      await interaction.reply({
        content:
          "❌ This renewal no longer exists.",
        ephemeral: true
      });

      return true;
    }

    if (
      renewal.discordUserId !==
      interaction.user.id
    ) {
      await interaction.reply({
        content:
          "❌ Only the customer who owns this renewal can continue it.",
        ephemeral: true
      });

      return true;
    }

    /* ========================================================
       RENEW OTP BUTTON
    ======================================================== */

    if (
      action ===
      "renew_otp"
    ) {
      if (
        !interaction.isButton()
      ) {
        return true;
      }

      if (
        renewal.status !==
        "otp_pending"
      ) {
        await interaction.reply({
          content:
            "❌ This renewal is not waiting for an OTP.",
          ephemeral: true
        });

        return true;
      }

      const modal =
        new ModalBuilder()
          .setCustomId(
            `renew_verify:${renewalId}`
          )
          .setTitle(
            "Verify Renewal"
          );

      const otp =
        new TextInputBuilder()
          .setCustomId("otp")
          .setLabel(
            "6-digit OTP"
          )
          .setStyle(
            TextInputStyle.Short
          )
          .setMinLength(6)
          .setMaxLength(6)
          .setRequired(true)
          .setPlaceholder(
            "123456"
          );

      modal.addComponents(
        new ActionRowBuilder()
          .addComponents(otp)
      );

      return interaction.showModal(
        modal
      );
    }

    /* ========================================================
       RENEW OTP VERIFICATION
    ======================================================== */

    if (
      action ===
      "renew_verify"
    ) {
      if (
        !interaction.isModalSubmit()
      ) {
        return true;
      }

      await interaction.deferReply({
        ephemeral: true
      });

      if (
        renewal.status !==
        "otp_pending"
      ) {
        await interaction.editReply(
          "❌ This renewal is not waiting for an OTP."
        );

        return true;
      }

      if (
        !renewal.otpExpiresAt ||
        Date.now() >
          new Date(
            renewal.otpExpiresAt
          ).getTime()
      ) {
        await interaction.editReply(
          "❌ Your OTP has expired. Start `/renew` again."
        );

        return true;
      }

      const entered =
        interaction.fields
          .getTextInputValue(
            "otp"
          )
          .trim();

      if (
        hashOtp(entered) !==
        renewal.otpHash
      ) {
        const attempts =
          Number(
            renewal.otpAttempts ||
            0
          ) + 1;

        await updateOrder(
          renewalId,
          {
            otpAttempts:
              attempts
          }
        );

        await interaction.editReply(
          "❌ Incorrect OTP."
        );

        return true;
      }

      const updated = {
        ...renewal,

        status:
          "awaiting_payment",

        otpHash:
          null,

        otpExpiresAt:
          null,

        otpAttempts:
          0,

        verifiedAt:
          new Date().toISOString()
      };

      await saveOrder(
        renewalId,
        updated
      );

      const embed =
        new EmbedBuilder()
          .setTitle(
            "✅ Email verified"
          )
          .setDescription(
            "Your renewal email has been verified.\n\n" +
            "Review the server details below and click **Pay Bill** to continue."
          )
          .addFields(
            {
              name: "Previous order",
              value:
                `\`${renewal.orderNumber}\``,
              inline: true
            },
            {
              name: "Renewal ID",
              value:
                `\`${renewalId}\``,
              inline: true
            },
            {
              name: "Server",
              value:
                getServerName(
                  renewal
                ),
              inline: false
            },
            {
              name: "Specifications",
              value:
                specsText(
                  renewal
                ),
              inline: false
            },
            {
              name: "Current expiry",
              value:
                renewal.previousExpiryDate ||
                "Not recorded",
              inline: true
            },
            {
              name: "Renewal amount",
              value:
                formatMoney(
                  renewal.total,
                  renewal.currency
                ),
              inline: true
            },
            {
              name: "Billing cycle",
              value:
                renewal.billingCycle ||
                "30 days",
              inline: true
            }
          )
          .setTimestamp();

      await interaction.editReply({
        embeds: [embed],
        components: [
          buildRenewPayBillButton(
            renewalId
          )
        ]
      });

      return true;
    }

    /* ========================================================
       PAY BILL
    ======================================================== */

    if (
      action ===
      "renew_paybill"
    ) {
      if (
        !interaction.isButton()
      ) {
        return true;
      }

      if (
        renewal.status !==
        "awaiting_payment"
      ) {
        await interaction.reply({
          content:
            "❌ This renewal is not ready for payment.",
          ephemeral: true
        });

        return true;
      }

      const embed =
        new EmbedBuilder()
          .setTitle(
            "💳 Choose a payment method"
          )
          .setDescription(
            `Your renewal amount is **${formatMoney(
              renewal.total,
              renewal.currency
            )}**.\n\n` +
            "Select one of the payment methods below."
          )
          .addFields(
            {
              name: "Renewal",
              value:
                `\`${renewalId}\``,
              inline: true
            },
            {
              name: "Previous order",
              value:
                `\`${renewal.orderNumber}\``,
              inline: true
            },
            {
              name: "Amount",
              value:
                formatMoney(
                  renewal.total,
                  renewal.currency
                ),
              inline: true
            }
          );

      await interaction.update({
        embeds: [embed],
        components: [
          buildRenewPaymentButtons(
            renewalId
          )
        ]
      });

      return true;
    }

    /* ========================================================
       RENEW PAYMENT SELECTION
    ======================================================== */

    if (
      action ===
      "renew_pay"
    ) {
      if (
        !interaction.isButton()
      ) {
        return true;
      }

      const method =
        parts[2];

      const payment =
        PAYMENTS[method];

      if (!payment) {
        await interaction.reply({
          content:
            "❌ Unknown payment method.",
          ephemeral: true
        });

        return true;
      }

      if (
        renewal.status !==
          "awaiting_payment" &&
        renewal.status !==
          "payment_selected"
      ) {
        await interaction.reply({
          content:
            "❌ This renewal is not ready for payment selection.",
          ephemeral: true
        });

        return true;
      }

      const total =
        money(
          renewal.total ??
          renewal.price
        );

      const updated = {
        ...renewal,

        status:
          "payment_selected",

        paymentMethod:
          payment.label,

        paymentMethodKey:
          method,

        total,

        paymentSelectedAt:
          new Date().toISOString()
      };

      await saveOrder(
        renewalId,
        updated
      );

      const currency =
        currencyOf(
          renewal
        );

      const note =
        "For payment notes, include:\n" +
        `**Discord username:** ${interaction.user.tag}\n` +
        `**Previous order:** ${renewal.orderNumber}\n` +
        `**Renewal ID:** ${renewalId}`;

      const embed =
        new EmbedBuilder()
          .setTitle(
            `${payment.emoji} ${payment.label}`
          )
          .setDescription(
            `Send **${formatMoney(
              total,
              currency
            )}** using the details below.\n\n` +
            `${payment.detail()}\n\n` +
            `${note}\n\n` +
            "After you complete the payment, the Aura Cloud admin team will check it manually. " +
            "No receipt upload is required.\n\n" +
            "Your renewal will only be completed after an admin verifies the payment."
          )
          .addFields(
            {
              name: "Renewal",
              value:
                `\`${renewalId}\``,
              inline: true
            },
            {
              name: "Previous order",
              value:
                `\`${renewal.orderNumber}\``,
              inline: true
            },
            {
              name: "Amount",
              value:
                formatMoney(
                  total,
                  currency
                ),
              inline: true
            },
            {
              name: "Status",
              value:
                "Waiting for admin payment verification",
              inline: false
            }
          );

      await interaction.update({
        embeds: [embed],
        components: []
      });

      try {
        await sendRenewalVerificationAlert(
          interaction.client,
          updated
        );
      } catch (error) {
        console.error(
          "Renewal admin alert failed:",
          error
        );
      }

      return true;
    }

    return true;
  }

  /* ==========================================================
     BUY ADMIN VERIFY / REJECT
  ========================================================== */

  if (
    customId.startsWith(
      "order_verify:"
    ) ||
    customId.startsWith(
      "order_reject:"
    )
  ) {
    if (
      !interaction.isButton()
    ) {
      return true;
    }

    if (
      !isVerificationAdmin(
        interaction
      )
    ) {
      await interaction.reply({
        content:
          "❌ You do not have permission to verify orders.",
        ephemeral: true
      });

      return true;
    }

    const orderId =
      customId.split(":")[1];

    const order =
      await getOrder(
        orderId
      );

    if (!order) {
      await interaction.reply({
        content:
          "❌ Order not found.",
        ephemeral: true
      });

      return true;
    }

    if (
      customId.startsWith(
        "order_reject:"
      )
    ) {
      await updateOrder(
        orderId,
        {
          status:
            "payment_needs_checking",

          paymentVerificationRejectedAt:
            new Date().toISOString(),

          paymentVerificationRejectedBy: {
            userId:
              interaction.user.id,

            username:
              interaction.user.tag ||
              interaction.user.username
          }
        }
      );

      await interaction.update({
        content:
          `⚠️ Payment for **${orderId}** was marked as needing checking by <@${interaction.user.id}>.`,

        embeds: [],

        components: []
      });

      return true;
    }

    await interaction.deferUpdate();

    try {
      const result =
        await finalizeOrder(
          orderId,
          interaction.user,
          interaction,
          interaction.client
        );

      if (
        result.alreadyConfirmed
      ) {
        await interaction.followUp({
          content:
            `ℹ️ This order was already confirmed with invoice **${result.invoiceNumber}**.`,

          ephemeral: true
        });

        return true;
      }

      const currency =
        currencyOf(
          result.order
        );

      await interaction.followUp({
        content:
          `✅ **Order verified successfully**\n\n` +
          `Order: **${orderId}**\n` +
          `Invoice: **${result.invoiceNumber}**\n` +
          `Customer: <@${result.order.discordUserId}>\n` +
          `Total: **${formatMoney(
            result.order.total,
            currency
          )}**\n\n` +
          `Firebase and Google Sheets were updated.\n` +
          (
            result.emailSent
              ? "The invoice was emailed to the customer."
              : "The invoice email failed."
          ) +
          (
            result.discordDmSent
              ? " The invoice was also sent by Discord DM."
              : ""
          ),

        files: [
          new AttachmentBuilder(
            result.pdfPath,
            {
              name:
                `${result.invoiceNumber}.pdf`
            }
          )
        ],

        ephemeral: true
      });
    } catch (error) {
      console.error(
        "Order verification failed:",
        error
      );

      await interaction.followUp({
        content:
          `❌ Could not verify order **${orderId}**: ${error.message}`,

        ephemeral: true
      });
    }

    return true;
  }

  /* ==========================================================
     NORMAL BUY FLOW
  ========================================================== */

  const parts =
    customId.split(":");

  const action =
    parts[0];

  const orderId =
    parts[1];

  const order =
    await getOrder(
      orderId
    );

  if (!order) {
    await interaction.reply({
      content:
        "❌ This order no longer exists or has expired.",
      ephemeral: true
    });

    return true;
  }

  if (
    order.discordUserId !==
    interaction.user.id
  ) {
    await interaction.reply({
      content:
        "❌ Only the customer selected for this order can continue it.",
      ephemeral: true
    });

    return true;
  }

  /* ==========================================================
     CONTINUE ORDER
  ========================================================== */

  if (
    action ===
    "buy_start"
  ) {
    if (
      !interaction.isButton()
    ) {
      return true;
    }

    const modal =
      new ModalBuilder()
        .setCustomId(
          `buy_details:${orderId}`
        )
        .setTitle(
          "Aura Cloud Order Details"
        );

    const email =
      new TextInputBuilder()
        .setCustomId("email")
        .setLabel(
          "Email (required)"
        )
        .setStyle(
          TextInputStyle.Short
        )
        .setRequired(true)
        .setPlaceholder(
          "you@example.com"
        );

    const firstName =
      new TextInputBuilder()
        .setCustomId(
          "first_name"
        )
        .setLabel(
          "First name (optional)"
        )
        .setStyle(
          TextInputStyle.Short
        )
        .setRequired(false);

    const lastName =
      new TextInputBuilder()
        .setCustomId(
          "last_name"
        )
        .setLabel(
          "Last name (optional)"
        )
        .setStyle(
          TextInputStyle.Short
        )
        .setRequired(false);

    const address =
      new TextInputBuilder()
        .setCustomId(
          "address"
        )
        .setLabel(
          "Address (optional)"
        )
        .setStyle(
          TextInputStyle.Paragraph
        )
        .setRequired(false);

    const discount =
      new TextInputBuilder()
        .setCustomId(
          "discount"
        )
        .setLabel(
          "Discount code (optional)"
        )
        .setStyle(
          TextInputStyle.Short
        )
        .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder()
        .addComponents(email),

      new ActionRowBuilder()
        .addComponents(firstName),

      new ActionRowBuilder()
        .addComponents(lastName),

      new ActionRowBuilder()
        .addComponents(address),

      new ActionRowBuilder()
        .addComponents(discount)
    );

    return interaction.showModal(
      modal
    );
  }

  /* ==========================================================
     CUSTOMER DETAILS
  ========================================================== */

  if (
    action ===
    "buy_details"
  ) {
    if (
      !interaction.isModalSubmit()
    ) {
      return true;
    }

    await interaction.deferReply({
      ephemeral: true
    });

    const email =
      interaction.fields
        .getTextInputValue(
          "email"
        )
        .trim();

    const firstName =
      interaction.fields
        .getTextInputValue(
          "first_name"
        )
        .trim();

    const lastName =
      interaction.fields
        .getTextInputValue(
          "last_name"
        )
        .trim();

    const address =
      interaction.fields
        .getTextInputValue(
          "address"
        )
        .trim();

    const discountCode =
      normalizeCode(
        interaction.fields
          .getTextInputValue(
            "discount"
          )
      );

    if (
      !/^\S+@\S+\.\S+$/.test(
        email
      )
    ) {
      await interaction.editReply(
        "❌ Please enter a valid email address."
      );

      return true;
    }

    const discountResult =
      await applyDiscount(
        order,
        discountCode
      );

    if (
      discountCode &&
      !discountResult.valid
    ) {
      await interaction.editReply(
        `❌ ${discountResult.message}\nPlease start the order again and use a valid code.`
      );

      return true;
    }

    const otp =
      generateOtp();

    const otpHash =
      hashOtp(otp);

    const expiresAt =
      new Date(
        Date.now() +
        OTP_TTL_MS
      ).toISOString();

    const customerName =
      [
        firstName,
        lastName
      ]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      interaction.user.username;

    const updated = {
      ...order,

      customer: {
        name:
          customerName,

        firstName,

        lastName,

        email,

        address
      },

      discountCode:
        discountCode || "",

      discount:
        discountResult.discount,

      discountText:
        discountResult.message,

      otpHash,

      otpExpiresAt:
        expiresAt,

      otpAttempts:
        0,

      status:
        "otp_pending",

      updatedAt:
        new Date().toISOString()
    };

    await saveOrder(
      orderId,
      updated
    );

    try {
      await sendOrderOtp(
        email,
        orderId,
        otp
      );
    } catch (error) {
      await updateOrder(
        orderId,
        {
          status:
            "created",

          otpHash:
            null,

          otpExpiresAt:
            null
        }
      );

      console.error(
        "Order OTP email failed:",
        error
      );

      await interaction.editReply(
        "❌ I could not send the verification email. Please check the email address and try again."
      );

      return true;
    }

    const embed =
      new EmbedBuilder()
        .setTitle(
          "Check your email"
        )
        .setDescription(
          `A verification code has been sent to **${email}**. Check your inbox and click **Enter OTP** below.`
        )
        .addFields(
          {
            name: "Order",
            value:
              `\`${order.orderNumber}\``,
            inline: true
          },
          {
            name:
              "Selected specifications",
            value:
              specsText(order),
            inline: false
          },
          {
            name: "Discount",
            value:
              discountCode
                ? discountResult.message
                : "None",
            inline: true
          },
          {
            name: "OTP expires",
            value:
              "10 minutes",
            inline: true
          }
        );

    await interaction.editReply({
      embeds: [embed],
      components: [
        buildOtpButton(
          orderId
        )
      ]
    });

    return true;
  }

  /* ==========================================================
     ENTER OTP
  ========================================================== */

  if (
    action ===
    "buy_otp"
  ) {
    if (
      !interaction.isButton()
    ) {
      return true;
    }

    if (
      order.status !==
      "otp_pending"
    ) {
      await interaction.reply({
        content:
          "❌ This order is not waiting for an OTP.",
        ephemeral: true
      });

      return true;
    }

    const modal =
      new ModalBuilder()
        .setCustomId(
          `buy_verify:${orderId}`
        )
        .setTitle(
          "Verify your email"
        );

    const otp =
      new TextInputBuilder()
        .setCustomId("otp")
        .setLabel(
          "6-digit OTP"
        )
        .setStyle(
          TextInputStyle.Short
        )
        .setMinLength(6)
        .setMaxLength(6)
        .setRequired(true)
        .setPlaceholder(
          "123456"
        );

    modal.addComponents(
      new ActionRowBuilder()
        .addComponents(otp)
    );

    return interaction.showModal(
      modal
    );
  }

  /* ==========================================================
     VERIFY OTP
  ========================================================== */

  if (
    action ===
    "buy_verify"
  ) {
    if (
      !interaction.isModalSubmit()
    ) {
      return true;
    }

    await interaction.deferReply({
      ephemeral: true
    });

    if (
      order.status !==
      "otp_pending"
    ) {
      await interaction.editReply(
        "❌ This order is not waiting for an OTP."
      );

      return true;
    }

    if (
      !order.otpExpiresAt ||
      Date.now() >
        new Date(
          order.otpExpiresAt
        ).getTime()
    ) {
      await interaction.editReply(
        "❌ Your OTP has expired. Start the order again."
      );

      return true;
    }

    const entered =
      interaction.fields
        .getTextInputValue(
          "otp"
        )
        .trim();

    if (
      hashOtp(entered) !==
      order.otpHash
    ) {
      const attempts =
        Number(
          order.otpAttempts ||
          0
        ) + 1;

      await updateOrder(
        orderId,
        {
          otpAttempts:
            attempts
        }
      );

      await interaction.editReply(
        "❌ Incorrect OTP."
      );

      return true;
    }

    const updated = {
      ...order,

      status:
        "awaiting_payment",

      otpHash:
        null,

      otpExpiresAt:
        null,

      otpAttempts:
        0,

      verifiedAt:
        new Date().toISOString()
    };

    await saveOrder(
      orderId,
      updated
    );

    const total =
      Math.max(
        0,
        money(order.price) -
        money(order.discount)
      );

    const embed =
      new EmbedBuilder()
        .setTitle(
          "Email verified"
        )
        .setDescription(
          "Select a payment method below. Your selected hosting specifications cannot be changed in this order."
        )
        .addFields(
          {
            name: "Order",
            value:
              `\`${order.orderNumber}\``,
            inline: true
          },
          {
            name: "Customer",
            value:
              order.customer?.name ||
              "Unknown",
            inline: true
          },
          {
            name:
              "Selected specifications",
            value:
              specsText(order),
            inline: false
          },
          {
            name: "Discount",
            value:
              order.discountCode
                ? order.discountText
                : "None",
            inline: true
          },
          {
            name: "Total",
            value:
              formatMoney(
                total,
                currencyOf(order)
              ),
            inline: true
          }
        );

    await interaction.editReply({
      embeds: [embed],
      components: [
        buildPaymentButtons(
          orderId
        )
      ]
    });

    return true;
  }

  /* ==========================================================
     PAYMENT SELECTION
  ========================================================== */

  if (
    action ===
    "buy_pay"
  ) {
    if (
      !interaction.isButton()
    ) {
      return true;
    }

    const method =
      parts[2];

    const payment =
      PAYMENTS[method];

    if (!payment) {
      await interaction.reply({
        content:
          "❌ Unknown payment method.",
        ephemeral: true
      });

      return true;
    }

    if (
      order.status !==
        "awaiting_payment" &&
      order.status !==
        "payment_selected"
    ) {
      await interaction.reply({
        content:
          "❌ This order is not ready for payment selection.",
        ephemeral: true
      });

      return true;
    }

    const total =
      Math.max(
        0,
        money(order.price) -
        money(order.discount)
      );

    const updated = {
      ...order,

      status:
        "payment_selected",

      paymentMethod:
        payment.label,

      paymentMethodKey:
        method,

      total,

      paymentSelectedAt:
        new Date().toISOString()
    };

    await saveOrder(
      orderId,
      updated
    );

    const currency =
      currencyOf(order);

    const note =
      "For payment notes, include:\n" +
      `**Discord username:** ${interaction.user.tag}\n` +
      `**Order number:** ${order.orderNumber}`;

    const embed =
      new EmbedBuilder()
        .setTitle(
          `${payment.emoji} ${payment.label}`
        )
        .setDescription(
          `Send **${formatMoney(
            total,
            currency
          )}** using the details below.\n\n` +
          `${payment.detail()}\n\n` +
          `${note}\n\n` +
          "After you complete the payment, the Aura Cloud admin team will check it. " +
          "No receipt upload is required.\n\n" +
          "Your order will only be completed after an admin verifies the payment."
        )
        .addFields(
          {
            name: "Order",
            value:
              `\`${order.orderNumber}\``,
            inline: true
          },
          {
            name: "Amount",
            value:
              formatMoney(
                total,
                currency
              ),
            inline: true
          },
          {
            name: "Status",
            value:
              "Waiting for admin payment verification",
            inline: true
          }
        );

    await interaction.update({
      embeds: [embed],
      components: []
    });

    try {
      await sendAdminVerificationAlert(
        interaction,
        updated
      );
    } catch (error) {
      console.error(
        "Admin verification alert failed:",
        error
      );
    }

    return true;
  }

  return true;
}

/* ============================================================
   /BUY COMMAND
============================================================ */

export async function handleBuySlashCommand(
  interaction
) {
  if (
    !interaction.isChatInputCommand() ||
    interaction.commandName !== "buy"
  ) {
    return false;
  }

  if (
    interaction.guildId !==
    process.env.ALLOWED_GUILD_ID
  ) {
    await interaction.reply({
      content:
        "❌ This command is not available in this server.",
      ephemeral: true
    });

    return true;
  }

  if (
    !interaction.member?.roles?.cache?.has(
      process.env.ALLOWED_ROLE_ID
    )
  ) {
    await interaction.reply({
      content:
        "❌ You are not authorized to create orders.",
      ephemeral: true
    });

    return true;
  }

  const user =
    interaction.options.getUser(
      "user",
      true
    );

  const ram =
    interaction.options.getString(
      "ram",
      true
    );

  const disk =
    interaction.options.getString(
      "disk",
      true
    );

  const cpu =
    interaction.options.getString(
      "cpu",
      true
    );

  const location =
    interaction.options.getString(
      "location",
      true
    );

  const price =
    money(
      interaction.options.getNumber(
        "price",
        true
      )
    );

  const currency =
    interaction.options
      .getString(
        "currency",
        true
      )
      .toUpperCase();

  if (
    currency !== "LKR" &&
    currency !== "USD"
  ) {
    await interaction.reply({
      content:
        "❌ Currency must be LKR or USD.",
      ephemeral: true
    });

    return true;
  }

  const orderNumber =
    await getNextOrderNumber();

  const order = {
    orderNumber,

    discordUserId:
      user.id,

    discordUsername:
      user.tag,

    ram,

    disk,

    cpu,

    location,

    price,

    currency,

    discount: 0,

    discountCode: "",

    total: price,

    status:
      "created",

    createdAt:
      new Date().toISOString(),

    expiresAt:
      new Date(
        Date.now() +
        ORDER_TTL_MS
      ).toISOString(),

    createdBy:
      interaction.user.id
  };

  await saveOrder(
    orderNumber,
    order
  );

  const embed =
    new EmbedBuilder()
      .setTitle(
        "Aura Cloud Hosting Order"
      )
      .setDescription(
        `Order created for <@${user.id}>. Click the button to continue.`
      )
      .addFields(
        {
          name: "Customer",
          value:
            `<@${user.id}>`,
          inline: true
        },
        {
          name: "Order",
          value:
            `\`${orderNumber}\``,
          inline: true
        },
        {
          name: "Currency",
          value:
            currency,
          inline: true
        },
        {
          name:
            "Selected specifications",
          value:
            specsText(order),
          inline: false
        }
      )
      .setFooter({
        text:
          "The selected specifications cannot be changed during this order."
      })
      .setTimestamp();

  await interaction.reply({
    content:
      `<@${user.id}>`,

    embeds: [embed],

    components: [
      buildBuyButton(
        orderNumber
      )
    ]
  });

  return true;
}

/* ============================================================
   ADMIN MESSAGE COMMANDS
============================================================ */

export async function handleBuyAdminMessage(
  message
) {
  if (
    !message.guildId ||
    message.author.bot
  ) {
    return false;
  }

  const raw =
    message.content.trim();

  const lower =
    raw.toLowerCase();

  /* ==========================================================
     !ADD OFFER
  ========================================================== */

  if (
    lower.startsWith(
      "!add offer"
    )
  ) {
    if (
      !isAdminMessage(
        message
      )
    ) {
      return false;
    }

    const args =
      raw
        .slice(
          "!add offer".length
        )
        .trim()
        .split(/\s+/);

    if (
      args.length < 3
    ) {
      await message.reply(
        "Usage: `!add offer CODE 20% 30 days` or `!add offer CODE 500 2027/7/1`"
      );

      return true;
    }

    const code =
      normalizeCode(
        args[0]
      );

    const value =
      parseDiscountValue(
        args[1]
      );

    const expiryInput =
      args
        .slice(2)
        .join(" ");

    const expiresAt =
      parseDuration(
        expiryInput
      );

    if (
      !code ||
      !value ||
      !expiresAt
    ) {
      await message.reply(
        "❌ Invalid offer. Examples: `!add offer SUMMER20 20% 30 days`, `!add offer SAVE500 500 2027/7/1`."
      );

      return true;
    }

    const coupon = {
      code,

      ...value,

      active:
        true,

      createdAt:
        new Date().toISOString(),

      createdBy:
        message.author.id,

      expiresAt
    };

    await saveDiscountCode(
      code,
      coupon
    );

    await message.reply(
      `✅ Offer **${code}** created.\n` +
      `Discount: **${
        value.type === "percent"
          ? `${value.value}%`
          : `LKR ${value.value.toLocaleString()}`
      }**\n` +
      `Expires: **${new Date(
        expiresAt
      ).toLocaleString()}**`
    );

    return true;
  }

  /* ==========================================================
     !CONFIRM
  ========================================================== */

  if (
    lower.startsWith(
      "!confirm"
    )
  ) {
    if (
      !isAdminMessage(
        message
      )
    ) {
      return false;
    }

    const args =
      raw.split(/\s+/);

    if (
      args.length < 2
    ) {
      await message.reply(
        "Usage: `!confirm ORDER-NUMBER`\n\n" +
        "The invoice number is generated automatically."
      );

      return true;
    }

    const orderNumber =
      args[1];

    try {
      const result =
        await finalizeOrder(
          orderNumber,
          message.author,
          null,
          message.client
        );

      if (
        result.alreadyConfirmed
      ) {
        await message.reply(
          `ℹ️ This order is already confirmed with invoice **${result.invoiceNumber}**.`
        );

        return true;
      }

      const currency =
        currencyOf(
          result.order
        );

      await message.reply({
        content:
          `✅ **Order confirmed**\n\n` +
          `Order: **${orderNumber}**\n` +
          `Invoice: **${result.invoiceNumber}**\n` +
          `Customer: <@${result.order.discordUserId}>\n` +
          `Payment: **${result.order.paymentMethod || "Unknown"}**\n` +
          `Total: **${formatMoney(
            result.order.total,
            currency
          )}**\n\n` +
          `Saved to Firebase and Google Sheets. Invoice generated.` +
          (
            result.emailSent
              ? " Invoice emailed to the customer."
              : " Invoice email failed."
          ) +
          (
            result.discordDmSent
              ? " Invoice also sent by Discord DM."
              : ""
          ),

        files: [
          new AttachmentBuilder(
            result.pdfPath,
            {
              name:
                `${result.invoiceNumber}.pdf`
            }
          )
        ]
      });
    } catch (error) {
      console.error(
        "!confirm failed:",
        error
      );

      await message.reply(
        `❌ Could not confirm **${orderNumber}**: ${error.message}`
      );
    }

    return true;
  }

  return false;
}