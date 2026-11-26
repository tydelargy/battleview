// Sample repo + PRs. Mirrors what a real provider would hand us.
import { hash, rng } from './hunks.js';

const SPEC = {
  'apps/api': { routes: ['auth.ts', 'users.ts', 'billing.ts', 'orders.ts', 'webhooks.ts', 'search.ts'], models: ['user.ts', 'org.ts', 'invoice.ts', 'order.ts', 'session.ts'], middleware: ['rateLimit.ts', 'authz.ts', 'logging.ts', 'cors.ts'], jobs: ['emailQueue.ts', 'reconcile.ts', 'exportCsv.ts'] },
  'apps/web': { pages: ['login.tsx', 'dashboard.tsx', 'settings.tsx', 'billing.tsx', 'orders.tsx', 'onboarding.tsx', 'admin.tsx'], components: ['Table.tsx', 'Modal.tsx', 'Chart.tsx', 'Nav.tsx', 'Form.tsx', 'Toast.tsx', 'Avatar.tsx', 'Sidebar.tsx'], hooks: ['useAuth.ts', 'useQuery.ts', 'useOrders.ts'] },
  'packages/core': { domain: ['pricing.ts', 'tax.ts', 'ledger.ts', 'inventory.ts'], utils: ['dates.ts', 'money.ts', 'retry.ts', 'ids.ts'] },
  'packages/sdk': { client: ['http.ts', 'auth.ts', 'types.ts', 'errors.ts', 'pagination.ts'] },
  infra: { terraform: ['vpc.tf', 'ecs.tf', 'rds.tf', 'iam.tf', 'cdn.tf'], ci: ['build.yml', 'deploy.yml', 'lint.yml'] },
  docs: { guides: ['quickstart.md', 'auth.md', 'webhooks.md', 'billing.md'] },
  tools: { scripts: ['release.ts', 'codegen.ts', 'bump.ts'] },
};
const BIG = { 'pricing.ts': 1450, 'billing.ts': 980, 'ledger.ts': 820, 'http.ts': 520, 'ecs.tf': 610, 'Table.tsx': 700, 'billing.tsx': 760, 'auth.ts': 430, 'invoice.ts': 540 };

export function sampleFiles() {
  const out = [];
  for (const pkg in SPEC) for (const sub in SPEC[pkg]) for (const f of SPEC[pkg][sub]) {
    const path = `${pkg}/${sub}/${f}`, r = rng(hash(path));
    const g = Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(6.283 * r());
    const loc = BIG[f] || Math.max(24, Math.min(900, Math.round(Math.exp(4.7 + 0.8 * g))));
    out.push({ path, loc, complexity: Math.round(loc / (14 + r() * 26)) });
  }
  return out;
}

