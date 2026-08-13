import { useEffect, useState } from 'react';
import { useReducedMotion } from '../lib/hooks';

/** monospace label that types itself in while `play` is true */
export default function TypeLabel({ text, play }) {
  const reduced = useReducedMotion();
  const [len, setLen] = useState(text.length);

  useEffect(() => {
    if (reduced || !play) {
      setLen(text.length);
      return undefined;
    }
    setLen(0);
    const iv = setInterval(() => {
      setLen((l) => {
        if (l >= text.length) {
          clearInterval(iv);
          return l;
        }
        return l + 1;
      });
    }, 24);
    return () => clearInterval(iv);
  }, [play, text, reduced]);

  return (
    <span className="typelabel">
      {text.slice(0, len)}
      {len < text.length && <i className="typelabel__caret" />}
    </span>
  );
}
