// A pretend GitHub for trying Battle Map with nothing to connect to (battlemap --demo, npm run mock): four fake repos with
// files and PRs, handed to the hub through the same three calls a real GitHub gets. "you" is the viewer.
import { sampleFiles, samplePRs } from './sample.js';
import { hash, rng } from './hunks.js';
import { needsReason } from './snapshot.js';
import { SyncError } from './providers/github.js';

const tree = (spec) => {
  const out = [];
  for (const dir in spec) for (const [name, loc] of Object.entries(spec[dir])) { const r = rng(hash(`${dir}/${name}`)); out.push({ path: `${dir}/${name}`, loc, complexity: Math.round(loc / (12 + r() * 24)) }); }
  return out;
};
const BILLING = tree({
  'src/invoices': { 'total.ts': 340, 'list.ts': 180, 'pdf.ts': 260, 'numbering.ts': 90 },
  'src/payments': { 'capture.ts': 420, 'refund.ts': 310, 'providers.ts': 230, 'webhooks.ts': 280 },
  'src/ledger': { 'entries.ts': 380, 'reconcile.ts': 450, 'balance.ts': 160 },
  'src/tax': { 'round.ts': 110, 'rates.ts': 520, 'vat.ts': 200 },
  'src/subscriptions': { 'plans.ts': 140, 'proration.ts': 360, 'renewal.ts': 240 },
  migrations: { '0040_invoices.sql': 60, '0041_ledger.sql': 90 },
  test: { 'tax.test.ts': 300, 'capture.test.ts': 380, 'ledger.test.ts': 260, 'proration.test.ts': 220 },
  docs: { 'refunds.md': 80, 'api.md': 200 },
});
const MOBILE = tree({
  'src/screens': { 'Home.tsx': 320, 'Login.tsx': 190, 'Invoices.tsx': 410, 'InvoiceDetail.tsx': 280, 'Settings.tsx': 220, 'Onboarding.tsx': 340 },
  'src/components': { 'Button.tsx': 70, 'Card.tsx': 90, 'List.tsx': 140, 'Chart.tsx': 260, 'Toast.tsx': 80 },
  'src/api': { 'client.ts': 230, 'auth.ts': 150, 'invoices.ts': 120 },
  'src/navigation': { 'Root.tsx': 130, 'Tabs.tsx': 100 },
  ios: { 'AppDelegate.mm': 90, 'Podfile': 60 }, android: { 'MainActivity.kt': 80, 'build.gradle': 110 },
});
// change: 'added' (not on the map yet), 'removed' (a building that comes down) or 'renamed' (moved from `from`); nothing means just changed
const f = (path, add, del, change, from) => ({ path, add, del, ...(change ? { change } : {}), ...(from ? { from } : {}) });
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const pr = (n, title, author, status, files, hAgo, branch, extra) => ({ id: `#${n}`, number: n, title, branch: branch || `${author}/${title.split(' ')[0].toLowerCase()}`, author, status, files, createdAt: ago(hAgo + 30), updatedAt: ago(hAgo), url: `https://github.com/acme/demo/pull/${n}`, ...extra });
const BILLING_PRS = () => [
  pr(118, 'ENG-481 Round tax per line, not per invoice', 'maya', 'review_requested', [f('src/tax/round.ts', 62, 18), f('src/invoices/total.ts', 20, 9), f('test/round.test.ts', 80, 0, 'added')], 5),
  pr(121, 'ENG-433 CSV export for invoices', 'you', 'ci_failing', [f('src/invoices/export.ts', 140, 0, 'added'), f('src/invoices/list.ts', 12, 3)], 3),
  pr(124, 'ENG-418 Idempotency keys on payment capture', 'devon', 're_review', [f('src/payments/capture.ts', 96, 40), f('src/payments/keys.ts', 58, 0, 'added'), f('migrations/0042_keys.sql', 24, 0, 'added')], 9),
  pr(126, 'Drop the legacy providers shim', 'ines', 'changes_requested', [f('src/payments/webhooks.ts', 110, 35), f('src/payments/providers.ts', 0, 230, 'removed')], 20),
  pr(127, 'ENG-440 Audit trail for refunds', 'you', 'ready_to_merge', [f('src/payments/refund.ts', 74, 12), f('src/ledger/entries.ts', 30, 4), f('docs/refunds.md', 22, 0)], 28),
  pr(130, 'docs: describe the refund flow', 'kofi', 'draft', [f('docs/refunds.md', 60, 8), f('docs/api.md', 14, 2)], 50),
  pr(133, 'ENG-412 Cap partial-month credits, and move proration into billing/', 'maya', 'review_requested', [f('src/subscriptions/billing/proration.ts', 88, 41, 'renamed', 'src/subscriptions/proration.ts'), f('test/proration.test.ts', 52, 10)], 12),
  pr(136, 'ENG-440 Payment provider adapters (Stripe, Adyen)', 'you', 'review_requested', [f('src/payments/providers/stripe.ts', 180, 0, 'added'), f('src/payments/providers/adyen.ts', 150, 0, 'added'), f('src/payments/providers/types.ts', 40, 0, 'added'), f('src/payments/providers/index.ts', 30, 0, 'added'), f('src/payments/capture.ts', 22, 9)], 2),
];
const MOBILE_PRS = () => [
  pr(41, 'ENG-431 Invoices list: pull to refresh', 'you', 'review_requested', [f('src/screens/Invoices.tsx', 64, 18), f('src/components/List.tsx', 22, 4), f('src/components/PullToRefresh.tsx', 70, 0, 'added')], 4),
  pr(44, 'ENG-470 Onboarding checklist', 'ines', 'ci_failing', [f('src/screens/Onboarding.tsx', 210, 0), f('src/components/Card.tsx', 18, 2)], 7),
  pr(45, 'Silent token refresh', 'agent', 'review_requested', [f('src/api/auth.ts', 70, 25), f('src/api/client.ts', 31, 9)], 15),
  pr(47, 'ENG-460 Tab bar badges; replace Toast with the shared one', 'devon', 're_review', [f('src/navigation/Tabs.tsx', 40, 11), f('src/components/Toast.tsx', 0, 80, 'removed'), f('src/screens/Settings.tsx', 6, 2)], 26),
];

