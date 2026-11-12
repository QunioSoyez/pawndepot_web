/**
 * Printify API helper — SERVER ONLY.
 *
 * - Reads PRINTIFY_API_TOKEN (secret) and PRINTIFY_SHOP_ID from the Cloudflare env.
 *   Locally they come from .dev.vars / wrangler.jsonc.
 * - Fetches all products, trims each one down to what the site needs
 *   (raw Printify data is ~2 MB per product), and caches the result.
 *
 * Never import this file from browser-side code: it would expose the token.
 */
import { env } from 'cloudflare:workers';

const API_BASE = 'https://api.printify.com/v1';
const CACHE_SECONDS = 300; // 5 minutes — product edits in Printify show up within this window

/* ------------------------------------------------------------------ */
/* Types the rest of the site uses (trimmed, browser-safe)            */
/* ------------------------------------------------------------------ */

export interface OptionValue {
  id: number;
  title: string;      // e.g. "Heather Aqua" or "XL"
  colors?: string[];  // hex swatches for color options
}

export interface ProductOption {
  name: string;       // e.g. "Bella + Canvas Colors"
  type: string;       // e.g. "color", "size"
  values: OptionValue[]; // only values used by enabled variants
}

export interface Variant {
  id: number;
  title: string;      // e.g. "White / XL"
  price: number;      // cents (what the customer pays)
  available: boolean; // false = out of stock at the print provider
  options: number[];  // option value ids — ORDER IS NOT RELIABLE, match by id
}

export interface ProductImage {
  src: string;
  variantIds: number[]; // enabled variants this mockup shows
  isDefault: boolean;
}

export interface Product {
  id: string;
  title: string;
  descriptionHtml: string; // HTML written in Printify
  tags: string[];
  options: ProductOption[];
  variants: Variant[];
  images: ProductImage[];
  priceMin: number; // cents — lowest price among available variants ("from $X")
  priceMax: number; // cents
  blueprintId: number;     // Printify catalog item (e.g. 12 = Bella+Canvas 3001)
  printProviderId: number; // who prints it — needed for shipping rates + orders
}

/* ------------------------------------------------------------------ */
/* Raw Printify shapes (only the fields we read)                      */
/* ------------------------------------------------------------------ */

interface RawProduct {
  id: string;
  title: string;
  description: string;
  tags: string[];
  visible: boolean;
  is_deleted?: boolean;
  /** true from the moment "Publish" is clicked until we confirm publishing */
  is_locked?: boolean;
  /** filled in once publishing is confirmed (publishing_succeeded) */
  external?: { id?: string; handle?: string } | null;
  blueprint_id: number;
  print_provider_id: number;
  options: { name: string; type: string; values: { id: number; title: string; colors?: string[] }[] }[];
  variants: {
    id: number;
    title: string;
    price: number;
    is_enabled: boolean;
    is_available: boolean;
    options: number[];
  }[];
  images: {
    src: string;
    variant_ids: number[];
    is_default: boolean;
    is_selected_for_publishing: boolean;
  }[];
}

interface RawProductPage {
  data: RawProduct[];
  current_page: number;
  last_page: number;
}

/* ------------------------------------------------------------------ */
/* Config + low-level fetch                                           */
/* ------------------------------------------------------------------ */

function getConfig() {
  const e = env as unknown as { PRINTIFY_API_TOKEN?: string; PRINTIFY_SHOP_ID?: string };
  if (!e.PRINTIFY_API_TOKEN) throw new Error('PRINTIFY_API_TOKEN is not set (.dev.vars locally, Cloudflare secret in prod)');
  if (!e.PRINTIFY_SHOP_ID) throw new Error('PRINTIFY_SHOP_ID is not set (wrangler.jsonc → vars)');
  return { token: e.PRINTIFY_API_TOKEN, shopId: e.PRINTIFY_SHOP_ID };
}

