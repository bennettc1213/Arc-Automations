// Media manifest — drop real assets into src/assets/media/ using the exact
// filenames listed in ASSETS.md and they are picked up automatically on rebuild.
// Nothing here is stock; missing files render as designed, honest slots.

const files = import.meta.glob('../assets/media/**/*', {
  eager: true,
  query: '?url',
  import: 'default',
});

const byName = {};
for (const [path, url] of Object.entries(files)) {
  const name = path.split('/').pop().toLowerCase();
  byName[name] = url;
}

/** returns the bundled URL for a media filename, or null if not uploaded yet */
export function media(name) {
  if (!name) return null;
  return byName[name.toLowerCase()] ?? null;
}

export function hasMedia(name) {
  return media(name) !== null;
}
