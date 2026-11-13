/**
 * POST /api/printify-webhook
 *
 * Printify calls this when you click "Publish" on a product (topic: product:publish:started).
 * For a custom "API" store, Printify locks the product and waits for the store to confirm.
 * We:
 *   1. Verify the X-Pfy-Signature header (HMAC-SHA256 of the raw body, keyed with
 *      PRINTIFY_WEBHOOK_SECRET) — rejects anything not really from Printify.
 *   2. Ignore other topics and other shops.
 *   3. action "create" / "update" → call publishing_succeeded (unlocks the product in Printify,
 *      sets external.handle = our product URL), then clear the product cache so it shows now.
 *   4. action "delete" (unpublish) → just clear the cache and log it. (Behavior to confirm in testing.)
 *
 * Printify retries 3× on any 4xx/5xx and then BLOCKS the webhook for 1 hour, so we only
 * return an error when a retry could actually help (e.g. Printify's API was briefly down).
 * If Printify rejects the confirm with a 4xx (other than 429), we log it and reply 200.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { confirmPublished, clearProductCache, getShopId } from '../../lib/printify';

export const prerender = false;

type Env = { PRINTIFY_WEBHOOK_SECRET?: string };

interface PrintifyEvent {
  id?: string;
  type?: string;
  resource?: {
    id?: string;
    type?: string;
    data?: { shop_id?: number | string; action?: string } | null;
  };
}

const text = (body: string, status = 200) => new Response(body, { status });

/** HMAC-SHA256(secret, body) as lowercase hex, using Web Crypto (Workers have no Node crypto). */
async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compare two strings without leaking where they differ (constant time for equal lengths). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const POST: APIRoute = async ({ request, url }) => {
  const secret = (env as unknown as Env).PRINTIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[printify-webhook] PRINTIFY_WEBHOOK_SECRET is not set');
    return text('Not configured', 500);
  }

  // 1. Verify signature — must use the RAW body, exactly as Printify sent it
  const rawBody = await request.text();
  const header = request.headers.get('x-pfy-signature') ?? '';
  const received = header.startsWith('sha256=') ? header.slice('sha256='.length).toLowerCase() : '';
  const expected = await hmacHex(secret, rawBody);
  if (!received || !safeEqual(received, expected)) {
    console.warn('[printify-webhook] Bad or missing signature');
    return text('Invalid signature', 401);
  }

  let event: PrintifyEvent;
  try {
    event = JSON.parse(rawBody) as PrintifyEvent;
  } catch {
    return text('Bad JSON', 400);
  }

  // 2. Only publish events for OUR shop matter
  if (event.type !== 'product:publish:started') {
    console.log(`[printify-webhook] Ignored ${event.type ?? 'unknown'} (${event.id ?? 'no id'})`);
    return text('Ignored');
  }

  const productId = event.resource?.id;
  const shopId = String(event.resource?.data?.shop_id ?? '');
  const action = event.resource?.data?.action ?? 'create';

  if (!productId) return text('No product id — ignored');
  if (shopId && shopId !== getShopId()) {
    console.log(`[printify-webhook] Event for other shop ${shopId} — ignored`);
    return text('Other shop — ignored');
  }

  // 4. Unpublish: nothing to confirm yet, just refresh what the site shows
  if (action === 'delete') {
    await clearProductCache();
    console.log(`[printify-webhook] Product ${productId} unpublished (action=delete) — cache cleared`);
    return text('Unpublish noted');
  }

  // 3. Publish / re-publish → confirm with Printify
  const productUrl = `${url.origin}/product/${productId}`;
  try {
    await confirmPublished(productId, productUrl);
    await clearProductCache();
    console.log(`[printify-webhook] Confirmed publish (${action}) for ${productId} → ${productUrl}`);
    return text('Published');
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[printify-webhook] publishing_succeeded failed for ${productId}:`, message);

    // printifyFetch errors read "... failed: <status> <body>". A 4xx (e.g. 404 unknown product,
    // which Printify's own "simulate" sends) won't succeed on retry — and every 4xx/5xx we return
    // counts toward Printify's 3 retries + 1-hour block. So only ask for a retry on 429 / 5xx /
    // network errors (no status).
    const status = Number(message.match(/ failed: (\d{3})\b/)?.[1] ?? 0);
    if (status >= 400 && status < 500 && status !== 429) {
      return text(`Confirm rejected by Printify (${status}) — not retrying`);
    }
    // Printify API hiccup → let Printify retry (up to 3×)
    return text('Confirm failed', 500);
  }
};