/** Call the Printify API. Exported so checkout/order code can reuse it later. */
export async function printifyFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { token } = getConfig();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'PawnDepot-Site',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    // Don't include the token or full body in errors — just enough to debug
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Printify ${init.method ?? 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  // Some endpoints (e.g. publishing_succeeded) may reply with an empty body
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function getShopId(): string {
  return getConfig().shopId;
}

/* ------------------------------------------------------------------ */
/* Trimming                                                           */
/* ------------------------------------------------------------------ */

function trimProduct(raw: RawProduct): Product {
  const variants: Variant[] = raw.variants
    .filter((v) => v.is_enabled)
    .map((v) => ({
      id: v.id,
      title: v.title,
      price: v.price,
      available: v.is_available,
      options: v.options,
    }));

  const enabledIds = new Set(variants.map((v) => v.id));
  const usedValueIds = new Set(variants.flatMap((v) => v.options));

  // Keep only option values actually used by enabled variants (154 colors → the 9 you picked)
  const options: ProductOption[] = raw.options
    .map((o) => ({
      name: o.name,
      type: o.type,
      values: o.values
        .filter((val) => usedValueIds.has(val.id))
        .map((val) => ({ id: val.id, title: val.title, ...(val.colors ? { colors: val.colors } : {}) })),
    }))
    .filter((o) => o.values.length > 0);

  // Keep mockups chosen for publishing that show at least one enabled variant
  const images: ProductImage[] = raw.images
    .filter((img) => img.is_selected_for_publishing)
    .map((img) => ({
      src: img.src,
      variantIds: img.variant_ids.filter((id) => enabledIds.has(id)),
      isDefault: img.is_default,
    }))
    .filter((img) => img.variantIds.length > 0);

  const availablePrices = variants.filter((v) => v.available).map((v) => v.price);
  const prices = availablePrices.length ? availablePrices : variants.map((v) => v.price);

  return {
    id: raw.id,
    title: raw.title,
    descriptionHtml: raw.description,
    tags: raw.tags,
    options,
    variants,
    images,
    priceMin: prices.length ? Math.min(...prices) : 0,
    priceMax: prices.length ? Math.max(...prices) : 0,
    blueprintId: raw.blueprint_id,
    printProviderId: raw.print_provider_id,
  };
}

/* ------------------------------------------------------------------ */
/* Fetch all products (with caching)                                  */
/* ------------------------------------------------------------------ */

/**
 * Only show products Michael has actually published in Printify.
 * Drafts ("Save" without "Publish") are visible too, so `visible` alone isn't enough:
 *   - is_locked    → Publish was clicked, waiting for our site to confirm
 *   - external.id  → publishing was confirmed
 * A plain draft has neither.
 */
function isPublished(raw: RawProduct): boolean {
  if (!raw.visible || raw.is_deleted) return false;
  return raw.is_locked === true || Boolean(raw.external?.id);
}

async function fetchAllProductsFromPrintify(): Promise<Product[]> {
  const shopId = getShopId();
  const products: Product[] = [];
  let page = 1;
  let lastPage = 1;

  do {
    const res = await printifyFetch<RawProductPage>(`/shops/${shopId}/products.json?limit=50&page=${page}`);
    for (const raw of res.data) {
      if (isPublished(raw)) products.push(trimProduct(raw));
    }
    lastPage = res.last_page;
    page++;
  } while (page <= lastPage);

  return products;
}

// Layer 1: in-memory cache (fast, but each Cloudflare instance has its own and it resets often)
let memoryCache: { products: Product[]; expires: number } | null = null;

// Layer 2: Cloudflare Cache API (shared within a data center). Note: may be a no-op
// on *.workers.dev test URLs — that's fine, layer 1 still helps. Works on pawndepot.shop.
const CACHE_KEY = 'https://cache.pawndepot.internal/printify/products-v2'; // bump when Product shape changes

/** All visible products, trimmed. Cached for CACHE_SECONDS. */
export async function getProducts(): Promise<Product[]> {
  const now = Date.now();
  if (memoryCache && memoryCache.expires > now) return memoryCache.products;

  const edgeCache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;

  if (edgeCache) {
    const hit = await edgeCache.match(CACHE_KEY);
    if (hit) {
      const products = (await hit.json()) as Product[];
      memoryCache = { products, expires: now + CACHE_SECONDS * 1000 };
      return products;
    }
  }

  const products = await fetchAllProductsFromPrintify();
  memoryCache = { products, expires: now + CACHE_SECONDS * 1000 };

  if (edgeCache) {
    await edgeCache.put(
      CACHE_KEY,
      new Response(JSON.stringify(products), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_SECONDS}` },
      }),
    );
  }

  return products;
}

/**
 * Forget cached products so the next request re-reads Printify.
 * Clears this instance's memory + this data center's edge cache. Other data centers
 * still expire on their own within CACHE_SECONDS — good enough.
 */
export async function clearProductCache(): Promise<void> {
  memoryCache = null;
  const edgeCache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  if (edgeCache) await edgeCache.delete(CACHE_KEY);
}

/**
 * Tell Printify a product is live on our site. This unlocks it in Printify
 * (is_locked → false) and sets external.id / external.handle.
 */
export async function confirmPublished(productId: string, productUrl: string): Promise<void> {
  const shopId = getShopId();
  await printifyFetch<unknown>(`/shops/${shopId}/products/${productId}/publishing_succeeded.json`, {
    method: 'POST',
    body: JSON.stringify({ external: { id: productId, handle: productUrl } }),
  });
}

/** One product by its Printify id, or undefined if not found / hidden. */
export async function getProduct(id: string): Promise<Product | undefined> {
  const products = await getProducts();
  return products.find((p) => p.id === id);
}

/* ------------------------------------------------------------------ */
/* Small helpers for pages                                            */
/* ------------------------------------------------------------------ */

/** 2500 → "$25.00" */
export function formatPrice(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/** Best image to show for a product card (default mockup, else first). */
export function primaryImage(product: Product): ProductImage | undefined {
  return product.images.find((i) => i.isDefault) ?? product.images[0];
}

/* ------------------------------------------------------------------ */
/* Shipping cost (asks Printify to price the actual cart)             */
/* ------------------------------------------------------------------ */

export interface ShippingLine {
  productId: string;
  variantId: number;
  quantity: number;
}

interface ShippingQuote {
  standard?: number;
  economy?: number;
  express?: number;
  priority?: number;
  printify_express?: number;
}

// Printify needs an address to price shipping, but Stripe collects the real one
// on its checkout page. Standard US rates are the same nationwide, so we quote
// against a fixed placeholder US address. (Revisit if we ship outside the US.)
const QUOTE_ADDRESS_US = {
  first_name: 'Rate',
  last_name: 'Quote',
  email: 'quote@pawndepot.shop',
  phone: '0000000000',
  country: 'US',
  region: 'NC',
  address1: '100 Main St',
  city: 'Raleigh',
  zip: '27601',
};

const quoteCache = new Map<string, { cents: number; expires: number }>();

/**
 * Standard shipping in cents for a cart (US), exactly as Printify will charge us.
 * Uses Printify's "calculate shipping" endpoint, so multi-item discounts are applied
 * by Printify itself. Cached 10 min per unique cart.
 */
export async function quoteStandardShippingUS(lines: ShippingLine[]): Promise<number> {
  const key = lines
    .map((l) => `${l.productId}:${l.variantId}:${l.quantity}`)
    .sort()
    .join('|');
  const hit = quoteCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.cents;

  const quote = await printifyFetch<ShippingQuote>(`/shops/${getShopId()}/orders/shipping.json`, {
    method: 'POST',
    body: JSON.stringify({
      line_items: lines.map((l) => ({ product_id: l.productId, variant_id: l.variantId, quantity: l.quantity })),
      address_to: QUOTE_ADDRESS_US,
    }),
  });

  if (typeof quote.standard !== 'number') {
    throw new Error(`Printify shipping quote had no standard rate: ${JSON.stringify(quote).slice(0, 200)}`);
  }

  quoteCache.set(key, { cents: quote.standard, expires: Date.now() + 10 * 60 * 1000 });
  return quote.standard;
}
