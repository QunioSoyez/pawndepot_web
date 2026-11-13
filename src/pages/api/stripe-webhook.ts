/**
 * POST /api/stripe-webhook
 *
 * Stripe calls this after a shopper pays. We:
 *   1. Verify the Stripe signature (rejects anything not really from Stripe).
 *   2. On a paid checkout, read the line items back from Stripe (never from the browser).
 *   3. Skip if we already made a Printify order for this payment (Stripe can resend events).
 *   4. Create the Printify order (external_id = Stripe session id).
 *   5. Send it to production ONLY for live-mode payments with PRINTIFY_SEND_TO_PRODUCTION = "true".
 *      Test-mode payments leave a draft order in Printify that is never printed or charged.
 *   6. Save the Printify order id on the Stripe PaymentIntent (our "already done" marker).
 *   7. Email the shopper an order confirmation (SMTP2GO). A failed email is logged only —
 *      it must never make Stripe retry, or we'd risk a duplicate order.
 *
 * Returning a non-2xx makes Stripe retry (for up to ~3 days), so we only do that
 * when something failed that a retry could fix.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import Stripe from 'stripe';
import { printifyFetch, getShopId } from '../../lib/printify';
import { sendOrderConfirmation } from '../../lib/email';

export const prerender = false;

const PRINTIFY_STANDARD_SHIPPING = 1;

type Env = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  PRINTIFY_SEND_TO_PRODUCTION?: string;
};

const text = (body: string, status = 200) => new Response(body, { status });

export const POST: APIRoute = async ({ request }) => {
  const e = env as unknown as Env;
  if (!e.STRIPE_SECRET_KEY || !e.STRIPE_WEBHOOK_SECRET) {
    console.error('[webhook] STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is not set');
    return text('Not configured', 500);
  }

  const stripe = new Stripe(e.STRIPE_SECRET_KEY);

  // 1. Verify signature — must use the RAW body, exactly as Stripe sent it
  const signature = request.headers.get('stripe-signature');
  if (!signature) return text('Missing signature', 400);

  let event: Stripe.Event;
  try {
    const rawBody = await request.text();
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      e.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(), // Workers use Web Crypto, not Node crypto
    );
  } catch (err) {
    console.warn('[webhook] Bad signature:', (err as Error).message);
    return text('Invalid signature', 400);
  }

  // Only paid checkouts matter. (Cards are paid at "completed"; delayed methods
  // like bank debits arrive later as "async_payment_succeeded".)
  if (
    event.type !== 'checkout.session.completed' &&
    event.type !== 'checkout.session.async_payment_succeeded'
  ) {
    return text('Ignored');
  }

  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== 'paid') {
    console.log(`[webhook] ${session.id} not paid yet (${session.payment_status}) — waiting`);
    return text('Not paid yet');
  }

  try {
    // 3. Idempotency: have we already made a Printify order for this payment?
    const paymentIntentId =
      typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    if (!paymentIntentId) throw new Error(`Session ${session.id} has no payment_intent`);

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.metadata?.printify_order_id) {
      console.log(`[webhook] ${session.id} already has Printify order ${paymentIntent.metadata.printify_order_id} — skipping`);
      return text('Already processed');
    }

    // 2. Line items straight from Stripe, with our Printify ids in product metadata
    const items = await stripe.checkout.sessions.listLineItems(session.id, {
      limit: 100,
      expand: ['data.price.product'],
    });

    const lineItems = items.data.map((li) => {
      const product = li.price?.product as Stripe.Product | undefined;
      const productId = product?.metadata?.printify_product_id;
      const variantId = Number(product?.metadata?.printify_variant_id);
      if (!productId || !Number.isInteger(variantId) || !li.quantity) {
        throw new Error(`Line item ${li.id} is missing Printify ids`);
      }
      return { product_id: productId, variant_id: variantId, quantity: li.quantity };
    });

    // Shipping address moved in newer Stripe API versions — check both spots
    type ShipDetails = { name?: string | null; address?: Stripe.Address | null } | null | undefined;
    const s = session as unknown as {
      collected_information?: { shipping_details?: ShipDetails };
      shipping_details?: ShipDetails;
    };
    const shipping = s.collected_information?.shipping_details ?? s.shipping_details;
    const addr = shipping?.address;
    if (!addr?.line1 || !addr.city || !addr.postal_code) {
      throw new Error(`Session ${session.id} has no shipping address`);
    }

    // Printify wants first/last name separately; Stripe gives one full name
    const fullName = (shipping?.name ?? session.customer_details?.name ?? '').trim();
    const cut = fullName.lastIndexOf(' ');
    const firstName = cut > 0 ? fullName.slice(0, cut) : fullName || 'Customer';
    const lastName = cut > 0 ? fullName.slice(cut + 1) : '-';

    // Same short ref the shopper sees on the success page
    const orderRef = session.id.slice(-8).toUpperCase();

    // 4. Create the Printify order
    // external_id = Stripe session id, so Printify itself refuses a second order for the same
    // payment (409, code 8503). That happens when two deliveries of the same event race past the
    // metadata check above — e.g. Stripe sending one event twice at once, or (in sandbox) both the
    // live site's destination and a local `stripe listen` getting it. The delivery that created the
    // order handles the rest (metadata, production, email), so this one just stops.
    let order: { id: string };
    try {
      order = await printifyFetch<{ id: string }>(`/shops/${getShopId()}/orders.json`, {
        method: 'POST',
        body: JSON.stringify({
          external_id: session.id,
          label: `PawnDepot #${orderRef}${event.livemode ? '' : ' (TEST)'}`,
          line_items: lineItems,
          shipping_method: PRINTIFY_STANDARD_SHIPPING,
          address_to: {
            first_name: firstName,
            last_name: lastName,
            email: session.customer_details?.email ?? '',
            phone: session.customer_details?.phone ?? '',
            country: addr.country ?? 'US',
            region: addr.state ?? '',
            address1: addr.line1,
            address2: addr.line2 ?? '',
            city: addr.city,
            zip: addr.postal_code,
          },
        }),
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (/ failed: 409 /.test(msg) && msg.includes('8503')) {
        console.log(`[webhook] ${session.id} already has a Printify order (created by another delivery) — skipping`);
        return text('Already processed');
      }
      throw err;
    }
    console.log(`[webhook] Created Printify order ${order.id} for ${session.id} (livemode=${event.livemode})`);

    // 6. Mark done right away, so a resend can't create a second order
    await stripe.paymentIntents.update(paymentIntentId, {
      metadata: { printify_order_id: order.id, pawndepot_order_ref: orderRef },
    });

    // 5. Print it — real payments only, and only when switched on
    if (event.livemode && e.PRINTIFY_SEND_TO_PRODUCTION === 'true') {
      try {
        await printifyFetch(`/shops/${getShopId()}/orders/${order.id}/send_to_production.json`, { method: 'POST' });
        console.log(`[webhook] Sent Printify order ${order.id} to production`);
      } catch (err) {
        // Order exists and is marked done — don't let Stripe retry and duplicate it.
        // Send it to production by hand in Printify.
        console.error(`[webhook] Printify order ${order.id} created but NOT sent to production:`, err);
      }
    } else {
      console.log(`[webhook] Printify order ${order.id} left as draft (test mode or production switch off)`);
    }

    // 7. Order confirmation email — best effort, never fails the webhook
    const email = session.customer_details?.email;
    if (email) {
      try {
        await sendOrderConfirmation({
          to: email,
          name: shipping?.name ?? session.customer_details?.name,
          orderRef,
          items: items.data.map((li) => ({
            name: li.description ?? (li.price?.product as Stripe.Product | undefined)?.name ?? 'Item',
            quantity: li.quantity ?? 1,
            amountCents: li.amount_total,
          })),
          shippingCents: session.total_details?.amount_shipping ?? 0,
          taxCents: session.total_details?.amount_tax ?? 0,
          totalCents: session.amount_total ?? 0,
          shipTo: {
            name: shipping?.name,
            line1: addr.line1,
            line2: addr.line2,
            city: addr.city,
            state: addr.state,
            postalCode: addr.postal_code,
          },
          test: !event.livemode,
        });
        console.log(`[webhook] Order confirmation emailed for #${orderRef}`);
      } catch (err) {
        console.error(`[webhook] Order confirmation email FAILED for #${orderRef}:`, (err as Error).message);
      }
    } else {
      console.warn(`[webhook] No customer email on ${session.id} — confirmation not sent`);
    }

    return text('OK');
  } catch (err) {
    console.error(`[webhook] Failed for ${session.id}:`, err);
    return text('Order creation failed', 500); // Stripe will retry
  }
};
