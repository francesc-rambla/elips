/*
 * elips — Editor de LIcitacions PúbliqueS
 * Copyright (C) 2026  Francesc Rambla i Marigot
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import katex from 'katex';
import MarkdownIt from 'markdown-it';
import TurndownService from 'turndown';
import { gfm as turndownGfm } from 'turndown-plugin-gfm';

// ============================================================================
// HTML -> Markdown+Jinja2  (turndown: a real, battle-tested HTML->Markdown
// converter, used both to sync live canvas edits back to source and to
// convert pasted HTML/rich text to Markdown before it ever enters the source).
// ============================================================================

const stripRawJinjaRef = (raw) => {
  let expr = (raw || '').trim();
  if (expr.endsWith('.')) expr = expr.slice(0, -1);
  return expr;
};

// Every chip/block below builds its HTML by interpolating a Jinja2
// expression (a condition, a variable path, a filter arg...) straight into
// a template literal — as a data-*="..." attribute value AND/OR as the
// element's visible text. Both positions are HTML syntax, not plain text:
// an expression containing '"' (e.g. `general.valor == "valor vàlid"`, or
// any filter argument written with double quotes) truncates the attribute
// value at that quote when the string is parsed as HTML, silently
// dropping everything after it; one containing '<'/'>' (e.g. `{% if x < 5
// %}`) corrupts the surrounding markup outright. Escaping is safe to apply
// unconditionally in both positions — for the overwhelmingly common case
// with none of these characters it's a complete no-op.
const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// Converts one branch's body (a .j-content element) to Markdown. Falls back to
// an empty string for a missing/empty node so callers can trim safely.
const branchBodyToMarkdown = (td, contentEl) => (contentEl ? td.turndown(contentEl).trim() : '');

const jinjaBlockToMarkdown = (td, node) => {
  const type = node.getAttribute('data-type') || 'if';
  const endTag = type === 'for' ? 'endfor' : 'endif';
  // Which extraction path to use is decided by the DOM's *actual* shape,
  // not the inline/data-layout flag: the "Inline"/"Bloc" toggle button
  // (TemplateEditor.vue) only flips that flag on the existing DOM — it
  // doesn't restructure it — and relies on this serialization, followed by
  // a full re-render from the resulting Markdown, to produce the other
  // shape. Trusting the flag alone here would try to read
  // .j-inline-tag/.j-content pairs out of a DOM that's still block-shaped
  // (.j-head/.j-branch/.j-content/.j-footer) or vice versa, find none, and
  // silently emit nothing — discarding the whole block's content the
  // instant the button is clicked.
  const domIsInlineShape = !!node.querySelector(':scope > .j-inline-tag');

  if (domIsInlineShape) {
    // Inline layout: alternating <span class="j-inline-tag">{% ... %}</span> and
    // <span class="j-content">body</span> children carry the exact tag text and
    // per-branch body already — just concatenate them in DOM order.
    let out = '';
    node.childNodes.forEach((child) => {
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      if (child.classList.contains('j-inline-tag')) {
        out += child.textContent;
      } else if (child.classList.contains('j-content')) {
        out += branchBodyToMarkdown(td, child);
      }
    });
    return out;
  }

  // Block-shaped DOM — also what a block still looks like right after
  // clicking "Inline" (see above), so wantsInlineOutput controls only the
  // *separator* between tag and body (none, for a single inline line, vs a
  // newline for the usual multi-line block syntax), never which children
  // this reads.
  //
  // The condition itself is read from the .j-head's .j-cond-text span, not
  // from this node's own data-cond: the visual editor (openBlockModal/
  // onBlockApply in TemplateEditor.vue) only ever keeps .j-cond-text's
  // data-cond up to date (on both initial creation and edits), the same way
  // the elif branch condition below is read from its own .j-cond-text.
  const wantsInlineOutput = node.classList.contains('inline') || node.getAttribute('data-layout') === 'inline';
  const sep = wantsInlineOutput ? '' : '\n';
  const headCond = node.querySelector(':scope > .j-head .j-cond-text')?.getAttribute('data-cond');
  let out = `{% ${type} ${headCond ?? node.getAttribute('data-cond') ?? ''} %}${sep}`;
  node.childNodes.forEach((child) => {
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    if (child.classList.contains('j-content')) {
      const body = branchBodyToMarkdown(td, child);
      if (body) out += body + sep;
    } else if (child.classList.contains('j-branch')) {
      const branchType = child.getAttribute('data-type');
      if (branchType === 'else') {
        out += `{% else %}${sep}`;
      } else {
        const cond = child.querySelector('.j-cond-text')?.getAttribute('data-cond') || '';
        out += `{% elif ${cond} %}${sep}`;
      }
    }
  });
  out += `{% ${endTag} %}`;
  return out;
};

const dynamicTableToMarkdown = (td, table, loopExpr) => {
  const rows = Array.from(table.querySelectorAll('tr'));
  let md = `\n<!-- DYNAMIC_TABLE_START:${loopExpr} -->\n`;

  rows.forEach((row, rIdx) => {
    const cells = Array.from(row.querySelectorAll('th, td'));
    const cellTexts = cells.map((cell) => {
      const chip = cell.querySelector(':scope > .j-var-chip');
      if (chip) return `{{ ${stripRawJinjaRef(chip.getAttribute('data-raw'))} }}`;
      return td.turndown(cell).trim();
    });
    const rowStr = '| ' + cellTexts.join(' | ') + ' |\n';
    md += row.classList.contains('j-row-loop') ? `{% for ${loopExpr} %}\n${rowStr}{% endfor %}\n` : rowStr;

    if (rIdx === 0 || row.querySelector('th')) {
      md += '| ' + cells.map((c) => {
        const align = c.getAttribute('data-align') || 'left';
        return align === 'center' ? ':---:' : (align === 'right' ? '---:' : '---');
      }).join(' | ') + ' |\n';
    }
  });

  return md + '<!-- DYNAMIC_TABLE_END -->\n';
};

const transposedTableToMarkdown = (td, table, loopExpr) => {
  const thLoop = table.querySelector('th[data-jinja-col-loop]');
  const thChip = thLoop ? thLoop.querySelector('.j-var-chip') : null;
  const colHeader = thChip ? stripRawJinjaRef(thChip.getAttribute('data-raw')).split('.').pop() : '';

  const rowKeys = [];
  table.querySelectorAll('tbody tr').forEach((r) => {
    const chip = r.querySelector('td[data-jinja-col-loop] .j-var-chip');
    rowKeys.push(chip ? stripRawJinjaRef(chip.getAttribute('data-raw')).split('.').pop() : '');
  });

  let md = `\n<!-- TRANSPOSED_TABLE_START:${loopExpr};colHeader=${colHeader};rows=${rowKeys.join(',')} -->\n`;

  const rows = Array.from(table.querySelectorAll('tr'));
  rows.forEach((row, rIdx) => {
    const cells = Array.from(row.querySelectorAll('th, td'));
    let rowStr = '| ';
    cells.forEach((cell) => {
      const colLoop = cell.getAttribute('data-jinja-col-loop');
      const chip = cell.querySelector(':scope > .j-var-chip');
      const cellText = chip ? `{{ ${stripRawJinjaRef(chip.getAttribute('data-raw'))} }}` : td.turndown(cell).trim();
      rowStr += colLoop ? `{% for ${colLoop} %}${cellText} | {% endfor %}` : `${cellText} | `;
    });
    md += rowStr + '\n';

    if (rIdx === 0 || row.querySelector('th')) {
      let divStr = '| ';
      cells.forEach((cell) => {
        const colLoop = cell.getAttribute('data-jinja-col-loop');
        const align = cell.getAttribute('data-align') || 'left';
        const alignStr = align === 'center' ? ':---:' : (align === 'right' ? '---:' : '---');
        divStr += colLoop ? `{% for ${colLoop} %}${alignStr} | {% endfor %}` : `${alignStr} | `;
      });
      md += divStr + '\n';
    }
  });

  return md + '<!-- TRANSPOSED_TABLE_END -->\n';
};

let cachedTurndownService = null;

// A "word" character for deciding whether an underscore sits inside a word
// (Unicode-aware — a plain \w would treat every accented Catalan letter as
// non-word and over-escape around them).
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

const buildTurndownService = () => {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  td.use(turndownGfm);

  // Turndown's default escape() backslash-escapes every '_' in plain text
  // unconditionally (markdownEscapes has an unanchored /_/g, unlike '-'/'+'/
  // '#'/etc., which are all anchored to the start of a line) — correct for
  // text turndown itself might render with underscore emphasis, but this
  // app's emDelimiter is '*', so a literal '_' reaching a text node is
  // never turndown's own emphasis syntax, only genuine prose/identifier
  // text (Catalan words, Excel/Jinja2 field names like "num_expedient")
  // that this app deals in constantly. Per CommonMark/GFM, an underscore
  // fully surrounded by word characters can never open/close emphasis
  // (GFM explicitly disables intraword "_" emphasis), so it needs no
  // escaping; keep escaping only the ones that could actually be
  // mistaken for an emphasis delimiter (adjacent to whitespace/punctuation
  // or string start/end).
  const defaultEscape = td.escape.bind(td);
  td.escape = (text) => defaultEscape(text).replace(/\\_/g, (m, offset, s) => {
    const prev = s[offset - 1];
    const next = s[offset + 2];
    return (prev && next && WORD_CHAR_RE.test(prev) && WORD_CHAR_RE.test(next)) ? '_' : m;
  });

  // Safety net: these are pure UI chrome (icons/buttons/condition labels) that
  // should only ever be reached through the dedicated .jinja-block rule below,
  // which reads them directly off data-* attributes rather than converting
  // their rendered text. If the DOM is ever in an unexpected shape and one of
  // these is visited directly, drop it rather than leaking button/icon text.
  td.remove((node) => node.nodeType === Node.ELEMENT_NODE && (
    node.classList.contains('j-head') || node.classList.contains('j-actions') ||
    node.classList.contains('j-footer') || node.classList.contains('j-inline-tag') ||
    node.classList.contains('j-inline-toolbar') || node.classList.contains('j-cond-text') ||
    node.classList.contains('table-edit-btn') || node.classList.contains('trailing-editable-line')
  ));

  td.addRule('jinjaVarChip', {
    filter: (node) => node.nodeType === Node.ELEMENT_NODE && node.classList.contains('j-var-chip'),
    replacement: (content, node) => `{{ ${stripRawJinjaRef(node.getAttribute('data-raw'))} }}`,
  });

  td.addRule('latexChip', {
    filter: (node) => node.nodeType === Node.ELEMENT_NODE && node.classList.contains('latex-chip'),
    replacement: (content, node) => {
      const expr = node.getAttribute('data-expr') || '';
      return node.getAttribute('data-type') === 'display' ? `$$${expr}$$` : `$${expr}$`;
    },
  });

  td.addRule('pandocMetadataChip', {
    filter: (node) => node.nodeType === Node.ELEMENT_NODE && node.classList.contains('pandoc-metadata-chip'),
    replacement: (content, node) => {
      const rawYaml = decodeURIComponent(node.getAttribute('data-raw') || '').trim();
      return rawYaml ? `---\n${rawYaml}\n---\n\n` : '';
    },
  });

  // Registered *after* the gfm plugin so it wins for tables that carry our
  // Jinja loop markers (turndown checks custom rules most-recently-added-first);
  // plain tables fall through to the gfm plugin's own table rule untouched.
  td.addRule('jinjaTable', {
    filter: (node) => node.nodeType === Node.ELEMENT_NODE && node.tagName === 'TABLE' &&
      !!(node.querySelector('[data-jinja-for]') || node.querySelector('[data-jinja-col-loop]')),
    replacement: (content, node) => {
      const rowLoop = node.querySelector('[data-jinja-for]');
      if (rowLoop) return dynamicTableToMarkdown(td, node, rowLoop.getAttribute('data-jinja-for') || '');
      const colLoop = node.querySelector('[data-jinja-col-loop]');
      return transposedTableToMarkdown(td, node, colLoop.getAttribute('data-jinja-col-loop') || '');
    },
  });

  td.addRule('jinjaBlock', {
    filter: (node) => node.nodeType === Node.ELEMENT_NODE && node.classList.contains('jinja-block'),
    replacement: (content, node) => jinjaBlockToMarkdown(td, node),
  });

  return td;
};

const getTurndownService = () => {
  if (!cachedTurndownService) cachedTurndownService = buildTurndownService();
  return cachedTurndownService;
};

// Converts a DOM element (or fragment/Range contents) to Markdown+Jinja2 source.
// Used for: syncing live canvas edits back to editorText, converting pasted
// HTML to Markdown, and computing what goes on the clipboard on copy/cut.
export const htmlToMarkdown = (element) => {
  const clone = element.cloneNode(true);
  clone.querySelectorAll('.trailing-editable-line').forEach((el) => el.remove());
  const markdown = getTurndownService().turndown(clone);
  return markdown.replace(/\n{3,}/g, '\n\n').trim();
};

// ============================================================================
// Markdown+Jinja2 -> HTML  (markdown-it: a real, spec-compliant Markdown
// parser, used to render the visual canvas). Custom syntax (Jinja2 tags,
// tables with our loop-marker convention, math, the Pandoc YAML header) is
// extracted/handled around a core markdown-it render call, which is left to
// do everything markdown-it is actually good at: headings, emphasis, lists
// (including nesting), paragraphs, and plain tables — exactly the constructs
// that were fragile under the old hand-rolled regex compiler.
// ============================================================================

const ICON_LOOP = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>';
const ICON_IF = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
const ICON_INLINE_TOGGLE = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
const ICON_TRASH = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const ICON_EDIT = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';

// A dedicated edit affordance for dynamic/transposed tables — double-clicking
// the header is the only other way in, and a double-click on a <th> also
// fires two single clicks first, silently toggling that column's alignment
// twice as an unwanted side effect. This is a plain sibling placed right
// before <table> (never a child of it — a stray non-<tr> child of <table>
// would just get foster-parented out by HTML parsing anyway), so it needs no
// wrapper and can't perturb the table's own cell/column structure.
const tableEditButtonHtml = () => `<div class="table-edit-btn" contenteditable="false" title="Edita la configuració de la taula">${ICON_EDIT} Edita taula</div>`;

const btnLayoutHtml = () => `<button class="j-btn-mini btn-layout" style="background-color:var(--color-primary);color:white;border:none;display:inline-flex;align-items:center;gap:3px;" title="Canvia a mode integrat al text (Inline)">${ICON_INLINE_TOGGLE} <span>Inline</span></button>`;
const btnToBlockHtml = () => `<button class="j-btn-mini btn-to-block" style="background-color:var(--color-primary);color:white;border:none;display:inline-flex;align-items:center;gap:3px;" title="Canvia a mode Bloc">${ICON_INLINE_TOGGLE} <span>Bloc</span></button>`;
const btnTrashHtml = (title) => `<button class="j-btn-mini btn-trash" style="background-color:var(--color-danger);color:white;border:none;display:inline-flex;align-items:center;justify-content:center;" title="${title}">${ICON_TRASH}</button>`;
const btnBranchTrashHtml = () => '<button class="j-btn-mini btn-branch-trash" style="background-color:var(--color-danger);color:white;border:none;display:inline-flex;align-items:center;justify-content:center;" title="Elimina la branca">' + ICON_TRASH + '</button>';

// The label and condition text next to this sit inside .j-head > div:first-
// child > span, hidden by CSS until the block has focus-within (see
// TemplateEditor.vue's collapse-to-icon styling) — this button is a plain
// <button>, not a <span>, so that CSS rule leaves it alone and it stays
// visible even when the block is collapsed. Without it, a collapsed
// block's condition becomes unreachable: the only other way to edit it is
// clicking the (now-hidden) condition text itself.
const btnHeadEditHtml = () => `<button class="j-btn-mini j-head-edit-btn" style="background:none;border:none;color:inherit;padding:0;display:inline-flex;align-items:center;cursor:pointer;" title="Edita la condició">${ICON_EDIT}</button>`;

const forHeadHtml = (cond) => { const c = escapeHtml(cond); return `<div class="j-head" data-type="for"><div style="display:flex;align-items:center;gap:4px;">${ICON_LOOP}${btnHeadEditHtml()} <span style="font-weight:700;color:var(--color-primary);">PER CADA:</span> <span class="j-cond-text" data-cond="${c}">${c}</span></div><div class="j-actions">${btnLayoutHtml()}${btnTrashHtml('Elimina el bucle')}</div></div>`; };
const ifHeadHtml = (cond) => { const c = escapeHtml(cond); return `<div class="j-head" data-type="if"><div style="display:flex;align-items:center;gap:4px;">${ICON_IF}${btnHeadEditHtml()} <span style="font-weight:700;color:#b45309;">SI:</span> <span class="j-cond-text" data-cond="${c}">${c}</span></div><div class="j-actions">${btnLayoutHtml()}<button class="j-btn-mini btn-elif" title="Afegeix branca O SI (ELIF)">+ ELIF</button><button class="j-btn-mini btn-else" title="Afegeix branca EN CAS CONTRARI (ELSE)">+ ELSE</button>${btnTrashHtml('Elimina el condicional')}</div></div>`; };

// Builds the interactive .jinja-block HTML for a block-layout for/if, given its
// branches ([{ keyword: 'for'|'if'|'elif'|'else', cond, body }]) and a function
// to recursively compile each branch's Markdown body to HTML.
const buildJinjaBlockHtml = (type, branches, compileFn) => {
  const openCond = branches[0].cond;
  const openHead = type === 'for' ? forHeadHtml(openCond) : ifHeadHtml(openCond);
  let html = `<div class="jinja-block" contenteditable="false" data-layout="block" data-type="${type}" data-cond="${escapeHtml(openCond)}">${openHead}<div class="j-content" contenteditable="true">${compileFn(branches[0].body)}</div>`;

  for (let i = 1; i < branches.length; i++) {
    const b = branches[i];
    if (b.keyword === 'else') {
      html += `<div class="j-branch" data-type="else"><div style="display:flex;align-items:center;gap:4px;"><span style="font-weight:700;color:#b45309;">EN CAS CONTRARI</span></div>${btnBranchTrashHtml()}</div>`;
    } else {
      const bc = escapeHtml(b.cond);
      html += `<div class="j-branch" data-type="elif"><div style="display:flex;align-items:center;gap:4px;"><span style="font-weight:700;color:#b45309;">O SI:</span> <span class="j-cond-text" data-cond="${bc}">${bc}</span></div>${btnBranchTrashHtml()}</div>`;
    }
    html += `<div class="j-content" contenteditable="true">${compileFn(b.body)}</div>`;
  }

  const footerLabel = type === 'for' ? 'FINAL BUCLE' : 'FINAL CONDICIONAL';
  html += `<div class="j-footer"><span>${footerLabel}</span></div></div>`;
  return html;
};

// Builds the interactive .jinja-block HTML for an inline-layout for/if. Each
// tag (open/elif/else/close) shows only a small icon — not its literal
// "{% ... %}" text, which would otherwise clutter running text — with the
// full tag kept in its title tooltip. A toolbar (just the switch-to-block
// button) is appended once, absolutely positioned below the whole inline
// construct and revealed only on :focus-within (see the matching CSS rules
// in TemplateEditor.vue), so it doesn't take up space until needed.
const buildInlineJinjaHtml = (type, branches, compileInline) => {
  const icon = type === 'for' ? ICON_LOOP : ICON_IF;
  // tagText is placed both as a title="..." attribute and as visible text
  // content below — build it from the raw (unescaped) condition, then
  // escape the whole rendered tag once so both positions get a
  // consistently-escaped value.
  const inlineTag = (tagText) => { const t = escapeHtml(tagText); return `<span class="j-inline-tag" contenteditable="false" title="${t} — Fes clic per passar a BLOC"><span class="j-inline-tag-icon">${icon}</span><span class="j-inline-tag-text">${t}</span></span>`; };

  let html = `<span class="jinja-block inline" contenteditable="false" data-layout="inline" data-type="${type}" data-cond="${escapeHtml(branches[0].cond)}">`;
  branches.forEach((b, i) => {
    const tagText = i === 0
      ? `{% ${type} ${b.cond} %}`
      : (b.keyword === 'else' ? '{% else %}' : `{% elif ${b.cond} %}`);
    html += inlineTag(tagText) + `<span class="j-content" contenteditable="true">${compileInline(b.body)}</span>`;
  });
  html += inlineTag(`{% end${type === 'for' ? 'for' : 'if'} %}`);
  html += `<span class="j-inline-toolbar" contenteditable="false">${btnToBlockHtml()}</span>`;
  html += `</span>`;
  return html;
};

// Scans `lines` for a Jinja {% for %}/{% if %} block starting at `startIdx`
// (already confirmed to be a standalone open-tag line), tracking nesting depth
// so inner for/if blocks' own elif/else/end don't get mistaken for this one's.
// Returns { endIdx, branches } where each branch is { keyword, cond, body },
// or null if unterminated (malformed template — left as literal text).
const OPEN_TAG_RE = /^\{%\s*(for|if)\s+([\s\S]+?)\s*%\}$/;
const ELIF_TAG_RE = /^\{%\s*elif\s+([\s\S]+?)\s*%\}$/;

const scanJinjaBlock = (lines, startIdx) => {
  const open = lines[startIdx].trim().match(OPEN_TAG_RE);
  const branches = [];
  let depth = 1;
  let branchKeyword = open[1];
  let branchCond = open[2];
  let branchStart = startIdx + 1;

  for (let i = startIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (OPEN_TAG_RE.test(t)) { depth++; continue; }

    if (depth === 1) {
      const elifMatch = t.match(ELIF_TAG_RE);
      if (elifMatch || t === '{% else %}') {
        branches.push({ keyword: branchKeyword, cond: branchCond, body: lines.slice(branchStart, i).join('\n') });
        branchKeyword = elifMatch ? 'elif' : 'else';
        branchCond = elifMatch ? elifMatch[1] : '';
        branchStart = i + 1;
        continue;
      }
    }
    if (t === '{% endfor %}' || t === '{% endif %}') {
      depth--;
      if (depth === 0) {
        branches.push({ keyword: branchKeyword, cond: branchCond, body: lines.slice(branchStart, i).join('\n') });
        return { endIdx: i, branches };
      }
    }
  }
  return null;
};

// Placeholders are plain alphanumeric tokens (no Markdown-significant
// characters), so they always pass through markdown-it untouched — no risk of
// being re-interpreted as emphasis/a list/etc., unlike e.g. "__PLACEHOLDER__".
const placeholder = (kind, idx) => `${kind}${idx}`;

// Restores placeholders in the rendered HTML. `blockLevel: true` (for
// block-layout Jinja blocks and tables, which always occupy an entire
// paragraph on their own) also strips the <p>...</p> wrapper markdown-it put
// around the lone placeholder text, since our replacement HTML (a <div> or
// <table>) is itself already block-level — leaving the <p> would nest
// block content inside an inline element.
//
// Tokens are unpadded ("JB1", "JB10", "JB11"...), so a plain substring
// replace of "JB1" would also match as a prefix inside "JB10"/"JB11"/...,
// corrupting any document with 10+ placeholders of the same kind. The
// (?!\d) lookahead ensures a token only matches when NOT followed by another
// digit, so "JB1" can never eat into "JB10".
const restorePlaceholders = (text, kind, values, blockLevel = false) => {
  let out = text;
  values.forEach((html, idx) => {
    const token = placeholder(kind, idx);
    if (blockLevel) {
      const wrapped = new RegExp(`<p>\\s*${token}(?!\\d)\\s*</p>`, 'g');
      out = out.replace(wrapped, () => html);
    }
    out = out.replace(new RegExp(`${token}(?!\\d)`, 'g'), () => html);
  });
  return out;
};

// Extracts every standalone (block-layout) {% for %}/{% if %} region from the
// text, replacing each with a placeholder and recursively compiling its
// branch bodies via `compileFn` (the outer compileMarkdownToHtml itself, so
// nested nested blocks, tables, math and plain Markdown inside a branch are
// all handled by the exact same pipeline).
const extractBlockJinja = (text, compileFn) => {
  const lines = text.split('\n');
  const outLines = [];
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const match = OPEN_TAG_RE.test(lines[i].trim()) ? scanJinjaBlock(lines, i) : null;
    if (match) {
      const type = lines[i].trim().match(OPEN_TAG_RE)[1];
      const branches = match.branches.map((b) => ({ ...b, cond: b.cond }));
      blocks.push(buildJinjaBlockHtml(type, branches, compileFn));
      outLines.push(placeholder('JB', blocks.length - 1));
      i = match.endIdx + 1;
      continue;
    }
    outLines.push(lines[i]);
    i++;
  }
  return { text: outLines.join('\n'), blocks };
};

// Extracts remaining (inline-layout) {% for %}/{% if %} tags — ones that were
// not alone on their own line, so extractBlockJinja left them untouched — using
// the same token-split + depth-tracking approach as the block scanner, just
// operating on `{% ... %}`-delimited tokens instead of lines. Their bodies are
// rendered with `compileInline` (markdown-it's *inline*-only renderer, since
// these live inside a single paragraph, not as standalone block content).
const extractInlineJinja = (text, compileInline) => {
  const tokens = text.split(/(\{%[\s\S]*?%\})/g);
  const blocks = [];
  let out = '';
  let i = 0;

  const readBlock = () => {
    const openMatch = tokens[i].match(OPEN_TAG_RE);
    const type = openMatch[1];
    const branches = [];
    let branchKeyword = type;
    let branchCond = openMatch[2];
    let body = '';
    let depth = 1;
    i++;
    while (i < tokens.length) {
      const tok = tokens[i].trim();
      if (OPEN_TAG_RE.test(tok)) { depth++; body += tokens[i]; i++; continue; }
      if (depth === 1) {
        const elifMatch = tok.match(ELIF_TAG_RE);
        if (elifMatch || tok === '{% else %}') {
          branches.push({ keyword: branchKeyword, cond: branchCond, body });
          branchKeyword = elifMatch ? 'elif' : 'else';
          branchCond = elifMatch ? elifMatch[1] : '';
          body = '';
          i++;
          continue;
        }
      }
      if (tok === '{% endfor %}' || tok === '{% endif %}') {
        depth--;
        i++;
        if (depth === 0) {
          branches.push({ keyword: branchKeyword, cond: branchCond, body });
          return { type, branches };
        }
        body += tokens[i - 1];
        continue;
      }
      body += tokens[i];
      i++;
    }
    branches.push({ keyword: branchKeyword, cond: branchCond, body });
    return { type, branches, unterminated: true };
  };

  while (i < tokens.length) {
    if (OPEN_TAG_RE.test(tokens[i])) {
      const block = readBlock();
      if (block.unterminated) {
        // Malformed template (missing endfor/endif): keep as literal text.
        out += `{% ${block.type} ${block.branches[0].cond} %}` + block.branches.map((b) => b.body).join('');
      } else {
        blocks.push(buildInlineJinjaHtml(block.type, block.branches, compileInline));
        out += placeholder('JI', blocks.length - 1);
      }
      continue;
    }
    out += tokens[i];
    i++;
  }
  return { text: out, blocks };
};

// Splits a "| a | b |" row into cells on '|', except a '|' that's part of a
// {{ ... | filter }} expression (e.g. {{ part.Import | coin }}) — a plain
// split('|') would also break on that one, turning one cell into two (or
// more, for chained filters) and leaving the header row's column count out
// of sync with the body's. Tracked via {{ / }} depth rather than a regex,
// since a cell can contain more than one such expression.
const splitTableLine = (line) => {
  const clean = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '{' && clean[i + 1] === '{') { depth++; current += '{{'; i++; continue; }
    if (clean[i] === '}' && clean[i + 1] === '}') { depth = Math.max(0, depth - 1); current += '}}'; i++; continue; }
    if (clean[i] === '|' && depth === 0) { cells.push(current.trim()); current = ''; continue; }
    current += clean[i];
  }
  cells.push(current.trim());
  return cells;
};

const alignFromDivider = (div) => {
  if (div.startsWith(':') && div.endsWith(':')) return 'center';
  if (div.endsWith(':')) return 'right';
  return 'left';
};

// A totals-row cell's raw expression is a compound Jinja2 expression (e.g.
// "(pres.parts | sum(attribute='Import')) | coin"), not a simple field path
// — resolveFieldLabel's "take the text before the first |" heuristic makes
// a mess of it. Give the chip a short, aggregate-shaped label instead.
const friendlyTotalLabel = (raw) => {
  if (/\|\s*sum\(attribute=/.test(raw) && /\)\s*\/\s*\(/.test(raw)) return 'Mitjana';
  if (/\|\s*sum\(attribute=/.test(raw)) return 'Suma';
  if (/\|\s*length\)/.test(raw)) return 'Compte';
  return 'Fórmula';
};

const TRANSPOSED_TABLE_RE = /<!--\s*TRANSPOSED_TABLE_START:(.*?)\s*-->([\s\S]*?)<!--\s*TRANSPOSED_TABLE_END\s*-->/g;
const DYNAMIC_TABLE_RE = /<!--\s*DYNAMIC_TABLE_START:(.*?)\s*-->([\s\S]*?)<!--\s*DYNAMIC_TABLE_END\s*-->/g;

// Extracts our app-specific table syntax (marked with HTML comments; row/column
// loop metadata lives in the comment itself, not in standard Markdown table
// syntax) directly to <table> HTML with data-jinja-for/data-jinja-col-loop
// attributes — same convention TemplateEditor.vue's interactive wiring expects.
// Plain Markdown tables are left untouched here; markdown-it renders those
// natively later.
const extractCommentTables = (text, { findBestKeyMatch, findColHeaderKeyMatch, resolveFieldLabel }) => {
  const blocks = [];
  const stash = (html) => {
    blocks.push(html);
    return placeholder('JT', blocks.length - 1);
  };

  let out = text.replace(TRANSPOSED_TABLE_RE, (match, meta, tableContent) => {
    const parts = meta.split(';');
    const loopExpr = parts[0].trim();
    let colHeader = '';
    let rowsStr = '';
    parts.slice(1).forEach((p) => {
      const [k, v] = p.split('=');
      if (k === 'colHeader') colHeader = v;
      if (k === 'rows') rowsStr = v;
    });
    const rowKeys = rowsStr ? rowsStr.split(',') : [];

    const lines = tableContent.trim().split('\n').filter((l) => l.trim().startsWith('|'));
    if (lines.length < 2) return match;

    const headers = splitTableLine(lines[0]);
    const headerValues = headers.slice(1);
    const loopVar = loopExpr.split(' ')[0];
    const arrayPath = (loopExpr.split(' in ')[1] || '').split(' if ')[0].trim();

    if (!colHeader) colHeader = findColHeaderKeyMatch(arrayPath, headerValues);

    let html = tableEditButtonHtml() + '<table><thead><tr><th data-align="left">Dada</th>';
    const headJinjaMatch = lines[0].match(/\{\{\s*([^}]+)\s*\}\}/);
    const headChipRaw = headJinjaMatch ? headJinjaMatch[1].trim() : `${loopVar}.${colHeader}`;
    html += `<th data-align="center" style="text-align: center;" data-jinja-col-loop="${escapeHtml(loopExpr)}"><span class="j-var-chip" contenteditable="false" data-raw="${escapeHtml(headChipRaw)}">${escapeHtml(resolveFieldLabel(headChipRaw))}</span></th></tr></thead><tbody>`;

    const bodyLines = lines.slice(2);
    const parsedRowKeys = [...rowKeys];
    bodyLines.forEach((bl, idx) => {
      const cells = splitTableLine(bl);
      const rowLabel = cells[0] || 'Dada';
      if (!parsedRowKeys[idx]) parsedRowKeys[idx] = findBestKeyMatch(arrayPath, rowLabel);
      const key = parsedRowKeys[idx] || '';
      const jinjaMatch = bl.match(/\{\{\s*([^}]+)\s*\}\}/);
      const cellChipRaw = jinjaMatch ? jinjaMatch[1].trim() : (key.includes('.') ? key : `${loopVar}.${key}`);

      html += `<tr><td>${escapeHtml(rowLabel)}</td><td style="text-align: left;" data-jinja-col-loop="${escapeHtml(loopExpr)}"><span class="j-var-chip" contenteditable="false" data-raw="${escapeHtml(cellChipRaw)}">${escapeHtml(resolveFieldLabel(cellChipRaw))}</span></td></tr>`;
    });
    html += '</tbody></table>';
    return stash(html);
  });

  out = out.replace(DYNAMIC_TABLE_RE, (match, loopExprRaw, tableContent) => {
    const loopExpr = loopExprRaw.trim();
    const lines = tableContent.trim().split('\n').filter((l) => l.trim().startsWith('|') || l.trim().startsWith('{%'));
    const headerLine = lines.find((l) => l.startsWith('|') && !l.includes('---'));
    const dividerLine = lines.find((l) => l.startsWith('|') && l.includes('---'));
    const bodyLine = lines.find((l) => l.startsWith('|') && l.includes('{{'));
    const endforIdx = lines.findIndex((l) => l.trim() === '{% endfor %}');
    // A totals row is just an ordinary "| ... |" line placed after the loop's
    // {% endfor %} — the same convention a hand-written totals row already
    // uses outside of DYNAMIC_TABLE. Recognized here so it survives being
    // re-rendered to the visual canvas instead of silently vanishing.
    const totalsLine = endforIdx !== -1 ? lines.slice(endforIdx + 1).find((l) => l.startsWith('|')) : undefined;
    if (!headerLine) return match;

    const headers = splitTableLine(headerLine);
    const aligns = dividerLine ? splitTableLine(dividerLine).map(alignFromDivider) : [];
    const cellToHtml = (cell, align, labelFn = resolveFieldLabel) => {
      // Escape the literal text surrounding each {{ }} match and the raw
      // expression/label inside it separately (rather than escaping the
      // whole cell up front and then matching {{ }} against the result) —
      // otherwise a raw expression already containing an HTML entity from a
      // first escaping pass (e.g. '"' -> '&quot;') would be escaped a
      // second time by the per-match step, mangling it (-> '&amp;quot;').
      const cellJinjaRe = /\{\{\s*(.*?)\s*\}\}/g;
      let chipHtml = '';
      let lastIndex = 0;
      let m;
      while ((m = cellJinjaRe.exec(cell)) !== null) {
        chipHtml += escapeHtml(cell.slice(lastIndex, m.index));
        const raw = m[1].trim();
        chipHtml += `<span class="j-var-chip" contenteditable="false" data-raw="${escapeHtml(raw)}">${escapeHtml(labelFn(raw))}</span>`;
        lastIndex = m.index + m[0].length;
      }
      chipHtml += escapeHtml(cell.slice(lastIndex));
      return `<td style="text-align: ${align};">${chipHtml}</td>`;
    };

    let html = tableEditButtonHtml() + '<table><thead><tr>';
    headers.forEach((h, idx) => {
      const align = aligns[idx] || 'left';
      html += `<th data-align="${align}" style="text-align: ${align};">${escapeHtml(h)}</th>`;
    });
    html += `</tr></thead><tbody><tr class="j-row-loop" data-jinja-for="${escapeHtml(loopExpr)}">`;
    if (bodyLine) {
      splitTableLine(bodyLine).forEach((cell, idx) => html += cellToHtml(cell, aligns[idx] || 'left'));
    }
    html += '</tr>';
    if (totalsLine) {
      html += '<tr class="j-totals-row">';
      splitTableLine(totalsLine).forEach((cell, idx) => html += cellToHtml(cell, aligns[idx] || 'left', friendlyTotalLabel));
      html += '</tr>';
    }
    html += '</tbody></table>';
    return stash(html);
  });

  return { text: out, blocks };
};

// ---- Math ($...$/$$...$$) extraction, rendered via KaTeX ----
const extractMath = (text) => {
  const blocks = [];
  const render = (expr, type) => {
    let html;
    try {
      const cleanExpr = expr.replace(/\{\{\s*([^}]+)\s*\}\}/g, (m, p1) => `\\text{[${p1.trim().replace(/_/g, '\\_')}]}`);
      html = katex.renderToString(cleanExpr, { displayMode: type === 'display', throwOnError: false });
    } catch (_) {
      html = escapeHtml(expr);
    }
    const tag = type === 'display' ? 'div' : 'span';
    blocks.push(`<${tag} class="latex-chip ${type}-math" contenteditable="false" data-type="${type}" data-expr="${escapeHtml(expr)}">${html}</${tag}>`);
    return placeholder('JM', blocks.length - 1);
  };
  let out = text.replace(/\$\$(.*?)\$\$/gs, (m, expr) => render(expr.trim(), 'display'));
  out = out.replace(/\$(.*?)\$/g, (m, expr) => render(expr.trim(), 'inline'));
  return { text: out, blocks };
};

// ---- Pandoc YAML front matter extraction ----
const extractYamlHeader = (text) => {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { text, headerHtml: '' };
  const rawYaml = match[1];
  const headerHtml = `<div class="pandoc-metadata-chip" contenteditable="false" data-raw="${encodeURIComponent(rawYaml)}" style="background-color: var(--bg-tertiary); border: 1px dashed var(--color-primary); border-radius: 6px; padding: 8px 12px; margin-bottom: 1rem; user-select: none;">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
      <div style="font-size: 0.8rem; font-weight: bold; color: var(--color-primary); display: flex; align-items: center; gap: 6px;">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
        <span>Metadades Pandoc (YAML Header)</span>
      </div>
      <button class="j-btn-mini btn-edit-metadata" style="background-color: var(--color-primary); color: white; border: none; padding: 3px 10px; cursor: pointer; border-radius: 4px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;">
        <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
        <span>Edita Metadades</span>
      </button>
    </div>
  </div>`;
  return { text: text.slice(match[0].length), headerHtml };
};

/**
 * Bidirectional Markdown <-> Jinja2 <-> HTML compiler used by the visual editor.
 * The Markdown+Jinja2->HTML direction (compileMarkdownToHtml) is built on
 * markdown-it for all standard Markdown; the HTML->Markdown direction lives in
 * htmlToMarkdown() above, built on turndown. Grouped together because
 * compileMarkdownToHtml's helpers call each other directly (extraction passes
 * -> recursive compileFn -> chip creation -> schema lookups), so splitting
 * them further would only add indirection without reducing coupling.
 */
