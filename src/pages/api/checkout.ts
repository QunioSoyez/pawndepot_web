/**
 * POST /api/checkout
 *
 * Body (from the browser cart): { items: [{ productId, variantId, quantity }] }
 * Returns: { url } — the Stripe-hosted checkout page to send the shopper to.
 *
 * SECURITY: the browser only tells us WHAT and HOW MANY. Every price, title,
 * image and stock status is looked up here from Printify, and shipping is quoted
 * by Printify. Nothing the browser sends about prices is used.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import Stripe from 'stripe';
import { getProducts, primaryImage, quoteStandardShippingUS, type ShippingLine } from '../../lib/printify';

export const prerender = false;

const MAX_LINES = 25;
const MAX_QTY = 10; // keep in sync with MAX_QTY_PER_ITEM in src/lib/cart.ts

interface IncomingItem {
  productId: string;
  variantId: number;
  quantity: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Validate + merge duplicate lines. Returns null if the body is malformed. */
function parseItems(body: unknown): IncomingItem[] | null {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_LINES) return null;

  const merged = new Map<string, IncomingItem>();
  for (const raw of items) {
    const i = raw as IncomingItem;
    if (
      typeof i?.productId !== 'string' ||
      i.productId.length === 0 ||
      i.productId.length > 64 ||
      !Number.isInteger(i.variantId) ||
      !Number.isInteger(i.quantity) ||
      i.quantity < 1
    ) {
      return null;
    }
    const key = `${i.productId}:${i.variantId}`;
    const existing = merged.get(key);
    const quantity = Math.min(MAX_QTY, (existing?.quantity ?? 0) + i.quantity);
    merged.set(key, { productId: i.productId, variantId: i.variantId, quantity });
  }
  return [...merged.values()];
}

export const POST: APIRoute = async ({ request, url }) => {
  const stripeKey = (env as unknown as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('[checkout] STRIPE_SECRET_KEY is not set');
    return json({ error: 'Checkout is not available right now.' }, 503);
  }

  // 1. Read + validate the cart
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  const items = parseItems(body);
  if (!items) return json({ error: 'Your cart looks invalid. Please refresh and try again.' }, 400);

  try {
    // 2. Re-price everything from Printify
    const products = await getProducts();
    const problems: string[] = [];
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
    const shippingLines: ShippingLine[] = [];

    for (const item of items) {
      const product = products.find((p) => p.id === item.productId);
      const variant = product?.variants.find((v) => v.id === item.variantId);

      if (!product || !variant) {
        problems.push('An item in your cart is no longer for sale.');
        continue;
      }
      if (!variant.available) {
        problems.push(`${product.title} (${variant.title}) is out of stock.`);
        continue;
      }

      const image = product.images.find((im) => im.variantIds.includes(variant.id)) ?? primaryImage(product);

      lineItems.push({
        quantity: item.quantity,
        price_data: {
          currency: 'usd',
          unit_amount: variant.price,
          product_data: {
            name: product.title,
            description: variant.title, // e.g. "White / L"
            ...(image ? { images: [image.src] } : {}),
            // Read back by the webhook to create the Printify order
            metadata: {
              printify_product_id: product.id,
              printify_variant_id: String(variant.id),
            },
          },
        },
      });
      shippingLines.push({ productId: product.id, variantId: variant.id, quantity: item.quantity });
    }

    if (problems.length) {
      return json({ error: 'Some items need your attention.', problems }, 409);
    }

    // 3. Exact Standard shipping from Printify
    const shippingCents = await quoteStandardShippingUS(shippingLines);

    // 4. Create the Stripe Checkout session
    const stripe = new Stripe(stripeKey);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      shipping_address_collection: { allowed_countries: ['US'] },
      phone_number_collection: { enabled: true }, // carriers may need it for delivery issues
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            display_name: 'Standard shipping',
            fixed_amount: { amount: shippingCents, currency: 'usd' },
            // Printed to order: production + transit. Adjust if Printify's real times differ.
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 5 },
              maximum: { unit: 'business_day', value: 12 },
            },
          },
        },
      ],
      success_url: `${url.origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${url.origin}/cart`,
      metadata: { source: 'pawndepot-site' },
    });

    if (!session.url) throw new Error('Stripe returned no checkout URL');
    return json({ url: session.url });
  } catch (err) {
    console.error('[checkout] Failed:', err);
    return json({ error: 'We couldn’t start checkout. Please try again in a minute.' }, 502);
  }
};
