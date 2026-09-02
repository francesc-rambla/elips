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

  it('inline if', () => {
    const md = 'Text abans {% if a %}mig{% endif %} text despres.';
    expect(roundtrip(md)).toBe(md);
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

  it('is idempotent for HTML pasted from Word (nested list with bold)', () => {
    const wordHtml = '<p>Some <strong>bold</strong> text.</p><ul><li>A<ul><li><strong>A1</strong></li><li>A2</li></ul></li><li>B</li></ul>';
    const asMarkdown = htmlToMarkdown(el(wordHtml));
    const backToHtml = makeCompiler().compileMarkdownToHtml(asMarkdown);
    expect(htmlToMarkdown(el(backToHtml))).toBe(asMarkdown);
  });
});
