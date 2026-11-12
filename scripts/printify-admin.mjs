#!/usr/bin/env node
/**
 * printify-admin.mjs — one-off Printify chores from your dev machine.
 *
 * Reads PRINTIFY_API_TOKEN and PRINTIFY_WEBHOOK_SECRET from .dev.vars and
 * PRINTIFY_SHOP_ID from wrangler.jsonc. Never prints secret values.
 * Run from the project folder (where .dev.vars lives):
 *
 *   node scripts/printify-admin.mjs list
 *       Show registered webhooks + every product's publish state. Read-only.
 *
 *   node scripts/printify-admin.mjs register
 *       Register the product:publish:started webhook → https://pawndepot.shop/api/printify-webhook
 *
 *   node scripts/printify-admin.mjs delete-webhook <webhookId>
 *       Remove a registered webhook.
 *
 *   node scripts/printify-admin.mjs simulate
 *       Ask Printify to send a harmless test event to our webhook (fake product, fake shop id,
 *       so the handler logs "Event for other shop … ignored" and changes nothing).
 *
 *   node scripts/printify-admin.mjs confirm-locked          (dry run: shows what it would do)
 *   node scripts/printify-admin.mjs confirm-locked --yes    (actually confirms)
 *       For products stuck "Publishing…" (is_locked), call publishing_succeeded with
 *       handle https://pawndepot.shop/product/<id>. Needed once for products published
 *       before the webhook existed.
 */
import { readFileSync } from 'node:fs';

const SITE = 'https://pawndepot.shop';
const WEBHOOK_URL = `${SITE}/api/printify-webhook`;
const TOPIC = 'product:publish:started';
const API = 'https://api.printify.com/v1';

/* ---------- config ---------- */

function readDevVars() {
  let text;
  try {
    text = readFileSync('.dev.vars', 'utf8');
  } catch {
    fail('.dev.vars not found — run this from the pawndepot_web folder.');
  }
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return vars;
}

function readShopId() {
  const text = readFileSync('wrangler.jsonc', 'utf8');
  const m = text.match(/"PRINTIFY_SHOP_ID"\s*:\s*"(\d+)"/);
  if (!m) fail('PRINTIFY_SHOP_ID not found in wrangler.jsonc');
  return m[1];
}

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

const vars = readDevVars();
const TOKEN = vars.PRINTIFY_API_TOKEN || fail('PRINTIFY_API_TOKEN missing from .dev.vars');
const SHOP = readShopId();

/* ---------- API ---------- */

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'PawnDepot-Admin',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) fail(`${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

async function allProducts() {
  const out = [];
  let page = 1;
  let last = 1;
  do {
    const res = await api(`/shops/${SHOP}/products.json?limit=50&page=${page}`);
    out.push(...res.data);
    last = res.last_page;
    page++;
  } while (page <= last);
  return out;
}

function stateOf(p) {
  if (p.is_deleted) return 'deleted';
  if (p.external?.id) return 'PUBLISHED (confirmed)';
  if (p.is_locked) return 'LOCKED (waiting for confirm)';
  return 'draft';
}

/* ---------- commands ---------- */

async function list() {
  const hooks = await api(`/shops/${SHOP}/webhooks.json`);
  console.log(`\nShop ${SHOP} — webhooks (${hooks.length}):`);
  if (!hooks.length) console.log('  (none)');
  for (const h of hooks) console.log(`  ${h.id}  ${h.topic}  →  ${h.url}`);

  const products = await allProducts();
  console.log(`\nProducts (${products.length}):`);
  for (const p of products) {
    console.log(`  ${p.id}  ${stateOf(p).padEnd(29)} visible=${p.visible}  ${p.title}`);
    if (p.external?.handle) console.log(`      handle: ${p.external.handle}`);
    console.log(`      blueprint: ${p.blueprint_id}  tags: ${(p.tags ?? []).join(', ') || '(none)'}`);
  }
  console.log('');
}

async function register() {
  const secret = vars.PRINTIFY_WEBHOOK_SECRET || fail('PRINTIFY_WEBHOOK_SECRET missing from .dev.vars');
  const hooks = await api(`/shops/${SHOP}/webhooks.json`);
  const existing = hooks.find((h) => h.topic === TOPIC);
  if (existing) fail(`A ${TOPIC} webhook already exists (${existing.id} → ${existing.url}). Delete it first if you want to re-create it.`);
  const created = await api(`/shops/${SHOP}/webhooks.json`, {
    method: 'POST',
    body: JSON.stringify({ topic: TOPIC, url: WEBHOOK_URL, secret }),
  });
  console.log(`✔ Registered ${created.topic} → ${created.url} (id ${created.id})`);
}

async function deleteWebhook(id) {
  if (!id) fail('Usage: delete-webhook <webhookId>  (get the id from "list")');
  const hooks = await api(`/shops/${SHOP}/webhooks.json`);
  const hook = hooks.find((h) => h.id === id) || fail(`No webhook with id ${id}`);
  const host = new URL(hook.url).host;
  await api(`/shops/${SHOP}/webhooks/${id}.json?host=${encodeURIComponent(host)}`, { method: 'DELETE' });
  console.log(`✔ Deleted webhook ${id} (${hook.topic} → ${hook.url})`);
}

async function simulate() {
  const hooks = await api(`/shops/${SHOP}/webhooks.json`);
  const hook = hooks.find((h) => h.topic === TOPIC) || fail(`No ${TOPIC} webhook registered — run "register" first.`);
  // Printify puts this body into the event's "resource". shop_id 1 ≠ ours → our handler ignores it (200).
  const resource = { id: '000000000000000000000000', type: 'product', data: { shop_id: 1, action: 'create' } };
  const res = await api(`/shops/${SHOP}/webhooks/${hook.id}/simulate`, {
    method: 'POST',
    body: JSON.stringify(resource),
  });
  console.log(`✔ Asked Printify to send a test ${TOPIC} event to ${hook.url}`);
  if (res !== undefined) console.log('  Printify replied:', JSON.stringify(res).slice(0, 300));
  console.log('  Now check the Worker log stream for a [printify-webhook] line.');
}

async function confirmLocked(apply) {
  const locked = (await allProducts()).filter((p) => p.is_locked && !p.external?.id && !p.is_deleted);
  if (!locked.length) {
    console.log('Nothing to do — no products are waiting for confirmation.');
    return;
  }
  console.log(apply ? 'Confirming:' : 'DRY RUN — would confirm (add --yes to do it):');
  for (const p of locked) {
    const handle = `${SITE}/product/${p.id}`;
    if (apply) {
      await api(`/shops/${SHOP}/products/${p.id}/publishing_succeeded.json`, {
        method: 'POST',
        body: JSON.stringify({ external: { id: p.id, handle } }),
      });
      console.log(`  ✔ ${p.id}  ${p.title}  → ${handle}`);
    } else {
      console.log(`  • ${p.id}  ${p.title}  → ${handle}`);
    }
  }
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case 'list': await list(); break;
  case 'register': await register(); break;
  case 'delete-webhook': await deleteWebhook(arg); break;
  case 'simulate': await simulate(); break;
  case 'confirm-locked': await confirmLocked(arg === '--yes'); break;
  default:
    console.log('Usage: node scripts/printify-admin.mjs <list | register | delete-webhook <id> | simulate | confirm-locked [--yes]>');
    process.exit(cmd ? 1 : 0);
}
