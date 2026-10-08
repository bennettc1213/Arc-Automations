import { routeCopyProblem } from '../../supabase/functions/_shared/routes/model.ts';

// the words a business owner should never have to learn to read the public site.
// portal-safe and stores nothing: a list and one function, used by the tests that
// read the rendered homepage. the company's own name is the one place "automations"
// is allowed, so it is taken out before the list is applied.
export const COMPANY_NAME = /\barc automations?\b/gi;

export const OWNER_JARGON = [
  ['n8n', /\bn8n\b/i],
  ['workflow', /\bworkflows?\b/i],
  ['automation', /\bautomations?\b/i],
  ['agent', /\bagents?\b/i],
  ['route', /\broutes?\b/i],
  ['native', /\bnative\b/i],
  ['hybrid', /\bhybrid\b/i],
  ['connected', /\bconnected\b/i],
  ['lifecycle', /\blifecycle\b/i],
  ['module', /\bmodules?\b/i],
  ['orchestration', /\borchestrat\w*/i],
  ['saas', /\bsaas\b/i],
  ['integration', /\bintegrations?\b/i],
  ['zap', /\bzaps?\b/i],
  ['speed-to-lead', /\bspeed[- ]to[- ]lead\b/i],
  ['pipeline', /\bpipelines?\b/i],
  ['template', /\btemplates?\b/i],
];

// a percentage, or an "x in y" — a statistic. none is allowed without its source,
// and the homepage carries no sources, so none is allowed.
const STATISTIC = /\d\s?%|\b\d+\s+(in|out of)\s+\d+\b/i;

// null when the text is fit for an owner, otherwise what is wrong with it.
export function ownerCopyProblem(text) {
  const plain = String(text ?? '').replace(COMPANY_NAME, ' ');
  for (const [word, pattern] of OWNER_JARGON) {
    if (pattern.test(plain)) return `uses "${word}"`;
  }
  if (STATISTIC.test(plain)) return 'quotes a statistic with no source';
  const route = routeCopyProblem(plain);
  // an empty string is the caller's business; the CRM and infrastructure rules are ours
  return route && route !== 'is empty' ? route : null;
}
