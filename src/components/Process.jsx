import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { site } from '../data/site';
import './Process.css';

export default function Process() {
  const [open, setOpen] = useState(0);

  return (
    <section className="process wrap" id="process" aria-labelledby="process-title">
      <p className="eyebrow">{site.process.eyebrow}</p>
      <h2 className="section-title process__title" id="process-title">
        {site.process.title}
      </h2>

      <div className="process__list">
        {site.process.steps.map((item, i) => {
          const isOpen = open === i;
          return (
            <div className={`acc ${isOpen ? 'is-open' : ''}`} key={item.q}>
              <button
                className="acc__head"
                onClick={() => setOpen(isOpen ? -1 : i)}
                aria-expanded={isOpen}
              >
                <span className="acc__idx mono">0{i + 1}</span>
                <span className="acc__q">{item.q}</span>
                <span className="acc__toggle" aria-hidden="true">
                  <i />
                  <i />
                </span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    className="acc__body"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.45, ease: [0.76, 0, 0.24, 1] }}
                  >
                    <p>{item.a}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </section>
  );
}
