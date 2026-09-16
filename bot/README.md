# Aura Cloud Manager Bot

Aura Cloud's Discord accounting and management bot.

## What was fixed

- `!tell` now reads accounting data from **Google Sheets** for company/customer/order analysis.
- AI answers are cleaned after generation so they use organized Discord Markdown instead of messy single `*` formatting or hyphen bullets.
- The AI is no longer forced into a large rigid report template. It can choose a useful structure while the bot keeps the final formatting readable.
- Specific order lookups use the Google Sheets invoice records.
- Added `!msg @user <message>` to DM a Discord user.
- Added `!email email@example.com <message>` to send a normal email.
- Existing invoice, transaction, Firebase, Google Sheets, and SMTP features remain.
- Secrets from the original project are intentionally not included in this package. Use your own `.env` and service-account JSON files.

## Requirements

- Node.js 20+
- Discord bot with Message Content Intent enabled
- OpenRouter API key
- Google Sheets API service account
- Firebase Realtime Database/service account
- SMTP account for email
- LibreOffice installed and available as `libreoffice` if PDF invoice generation is required

## Install

```bash
npm install
```

Copy `.env.example` to `.env` and fill in the values.

Then place your real service-account files in the project root:

- `google-service-account.json`
- `firebase-service-account.json`

The example JSON files in this package are only templates.

## Google Sheets

The bot uses these tabs:

- `Transactions`
- `Invoices`

The bot creates missing tabs and headers automatically.

For `!tell`, Google Sheets is the accounting source used for company, customer, and order analysis. Firebase remains part of the existing storage/invoice workflow.

## Commands

### `!in`

Record a transaction.

```text
!in Client paid 21000 LKR today for VPS hosting by bank transfer
```

### `!inv`

Create an invoice draft.

```text
!inv Client purchased a Minecraft server for 5000 LKR monthly and paid today
```

Click the button and enter the customer details.

### `!ap`

Send an invoice to a Discord user or email.

```text
!ap @User AURA-2026-000001
```

or

```text
!ap customer@example.com AURA-2026-000001
```

### `!tell`

Ask Aura AI to analyze the accounting data.

```text
!tell What is the company status?
!tell How much revenue do we have?
!tell What does pixelDreamescapes owe us?
!tell How many unpaid Minecraft servers does pixelDreamescapes have?
!tell Explain order AURA-2026-000001
```

For financial questions, the bot supplies the relevant verified Google Sheets records to the AI. The AI is used for interpretation and explanation, not for inventing accounting data.

### `!msg`

Send a DM to a Discord user.

```text
!msg @User Your invoice is ready.
```

A user ID also works:

```text
!msg 123456789012345678 Your invoice is ready.
```

### `!email`

Send an email to a specific address.

```text
!email customer@example.com Your invoice is ready. Please check your email.
```

The command uses the SMTP settings in `.env`.

## Permissions

Management commands are limited to the configured:

- Guild: `ALLOWED_GUILD_ID`
- Channel: `ALLOWED_CHANNEL_ID`
- Role: `ALLOWED_ROLE_ID`

This also protects `!msg` and `!email` from being used by unauthorized members.

## Start

```bash
npm start
```

## Security

Never upload or commit these files:

- `.env`
- `google-service-account.json`
- `firebase-service-account.json`

If a real service-account key was previously shared outside your private environment, rotate/revoke that key in Google/Firebase and create a new one.
