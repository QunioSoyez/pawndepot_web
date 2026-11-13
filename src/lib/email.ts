/**
 * Customer emails — SERVER ONLY.
 *
 * Sends through SMTP2GO's HTTP API (POST https://api.smtp2go.com/v3/email/send).
 * - Key: SMTP2GO_API_KEY (Cloudflare secret in prod, .dev.vars locally). Never logged.
 * - From "PawnDepot" <orders@pawndepot.shop> (domain verified in SMTP2GO via CNAMEs);
 *   replies go to help@pawndepot.shop (Cloudflare Email Routing forwards it).
 * - Test-mode (Stripe sandbox) orders still send real emails, with "(TEST)" in the subject.
 *
 * Two emails:
 *   sendOrderConfirmation() — called by /api/stripe-webhook after the Printify order is created
 *   sendShippedEmail()      — called by /api/printify-webhook on order:shipment:created
 *
 * Each email has a plain-text and a simple HTML version (inline styles only — email clients
 * ignore <style> blocks and web fonts). Never import this from browser code.
 */
import { env } from 'cloudflare:workers';
import { formatPrice } from './printify';

const API_URL = 'https://api.smtp2go.com/v3/email/send';
const FROM = 'PawnDepot <orders@pawndepot.shop>';
const REPLY_TO = 'help@pawndepot.shop';
const SITE = 'https://pawndepot.shop';

// Brand palette (see notes → Branding)
const INK = '#111111';
const RED = '#CE2223';
const PAPER = '#F7F4EE';
const STEEL = '#6B6B6B';

type Env = { SMTP2GO_API_KEY?: string };

interface Smtp2goResponse {
  request_id?: string;
  data?: {
    succeeded?: number;
    failed?: number;
    failures?: string[];
    email_id?: string;
    error?: string;
    error_code?: string;
  };
}

/* ------------------------------------------------------------------ */
/* Low-level send                                                     */
/* ------------------------------------------------------------------ */

interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Send one email. Throws on any failure (caller decides whether that matters). */
export async function sendEmail({ to, subject, text, html }: Email): Promise<void> {
  const apiKey = (env as unknown as Env).SMTP2GO_API_KEY;
  if (!apiKey) throw new Error('SMTP2GO_API_KEY is not set');
  if (!to) throw new Error('No recipient address');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Smtp2go-Api-Key': apiKey,
    },
    body: JSON.stringify({
      sender: FROM,
      to: [to],
      subject,
      text_body: text,
      html_body: html,
      custom_headers: [{ header: 'Reply-To', value: REPLY_TO }],
    }),
  });

  let json: Smtp2goResponse = {};
  try {
    json = (await res.json()) as Smtp2goResponse;
  } catch {
    /* non-JSON reply — handled below */
  }

  if (!res.ok || json.data?.error || (json.data?.succeeded ?? 0) < 1) {
    const detail = json.data?.error_code ?? json.data?.error ?? json.data?.failures?.join('; ') ?? '';
    throw new Error(`SMTP2GO send failed: ${res.status} ${detail}`.trim());
  }
}

/* ------------------------------------------------------------------ */
/* Order confirmation                                                 */
/* ------------------------------------------------------------------ */

export interface OrderEmailItem {
  name: string;        // e.g. "People Over Money Tee — White / XL"
  quantity: number;
  amountCents: number; // line total
}

export interface OrderConfirmation {
  to: string;
  name?: string | null;
  orderRef: string;    // short ref shown on the success page, e.g. "A1B2C3D4"
  items: OrderEmailItem[];
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  shipTo?: { name?: string | null; line1?: string | null; line2?: string | null; city?: string | null; state?: string | null; postalCode?: string | null } | null;
  test: boolean;       // true = Stripe sandbox order
}

export async function sendOrderConfirmation(o: OrderConfirmation): Promise<void> {
  const hello = o.name?.trim() ? `Hi ${firstWord(o.name)},` : 'Hi there,';
  const subject = `${o.test ? '(TEST) ' : ''}PawnDepot order #${o.orderRef} confirmed`;

  const addrLines = o.shipTo
    ? [o.shipTo.name, o.shipTo.line1, o.shipTo.line2, [o.shipTo.city, o.shipTo.state, o.shipTo.postalCode].filter(Boolean).join(' ')]
        .filter((l): l is string => !!l && l.trim() !== '')
    : [];

  const text = [
    hello,
    '',
    `Thanks for your order! We've got it, and it's headed to the print shop.`,
    '',
    `Order #${o.orderRef}`,
    ...o.items.map((i) => `  ${i.quantity} × ${i.name} — ${formatPrice(i.amountCents)}`),
    '',
    `  Shipping: ${formatPrice(o.shippingCents)}`,
    ...(o.taxCents > 0 ? [`  Tax: ${formatPrice(o.taxCents)}`] : []),
    `  Total: ${formatPrice(o.totalCents)}`,
    ...(addrLines.length ? ['', 'Shipping to:', ...addrLines.map((l) => `  ${l}`)] : []),
    '',
    `What's next: each item is printed to order, and most orders arrive in about 5–12 business days.`,
    `We'll email you again with tracking as soon as it ships.`,
    '',
    `Questions? Just reply to this email or write to ${REPLY_TO}.`,
    '',
    '— PawnDepot',
    SITE,
  ].join('\n');

  const itemRows = o.items
    .map(
      (i) => `<tr>
        <td style="padding:6px 0;color:${INK};">${i.quantity} &times; ${esc(i.name)}</td>
        <td style="padding:6px 0;color:${INK};text-align:right;white-space:nowrap;">${formatPrice(i.amountCents)}</td>
      </tr>`,
    )
    .join('');

  const totalsRows = [
    row('Shipping', formatPrice(o.shippingCents)),
    o.taxCents > 0 ? row('Tax', formatPrice(o.taxCents)) : '',
    `<tr>
      <td style="padding:8px 0 0;border-top:2px solid ${INK};font-weight:bold;color:${INK};">Total</td>
      <td style="padding:8px 0 0;border-top:2px solid ${INK};font-weight:bold;color:${INK};text-align:right;">${formatPrice(o.totalCents)}</td>
    </tr>`,
  ].join('');

  const body = `
    <p style="margin:0 0 12px;">${esc(hello)}</p>
    <p style="margin:0 0 20px;">Thanks for your order! We've got it, and it's headed to the print shop.</p>
    <p style="margin:0 0 8px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${RED};">Order #${esc(o.orderRef)}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:15px;">
      ${itemRows}
      <tr><td colspan="2" style="padding:6px 0;border-top:1px solid #ddd;"></td></tr>
      ${totalsRows}
    </table>
    ${
      addrLines.length
        ? `<p style="margin:20px 0 0;color:${STEEL};font-size:14px;">Shipping to:<br>${addrLines.map(esc).join('<br>')}</p>`
        : ''
    }
    <p style="margin:20px 0 0;">Each item is printed to order, and most orders arrive in about <strong>5–12 business days</strong>.
    We'll email you again with tracking as soon as it ships.</p>`;

  await sendEmail({ to: o.to, subject, text, html: layout(subject, body, o.test) });
}

