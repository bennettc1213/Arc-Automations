import { useEffect, useState } from 'react';
import { useReducedMotion } from '../lib/hooks';

/** counter that mechanically steps to a new value when it changes — snap, no fade */
export default function TickOnChange({ value, pad = 2, className = '' }) {
  const reduced = useReducedMotion();
  const [n, setN] = useState(value);

  useEffect(() => {
    if (reduced) {
      setN(value);
      return undefined;
    }
    const iv = setInterval(() => {
      setN((cur) => {
        if (cur === value) {
          clearInterval(iv);
          return cur;
        }
        return cur + Math.sign(value - cur);
      });
    }, 70);
    return () => clearInterval(iv);
  }, [value, reduced]);

  return <span className={className}>{String(n).padStart(pad, '0')}</span>;
}
