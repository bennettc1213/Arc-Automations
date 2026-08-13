// tiny bus so any "start a pilot" button can open the overlay.
// openPilot(key) presets a specific pilot flow (see site.pilot.presets);
// openPilot() with no key runs the generic intake.
export function openPilot(pilotKey) {
  window.dispatchEvent(new CustomEvent('open-pilot', { detail: { key: pilotKey } }));
}

export function onOpenPilot(handler) {
  const wrap = (e) => handler(e.detail || {});
  window.addEventListener('open-pilot', wrap);
  return () => window.removeEventListener('open-pilot', wrap);
}
