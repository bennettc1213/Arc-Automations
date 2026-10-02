import { getRoute, parseRouteKey } from '../../supabase/functions/_shared/routes/model.ts';

// tiny bus so any "start a pilot" button can open the overlay.
// openPilot(key) presets a specific pilot flow (see site.pilot.presets);
// openPilot() with no key runs the generic intake.
// openPilot(key, { route }) also says which arc route the visitor came in on —
// a note for the sales call, never a setup: the route a client is on is
// confirmed in onboarding, not here.
export function openPilot(pilotKey, context) {
  window.dispatchEvent(
    new CustomEvent('open-pilot', { detail: { key: pilotKey, ...pilotContext(context) } }),
  );
}

export function onOpenPilot(handler) {
  const wrap = (e) => handler(e.detail || {});
  window.addEventListener('open-pilot', wrap);
  return () => window.removeEventListener('open-pilot', wrap);
}

// a known route key and how it was arrived at, or nulls. anything else a caller
// passes — a click event, a typo — is dropped rather than forwarded.
export function pilotContext(context) {
  const route = parseRouteKey(context?.route);
  if (!route) return { route: null, routeSource: null };
  return { route, routeSource: context.routeSource === 'assessment' ? 'assessment' : 'chosen' };
}

// the line the intake email and the booking notes carry, or null with no route.
export function routeNote(context) {
  const { route, routeSource } = pilotContext(context);
  if (!route) return null;
  const how = routeSource === 'assessment' ? 'suggested by the route questions' : 'picked on the site';
  return `route: ${getRoute(route).name} (${how}, to confirm)`;
}
