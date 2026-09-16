import axios from "axios";

/* ============================================================
   OPENROUTER CONFIG
============================================================ */

const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/chat/completions";

/* ============================================================
   DELAY
============================================================ */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ============================================================
   LIVE USD -> LKR EXCHANGE RATE
============================================================ */

let cachedUsdToLkr = null;
let cachedExchangeRateTime = 0;

const EXCHANGE_RATE_CACHE_MS = 60 * 60 * 1000;

export async function getUsdToLkrRate() {
  const now = Date.now();

  if (
    cachedUsdToLkr !== null &&
    now - cachedExchangeRateTime < EXCHANGE_RATE_CACHE_MS
  ) {
    return cachedUsdToLkr;
  }

  try {
    const apiKey = process.env.EXCHANGERATE_API_KEY;

    if (!apiKey) {
      throw new Error(
        "EXCHANGERATE_API_KEY is missing from .env"
      );
    }

    const response = await axios.get(
      "https://api.exchangerate.host/live",
      {
        params: {
          access_key: apiKey,
          source: "USD",
          currencies: "LKR"
        },
        timeout: 15000
      }
    );

    if (!response.data || response.data.success === false) {
      throw new Error(
        response.data?.error?.info ||
          "Exchange-rate API returned an error."
      );
    }

    const rate = Number(
      response.data?.quotes?.USDLKR
    );

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(
        "Invalid USD/LKR exchange rate received."
      );
    }

    cachedUsdToLkr = rate;
    cachedExchangeRateTime = now;

    console.log(
      `💱 Current USD → LKR rate: ${rate}`
    );

    return rate;
  } catch (error) {
    console.error(
      "❌ Failed to get USD → LKR exchange rate:",
      error.message
    );

    throw new Error(
      "Unable to get the current USD → LKR exchange rate."
    );
  }
}

/* ============================================================
   CONVERT MONEY TO LKR
============================================================ */

async function convertToLkr(
  amount,
  currency,
  usdToLkr
) {
  const value = Number(amount || 0);

  if (!Number.isFinite(value)) {
    return 0;
  }

  const normalizedCurrency = String(
    currency || "LKR"
  )
    .trim()
    .toUpperCase();

  if (normalizedCurrency === "LKR") {
    return value;
  }

  if (normalizedCurrency === "USD") {
    return value * usdToLkr;
  }

  throw new Error(
    `Unsupported currency: ${normalizedCurrency}`
  );
}

/* ============================================================
   DATE HELPERS
============================================================ */

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function extractDate(text) {
  if (!text) {
    return null;
  }

  const original = String(text);

  /* YYYY-MM-DD or YYYY/MM/DD */
  const explicit = original.match(
    /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/
  );

  if (explicit) {
    const year = Number(explicit[1]);
    const month = Number(explicit[2]);
    const day = Number(explicit[3]);

    const date = new Date(
      Date.UTC(year, month - 1, day)
    );

    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return formatDate(date);
    }
  }

  const lower = original.toLowerCase();
  const today = new Date();

  if (/\btoday\b/.test(lower)) {
    return formatDate(today);
  }

  if (/\byesterday\b/.test(lower)) {
    const date = new Date(today);

    date.setDate(date.getDate() - 1);

    return formatDate(date);
  }

  if (/\btomorrow\b/.test(lower)) {
    const date = new Date(today);

    date.setDate(date.getDate() + 1);

    return formatDate(date);
  }

  return null;
}

/* ============================================================
   NUMBER PARSER
============================================================ */

function parseNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : null;
  }

  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");

  if (
    !cleaned ||
    cleaned === "-" ||
    cleaned === "." ||
    cleaned === "-."
  ) {
    return null;
  }

  const number = Number(cleaned);

  return Number.isFinite(number)
    ? number
    : null;
}

/* ============================================================
   FORMAT MONEY
============================================================ */

function formatMoney(
  amount,
  currency = "LKR"
) {
  const number = Number(amount || 0);

  return `${currency} ${number.toFixed(2)}`;
}

/* ============================================================
   JSON CLEANER
============================================================ */

