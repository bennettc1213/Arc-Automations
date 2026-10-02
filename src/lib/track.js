// the site's one analytics hook. same shape as lib/pilot.js: a window event and
// nothing else, so a component can say what happened without knowing who, if
// anyone, is counting. no vendor script is loaded and nothing leaves the page
// from here — whatever listens later subscribes with onTrack().
// names and keys only: never a name, an email, a phone number or free text.
export const TRACK_EVENT = 'arc-track';

export const ROUTE_EVENTS = {
  picked: 'route_picked',
  opened: 'route_detail_opened',
  answered: 'route_assessment_answered',
  suggested: 'route_assessment_completed',
  reset: 'route_assessment_reset',
  cta: 'route_cta_clicked',
};

export function track(name, detail = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TRACK_EVENT, { detail: { ...detail, name } }));
}

export function onTrack(handler) {
  const wrap = (e) => handler(e.detail || {});
  window.addEventListener(TRACK_EVENT, wrap);
  return () => window.removeEventListener(TRACK_EVENT, wrap);
}
