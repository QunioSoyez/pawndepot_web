/**
 * Cart — BROWSER ONLY. Stored in localStorage so it survives page loads.
 *
 * Prices/titles stored here are for DISPLAY ONLY. At checkout the server
 * re-reads every price from Printify, so editing localStorage can't change
 * what a customer is charged.
 *
 * Any change fires a "pawndepot:cart-changed" event on document
 * (also when the cart changes in another tab).
 */

export interface CartItem {
  productId: string;
  variantId: number;
  quantity: number;
  // Display-only snapshot (refreshed from Printify at checkout)
  title: string;
  variantTitle: string; // e.g. "White / XL"
  price: number;        // cents
  image?: string;
}

const STORAGE_KEY = 'pawndepot-cart-v1';
export const MAX_QTY_PER_ITEM = 10;
export const CART_EVENT = 'pawndepot:cart-changed';

/* ---------- storage (guarded: private mode / blocked storage won't crash the site) ---------- */

let memoryFallback: CartItem[] = [];

function read(): CartItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isValidItem) : [];
  } catch {
    return memoryFallback;
  }
}

function write(items: CartItem[]) {
  memoryFallback = items;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* storage unavailable — keep in memory for this page */
  }
  document.dispatchEvent(new CustomEvent(CART_EVENT, { detail: { items } }));
}

function isValidItem(i: unknown): i is CartItem {
  const x = i as CartItem;
  return (
    !!x &&
    typeof x.productId === 'string' &&
    Number.isInteger(x.variantId) &&
    Number.isInteger(x.quantity) &&
    x.quantity > 0 &&
    typeof x.price === 'number'
  );
}

const clampQty = (n: number) => Math.max(1, Math.min(MAX_QTY_PER_ITEM, Math.floor(n)));

/* ---------- public API ---------- */

export function getCart(): CartItem[] {
  return read();
}

/** Total number of items (sum of quantities) — for the header badge */
export function getCount(): number {
  return read().reduce((sum, i) => sum + i.quantity, 0);
}

/** Display subtotal in cents (server recalculates at checkout) */
export function getSubtotal(): number {
  return read().reduce((sum, i) => sum + i.price * i.quantity, 0);
}

/** Add an item; if the same variant is already in the cart, increase its quantity */
export function addItem(item: Omit<CartItem, 'quantity'>, quantity = 1) {
  const items = read();
  const existing = items.find((i) => i.productId === item.productId && i.variantId === item.variantId);
  if (existing) {
    existing.quantity = clampQty(existing.quantity + quantity);
    Object.assign(existing, { title: item.title, variantTitle: item.variantTitle, price: item.price, image: item.image });
  } else {
    items.push({ ...item, quantity: clampQty(quantity) });
  }
  write(items);
}

/** Set an exact quantity; 0 or less removes the item */
export function setQuantity(productId: string, variantId: number, quantity: number) {
  let items = read();
  if (quantity <= 0) {
    items = items.filter((i) => !(i.productId === productId && i.variantId === variantId));
  } else {
    const item = items.find((i) => i.productId === productId && i.variantId === variantId);
    if (item) item.quantity = clampQty(quantity);
  }
  write(items);
}

export function removeItem(productId: string, variantId: number) {
  setQuantity(productId, variantId, 0);
}

export function clearCart() {
  write([]);
}

/** Call fn now and whenever the cart changes (this tab or another tab). Returns an unsubscribe fn. */
export function onCartChange(fn: (items: CartItem[]) => void): () => void {
  const handler = () => fn(read());
  const storageHandler = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) handler();
  };
  document.addEventListener(CART_EVENT, handler);
  window.addEventListener('storage', storageHandler);
  handler();
  return () => {
    document.removeEventListener(CART_EVENT, handler);
    window.removeEventListener('storage', storageHandler);
  };
}