function cleanJSON(text) {
  if (!text || typeof text !== "string") {
    throw new Error(
      "AI returned an empty response."
    );
  }

  let cleaned = text.trim();

  /*
     Remove <think>...</think> blocks if a model
     happens to return reasoning before the JSON.
  */

  cleaned = cleaned.replace(
    /<think>[\s\S]*?<\/think>/gi,
    ""
  );

  /*
     Remove Markdown code fences.
  */

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  /*
     First attempt: entire response is JSON.
  */

  try {
    return JSON.parse(cleaned);
  } catch {}

  /*
     Second attempt:
     Find the first { and last }.
  */

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (
    firstBrace !== -1 &&
    lastBrace !== -1 &&
    lastBrace > firstBrace
  ) {
    const possibleJSON = cleaned.slice(
      firstBrace,
      lastBrace + 1
    );

    try {
      return JSON.parse(possibleJSON);
    } catch {}
  }

  /*
     Third attempt:
     Sometimes the model returns JSON with
     leading/trailing whitespace or fences.
  */

  const objectMatch = cleaned.match(
    /\{[\s\S]*\}/
  );

  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {}
  }

  console.error(
    "❌ AI returned invalid JSON:",
    cleaned
  );

  throw new Error(
    "AI returned invalid JSON."
  );
}

/* ============================================================
   LOCAL TRANSACTION PARSER
============================================================ */

function localTransactionParser(text) {
  const original = String(text || "");
  const lower = original.toLowerCase();

  let amount = null;
  let currency = "LKR";

  /* ==========================================================
     USD
  ========================================================== */

  const usdMatch = original.match(
    /(?:\$\s*([\d,]+(?:\.\d{1,2})?)|\bUSD\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*USD\b)/i
  );

  if (usdMatch) {
    amount = parseNumber(
      usdMatch[1] ||
        usdMatch[2] ||
        usdMatch[3]
    );

    currency = "USD";
  }

  /* ==========================================================
     LKR
  ========================================================== */

  if (amount === null) {
    const lkrMatch = original.match(
      /(?:\bLKR\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*LKR\b|\bRs\.?\s*([\d,]+(?:\.\d+)?)|රු\.?\s*([\d,]+(?:\.\d+)?))/i
    );

    if (lkrMatch) {
      amount = parseNumber(
        lkrMatch[1] ||
          lkrMatch[2] ||
          lkrMatch[3] ||
          lkrMatch[4]
      );

      currency = "LKR";
    }
  }

  /* ==========================================================
     TYPE
  ========================================================== */

  const expenseWords = [
    "bought",
    "buy",
    "purchased",
    "purchase",
    "paid for",
    "spent",
    "expense",
    "renewed",
    "renew",
    "cost",
    "subscription",
    "server cost"
  ];

  const incomeWords = [
    "received",
    "earned",
    "client paid",
    "customer paid",
    "payment received",
    "got paid",
    "sold"
  ];

  let type = "income";

  if (
    expenseWords.some(word =>
      lower.includes(word)
    )
  ) {
    type = "expense";
  }

  if (
    incomeWords.some(word =>
      lower.includes(word)
    )
  ) {
    type = "income";
  }

  /* ==========================================================
     SERVICE
  ========================================================== */

  let service = null;

  if (/\bv2ray\b/i.test(original)) {
    service = "V2Ray Service";
  } else if (/\bvps\b/i.test(original)) {
    service = "VPS Hosting";
  } else if (/\bminecraft\b/i.test(original)) {
    service = "Minecraft Hosting";
  } else if (/\bdiscord\b/i.test(original)) {
    service = "Discord Bot Hosting";
  } else if (
    /\bweb\s+hosting\b/i.test(original)
  ) {
    service = "Web Hosting";
  }

  /* ==========================================================
     PAYMENT METHOD
  ========================================================== */

  let paymentMethod = null;

  const paymentMethods = [
    {
      pattern: /paypal/i,
      value: "PayPal"
    },
    {
      pattern: /bank transfer|bank payment/i,
      value: "Bank Transfer"
    },
    {
      pattern: /credit card|debit card|card/i,
      value: "Card"
    },
    {
      pattern: /crypto|bitcoin|usdt/i,
      value: "Crypto"
    },
    {
      pattern: /cash/i,
      value: "Cash"
    }
  ];

  for (const method of paymentMethods) {
    if (method.pattern.test(original)) {
      paymentMethod = method.value;
      break;
    }
  }

  /* ==========================================================
     STATUS
  ========================================================== */

  let status = "paid";

  if (/\bpending\b/i.test(original)) {
    status = "pending";
  }

  if (/\bfailed\b/i.test(original)) {
    status = "failed";
  }

  if (/\brefunded\b/i.test(original)) {
    status = "refunded";
  }

  return {
    type,
    amount,
    currency,
    description: original,
    service,
    paymentMethod,
    status,
    date: extractDate(original)
  };
}

