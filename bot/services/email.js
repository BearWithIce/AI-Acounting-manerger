import nodemailer from "nodemailer";

function getTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

export async function sendInvoiceEmail(email, invoiceNumber, pdfPath) {
  await getTransporter().sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: `Aura Cloud Hosting Invoice ${invoiceNumber}`,
    text: `Hello,\n\nYour Aura Cloud Hosting invoice is attached.\n\nInvoice Number: ${invoiceNumber}\n\nThank you for choosing Aura Cloud Hosting.`,
    attachments: [
      {
        filename: `${invoiceNumber}.pdf`,
        path: pdfPath
      }
    ]
  });
}


export async function sendMessageEmail(email, message) {
  const body = String(message || "").trim();

  if (!body) {
    throw new Error("Email message cannot be empty.");
  }

  await getTransporter().sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: process.env.SMTP_DEFAULT_SUBJECT || "Aura Cloud Hosting",
    text: body
  });
}

export async function sendOrderOtp(email, orderNumber, otp) {
  await getTransporter().sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: `Aura Cloud Hosting order verification - ${orderNumber}`,
    text: `Hello,\n\nYour Aura Cloud Hosting verification code is: ${otp}\n\nOrder: ${orderNumber}\nThis code expires in 10 minutes.\n\nIf you did not request this order, you can ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>Aura Cloud Hosting</h2><p>Your verification code for order <b>${orderNumber}</b> is:</p><p style="font-size:30px;font-weight:700;letter-spacing:6px">${otp}</p><p>This code expires in 10 minutes.</p></div>`
  });
}
