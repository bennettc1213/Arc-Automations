import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../lib/hooks';

/** mechanical counter — ticks up to its value on enter. Snaps, never fades. */
export default function TickNumber({ value, className = '' }) {
  const reduced = useReducedMotion();
  const ref = useRef(null);
  const [n, setN] = useState(value);

  useEffect(() => {
    if (reduced) {
      setN(value);
      return undefined;
    }
    const el = ref.current;
    let iv;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        clearInterval(iv);
        let cur = Math.max(0, value - 2);
        setN(cur);
        if (cur < value) {
          iv = setInterval(() => {
            cur += 1;
            setN(cur);
            if (cur >= value) clearInterval(iv);
          }, 90);
        }
      },
      { threshold: 0.6 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clearInterval(iv);
    };
  }, [value, reduced]);

  return (
    <span ref={ref} className={className}>
      {String(n).padStart(2, '0')}
    </span>
  );
}