/* ============================================================
   LOCAL INVOICE PARSER
============================================================ */

function localInvoiceParser(text) {
  const original = String(text || "");

  let unitPrice = 0;
  let currency = "LKR";

  /* ==========================================================
     USD
  ========================================================== */

  const usdMatch = original.match(
    /(?:\$\s*([\d,]+(?:\.\d{1,2})?)|\bUSD\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*USD\b)/i
  );

  if (usdMatch) {
    unitPrice =
      parseNumber(
        usdMatch[1] ||
          usdMatch[2] ||
          usdMatch[3]
      ) || 0;

    currency = "USD";
  }

  /* ==========================================================
     LKR
  ========================================================== */

  if (unitPrice === 0) {
    const lkrMatch = original.match(
      /(?:\bLKR\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*LKR\b|\bRs\.?\s*([\d,]+(?:\.\d+)?)|රු\.?\s*([\d,]+(?:\.\d+)?))/i
    );

    if (lkrMatch) {
      unitPrice =
        parseNumber(
          lkrMatch[1] ||
            lkrMatch[2] ||
            lkrMatch[3] ||
            lkrMatch[4]
        ) || 0;

      currency = "LKR";
    }
  }

  /* ==========================================================
     QUANTITY
  ========================================================== */

  let quantity = 1;

  const quantityMatch = original.match(
    /\b(\d+)\s*(?:x|servers?|plans?|items?)\b/i
  );

  if (quantityMatch) {
    const parsed = Number(quantityMatch[1]);

    if (
      Number.isFinite(parsed) &&
      parsed > 0
    ) {
      quantity = parsed;
    }
  }

  /* ==========================================================
     BILLING CYCLE
  ========================================================== */

  let billingCycle = "Monthly";

  if (
    /\bmonthly\b|\bper month\b/i.test(
      original
    )
  ) {
    billingCycle = "Monthly";
  }

  if (
    /\byearly\b|\bannual\b|\bper year\b/i.test(
      original
    )
  ) {
    billingCycle = "Yearly";
  }

  if (
    /\bone[- ]?time\b/i.test(original)
  ) {
    billingCycle = "One-time";
  }

  /* ==========================================================
     STATUS
  ========================================================== */

  let status = "Pending";

  if (/\bpaid\b/i.test(original)) {
    status = "Paid";
  }

  if (/\bunpaid\b/i.test(original)) {
    status = "Unpaid";
  }

  if (
    /\bcancelled\b|\bcanceled\b/i.test(
      original
    )
  ) {
    status = "Cancelled";
  }

  return {
    description: original,
    quantity,
    billingCycle,
    unitPrice,
    discount: 0,
    tax: 0,
    currency,
    status,
    purchaseDate: extractDate(original),
    expiryDate: null
  };
}

/* ============================================================
   OPENROUTER REQUEST
============================================================ */

