import log from "../modules/logger";
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  pool: true,
  host: process.env.EMAIL_SERVICE,
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

const GAME_NAME = process.env.GAME_NAME || "Frostfire Forge";

export function buildEmailBody(title: string, description: string, action: string): string {
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:40px 0;">
      <tr>
        <td align="center">
          <table width="540" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
            <tr>
              <td style="padding:36px 40px 0;text-align:center;">
                <p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#8898aa;margin:0 0 8px;text-transform:uppercase;letter-spacing:1px;">${GAME_NAME}</p>
                <h2 style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:600;color:#1a1f36;margin:0 0 8px;line-height:1.3;">${title}</h2>
                <p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#525f7f;line-height:1.6;margin:0;">${description}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 40px;text-align:center;">
                ${action}
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 36px;text-align:center;">
                <p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#8898aa;line-height:1.5;margin:0;border-top:1px solid #e6ebf1;padding-top:20px;">If you did not request this, you can safely ignore this email.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

export function buildCodeAction(code: string): string {
  const chars = code.split("");
  const digits = chars.map(c => `<span style="display:inline-block;width:36px;height:44px;line-height:44px;background:#f7f8fc;border:1px solid #e3e8ee;border-radius:4px;font-family:'Courier New',monospace;font-size:22px;font-weight:700;color:#1a1f36;margin:0 3px;text-align:center;">${c}</span>`).join("");
  return `<div style="display:inline-block;">${digits}</div>`;
}

export function buildLinkAction(url: string, label: string): string {
  return `
    <a href="${url}" style="display:inline-block;padding:12px 40px;background-color:#22c55e;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;border-radius:6px;">${label}</a>
  `;
}

export default function sendEmail(email: string, subject: string, header: string, message: string): Promise<string> {
  return new Promise((resolve) => {

    if (!email || !subject || !message) {
      log.error("Email, subject, and message are required");
      resolve("Email, subject, and message are required");
      return;
    }

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD || !process.env.EMAIL_SERVICE) {
      log.error("Email configuration is missing");
      resolve("Email configuration is missing");
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      log.error("Invalid email format");
      resolve("Invalid email format");
      return;
    }

    if (subject.length > 78) {
      log.error("Subject exceeds maximum length of 78 characters");
      resolve("Subject exceeds maximum length of 78 characters");
      return;
    }

    try {
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: `${header} - ${subject}`,
        html: createHTML(subject, message),
      };

      transporter.sendMail(mailOptions, function (error: any) {
        if (error) {
          log.error(error as string);
          resolve("Email failed to send");
        } else {
          log.info(`Email sent: ${censorEmail(email)} — ${subject}`);
          resolve("Email sent successfully");
        }
      });
    } catch (err) {
      log.error(err as string);
      resolve("Email system error");
    }
  });
}

const censorEmail = (email: string) => {
  const [local, domain] = email.split('@');
  const censoredLocal = local.length > 2
    ? `${local.slice(0, 2)}${'*'.repeat(local.length - 2)}`
    : '*'.repeat(local.length);
  const [domainName, domainExtension] = domain.split('.');
  const censoredDomain = `${domainName[0]}${'*'.repeat(domainName.length - 1)}.${domainExtension}`;
  return `${censoredLocal}@${censoredDomain}`;
};

function createHTML(subject: string, message: string) {
  return `<!doctypehtml><html lang=en><title></title><meta content="text/html; charset=utf-8"http-equiv=Content-Type><meta content="width=device-width,initial-scale=1"name=viewport><body style="background-color:#f4f5f7;margin:0;padding:0;-webkit-text-size-adjust:none;text-size-adjust:none">${message}</body></html>`;
}