/* ------------------------------------------------------------------ */
/* Shipped (tracking)                                                 */
/* ------------------------------------------------------------------ */

export interface ShippedEmail {
  to: string;
  name?: string | null;
  orderRef: string;
  carrier?: string | null;        // e.g. "USPS"
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  test: boolean;
}

export async function sendShippedEmail(s: ShippedEmail): Promise<void> {
  const hello = s.name?.trim() ? `Hi ${firstWord(s.name)},` : 'Hi there,';
  const subject = `${s.test ? '(TEST) ' : ''}Your PawnDepot order #${s.orderRef} has shipped`;
  const url = safeUrl(s.trackingUrl);
  const carrier = s.carrier?.trim() || 'the carrier';

  const text = [
    hello,
    '',
    `Good news — your order #${s.orderRef} is on its way!`,
    '',
    ...(s.trackingNumber ? [`Carrier: ${carrier}`, `Tracking number: ${s.trackingNumber}`] : []),
    ...(url ? [`Track it here: ${url}`] : []),
    ...(!s.trackingNumber && !url ? ['Tracking details aren\'t available yet — reply to this email and we\'ll look it up.'] : []),
    '',
    `Tracking can take a day to show movement after the label is created.`,
    `Questions? Just reply to this email or write to ${REPLY_TO}.`,
    '',
    '— PawnDepot',
    SITE,
  ].join('\n');

  const body = `
    <p style="margin:0 0 12px;">${esc(hello)}</p>
    <p style="margin:0 0 20px;">Good news — your order <strong>#${esc(s.orderRef)}</strong> is on its way!</p>
    ${
      s.trackingNumber
        ? `<p style="margin:0 0 20px;color:${STEEL};font-size:14px;">Carrier: <strong style="color:${INK};">${esc(carrier)}</strong><br>
           Tracking number: <strong style="color:${INK};">${esc(s.trackingNumber)}</strong></p>`
        : ''
    }
    ${
      url
        ? `<p style="margin:0 0 20px;"><a href="${esc(url)}" style="display:inline-block;background:${RED};color:#ffffff;text-decoration:none;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:12px 22px;border-radius:4px;">Track your package</a></p>`
        : ''
    }
    ${
      !s.trackingNumber && !url
        ? `<p style="margin:0 0 20px;">Tracking details aren't available yet — reply to this email and we'll look it up.</p>`
        : ''
    }
    <p style="margin:0;color:${STEEL};font-size:14px;">Tracking can take a day to show movement after the label is created.</p>`;

  await sendEmail({ to: s.to, subject, text, html: layout(subject, body, s.test) });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Shared HTML wrapper: black header with wordmark, paper body, footer with help address. */
function layout(title: string, body: string, test: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e2ddd3;">
        <tr><td style="background:${INK};padding:18px 24px;">
          <a href="${SITE}" style="color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;letter-spacing:3px;">PAWN<span style="color:${RED};">DEPOT</span></a>
        </td></tr>
        ${
          test
            ? `<tr><td style="background:#fff3cd;color:#664d03;padding:8px 24px;font-family:Arial,Helvetica,sans-serif;font-size:13px;">TEST ORDER — sandbox payment, nothing will be printed or shipped.</td></tr>`
            : ''
        }
        <tr><td style="padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:${INK};">
          ${body}
        </td></tr>
        <tr><td style="padding:16px 24px;border-top:1px solid #e2ddd3;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${STEEL};">
          Questions? Reply to this email or write to <a href="mailto:${REPLY_TO}" style="color:${RED};">${REPLY_TO}</a>.<br>
          <a href="${SITE}" style="color:${STEEL};">pawndepot.shop</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function row(label: string, value: string): string {
  return `<tr>
    <td style="padding:4px 0;color:${STEEL};">${esc(label)}</td>
    <td style="padding:4px 0;color:${STEEL};text-align:right;">${esc(value)}</td>
  </tr>`;
}

/** Escape text for safe use inside HTML (customer names/addresses are user input). */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Only allow http(s) links (tracking URLs come from Printify, but be safe). */
function safeUrl(u?: string | null): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.toString() : null;
  } catch {
    return null;
  }
}

function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0];
}