export async function askAI(
  userPrompt,
  systemPrompt =
    "You are Aura Cloud Hosting's AI manager. Be accurate and concise."
) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is missing from .env"
    );
  }

  const primaryModel =
    process.env.OPENROUTER_MODEL ||
    "google/gemma-4-26b-a4b-it:free";

  const fallbackModels = String(
    process.env.OPENROUTER_FALLBACK_MODELS || ""
  )
    .split(",")
    .map(model => model.trim())
    .filter(Boolean);

  const models = [
    ...new Set([
      primaryModel,
      ...fallbackModels
    ])
  ];

  const messages = [
    {
      role: "system",
      content: systemPrompt
    },
    {
      role: "user",
      content: userPrompt
    }
  ];

  let lastError = null;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        console.log(
          `🤖 Asking OpenRouter using model: ${model}`
        );

        const response = await axios.post(
          OPENROUTER_URL,
          {
            model,
            messages,
            temperature: 0.2,
            max_tokens: 800,
            stream: false
          },
          {
            headers: {
              Authorization:
                `Bearer ${process.env.OPENROUTER_API_KEY}`,

              "Content-Type":
                "application/json",

              "HTTP-Referer":
                process.env.OPENROUTER_SITE_URL ||
                "https://auracloud.cloud",

              "X-Title":
                process.env.OPENROUTER_APP_NAME ||
                "Aura Cloud Manager Bot"
            },

            timeout: 90000,

            validateStatus: () => true
          }
        );

        const status = response.status;

        /* ======================================================
           429 RATE LIMIT
        ====================================================== */

        if (status === 429) {
          const retryAfterHeader =
            response.headers?.["retry-after"];

          const retryAfterSeconds =
            Number(retryAfterHeader);

          const waitMs =
            Number.isFinite(
              retryAfterSeconds
            ) &&
            retryAfterSeconds > 0
              ? Math.min(
                  retryAfterSeconds * 1000,
                  15000
                )
              : 3000;

          const providerMessage =
            response.data?.error?.message ||
            "OpenRouter rate limit reached.";

          console.warn(
            `⚠️ OpenRouter rate limit for ${model}: ${providerMessage}`
          );

          if (attempt === 0) {
            console.log(
              `⏳ Waiting ${Math.ceil(
                waitMs / 1000
              )} seconds before retrying...`
            );

            await sleep(waitMs);

            continue;
          }

          const rateLimitError =
            new Error(
              "OPENROUTER_RATE_LIMITED"
            );

          rateLimitError.code =
            "OPENROUTER_RATE_LIMITED";

          rateLimitError.model = model;
          rateLimitError.providerMessage =
            providerMessage;

          lastError = rateLimitError;

          break;
        }

        /* ======================================================
           SERVER ERROR
        ====================================================== */

        if (
          status >= 500 &&
          status < 600
        ) {
          const providerMessage =
            response.data?.error?.message ||
            `OpenRouter server error ${status}`;

          if (attempt === 0) {
            console.warn(
              `⚠️ OpenRouter server error ${status}. Retrying in 3 seconds...`
            );

            await sleep(3000);

            continue;
          }

          lastError = new Error(
            `OpenRouter API error ${status}: ${providerMessage}`
          );

          break;
        }

        /* ======================================================
           OTHER HTTP ERRORS
        ====================================================== */

        if (
          status < 200 ||
          status >= 300
        ) {
          const providerMessage =
            response.data?.error?.message ||
            `HTTP ${status}`;

          console.error(
            `❌ OpenRouter API error: ${status} ${providerMessage}`
          );

          lastError = new Error(
            `OpenRouter API error ${status}: ${providerMessage}`
          );

          break;
        }

        /* ======================================================
           SUCCESS
        ====================================================== */

        const choice =
          response.data?.choices?.[0];

        if (!choice) {
          lastError = new Error(
            "OpenRouter returned no choices."
          );

          break;
        }

        const content =
          choice.message?.content;

        if (
          typeof content === "string" &&
          content.trim()
        ) {
          return content.trim();
        }

        if (Array.isArray(content)) {
          const result = content
            .map(part => {
              if (typeof part === "string") {
                return part;
              }

              if (part?.type === "text") {
                return part.text || "";
              }

              return "";
            })
            .join("")
            .trim();

          if (result) {
            return result;
          }
        }

        lastError = new Error(
          "OpenRouter returned an empty response."
        );

        break;
      } catch (error) {
        /* ======================================================
           AXIOS TIMEOUT
        ====================================================== */

        if (
          error.code ===
          "ECONNABORTED"
        ) {
          lastError = new Error(
            "OpenRouter request timed out."
          );

          if (attempt === 0) {
            await sleep(2000);
            continue;
          }

          break;
        }

        /* ======================================================
           NETWORK ERROR
        ====================================================== */

        if (!error.response) {
          lastError = error;

          if (attempt === 0) {
            console.warn(
              "⚠️ OpenRouter network error. Retrying in 2 seconds..."
            );

            await sleep(2000);

            continue;
          }

          break;
        }

        lastError = error;

        break;
      }
    }
  }

  throw (
    lastError ||
    new Error("OPENROUTER_FAILED")
  );
}

