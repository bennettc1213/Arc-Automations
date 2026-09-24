/* the small piece of markdown an assistant reply may use, parsed into plain data.
 *
 * a reply is model output, so it is untrusted text. it is never handed to the DOM as html:
 * this turns it into a tree of paragraphs, lists, code and emphasis, and the component builds
 * react elements from that tree, which escape every character they render. an `<img onerror>`
 * in a reply arrives on screen as those characters. a link survives only if it is https or
 * mailto; anything else is shown as its text.
 *
 * deliberately small: paragraphs, bullet and numbered lists, fenced code, `code`, **bold**,
 * *italic*, [links](https://…). headings come out as bold paragraphs, and anything the parser
 * does not know is text.
 */

const SAFE_HREF = /^(https:\/\/|mailto:)[^\s<>"'`]+$/i;

export function safeHref(href) {
  const value = String(href ?? '').trim();
  return SAFE_HREF.test(value) ? value : null;
}

/* a link target may hold one level of balanced parentheses, so "(…(1))" is read whole and
   judged whole rather than leaving a stray ")" behind. */
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)|(\*[^*\s][^*\n]*?\*|_[^_\s][^_\n]*?_)|(\[[^\]\n]+\]\((?:[^()\s]|\([^()\s]*\))+\))/;

/* one line of text into text, code, strong, em and link nodes. */
export function parseInline(text) {
  const nodes = [];
  let rest = String(text ?? '');
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      nodes.push({ type: 'text', text: rest });
      break;
    }
    if (m.index > 0) nodes.push({ type: 'text', text: rest.slice(0, m.index) });
    const token = m[0];
    if (m[1]) {
      nodes.push({ type: 'code', text: token.slice(1, -1) });
    } else if (m[2]) {
      nodes.push({ type: 'strong', children: parseInline(token.slice(2, -2)) });
    } else if (m[3]) {
      /* an underscore inside a word (ARC_N8N_…) is not emphasis. */
      const before = rest[m.index - 1];
      if (token.startsWith('_') && before && /\w/.test(before)) {
        nodes.push({ type: 'text', text: token });
      } else {
        nodes.push({ type: 'em', children: parseInline(token.slice(1, -1)) });
      }
    } else if (m[4]) {
      const close = token.indexOf('](');
      const label = token.slice(1, close);
      const href = safeHref(token.slice(close + 2, -1));
      nodes.push(href ? { type: 'link', href, children: parseInline(label) } : { type: 'text', text: label });
    }
    rest = rest.slice(m.index + token.length);
  }
  return merge(nodes);
}

function merge(nodes) {
  const out = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === 'text' && last?.type === 'text') last.text += n.text;
    else out.push(n);
  }
  return out;
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/* a reply into blocks. */
export function parseSafeMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'p', children: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (FENCE.test(line)) {
      flushParagraph();
      flushList();
      const code = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }

    if (!line.trim() || RULE.test(line)) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'p', children: [{ type: 'strong', children: parseInline(heading[1]) }] });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { type: 'list', ordered, items: [] };
      }
      list.items.push(parseInline((bullet ?? numbered)[1]));
      continue;
    }

    /* an indented line under a list item continues it. */
    if (list && /^\s{2,}\S/.test(line)) {
      const last = list.items[list.items.length - 1];
      list.items[list.items.length - 1] = merge([...last, { type: 'text', text: ' ' }, ...parseInline(line.trim())]);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}