const f = (path, add, del) => ({ path, add, del });
export function samplePRs() {
  // Staggered "last updated" times, so the track list has a recent-activity order to show.
  return SAMPLE.map((p, i) => ({ ...p, updatedAt: new Date(Date.now() - (2 + i * 7) * 3600e3).toISOString() }));
}
const SAMPLE = [
  { id: '#2291', number: 2291, title: 'ENG-412 Proration engine rewrite', branch: 'maya/ENG-412-proration', author: 'maya', status: 'changes_requested', files: [f('packages/core/domain/pricing.ts', 420, 310), f('apps/api/routes/billing.ts', 88, 40), f('packages/core/domain/ledger.ts', 60, 12), f('apps/web/pages/billing.tsx', 30, 8)] },
  { id: '#2296', number: 2296, title: 'ENG-418 Invoice model and migration', branch: 'devon/ENG-418-invoice-model', author: 'devon', status: 're_review', files: [f('apps/api/models/invoice.ts', 150, 20), f('apps/api/models/order.ts', 22, 5), f('apps/api/jobs/reconcile.ts', 95, 60), f('packages/core/domain/ledger.ts', 10, 0)] },
  { id: '#2302', number: 2302, title: 'ENG-431 Billing page redesign', branch: 'you/ENG-431-billing-page', author: 'you', status: 'ci_failing', files: [f('apps/web/pages/billing.tsx', 260, 190), f('apps/web/components/Table.tsx', 40, 30), f('apps/web/components/Chart.tsx', 75, 10), f('apps/web/hooks/useOrders.ts', 20, 4)] },
  { id: '#2311', number: 2311, title: 'ENG-481 Tax rounding fix', branch: 'agent/ENG-481-tax-rounding', author: 'agent', status: 'review_requested', files: [f('packages/core/domain/tax.ts', 48, 20), f('packages/core/utils/money.ts', 22, 9), f('packages/core/domain/pricing.ts', 9, 3)] },
  { id: '#2279', number: 2279, title: 'ENG-377 Rate limit login attempts', branch: 'ines/ENG-377-rate-limit', author: 'ines', status: 'review_requested', files: [f('apps/api/middleware/rateLimit.ts', 130, 0), f('apps/api/routes/auth.ts', 44, 12), f('apps/api/middleware/authz.ts', 18, 6)] },
  { id: '#2284', number: 2284, title: 'ENG-380 Session rotation', branch: 'you/ENG-380-session-rotation', author: 'you', status: 'ready_to_merge', files: [f('apps/api/models/session.ts', 70, 30), f('apps/api/routes/auth.ts', 25, 9), f('apps/web/hooks/useAuth.ts', 30, 14), f('packages/sdk/client/auth.ts', 36, 8)] },
  { id: '#2299', number: 2299, title: 'ENG-390 SDK token refresh', branch: 'agent/ENG-390-token-refresh', author: 'agent', status: 'review_requested', files: [f('packages/sdk/client/http.ts', 88, 20), f('packages/sdk/client/auth.ts', 60, 10), f('packages/sdk/client/errors.ts', 14, 0)] },
  { id: '#2305', number: 2305, title: 'ENG-455 Move API to ECS Fargate', branch: 'kofi/ENG-455-fargate', author: 'kofi', status: 're_review', files: [f('infra/terraform/ecs.tf', 210, 80), f('infra/terraform/vpc.tf', 40, 10), f('infra/terraform/iam.tf', 55, 12), f('infra/ci/deploy.yml', 70, 25)] },
  { id: '#2308', number: 2308, title: 'ENG-460 CDN cache rules', branch: 'kofi/ENG-460-cdn', author: 'kofi', status: 'draft', files: [f('infra/terraform/cdn.tf', 60, 5), f('infra/ci/build.yml', 12, 3)] },
  { id: '#2313', number: 2313, title: 'ENG-470 Onboarding checklist', branch: 'ines/ENG-470-onboarding', author: 'ines', status: 'ci_failing', files: [f('apps/web/pages/onboarding.tsx', 310, 0), f('apps/web/components/Form.tsx', 45, 12), f('apps/web/components/Toast.tsx', 20, 0), f('apps/web/hooks/useAuth.ts', 8, 2)] },
  { id: '#2316', number: 2316, title: 'ENG-472 Webhooks guide', branch: 'maya/ENG-472-webhooks-docs', author: 'maya', status: 'ready_to_merge', files: [f('docs/guides/webhooks.md', 120, 30), f('apps/api/routes/webhooks.ts', 16, 4)] },
  // Deliberate loose ends for the insights panel:
  { id: '#2320', number: 2320, title: 'chore: bump esbuild', branch: 'devon/bump-esbuild', author: 'devon', status: 'review_requested', files: [f('tools/scripts/bump.ts', 14, 6), f('tools/scripts/release.ts', 4, 4)] },
  { id: '#2322', number: 2322, title: 'ENG-999 Hotfix lint cache key', branch: 'devon/ENG-999-lint-cache', author: 'devon', status: 'review_requested', files: [f('infra/ci/lint.yml', 9, 3)] },
];
