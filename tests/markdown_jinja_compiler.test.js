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

// @vitest-environment happy-dom
//
// Tests the visual editor's Markdown+Jinja2 <-> HTML compiler
// (src/composables/useMarkdownJinjaCompiler.js), rewritten from hand-rolled
// regex over innerHTML to real libraries: markdown-it (Markdown+Jinja2 -> HTML,
// with custom rules for our Jinja2/table/math/YAML syntax) and turndown
// (HTML -> Markdown+Jinja2, with custom rules for our chips/blocks/tables).
// Markdown/Jinja2 is the priority representation: copy/cut from the visual
// canvas puts source text on the clipboard, and pasted HTML is always
// converted to Markdown via htmlToMarkdown before it enters the source.
import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { useMarkdownJinjaCompiler, htmlToMarkdown } from '../src/composables/useMarkdownJinjaCompiler.js';

const el = (html) => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
};

const resolvePath = (obj, path) => {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
};
const resolveFieldLabel = (rawExpr) => (rawExpr || '').split('|')[0].trim().split('.').pop();

const SAMPLE_DATA = {
  General: { titol: 'Hola' },
  pres: { parts: [{ nom: 'A', import: 100 }, { nom: 'B', import: 200 }] },
};

function makeCompiler(excelJsonData = SAMPLE_DATA, hasCheckedTemplate = ref(false)) {
  const store = { excelJsonData, editorMetadata: [] };
  return useMarkdownJinjaCompiler({ store, activeLoopStack: ref([]), hasCheckedTemplate, resolveFieldLabel, resolvePath });
}

describe('htmlToMarkdown (visual canvas -> Markdown+Jinja2 source)', () => {
  it('converts a flat unordered list', () => {
    expect(htmlToMarkdown(el('<ul><li>A</li><li>B</li></ul>'))).toBe('-   A\n-   B');
  });

  it('numbers an ordered list instead of always using bullets', () => {
    // Regression: the old regex chain ran a global <li> -> "- $1" replacement
    // across the whole document *before* the <ol>-specific numbering pass
    // ever ran, so ordered lists always rendered as unordered bullets.
    expect(htmlToMarkdown(el('<ol><li>First</li><li>Second</li></ol>'))).toBe('1.  First\n2.  Second');
  });

  it('preserves a nested (indented) sub-list instead of truncating it', () => {
    // Regression: /<li>(.*?)<\/li>/ has no notion of nesting and closes at the
    // *first* </li> it finds — the innermost one — corrupting Tab-indented
    // sub-bullets or lettered sub-clauses pasted from Word.
    expect(htmlToMarkdown(el('<ul><li>A<ul><li>A1</li><li>A2</li></ul></li><li>B</li></ul>')))
      .toBe('-   A\n    -   A1\n    -   A2\n-   B');
  });

  it('handles combined bold+italic nesting', () => {
    expect(htmlToMarkdown(el('<b><i>both</i></b>'))).toBe('***both***');
  });

  it('converts simple headings/bold/italic correctly', () => {
    expect(htmlToMarkdown(el('<h2>Title</h2><p>Some <strong>bold</strong> and <i>italic</i> text.</p>')))
      .toBe('## Title\n\nSome **bold** and *italic* text.');
  });

  it('reconstructs a Jinja if/elif/else block', () => {
    const html = `<div class="jinja-block" data-layout="block" data-type="if" data-cond="a &gt; 0">
      <div class="j-head" data-type="if"><span class="j-cond-text" data-cond="a &gt; 0"></span></div>
      <div class="j-content"><p>Positive</p></div>
      <div class="j-branch" data-type="elif"><span class="j-cond-text" data-cond="a == 0"></span></div>
      <div class="j-content"><p>Zero</p></div>
      <div class="j-branch" data-type="else"></div>
      <div class="j-content"><p>Negative</p></div>
    </div>`;
    expect(htmlToMarkdown(el(html))).toBe('{% if a > 0 %}\nPositive\n{% elif a == 0 %}\nZero\n{% else %}\nNegative\n{% endif %}');
  });

  it('reconstructs a var chip and a plain GFM table', () => {
    expect(htmlToMarkdown(el('<p>Hola <span class="j-var-chip" data-raw="General.nom">Nom</span>!</p>')))
      .toBe('Hola {{ General.nom }}!');
    expect(htmlToMarkdown(el('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')))
      .toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });
});

