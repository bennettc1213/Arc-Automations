import { useEffect, useState } from 'react';

/**
 * Focus rings as orange pixel-corners. One overlay, repositioned on focusin.
 * Fixed elements (nav) get a fixed ring; everything else rides the document.
 */
export default function FocusRing() {
  const [box, setBox] = useState(null);

  useEffect(() => {
    const onFocus = (e) => {
      const el = e.target;
      if (!(el instanceof Element)) return;
      // wait a frame so :focus-visible has settled
      requestAnimationFrame(() => {
        if (!el.matches(':focus-visible')) {
          setBox(null);
          return;
        }
        const r = el.getBoundingClientRect();
        const fixed = !!el.closest('.nav');
        setBox({
          fixed,
          top: r.top + (fixed ? 0 : window.scrollY) - 5,
          left: r.left + (fixed ? 0 : window.scrollX) - 5,
          w: r.width + 10,
          h: r.height + 10,
        });
      });
    };
    const clear = () => setBox(null);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', clear);
    window.addEventListener('resize', clear);
    return () => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', clear);
      window.removeEventListener('resize', clear);
    };
  }, []);

  if (!box) return null;
  return (
    <span
      className="focus-ring"
      style={{
        position: box.fixed ? 'fixed' : 'absolute',
        top: box.top,
        left: box.left,
        width: box.w,
        height: box.h,
      }}
      aria-hidden="true"
    >
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