/* ============================================================
   EXTRACT TRANSACTION
============================================================ */

export async function extractTransaction(text) {
  const fallback =
    localTransactionParser(text);

  /*
     If the local parser found an amount,
     avoid unnecessary AI requests.
  */

  if (fallback.amount !== null) {
    return fallback;
  }

  try {
    const result = await askAI(
      `
Extract accounting information.

MESSAGE:
${text}

Return exactly one valid JSON object:

{
  "type": "income",
  "amount": null,
  "currency": "LKR",
  "description": "",
  "service": null,
  "paymentMethod": null,
  "status": "paid",
  "date": null
}

Rules:
- type must be income or expense
- amount must be a number or null
- never invent an amount
- currency must be LKR or USD
- date must be YYYY-MM-DD or null
- never invent a date
- return JSON only
- do not use Markdown
- do not add explanations
`,
      "You are a structured accounting data extraction system. Output only valid JSON."
    );

    const data = cleanJSON(result);

    const normalizedCurrency =
      String(
        data.currency ||
          fallback.currency ||
          "LKR"
      )
        .trim()
        .toUpperCase();

    const allowedCurrencies = [
      "LKR",
      "USD"
    ];

    return {
      type:
        data.type === "expense"
          ? "expense"
          : "income",

      amount:
        parseNumber(data.amount),

      currency:
        allowedCurrencies.includes(
          normalizedCurrency
        )
          ? normalizedCurrency
          : fallback.currency,

      description:
        data.description ||
        fallback.description,

      service:
        data.service ||
        fallback.service,

      paymentMethod:
        data.paymentMethod ||
        fallback.paymentMethod,

      status:
        [
          "paid",
          "pending",
          "failed",
          "refunded",
          "unknown"
        ].includes(
          String(
            data.status || ""
          ).toLowerCase()
        )
          ? String(
              data.status
            ).toLowerCase()
          : fallback.status,

      date:
        data.date ||
        fallback.date
    };
  } catch (error) {
    console.warn(
      "⚠️ AI transaction extraction unavailable. Using local parser:",
      error.message
    );

    return fallback;
  }
}

/* ============================================================
   EXTRACT INVOICE DATA
============================================================ */

export async function extractInvoiceData(text) {
  const fallback =
    localInvoiceParser(text);

  /*
     If local parser found a price,
     avoid unnecessary AI requests.
  */

  if (fallback.unitPrice > 0) {
    return fallback;
  }

  try {
    const result = await askAI(
      `
Extract invoice information.

MESSAGE:
${text}

Return exactly one valid JSON object:

{
  "description": "",
  "quantity": 1,
  "billingCycle": "Monthly",
  "unitPrice": 0,
  "discount": 0,
  "tax": 0,
  "currency": "LKR",
  "status": "Pending",
  "purchaseDate": null,
  "expiryDate": null
}

Rules:
- Return JSON only
- Do not use Markdown
- Never invent prices
- Never invent dates
- quantity must be a positive number
- unitPrice must be a number
- discount must be a number
- tax must be a number
- currency must be LKR or USD
- billingCycle must be Monthly, Yearly, or One-time
- status must be Paid, Pending, Unpaid, or Cancelled
`,
      "You are a structured invoice data extraction system. Return exactly one valid JSON object."
    );

    const data = cleanJSON(result);

    const quantity =
      parseNumber(data.quantity);

    const unitPrice =
      parseNumber(data.unitPrice);

    const discount =
      parseNumber(data.discount);

    const tax =
      parseNumber(data.tax);

    const normalizedCurrency =
      String(
        data.currency ||
          fallback.currency ||
          "LKR"
      )
        .trim()
        .toUpperCase();

    const allowedCurrencies = [
      "LKR",
      "USD"
    ];

    const billingCycles = [
      "Monthly",
      "Yearly",
      "One-time"
    ];

    const statuses = [
      "Paid",
      "Pending",
      "Unpaid",
      "Cancelled"
    ];

    return {
      description:
        data.description ||
        fallback.description,

      quantity:
        Number.isFinite(quantity) &&
        quantity > 0
          ? quantity
          : fallback.quantity,

      billingCycle:
        billingCycles.includes(
          data.billingCycle
        )
          ? data.billingCycle
          : fallback.billingCycle,

      unitPrice:
        Number.isFinite(unitPrice) &&
        unitPrice >= 0
          ? unitPrice
          : fallback.unitPrice,

      discount:
        Number.isFinite(discount) &&
        discount >= 0
          ? discount
          : fallback.discount,

      tax:
        Number.isFinite(tax) &&
        tax >= 0
          ? tax
          : fallback.tax,

      currency:
        allowedCurrencies.includes(
          normalizedCurrency
        )
          ? normalizedCurrency
          : fallback.currency,

      status:
        statuses.includes(data.status)
          ? data.status
          : fallback.status,

      purchaseDate:
        data.purchaseDate ||
        fallback.purchaseDate,

      expiryDate:
        data.expiryDate ||
        null
    };
  } catch (error) {
    console.warn(
      "⚠️ AI invoice extraction unavailable. Using local parser:",
      error.message
    );

    return fallback;
  }
}