describe('compileMarkdownToHtml (Markdown+Jinja2 source -> visual canvas)', () => {
  it('renders headings, bold, and nested lists via real markdown-it', () => {
    const html = makeCompiler().compileMarkdownToHtml('# Title\n\nSome **bold** text.\n\n- A\n  - A1\n- B\n');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    // nested <ul> preserved, not truncated
    expect(html.match(/<ul>/g)?.length).toBe(2);
  });

  it('renders a {{ var }} as an interactive chip, resolving through the schema', () => {
    const html = makeCompiler().compileMarkdownToHtml('Hola {{ General.titol }}!');
    expect(html).toContain('class="j-var-chip"');
    expect(html).toContain('data-raw="General.titol"');
  });

  it('only shows the undefined-variable warning after "Comprova Plantilla" has run', () => {
    const hasChecked = ref(false);
    const { compileMarkdownToHtml } = makeCompiler(SAMPLE_DATA, hasChecked);
    expect(compileMarkdownToHtml('{{ no.existeix }}')).not.toContain('undefined-var');
    hasChecked.value = true;
    expect(compileMarkdownToHtml('{{ no.existeix }}')).toContain('undefined-var');
  });

  it('handles nested {% if %}/{% for %} blocks of arbitrary depth (recursive by construction)', () => {
    const md = '{% if pres.parts %}\n{% for part in pres.parts %}\n- {{ part.nom }}\n{% endfor %}\n{% endif %}\n';
    const html = makeCompiler().compileMarkdownToHtml(md);
    expect(html).toContain('data-type="if"');
    expect(html).toContain('data-type="for"');
    expect(html).toContain('data-raw="part.nom"');
  });

  it('supports inline-layout jinja tags embedded within running text', () => {
    const html = makeCompiler().compileMarkdownToHtml('Text abans {% if a %}mig{% endif %} text despres.');
    expect(html).toContain('class="jinja-block inline"');
    expect(html).toContain('{% if a %}');
  });

  it('handles a block tag truly nested inside another inline-layout block on the same line', () => {
    const md = '{% for item in array %}{% if item.exists %}{{ item.name }}{% endif %}{% endfor %}';
    const html = makeCompiler().compileMarkdownToHtml(md);
    // Both the outer for and the inner if become their own interactive
    // inline blocks, not raw "{% if ... %}" text flanking the chip.
    expect(html.match(/class="jinja-block inline"/g)?.length).toBe(2);
    expect(html).toContain('data-type="for"');
    expect(html).toContain('data-type="if"');
    expect(html).toContain('class="j-var-chip"');
    // All 4 tags (for/endfor + the nested if/endif) became their own
    // interactive tag chips -- none was left behind as loose literal text.
    expect(html.match(/class="j-inline-tag-text"/g)?.length).toBe(4);
  });

  it('renders a {% macro %}...{% endmacro %} block collapsed to its signature', () => {
    const md = '{% macro taula(files, columnes=3) %}\nContingut\n{% endmacro %}';
    const html = makeCompiler().compileMarkdownToHtml(md);
    expect(html).toContain('data-type="macro"');
    expect(html).toContain('data-collapsed="true"');
    expect(html).toContain('class="j-collapsed-chip"');
    expect(html).toContain('taula(files, columnes=3)');
    expect(html).toContain('Contingut');
  });

  it('renders a {% set x %}...{% endset %} block collapsed to its variable name', () => {
    const md = '{% set resultat %}\nContingut capturat\n{% endset %}';
    const html = makeCompiler().compileMarkdownToHtml(md);
    expect(html).toContain('data-type="set"');
    expect(html).toContain('data-collapsed="true"');
    expect(html).toContain('resultat');
    expect(html).toContain('Contingut capturat');
  });

  it('renders {% set x = expr %} (single-line assignment) as a leaf chip collapsed to just the name', () => {
    const html = makeCompiler().compileMarkdownToHtml('Abans {% set total = pres.parts | length %} despres.');
    expect(html).toContain('class="j-set-chip"');
    expect(html).toContain('data-cond="total = pres.parts | length"');
    expect(html).toContain('data-collapsed="true"');
    expect(html).toContain('<span class="j-cond-text-collapsed">total</span>');
    expect(html).toContain('<span class="j-cond-text-expanded">total = pres.parts | length</span>');
  });

  it('handles a {% set x = expr %} nested inside a for-loop body (recursive by construction)', () => {
    const md = '{% for part in pres.parts %}\n{% set doble = part.import * 2 %}\n- {{ part.nom }}\n{% endfor %}';
    const html = makeCompiler().compileMarkdownToHtml(md);
    expect(html).toContain('data-type="for"');
    expect(html).toContain('class="j-set-chip"');
    expect(html).toContain('data-cond="doble = part.import * 2"');
  });

  it('does NOT pair a {% for %} with a mismatched {% endif %} (block layout) -- left as literal text, not corrupted into a fake "for"', () => {
    const md = '{% for part in pres.parts %}\n- {{ part.nom }}\n{% endif %}';
    const html = makeCompiler().compileMarkdownToHtml(md);
    expect(html).not.toContain('class="jinja-block"');
    expect(html).not.toContain('data-type="for"');
    // The literal tags survive untouched -- markdown-it escapes "{%"/"%}" to
    // HTML entities when rendering plain text, so check the source text
    // reaches the point of being handed to markdown-it unmangled instead.
    expect(html).toMatch(/for part in pres\.parts/);
    expect(html).toMatch(/endif/);
  });

  it('does NOT pair a {% for %} with a mismatched {% endif %} (inline layout, same line) -- left as literal text', () => {
    const html = makeCompiler().compileMarkdownToHtml('X {% for part in pres.parts %}{{ part.nom }}{% endif %} Y');
    expect(html).not.toContain('class="jinja-block inline"');
    expect(html).toMatch(/for part in pres\.parts/);
    expect(html).toMatch(/endif/);
  });

  it('accepts a {% for %}...{% else %}...{% endfor %} (real Jinja2 for-else, runs on an empty iterable)', () => {
    const md = '{% for x in a %}\nA\n{% else %}\nB\n{% endfor %}';
    const html = makeCompiler().compileMarkdownToHtml(md);
    expect(html).toContain('data-type="for"');
    expect(html).toContain('j-branch');
    expect(html).toContain('EN CAS CONTRARI');
  });

  it('does NOT treat a stray elif inside a {% for %} as a branch (for-loops have no elif, only a trailing else) -- it stays literal text in the single body', () => {
    const md = '{% for x in a %}\nA\n{% elif b %}\nB\n{% endfor %}';
    const html = makeCompiler().compileMarkdownToHtml(md);
    expect(html).toContain('data-type="for"');
    expect(html).not.toContain('j-branch');
    expect(html).toMatch(/elif b/);
  });

  it('does NOT treat a stray {% else %} inside a {% macro %} as a branch (real Jinja2 has no macro-else) -- it stays literal text in the single body', () => {
    const md = '{% macro nom(a) %}\nA\n{% else %}\nB\n{% endmacro %}';
    const html = makeCompiler().compileMarkdownToHtml(md);
    expect(html).toContain('data-type="macro"');
    expect(html).not.toContain('j-branch');
    expect(html).toMatch(/else/);
  });
});

