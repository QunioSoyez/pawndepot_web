<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/logo-pawn-white.svg" />
    <img src="public/logo-pawn.svg" alt="PawnDepot logo" width="160" />
  </picture>
</p>

<h1 align="center">PawnDepot</h1>

<p align="center">
  Custom merch, printed on demand and shipped to your door.<br />
  <a href="https://pawndepot.shop">pawndepot.shop</a>
</p>

---

PawnDepot is a small drop-ship store. Products are designed and managed in
[Printify](https://printify.com); this repo is the custom storefront that sells them.
Shoppers browse and pay on the site (via Stripe Checkout), and paid orders are sent to
Printify automatically to be printed and shipped.

> The upside-down pawn is intentional. 🙃

## How it works

```
Customer browser
   │  browses products / cart            (Astro pages on Cloudflare Workers)
   ▼
/api/checkout ──► Stripe Checkout Session ──► customer pays on Stripe
                                                     │
Stripe webhook (checkout.session.completed) ◄────────┘
   ▼
/api/stripe-webhook
   │  1. verify Stripe signature
   │  2. skip if this payment already has a Printify order
   ▼
Printify API: create order ──► Printify prints & ships
```

- **Catalog comes from Printify.** Published products appear on the site automatically
  (cached ~5 minutes). Drafts are hidden. Prices are set in Printify.
- **Prices are never trusted from the browser.** Checkout re-reads every price and
  stock status from Printify, and shipping is quoted by Printify for the actual cart.
- **Card data never touches this code.** Stripe hosts the payment page.
- **Test payments can't print anything.** Orders are only sent to production for
  live-mode payments with `PRINTIFY_SEND_TO_PRODUCTION = "true"`; otherwise they stay
  *On Hold* in Printify.

## Tech stack

| Piece | Choice |
|---|---|
| Framework | [Astro](https://astro.build) 7 (server routes + static pages) |
| Hosting | Cloudflare Workers with static assets (`@astrojs/cloudflare`) |
| Payments | Stripe Checkout + webhooks (`stripe` npm package) |
| Fulfillment | Printify API (custom "API" store) |
| Fonts | Oswald + Inter, self-hosted via `@fontsource` |

## Project layout

```text
public/                     logos, favicons (served as-is)
src/
├── layouts/BaseLayout.astro   header, footer, <head>, cart badge
├── lib/
│   ├── printify.ts            server-only Printify API: products, cache, shipping quotes
│   └── cart.ts                browser cart (localStorage)
├── pages/
│   ├── index.astro            home
│   ├── shop.astro             product grid
│   ├── product/[id].astro     product page (color/size pickers)
│   ├── cart.astro             cart
│   ├── checkout/success.astro thank-you / receipt
│   ├── 404.astro              "This train doesn't stop here."
│   └── api/
│       ├── checkout.ts        creates the Stripe Checkout Session
│       └── stripe-webhook.ts  paid checkout → Printify order
└── styles/global.css          colors, type, buttons
wrangler.jsonc                 Cloudflare Worker config (non-secret vars)
```

## Local development

Requires Node 22+ and npm.

```sh
npm install
npm run dev        # http://localhost:4321
```

Create a `.dev.vars` file in the project root for local secrets (it's git-ignored —
never commit it):

```ini
PRINTIFY_API_TOKEN=...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

### Testing the Stripe webhook locally

Uses the [Stripe CLI](https://docs.stripe.com/stripe-cli). In a second terminal:

```sh
stripe login
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded --forward-to localhost:4321/api/stripe-webhook
```

Put the `whsec_...` it prints into `.dev.vars` as `STRIPE_WEBHOOK_SECRET`, restart
`npm run dev`, then place a test order with card `4242 4242 4242 4242`.

## Configuration

| Name | Where | Purpose |
|---|---|---|
| `PRINTIFY_API_TOKEN` | secret | Printify API access |
| `PRINTIFY_SHOP_ID` | `wrangler.jsonc` → `vars` | Which Printify store to use |
| `STRIPE_SECRET_KEY` | secret | Create checkout sessions |
| `STRIPE_WEBHOOK_SECRET` | secret | Verify webhook signatures (local and production values differ) |
| `PRINTIFY_SEND_TO_PRODUCTION` | var | `"true"` lets live orders auto-print. Leave unset until launch. |

Secrets live in `.dev.vars` locally and as **Cloudflare Secrets** on the `pawndepot`
Worker in production. They never go in the repo.

## Deployment

Every push to `main` builds and deploys automatically through Cloudflare Workers Builds
(`npm run build` → `npx wrangler deploy`).

## Commands

| Command | Action |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Local dev server at `localhost:4321` |
| `npm run build` | Build the production site to `./dist/` |
| `npm run preview` | Preview the build locally |
| `npm run generate-types` | Regenerate Cloudflare env types (`wrangler types`) |
