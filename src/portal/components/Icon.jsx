/**
 * the portal's icon set, drawn here rather than installed.
 *
 * an icon library is a second visual language arriving in the codebase: lucide draws round
 * caps and 2px strokes and 24px boxes, and every one of those decisions argues with a site
 * built out of hard 1px hairlines and square corners. these are geometric on purpose —
 * squares, right angles, butt caps — so they read as part of the same drawing as the
 * cursor, the focus ring and the status glyphs.
 *
 * they are also decoration. every one sits next to a written label, so nothing here is
 * load-bearing for meaning and all of it is aria-hidden.
 */

const PATHS = {
  overview: <path d="M2.5 2.5h4.2v4.2H2.5zM9.3 2.5h4.2v4.2H9.3zM2.5 9.3h4.2v4.2H2.5zM9.3 9.3h4.2v4.2H9.3z" />,
  leads: (
    <>
      <path d="M2.5 3.6h1.8M2.5 8h1.8M2.5 12.4h1.8" />
      <path d="M6.6 3.6h6.9M6.6 8h6.9M6.6 12.4h4.4" />
    </>
  ),
  activity: <path d="M1.6 8h3l1.7-4.6L9.1 12l1.6-4h3.7" />,
  automations: (
    <>
      <path d="M2.2 2.4h3.4v3.4H2.2zM10.4 2.4h3.4v3.4h-3.4zM6.3 10.2h3.4v3.4H6.3z" />
      <path d="M5.6 4.1h4.8M4 5.8v2.6h8v-2.6M8 8.4v1.8" />
    </>
  ),
  reliability: (
    <>
      <path d="M2.6 2.6h10.8v10.8H2.6z" />
      <path d="M5 8.2l2 2.1 4-4.6" />
    </>
  ),
  reports: (
    <>
      <path d="M3.4 1.9h9.2v12.2H3.4z" />
      <path d="M5.7 5.2h4.6M5.7 8h4.6M5.7 10.8h2.9" />
    </>
  ),
  account: (
    <>
      <path d="M2.6 2.6h10.8v10.8H2.6z" />
      <path d="M8 5.1v2.2M8 8.7v2.2M5.2 8h1.4M9.4 8h1.4" />
    </>
  ),
  support: (
    <>
      <path d="M2.6 2.6h10.8v10.8H2.6z" />
      <path d="M6.2 6.1c0-1 .8-1.7 1.8-1.7s1.8.7 1.8 1.7c0 1.2-1.8 1.2-1.8 2.5" />
      <path d="M8 10.9h.01" />
    </>
  ),
  search: (
    <>
      <path d="M2.6 2.6h8.2v8.2H2.6z" />
      <path d="M10.9 10.9l2.6 2.6" />
    </>
  ),
  bell: (
    <>
      <path d="M4 6.4a4 4 0 018 0v4h1.3v1.2H2.7V10.4H4z" />
      <path d="M6.5 12.8a1.6 1.6 0 003 0" />
    </>
  ),
  menu: <path d="M2 4h12M2 8h12M2 12h12" />,
  close: <path d="M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" />,
  chevron: <path d="M5.8 3.4L10.4 8l-4.6 4.6" />,
  collapse: <path d="M9.6 3.4L5 8l4.6 4.6M12.8 2.4v11.2" />,
  expand: <path d="M6.4 3.4L11 8l-4.6 4.6M3.2 2.4v11.2" />,
  download: <path d="M8 2.2v7.6M4.8 7l3.2 3 3.2-3M2.8 13.2h10.4" />,
  external: <path d="M6.4 3.2H3.1v9.6h9.6V9.5M9.1 3.2h3.6v3.6M12.7 3.2L7.4 8.5" />,
  filter: <path d="M2.2 3.4h11.6L9.3 8.5v4.4L6.7 11.5V8.5z" />,
  clock: (
    <>
      <path d="M2.6 2.6h10.8v10.8H2.6z" />
      <path d="M8 5.1V8l2.1 1.5" />
    </>
  ),
  signout: <path d="M6.2 2.6H2.8v10.8h3.4M9.2 5.1L12.1 8l-2.9 2.9M12.1 8H6" />,

  /* ── the ops console ──────────────────────────────────────
     same drawing rules as everything above: squares, right angles, butt caps.
     an icon here that came from a library would be the one glyph in the product
     with round caps, and it would read as a different application. */

  /* the roster: four accounts at a glance, one of them flagged */
  roster: (
    <>
      <path d="M2.4 2.6h11.2v3.1H2.4zM2.4 7.2h11.2v3.1H2.4z" />
      <path d="M2.4 11.8h6.8v1.8H2.4z" />
    </>
  ),
  clients: (
    <>
      <path d="M2.4 2.6h5.2v5.2H2.4zM8.4 2.6h5.2v5.2H8.4zM2.4 8.6h5.2v5.2H2.4zM8.4 8.6h5.2v5.2H8.4z" />
    </>
  ),
  /* stacked racks with a status lamp on each */
  servers: (
    <>
      <path d="M2.4 2.8h11.2v4H2.4zM2.4 9.2h11.2v4H2.4z" />
      <path d="M4.4 4.8h.01M4.4 11.2h.01" />
      <path d="M7 4.8h4.4M7 11.2h4.4" />
    </>
  ),
  database: (
    <>
      <path d="M3 3.4h10v9.2H3z" />
      <path d="M3 6.5h10M3 9.6h10" />
    </>
  ),
  /* a key: the id that opens an account */
  identity: (
    <>
      <path d="M2.6 5.2h5.6v5.6H2.6z" />
      <path d="M8.2 8h5.2M11.4 8v2.4M13.4 8v1.8" />
    </>
  ),
  plus: <path d="M8 2.6v10.8M2.6 8h10.8" />,
  check: <path d="M2.8 8.4l3.4 3.4 7-7.6" />,
  copy: (
    <>
      <path d="M5.4 5.4h8.2v8.2H5.4z" />
      <path d="M10.6 5.4V2.4H2.4v8.2h3" />
    </>
  ),
  refresh: (
    <>
      <path d="M13 8a5 5 0 11-1.9-3.9" />
      <path d="M13.4 2.2v3h-3" />
    </>
  ),
  mail: (
    <>
      <path d="M2.2 3.6h11.6v8.8H2.2z" />
      <path d="M2.2 3.6L8 8.8l5.8-5.2" />
    </>
  ),
  phone: <path d="M3 2.8h3.2l1.2 3-1.6 1.2a8 8 0 003.2 3.2l1.2-1.6 3 1.2v3.2a10.6 10.6 0 01-10.2-10.2z" />,
  link: <path d="M6.6 9.4l2.8-2.8M6.2 4.4l1.6-1.6 5.4 5.4-1.6 1.6M9.8 11.6l-1.6 1.6-5.4-5.4 1.6-1.6" />,
  trash: (
    <>
      <path d="M3.2 4.2h9.6M6.4 4.2V2.6h3.2v1.6" />
      <path d="M4.4 4.2l.7 9.2h5.8l.7-9.2" />
    </>
  ),
  edit: <path d="M2.6 11.2l8.2-8.2 2.2 2.2-8.2 8.2H2.6z" />,
  back: <path d="M13.4 8H3M6.6 4.4L3 8l3.6 3.6" />,
  warn: (
    <>
      <path d="M8 1.8l6.2 11.4H1.8z" />
      <path d="M8 6v3.2M8 11.2h.01" />
    </>
  ),
};

export default function Icon({ name, size = 16, className = '' }) {
  const path = PATHS[name];
  if (!path) return null;

  return (
    <svg
      className={`ws-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="butt"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  );
}