// acme/storefront: PRs whose BASE is not the default branch's head. Since these PRs branched, `main` moved src/cart/ to
// src/checkout/cart/, moved src/utils/format.ts to src/lib/format.ts, deleted src/legacy/oldCheckout.ts and added src/lib/money.ts.
// GitHub lists a PR's files against its own merge base, so a stale PR names paths the way they were when it branched: those paths are
// not on the map. `base` (the branch it targets), `behind` (commits it is behind that branch) and `mergeState` are what GitHub knows and
// the feed does not carry yet; they are here so the cases say what is true. test/stale-base.test.js records what the map does with each.
const STORE = tree({
  'src/checkout/cart': { 'Cart.tsx': 300, 'CartItem.tsx': 120, 'totals.ts': 140, 'promo.ts': 180 },
  'src/checkout': { 'Checkout.tsx': 380, 'Payment.tsx': 260 },
  'src/lib': { 'format.ts': 90, 'money.ts': 110, 'http.ts': 150 },
  'src/catalog': { 'Catalog.tsx': 340, 'Product.tsx': 280, 'search.ts': 200 },
  'src/account': { 'Login.tsx': 180, 'Profile.tsx': 220 },
  config: { 'build.ts': 70 },
  test: { 'cart.test.ts': 220 },
});
const stale = (base, behind, mergeState) => ({ base, behind, mergeState });
const STORE_PRS = () => [
  pr(300, 'Control: edit a product page (up to date)', 'you', 'review_requested', [f('src/catalog/Product.tsx', 44, 12)], 3, undefined, stale('main', 0, 'CLEAN')),
  pr(301, 'Promo codes: edit the cart (cart moved on main)', 'you', 'review_requested', [f('src/cart/Cart.tsx', 60, 14), f('src/cart/totals.ts', 22, 6)], 6, undefined, stale('main', 41, 'DIRTY')),
  pr(302, 'Cart rewrite, 5 files in the folder main renamed', 'devon', 'review_requested', [f('src/cart/Cart.tsx', 120, 80), f('src/cart/CartItem.tsx', 40, 10), f('src/cart/totals.ts', 30, 12), f('src/cart/promo.ts', 55, 3), f('src/cart/Coupons.tsx', 90, 0, 'added')], 30, undefined, stale('main', 41, 'DIRTY')),
  pr(303, 'Tidy checkout (touches a file main deleted)', 'maya', 'changes_requested', [f('src/legacy/oldCheckout.ts', 18, 7), f('src/checkout/Checkout.tsx', 36, 20)], 18, undefined, stale('main', 25, 'DIRTY')),
  pr(304, 'Remove the old formatter (main moved it)', 'ines', 'review_requested', [f('src/utils/format.ts', 0, 90, 'removed'), f('src/lib/http.ts', 8, 2)], 40, undefined, stale('main', 12, 'DIRTY')),
  pr(305, 'Move promo.ts into its own folder (main moved it first)', 'kofi', 'review_requested', [f('src/checkout/promo/promo.ts', 6, 2, 'renamed', 'src/cart/promo.ts')], 22, undefined, stale('main', 41, 'DIRTY')),
  pr(306, 'Move format.ts to lib/ (main already did)', 'agent', 'review_requested', [f('src/lib/format.ts', 4, 1, 'renamed', 'src/utils/format.ts')], 9, undefined, stale('main', 12, 'DIRTY')),
  pr(307, 'Add money.ts (main added it too)', 'devon', 'ci_failing', [f('src/lib/money.ts', 120, 0, 'added'), f('src/checkout/Payment.tsx', 14, 3)], 14, undefined, stale('main', 8, 'DIRTY')),
  pr(308, 'Backport search fix to the 2.x release', 'maya', 'review_requested', [f('src/catalog/search.ts', 30, 8), f('src/catalog/v2/search.ts', 110, 0, 'added'), f('src/catalog/v2/index.ts', 12, 0, 'added')], 50, undefined, stale('release/2.x', 260, 'CLEAN')),
  pr(309, 'New search filters', 'you', 'review_requested', [f('src/catalog/filters.ts', 140, 0, 'added'), f('src/catalog/search.ts', 26, 5)], 8, 'you/filters', stale('main', 0, 'CLEAN')),
  pr(310, 'Filter chips (stacked on #309)', 'you', 'draft', [f('src/catalog/filters.ts', 34, 6), f('src/catalog/Catalog.tsx', 28, 4)], 4, undefined, stale('you/filters', 0, 'CLEAN')),
];
const REPOS = {
  'acme/platform': { files: sampleFiles, prs: samplePRs, description: 'The monolith (the built-in sample)', estimated: false },
  'acme/billing-api': { files: () => BILLING, prs: BILLING_PRS, description: 'Invoices, payments and the ledger', estimated: true },
  'acme/mobile-app': { files: () => MOBILE, prs: MOBILE_PRS, description: 'The customer app', estimated: true },
  'acme/storefront': { files: () => STORE, prs: STORE_PRS, description: 'The shop front end: PRs on old or different bases', estimated: true },
};

export function demoProvider() {
  const find = (ref) => REPOS[`${ref.owner}/${ref.name}`.toLowerCase()] || (() => { throw new SyncError(`HTTP 404: Not Found. This is the demo: try ${Object.keys(REPOS).join(' or ')}`); })();
  return {
    names: Object.keys(REPOS),
    async tree(ref) { const r = find(ref); return { files: r.files(), branch: 'main', warnings: [], estimated: r.estimated, description: r.description, private: false }; },
    async stats(ref) {
      const prs = find(ref).prs().map((p) => ({ ...p, mine: p.author === 'you' }));
      return { open: prs.length, mine: prs.filter((p) => p.mine).length, needs: prs.filter((p) => needsReason(p)).length, viewer: 'you', capped: false };
    },
    async prs(ref) { const prs = find(ref).prs(); return { prs, viewer: 'you', warnings: [], counts: { open: prs.length, ended: 0 } }; },
  };
}
