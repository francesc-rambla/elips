// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { convertHtmlToMarkdown } from '../src/composables/useMarkdownJinjaCompiler.js';

const el = (html) => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
};

describe('convertHtmlToMarkdown (visual editor -> Markdown)', () => {
  it('converts a flat unordered list', () => {
    expect(convertHtmlToMarkdown(el('<ul><li>A</li><li>B</li></ul>'))).toBe('\n- A\n- B\n\n');
  });

  it('numbers an ordered list instead of always using bullets', () => {
    // Regression: the previous regex-chain implementation ran a global <li> -> "- $1"
    // replacement across the whole document *before* the <ol>-specific numbering pass
    // ever ran, so ordered lists always rendered as unordered bullets.
    expect(convertHtmlToMarkdown(el('<ol><li>First</li><li>Second</li></ol>')))
      .toBe('\n1. First\n2. Second\n\n');
  });

  it('preserves a nested (indented) sub-list instead of truncating it', () => {
    // Regression: /<li>(.*?)<\/li>/ has no notion of nesting and closes at the
    // *first* </li> it finds — the innermost one — corrupting Tab-indented
    // sub-bullets or lettered sub-clauses pasted from Word.
    const md = convertHtmlToMarkdown(el('<ul><li>A<ul><li>A1</li><li>A2</li></ul></li><li>B</li></ul>'));
    expect(md).toBe('\n- A\n  - A1\n  - A2\n- B\n\n');
  });

  it('preserves a nested ordered sub-list with its own numbering', () => {
    const md = convertHtmlToMarkdown(el('<ol><li>A<ol><li>A1</li><li>A2</li></ol></li><li>B</li></ol>'));
    expect(md).toBe('\n1. A\n  1. A1\n  2. A2\n2. B\n\n');
  });

  it('does not silently drop bold/italic content spanning a line break', () => {
    // Regression: the old <b>(.*?)<\/b> regex had no dotAll flag, so a literal
    // newline character inside the tag left it unmatched and later stripped by
    // the catch-all tag remover, silently discarding the formatting.
    const strongText = document.createElement('div');
    strongText.innerHTML = '<strong>Line1</strong>';
    strongText.querySelector('strong').appendChild(document.createTextNode('\nLine2'));
    expect(convertHtmlToMarkdown(strongText)).toBe('**Line1\nLine2**');
  });

  it('handles combined bold+italic nesting', () => {
    expect(convertHtmlToMarkdown(el('<b><i>both</i></b>'))).toBe('***both***');
  });

  it('still converts the simple, non-nested cases correctly', () => {
    const md = convertHtmlToMarkdown(el('<h2>Title</h2><p>Some <strong>bold</strong> and <i>italic</i> text.</p>'));
    expect(md.replace(/\n{3,}/g, '\n\n')).toBe('\n## Title\n\nSome **bold** and *italic* text.\n');
  });
});