export function useMarkdownJinjaCompiler({ store, activeLoopStack, hasCheckedTemplate, resolveFieldLabel, resolvePath }) {
  // Helper to check if a Jinja variable expression exists in the schema or active loop context
  const isVariableDefinedInSchema = (exprStr, loopStack = []) => {
    if (!exprStr || typeof exprStr !== 'string') return true;

    let cleanExpr = exprStr.split('|')[0].trim();
    cleanExpr = cleanExpr.replace(/\(.*\)/, '').trim();
    if (!cleanExpr) return true;

    const jinjaKeywords = new Set([
      'loop', 'loop.index', 'loop.index0', 'loop.first', 'loop.last', 'loop.revindex',
      'loop.length', 'loop.cycle', 'loop.depth', 'loop.depth0',
      'true', 'false', 'none', 'null', 'undefined'
    ]);
    if (jinjaKeywords.has(cleanExpr.toLowerCase())) return true;

    const gData = store.excelJsonData;
    const metas = store.editorMetadata || [];

    let resolvedExpr = cleanExpr;
    const parts = cleanExpr.split('.');
    if (parts.length > 1 && loopStack && loopStack.length > 0) {
      const iter = parts[0];
      const subPath = parts.slice(1).join('.');
      const loopMatch = loopStack.find((l) => l && l.iterator === iter);
      if (loopMatch) resolvedExpr = `${loopMatch.arrayPath}.${subPath}`;
    }

    if (gData) {
      const directVal = resolvePath(gData, resolvedExpr);
      if (directVal !== null && directVal !== undefined) return true;
    }

    const metaMatch = metas.some((m) => {
      if (!m || !m.element) return false;
      const fullMetaPath = m.group ? `${m.group}.${m.element}` : m.element;
      if (fullMetaPath === resolvedExpr || m.element === resolvedExpr) return true;
      if (m.group && resolvedExpr.endsWith(`${m.group}.${m.element}`)) return true;
      return false;
    });
    if (metaMatch) return true;

    if (gData && gData[cleanExpr] !== undefined) return true;
    return false;
  };

  const createJinjaVarChip = (v, loopStack = []) => {
    const vars = v.split('|');
    const expr = vars[0].trim();
    const filter = vars.length > 1 ? vars.slice(1).join('|').trim() : '';
    const displayLabel = resolveFieldLabel(v);
    const isDefined = isVariableDefinedInSchema(expr, loopStack);
    const rawAttr = `${expr}${filter ? '|' + filter : ''}`;

    if (!isDefined && hasCheckedTemplate.value) {
      return `<span class="j-var-chip undefined-var" contenteditable="false" data-raw="${escapeHtml(rawAttr)}" title="⚠️ Atenció: La variable '${escapeHtml(expr)}' no està definida a l'esquema de dades!"><span class="warn-icon">⚠️</span>${escapeHtml(displayLabel)}</span>`;
    }
    return `<span class="j-var-chip" contenteditable="false" data-raw="${escapeHtml(rawAttr)}">${escapeHtml(displayLabel)}</span>`;
  };

  const convertJinjaToChips = (text, loopStack = []) => text.replace(/\{\{\s*(.*?)\s*\}\}/g, (m, v) => createJinjaVarChip(v, loopStack));

  const findBestKeyMatch = (arrayPath, label) => {
    if (!store.excelJsonData || !arrayPath || !label) return '';
    const arr = resolvePath(store.excelJsonData, arrayPath);
    if (!arr || !Array.isArray(arr) || arr.length === 0) return '';
    const keys = Object.keys(arr[0]);
    const normLabel = label.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const k of keys) if (k.toLowerCase().replace(/[^a-z0-9]/g, '') === normLabel) return k;
    for (const k of keys) if (k.toLowerCase().includes(normLabel) || normLabel.includes(k.toLowerCase())) return k;
    return keys[0] || '';
  };

  const findColHeaderKeyMatch = (arrayPath, values) => {
    if (!store.excelJsonData || !arrayPath || !values || values.length === 0) return '';
    const arr = resolvePath(store.excelJsonData, arrayPath);
    if (!arr || !Array.isArray(arr) || arr.length === 0) return '';
    const keys = Object.keys(arr[0]);
    for (const k of keys) {
      const sampleVals = arr.map((item) => String(item[k]).trim().toLowerCase());
      const matchCount = values.filter((v) => sampleVals.includes(v.trim().toLowerCase())).length;
      if (matchCount > 0) return k;
    }
    return keys[0] || '';
  };

  // ---- markdown-it instance: real Markdown parsing/rendering, extended with
  // a custom inline rule for {{ expr | filter }} variable chips, and a
  // table-cell renderer override so alignment surfaces as data-align (what
  // TemplateEditor.vue's click-to-toggle-alignment wiring expects) instead of
  // markdown-it's default inline text-align style only. ----
  const md = new MarkdownIt({ html: false, breaks: true, linkify: false, typographer: false });

  md.inline.ruler.before('text', 'jinja_var', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x7b || state.src.charCodeAt(state.pos + 1) !== 0x7b) return false;
    const end = state.src.indexOf('}}', state.pos + 2);
    if (end === -1) return false;
    if (!silent) {
      const token = state.push('jinja_var', '', 0);
      // This rule slices raw source text directly rather than going through
      // markdown-it's normal character-by-character inline tokenization, so
      // it never benefits from markdown-it's own backslash-escape handling —
      // unescape \| back to | ourselves (see escapeFilterPipesInBraces below,
      // the counterpart that put it there).
      token.content = state.src.slice(state.pos + 2, end).trim().replace(/\\\|/g, '|');
    }
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules.jinja_var = (tokens, idx) => createJinjaVarChip(tokens[idx].content, activeLoopStack.value || []);

  const alignAttr = (token) => {
    const style = token.attrGet('style') || '';
    const m = style.match(/text-align:\s*(left|center|right)/);
    return m ? m[1] : 'left';
  };
  // Besides data-align (what TemplateEditor.vue's click-to-toggle-alignment
  // wiring reads) also set the legacy `align` HTML attribute — it's what
  // turndown-plugin-gfm's table rule reads to reconstruct the ---/---:/:-:
  // divider row on the way back to Markdown. Omitted for 'left' (the
  // implicit default) so a plain, unmarked '---' round-trips as '---',
  // not the equally-valid but less common explicit ':--'.
  md.renderer.rules.th_open = (tokens, idx) => {
    const align = alignAttr(tokens[idx]);
    const alignHtmlAttr = align === 'left' ? '' : ` align="${align}"`;
    return `<th data-align="${align}" style="text-align: ${align};"${alignHtmlAttr}>`;
  };
  md.renderer.rules.td_open = (tokens, idx) => {
    const align = alignAttr(tokens[idx]);
    return `<td style="text-align: ${align};">`;
  };

  // markdown-it's table block-parser splits a row into cells on every
  // unescaped '|', BEFORE any inline rule (including our jinja_var rule
  // above) ever runs — so a filter expression like {{ x | percent }} sitting
  // in a plain author-typed Markdown table gets its '|' read as an extra
  // column separator, silently truncating/misaligning that row. Escaping it
  // as \| (markdown-it's own convention for "not a separator") fixes the
  // table parse; jinja_var's content slicing above undoes the escape again.
  const escapeFilterPipesInBraces = (text) => text.replace(/\{\{[^{}]*\}\}/g, (m) => m.replace(/\|/g, '\\|'));

  // Compiles Markdown+Jinja2 to the interactive visual-canvas HTML. Recursive:
  // called again for each Jinja block branch's body (block-layout) so nesting
  // of any depth is handled by construction, not by a hand-tracked stack.
  const compileMarkdownToHtml = (markdownText) => {
    const { text: afterYaml, headerHtml } = extractYamlHeader(markdownText || '');
    const { text: afterMath, blocks: mathBlocks } = extractMath(afterYaml);
    const { text: afterTables, blocks: tableBlocks } = extractCommentTables(afterMath, { findBestKeyMatch, findColHeaderKeyMatch, resolveFieldLabel });
    const { text: afterBlockJinja, blocks: blockJinjaBlocks } = extractBlockJinja(afterTables, compileMarkdownToHtml);
    const { text: afterInlineJinja, blocks: inlineJinjaBlocks } = extractInlineJinja(afterBlockJinja, (t) => md.renderInline(t));

    let html = md.render(escapeFilterPipesInBraces(afterInlineJinja));
    // blockLevel: true for all — a no-op when a placeholder isn't alone in its
    // own paragraph (the common case for inline jinja/math), but strips the
    // <p> markdown-it wrapped it in when it is (block jinja, tables, and
    // standalone $$display math$$), avoiding invalid <p><div>...</div></p> nesting.
    html = restorePlaceholders(html, 'JI', inlineJinjaBlocks, true);
    html = restorePlaceholders(html, 'JB', blockJinjaBlocks, true);
    html = restorePlaceholders(html, 'JT', tableBlocks, true);
    html = restorePlaceholders(html, 'JM', mathBlocks, true);
    return headerHtml + html;
  };

  return {
    isVariableDefinedInSchema,
    createJinjaVarChip,
    convertJinjaToChips,
    findBestKeyMatch,
    findColHeaderKeyMatch,
    compileMarkdownToHtml,
  };
}