describe('Markdown -> HTML -> Markdown round-trip stability', () => {
  const roundtrip = (md) => {
    const { compileMarkdownToHtml } = makeCompiler();
    return htmlToMarkdown(el(compileMarkdownToHtml(md)));
  };

  it('for-loop with a var chip and a list marker', () => {
    const md = '{% for part in pres.parts %}\n- {{ part.nom }}: {{ part.import }}\n{% endfor %}';
    expect(roundtrip(md)).toBe('{% for part in pres.parts %}\n-   {{ part.nom }}: {{ part.import }}\n{% endfor %}');
  });

  it('if/elif/else block', () => {
    const md = '{% if a > 0 %}\nPositive\n{% elif a == 0 %}\nZero\n{% else %}\nNegative\n{% endif %}';
    expect(roundtrip(md)).toBe(md);
  });

  it('preserves a blank line at the end of a block body, right before its closing tag', () => {
    // Reported bug: this blank line isn't cosmetic -- inside a {% for %}
    // body it's what separates one iteration's output from the next in the
    // final generated document, so silently dropping it on a Visual
    // round-trip is a real (if subtle) data-loss bug, not just whitespace.
    const md = '{% if general.decisio %}\nadfadf\n\n{% endif %}';
    expect(roundtrip(md)).toBe(md);
  });

  it('preserves both the blank line inside a body AND the blank line between two adjacent top-level blocks', () => {
    const md = '{% for anualitat in anualitats %}\nprova\n\n{% endfor %}\n\n{% if prova %}\nFes prova\n{% endif %}';
    expect(roundtrip(md)).toBe(md);
  });

  it('keeps two adjacent top-level blocks separated by a blank line (they used to come out glued together, {% endfor %}{% if %} with nothing between)', () => {
    const md = '{% for x in a %}\nA\n{% endfor %}\n\n{% if b %}\nB\n{% endif %}';
    expect(roundtrip(md)).toBe(md);
  });

  it('does not add blank-line padding around an inline-layout block (it must stay flush with surrounding prose)', () => {
    const md = 'Text abans {% if a %}mig{% endif %} text despres.';
    expect(roundtrip(md)).toBe(md);
  });

  it('serializes a block-shaped jinja-block flagged inline (the moment right after clicking "Inline", before a re-render restructures it)', () => {
    // TemplateEditor.vue's "Inline"/"Bloc" toggle button only flips the
    // inline class / data-layout attribute on the *existing* DOM — it does
    // not itself rebuild .j-head/.j-content into .j-inline-tag/.j-content
    // pairs (a subsequent syncCodeToVisual() re-render does that, from
    // *this* function's own output). Regression: jinjaBlockToMarkdown used
    // to pick its extraction path from the inline flag alone, so a
    // still-block-shaped-but-inline-flagged node found no .j-inline-tag
    // children and silently emitted nothing, discarding the whole block.
    const html = '<div class="jinja-block inline" data-layout="inline" data-type="if">'
      + '<div class="j-head" data-type="if"><div><span class="j-cond-text" data-cond="a &gt; 0"></span></div><div class="j-actions"></div></div>'
      + '<div class="j-content">Contingut</div>'
      + '<div class="j-footer"></div>'
      + '</div>';
    expect(htmlToMarkdown(el(html))).toBe('{% if a > 0 %}Contingut{% endif %}');
  });

  it('serializes an inline-shaped jinja-block flagged block (the moment right after clicking "Bloc", before a re-render restructures it)', () => {
    // Mirror of the test above, opposite direction: clicking "Bloc" on an
    // inline block only flips data-layout/removes the inline class on the
    // *existing* (still .j-inline-tag-shaped) DOM. Regression: the
    // domIsInlineShape branch used to hardcode "no separator" regardless of
    // this flag, so the freshly-flagged-block node still serialized with
    // every tag crammed onto one line -- which the next recompile's
    // line-based extractBlockJinja can't recognize as a standalone block,
    // silently leaving it inline forever ("switching to Bloc doesn't work").
    const html = '<span class="jinja-block" data-layout="block" data-type="if" data-cond="a &gt; 0">'
      + '<span class="j-inline-tag">{% if a > 0 %}</span>'
      + '<span class="j-content">mig</span>'
      + '<span class="j-inline-tag">{% endif %}</span>'
      + '</span>';
    expect(htmlToMarkdown(el(html))).toBe('{% if a > 0 %}\nmig\n{% endif %}');
  });

  it('inline if', () => {
    const md = 'Text abans {% if a %}mig{% endif %} text despres.';
    expect(roundtrip(md)).toBe(md);
  });

  it('macro block', () => {
    const md = '{% macro taula(files, columnes=3) %}\nContingut\n{% endmacro %}';
    expect(roundtrip(md)).toBe(md);
  });

  it('set block (content-capture form)', () => {
    const md = '{% set resultat %}\nContingut capturat\n{% endset %}';
    expect(roundtrip(md)).toBe(md);
  });

  it('set single-line assignment', () => {
    const md = 'Abans {% set total = pres.parts | length %} despres.';
    expect(roundtrip(md)).toBe(md);
  });

  it('set single-line assignment nested inside a for-loop', () => {
    // Turndown always pads list markers to "-   " (3 spaces) and inserts a
    // blank line between a preceding block-ish line and the list -- the same
    // kind of cosmetic markdown-it/turndown round-trip normalization already
    // seen elsewhere in this file (e.g. the "---"/"--:" table-alignment
    // test), not something introduced by set-chip support.
    const md = '{% for part in pres.parts %}\n{% set doble = part.import * 2 %}\n- {{ part.nom }}\n{% endfor %}';
    const normalized = '{% for part in pres.parts %}\n{% set doble = part.import * 2 %}\n\n-   {{ part.nom }}\n{% endfor %}';
    expect(roundtrip(md)).toBe(normalized);
    expect(roundtrip(normalized)).toBe(normalized);
  });

  it('math (inline + display)', () => {
    const md = 'La formula es $x^2$ i tambe:\n\n$$y = mx + b$$\n\nFi.';
    expect(roundtrip(md)).toBe(md);
  });

  it('Pandoc YAML front matter', () => {
    const md = '---\ntitle: Hola\nauthor: Jo\n---\n\n# Body\n\nText.';
    expect(roundtrip(md)).toBe(md);
  });

  it('plain Markdown table with alignment', () => {
    const md = '| A | B |\n| --- | ---: |\n| 1 | 2 |';
    // turndown-plugin-gfm always writes the right-align divider as "--:" (2
    // dashes); both are valid GFM, so this is a cosmetic normalization, not data loss.
    expect(roundtrip(md)).toBe('| A | B |\n| --- | --: |\n| 1 | 2 |');
  });

  it('DYNAMIC_TABLE and TRANSPOSED_TABLE app-specific conventions', () => {
    const dynamic = [
      '<!-- DYNAMIC_TABLE_START:part in pres.parts -->',
      '| Nom | Import |',
      '| --- | ---: |',
      '{% for part in pres.parts %}',
      '| {{ part.nom }} | {{ part.import }} |',
      '{% endfor %}',
      '<!-- DYNAMIC_TABLE_END -->',
    ].join('\n');
    expect(roundtrip(dynamic)).toBe(dynamic);

    // Transposed tables round-trip to a stable (if more verbose) fixed point:
    // the reverse serializer re-states the loop per cell, which the forward
    // parser's {{ }}-extraction handles fine regardless — verify it doesn't
    // keep growing/drifting on a second pass.
    const transposed = [
      '<!-- TRANSPOSED_TABLE_START:part in pres.parts;colHeader=nom;rows=import -->',
      '| Dada | {{ part.nom }} |',
      '| --- | :---: |',
      '| Import | {{ part.import }} |',
      '<!-- TRANSPOSED_TABLE_END -->',
    ].join('\n');
    const once = roundtrip(transposed);
    const twice = htmlToMarkdown(el(makeCompiler().compileMarkdownToHtml(once)));
    expect(twice).toBe(once);
  });

  it('keeps a DYNAMIC_TABLE row intact when a cell uses a Jinja filter pipe', () => {
    // DYNAMIC_TABLE/TRANSPOSED_TABLE rows are split on '|' by splitTableLine,
    // a hand-rolled parser separate from markdown-it's own table plugin — it
    // had the exact same "|' inside {{ x | filter }} is not a filter, it's an
    // extra column" bug, previously untested because no existing fixture used
    // a filtered column inside one of these blocks (even though filters are
    // the default for numeric columns created via the Table modal).
    const dynamic = [
      '<!-- DYNAMIC_TABLE_START:part in pres.parts -->',
      '| Nom | Import |',
      '| --- | ---: |',
      '{% for part in pres.parts %}',
      '| {{ part.nom }} | {{ part.import | coin }} |',
      '{% endfor %}',
      '<!-- DYNAMIC_TABLE_END -->',
    ].join('\n');
    const html = makeCompiler().compileMarkdownToHtml(dynamic);
    const table = el(html).querySelector('table');
    expect(table.querySelectorAll('thead th')).toHaveLength(2);
    const bodyCells = Array.from(table.querySelector('.j-row-loop').querySelectorAll('td'));
    expect(bodyCells).toHaveLength(2);
    expect(bodyCells[1].querySelector('.j-var-chip').getAttribute('data-raw')).toBe('part.import | coin');
    expect(roundtrip(dynamic)).toBe(dynamic);
  });

  it('supports an optional totals row on a DYNAMIC_TABLE, using only built-in Jinja2 filters', () => {
    const dynamic = [
      '<!-- DYNAMIC_TABLE_START:part in pres.parts -->',
      '| Nom | Import |',
      '| --- | ---: |',
      '{% for part in pres.parts %}',
      '| {{ part.nom }} | {{ part.import | coin }} |',
      '{% endfor %}',
      "| Total | {{ (pres.parts | sum(attribute='import')) | coin }} |",
      '<!-- DYNAMIC_TABLE_END -->',
    ].join('\n');
    const html = makeCompiler().compileMarkdownToHtml(dynamic);
    const table = el(html).querySelector('table');
    const totalsRow = table.querySelector('.j-totals-row');
    expect(totalsRow).not.toBeNull();
    const cells = Array.from(totalsRow.querySelectorAll('td'));
    expect(cells).toHaveLength(2);
    expect(cells[0].textContent.trim()).toBe('Total');
    const chip = cells[1].querySelector('.j-var-chip');
    expect(chip.getAttribute('data-raw')).toBe("(pres.parts | sum(attribute='import')) | coin");
    // Labeled by aggregate type ("Suma"), not resolveFieldLabel's mangled
    // take on a compound expression with more than one '|'.
    expect(chip.textContent.trim()).toBe('Suma');
    expect(roundtrip(dynamic)).toBe(dynamic);
  });

  it('is idempotent for HTML pasted from Word (nested list with bold)', () => {
    const wordHtml = '<p>Some <strong>bold</strong> text.</p><ul><li>A<ul><li><strong>A1</strong></li><li>A2</li></ul></li><li>B</li></ul>';
    const asMarkdown = htmlToMarkdown(el(wordHtml));
    const backToHtml = makeCompiler().compileMarkdownToHtml(asMarkdown);
    expect(htmlToMarkdown(el(backToHtml))).toBe(asMarkdown);
  });

  it('does not corrupt block #1 when 10+ block-level jinja constructs are present (placeholder token collision)', () => {
    // Placeholder tokens are unpadded ("JB1", "JB10", "JB11"...): a naive
    // substring replace of "JB1" also matches as a prefix inside "JB10"/
    // "JB11"/..., so a document with 10+ if/for blocks used to have block #1's
    // content stomp over blocks #10, #11, etc. (with a stray trailing digit
    // left behind). Build 12 distinct if-blocks and check each one's own
    // condition/content survives intact and exactly once (adjacent-block
    // whitespace is covered by other tests, so this checks content only).
    const blocks = Array.from({ length: 12 }, (_, i) => `{% if v${i} %}\nBlock number ${i}\n{% endif %}`);
    const md = blocks.join('\n\n');
    const result = roundtrip(md);
    for (let i = 0; i < 12; i++) {
      expect(result).toContain(`{% if v${i} %}\nBlock number ${i}\n{% endif %}`);
      expect((result.match(new RegExp(`Block number ${i}(?!\\d)`, 'g')) || [])).toHaveLength(1);
    }
  });

  it('keeps every column of a plain Markdown table row whose cells use a Jinja filter pipe', () => {
    // markdown-it's table block-parser splits a row on every unescaped '|',
    // including ones inside a Jinja filter expression like {{ x | percent }}
    // — since that happens before any inline rule runs. Left unescaped, this
    // silently drops/misaligns columns (a real data-loss bug, not cosmetic).
    const md = [
      '| Concepte | Percentatge | Import |',
      '| --- | --: | --: |',
      '| Costos directes | {{ pres.perc|percent }} | {{ pres.costos|coin }} |',
    ].join('\n');
    const { compileMarkdownToHtml } = makeCompiler();
    const html = compileMarkdownToHtml(md);
    const table = el(html).querySelector('table');
    const dataRow = Array.from(table.querySelectorAll('tbody tr')[0].querySelectorAll('td'));
    expect(dataRow).toHaveLength(3);
    expect(dataRow[1].querySelector('.j-var-chip').getAttribute('data-raw')).toBe('pres.perc|percent');
    expect(dataRow[2].querySelector('.j-var-chip').getAttribute('data-raw')).toBe('pres.costos|coin');

    // Both filter expressions must survive as whole, correctly-delimited
    // cells — not merged into one cell, not truncated at their own internal
    // '|'. (A naive split on every '|' can't tell a real column separator
    // from one that's legitimately part of a filter's syntax, which is
    // exactly the distinction the fix restores — so check cell boundaries
    // directly instead.)
    const backToMarkdown = htmlToMarkdown(el(html));
    const dataLine = backToMarkdown.split('\n').find((l) => l.includes('Costos directes'));
    expect(dataLine).toBe('| Costos directes | {{ pres.perc|percent }} | {{ pres.costos|coin }} |');
  });

  it('preserves a double-quoted string literal in an IF condition across a round-trip', () => {
    // Regression: the condition was interpolated into data-cond="${cond}"
    // (and the chip equivalent, data-raw="${rawAttr}") completely
    // unescaped. A literal '"' inside the expression — routine for a
    // string-literal comparison like general.valor == "valor vàlid" — closed
    // the HTML attribute early when the browser parsed it, silently
    // truncating everything after the quote the moment the block was first
    // rendered; jinjaBlockToMarkdown then read that already-truncated
    // data-cond back out, so the loss only became visible on the next
    // canvas->source sync (tab switch, reload, ...), not immediately.
    const md = '{% if general.valor == "valor vàlid" %}\nText\n{% endif %}';
    const html = makeCompiler().compileMarkdownToHtml(md);
    expect(el(html).querySelector('.j-cond-text').getAttribute('data-cond')).toBe('general.valor == "valor vàlid"');
    expect(htmlToMarkdown(el(html))).toBe(md);
  });

  it('preserves a double-quoted filter argument in a variable chip across a round-trip', () => {
    const md = '{{ general.valor|default("Sense dades") }}';
    const html = makeCompiler().compileMarkdownToHtml(md);
    expect(el(html).querySelector('.j-var-chip').getAttribute('data-raw')).toBe('general.valor|default("Sense dades")');
    expect(htmlToMarkdown(el(html))).toBe(md);
  });

  it('does not backslash-escape an underscore sitting inside a word (Catalan prose, Excel/Jinja2 field names)', () => {
    // Regression: turndown's default escape() backslash-escapes every '_'
    // unconditionally, unlike '-'/'+'/'#'/etc. (only escaped at the start of
    // a line) — technically safe for turndown's own emphasis output, but
    // this app sets emDelimiter: '*', so a literal '_' reaching a text node
    // is never turndown's own syntax, only genuine prose/identifier text
    // (e.g. "num_expedient") that should round-trip untouched. Genuinely
    // ambiguous placements (flanking whitespace/punctuation, so markdown-it
    // could otherwise re-parse it as emphasis) must still be escaped.
    expect(htmlToMarkdown(el('<p>Text amb num_expedient i preu_amb_iva normals.</p>')))
      .toBe('Text amb num_expedient i preu_amb_iva normals.');
    expect(htmlToMarkdown(el('<p>café_amb_accents_ok</p>'))).toBe('café_amb_accents_ok');
    expect(htmlToMarkdown(el('<p>_start i end_ i hello _world_ test</p>')))
      .toBe('\\_start i end\\_ i hello \\_world\\_ test');
  });
});
