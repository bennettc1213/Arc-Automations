import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../../lib/hooks';

/**
 * mechanical counter for portal values. same language as the site's TickNumber —
 * it steps, it never eases or crossfades — but magnitude-aware.
 *
 * TickNumber steps by exactly 1 every 90ms, which is right for a two-digit
 * section index and wrong here: 183 leads would take sixteen seconds to arrive.
 * this covers the distance in a fixed number of steps instead, so every value
 * lands in the same ~700ms regardless of size.
 */
export default function TickValue({ value, format = (n) => String(n), className = '' }) {
  const reduced = useReducedMotion();
  const [n, setN] = useState(value);
  const from = useRef(value);

  useEffect(() => {
    if (reduced || value === from.current) {
      setN(value);
      from.current = value;
      return undefined;
    }

    const start = from.current;
    const steps = 8;
    const stride = (value - start) / steps;
    let i = 0;

    const iv = setInterval(() => {
      i += 1;
      // the last step writes the exact target rather than a rounded stride, so
      // the number that settles is always the real one.
      setN(i >= steps ? value : Math.round(start + stride * i));
      if (i >= steps) clearInterval(iv);
    }, 55);

    from.current = value;
    return () => clearInterval(iv);
  }, [value, reduced]);

  return <span className={className}>{format(n)}</span>;
}