/* ============================================================
   COMPANY ANALYSIS
============================================================ */

export async function analyzeCompany(companyData) {
  const data = companyData || {};

  let usdToLkr;

  /* ==========================================================
     GET CURRENT USD -> LKR RATE
  ========================================================== */

  try {
    usdToLkr =
      await getUsdToLkrRate();
  } catch (error) {
    console.error(
      "❌ Currency conversion failed:",
      error.message
    );

    return [
      "# ❌ Company Analysis Unavailable",
      "",
      "The current USD → LKR exchange rate could not be retrieved.",
      "",
      `**Reason:** ${error.message}`,
      "",
      "No mixed-currency financial totals were calculated."
    ].join("\n");
  }

  /* ==========================================================
     TRANSACTIONS
  ========================================================== */

  let totalIncomeLkr = 0;
  let totalExpensesLkr = 0;

  const transactions =
    Array.isArray(data.transactions)
      ? data.transactions
      : [];

  for (const transaction of transactions) {
    const amount = Number(
      transaction?.amount || 0
    );

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      continue;
    }

    const currency = String(
      transaction?.currency || "LKR"
    )
      .trim()
      .toUpperCase();

    try {
      const amountLkr =
        await convertToLkr(
          amount,
          currency,
          usdToLkr
        );

      const type = String(
        transaction?.type || ""
      )
        .trim()
        .toLowerCase();

      if (type === "income") {
        totalIncomeLkr += amountLkr;
      }

      if (type === "expense") {
        totalExpensesLkr += amountLkr;
      }
    } catch (error) {
      console.warn(
        `⚠️ Skipping transaction with unsupported currency ${currency}:`,
        error.message
      );
    }
  }

  /* ==========================================================
     PROFIT / LOSS
  ========================================================== */

  const profitLkr =
    totalIncomeLkr -
    totalExpensesLkr;

  /* ==========================================================
     INVOICES
  ========================================================== */

  const invoices =
    Array.isArray(data.invoices)
      ? data.invoices
      : [];

  let paidInvoiceRevenueLkr = 0;

  for (const invoice of invoices) {
    const status = String(
      invoice?.status || ""
    )
      .trim()
      .toLowerCase();

    if (status !== "paid") {
      continue;
    }

    const quantity = Number(
      invoice?.quantity || 1
    );

    const unitPrice = Number(
      invoice?.unitPrice || 0
    );

    const discount = Number(
      invoice?.discount || 0
    );

    const tax = Number(
      invoice?.tax || 0
    );

    if (
      !Number.isFinite(quantity) ||
      !Number.isFinite(unitPrice)
    ) {
      continue;
    }

    const invoiceTotal =
      unitPrice * quantity -
      (Number.isFinite(discount)
        ? discount
        : 0) +
      (Number.isFinite(tax)
        ? tax
        : 0);

    if (invoiceTotal <= 0) {
      continue;
    }

    const currency = String(
      invoice?.currency || "LKR"
    )
      .trim()
      .toUpperCase();

    try {
      const invoiceLkr =
        await convertToLkr(
          invoiceTotal,
          currency,
          usdToLkr
        );

      paidInvoiceRevenueLkr +=
        invoiceLkr;
    } catch (error) {
      console.warn(
        `⚠️ Skipping invoice with unsupported currency ${currency}:`,
        error.message
      );
    }
  }

  /* ==========================================================
     RECORD COUNTS
  ========================================================== */

  const totalInvoices =
    invoices.length;

  const totalTransactions =
    transactions.length;

  /* ==========================================================
     PERFORMANCE
  ========================================================== */

  let performance =
    "There is not enough financial data to determine overall performance.";

  if (
    totalIncomeLkr > 0 &&
    totalExpensesLkr === 0
  ) {
    performance =
      "The available records show income with no recorded expenses.";
  } else if (
    totalIncomeLkr > 0 &&
    totalExpensesLkr > 0 &&
    profitLkr > 0
  ) {
    performance =
      "The company is currently operating at a profit based on the recorded transactions.";
  } else if (
    totalIncomeLkr > 0 &&
    totalExpensesLkr > 0 &&
    profitLkr < 0
  ) {
    performance =
      "The company is currently operating at a loss based on the recorded transactions.";
  } else if (
    totalIncomeLkr === 0 &&
    totalExpensesLkr > 0
  ) {
    performance =
      "The available records show expenses but no recorded income.";
  } else if (
    totalIncomeLkr === 0 &&
    totalExpensesLkr === 0
  ) {
    performance =
      "No recorded income or expenses are currently available.";
  }

  /* ==========================================================
     VERIFIED DATA SENT TO AI
  ========================================================== */

  const compactData = {
    reportingCurrency: "LKR",

    exchangeRate: {
      USD_LKR:
        Number(usdToLkr.toFixed(6)),

      source:
        "Live exchange-rate API",

      description:
        "USD records were converted to LKR before analysis."
    },

    recordedIncomeLKR:
      Number(totalIncomeLkr.toFixed(2)),

    recordedExpensesLKR:
      Number(totalExpensesLkr.toFixed(2)),

    recordedProfitLKR:
      Number(profitLkr.toFixed(2)),

    paidInvoiceRevenueLKR:
      Number(
        paidInvoiceRevenueLkr.toFixed(2)
      ),

    totalInvoices,
    totalTransactions
  };

  /* ==========================================================
     AI ANALYSIS
  ========================================================== */

  try {
    const result = await askAI(
      `
You are analyzing Aura Cloud Hosting.

IMPORTANT:

The reporting currency is LKR.

All USD values have ALREADY been converted to LKR.

DO NOT convert any value again.

VERIFIED COMPANY DATA:

${JSON.stringify(
  compactData,
  null,
  2
)}

Give a clear business analysis based on the verified data above.

Use simple Discord Markdown:
- One main "#" title.
- Use "##" for major sections when helpful.
- Use "**Label:** value" for important facts.
- Do not use single-asterisk italic formatting.
- Do not use hyphen or bullet lists. Put each fact on its own line.
- Use normal readable dates such as "2026-08-20" when a date is relevant.
- Keep the response organized and concise.
- Do not repeat the same fact.
- If you make a recommendation, clearly label it as a recommendation.
- Use only the supplied accounting data for financial facts.
      `,
      "You are Aura Cloud Hosting's business analyst. Give clear, organized Discord Markdown. Use headings and bold labels, avoid single-asterisk italics and hyphen bullets."
    );

    const cleanedResult = result.trim();

    if (cleanedResult.length <= 1800) {
      return cleanedResult;
    }

    /*
       Emergency fallback if AI exceeds Discord
       message limit.
    */

    return (
      cleanedResult
        .slice(0, 1750)
        .replace(/\s+\S*$/, "")
        .trim() +
      "\n\n**Note:** Report shortened to fit Discord."
    );
  } catch (error) {
    console.error(
      "❌ Company analysis failed:",
      error.message
    );

    return [
      "# ❌ Company Analysis Unavailable",
      "",
      "The company analysis could not be generated.",
      "",
      `**Reason:** ${error.message}`
    ].join("\n");
  }
}