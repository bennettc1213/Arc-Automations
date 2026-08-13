// tiny bus so any "start a pilot" button can open the overlay
export function openPilot() {
  window.dispatchEvent(new Event('open-pilot'));
}

export function onOpenPilot(handler) {
  window.addEventListener('open-pilot', handler);
  return () => window.removeEventListener('open-pilot', handler);
}
