import katex from 'katex';

// 1. Convert visual HTML to clean Markdown + Jinja (using Text Placeholders to bypass DOM serialisation linebreak bugs)
// Pure DOM-element-in/string-out helper, no store or editor-state dependencies.
export const convertHtmlToMarkdown = (element) => {
  const clone = element.cloneNode(true);

  // Remove UI helper elements before conversion
  clone.querySelectorAll('.j-head, .j-actions, .j-footer, .j-inline-tag, .btn-layout, .btn-trash, .trailing-editable-line, .pandoc-metadata-chip').forEach(el => el.remove());

  // Replace variable chips in the element
  clone.querySelectorAll('.j-var-chip').forEach(c => {
    let raw = (c.getAttribute('data-raw') || '').trim();
    if (raw.endsWith('.')) raw = raw.slice(0, -1);
    const parts = raw.split('|');
    const expr = parts[0].trim();
    const filter = parts.slice(1).join('|').trim();
    const str = expr ? (filter ? `{{ ${expr} | ${filter} }}` : `{{ ${expr} }}`) : '[Variable sense nom]';
    c.parentNode.replaceChild(document.createTextNode(str), c);
  });

  // Replace math chips in the element
  clone.querySelectorAll('.latex-chip').forEach(c => {
    const expr = c.getAttribute('data-expr') || '';
    const type = c.getAttribute('data-type') || 'inline';
    const marker = type === 'display' ? `$$${expr}$$` : `$${expr}$`;
    c.parentNode.replaceChild(document.createTextNode(marker), c);
  });

  // Serialize the (now chip-free) DOM tree to Markdown by recursively walking
  // it, rather than running regex over the innerHTML string. A regex like
  // /<li>(.*?)<\/li>/ has no notion of nesting and truncates at the *first*
  // closing tag it finds — which is the innermost one — silently corrupting
  // any nested list (e.g. a Tab-indented sub-bullet, or a lettered sub-clause
  // pasted from Word) and any <div> that itself contains a nested <div>
  // (common in browser-generated contentEditable markup). Walking real DOM
  // nodes handles arbitrary nesting correctly by construction. It also fixes
  // ordered lists always rendering as "-" bullets: the previous regex chain
  // converted every <li> to "- $1" globally *before* the <ol>-specific
  // numbering pass ever got a chance to see one.
  const HEADING_MARKERS = { H1: '#', H2: '##', H3: '###', H4: '####', H5: '#####', H6: '######' };

  const childrenToMarkdown = (node, listDepth) => {
    let out = '';
    node.childNodes.forEach(child => { out += nodeToMarkdown(child, listDepth); });
    return out;
  };

  const listItemToMarkdown = (li, depth, orderedIndex) => {
    const indent = '  '.repeat(depth);
    const marker = orderedIndex !== null ? `${orderedIndex}.` : '-';

    // Split this <li>'s own inline content from any nested <ul>/<ol> inside it
    let inlineMd = '';
    let nestedMd = '';
    li.childNodes.forEach(child => {
      if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'UL' || child.tagName === 'OL')) {
        nestedMd += nodeToMarkdown(child, depth + 1);
      } else {
        inlineMd += nodeToMarkdown(child, depth);
      }
    });

    let out = `${indent}${marker} ${inlineMd.trim()}\n`;
    if (nestedMd.trim()) {
      out += nestedMd.replace(/^\n+/, '').replace(/\n{2,}/g, '\n');
    }
    return out;
  };

  const nodeToMarkdown = (node, listDepth = 0) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName;

    if (HEADING_MARKERS[tag]) {
      return `\n${HEADING_MARKERS[tag]} ${childrenToMarkdown(node, listDepth).trim()}\n\n`;
    }
    if (tag === 'B' || tag === 'STRONG') {
      const inner = childrenToMarkdown(node, listDepth);
      return inner.trim() ? `**${inner}**` : inner;
    }
    if (tag === 'I' || tag === 'EM') {
      const inner = childrenToMarkdown(node, listDepth);
      return inner.trim() ? `*${inner}*` : inner;
    }
    if (tag === 'BR') {
      return '\n';
    }
    if (tag === 'UL' || tag === 'OL') {
      let out = '\n';
      let counter = 1;
      node.childNodes.forEach(child => {
        if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'LI') {
          out += listItemToMarkdown(child, listDepth, tag === 'OL' ? counter++ : null);
        }
      });
      return out + '\n';
    }
    if (tag === 'P') {
      return `\n${childrenToMarkdown(node, listDepth)}\n`;
    }
    if (tag === 'DIV') {
      if (node.childNodes.length === 1 && node.firstChild.nodeType === Node.ELEMENT_NODE && node.firstChild.tagName === 'BR') {
        return '\n';
      }
      return `\n${childrenToMarkdown(node, listDepth)}`;
    }
    // Unknown/generic wrapper (span, etc.): drop the tag, keep its content
    return childrenToMarkdown(node, listDepth);
  };

  return childrenToMarkdown(clone, 0);
};

// 1. Convert visual HTML to clean Markdown + Jinja (using Text Placeholders to bypass DOM serialisation linebreak bugs)
export const parseHtmlToMarkdown = (sourceElement) => {
  const clone = sourceElement.cloneNode(true);

  // Remove helper trailing editable lines used for caret placement
  clone.querySelectorAll('.trailing-editable-line').forEach(el => el.remove());

  // Extract leading Pandoc YAML metadata chip if present
  let pandocYamlHeader = '';
  const metadataChip = clone.querySelector('.pandoc-metadata-chip');
  if (metadataChip) {
    const rawYaml = decodeURIComponent(metadataChip.getAttribute('data-raw') || '');
    if (rawYaml.trim()) {
      pandocYamlHeader = `---\n${rawYaml.trim()}\n---\n\n`;
    }
    metadataChip.remove();
  }

  // Replace tables with full Row and Column loops support and placeholders FIRST
  const tablePlaceholders = [];
  clone.querySelectorAll('table').forEach((table, idx) => {
    const rowLoop = table.querySelector('.j-row-loop');
    const colLoopCell = table.querySelector('[data-jinja-col-loop]');

    let mdTable = "";
    if (rowLoop) {
      // Dynamic Table
      const loopExpr = rowLoop.getAttribute('data-jinja-for') || '';
      mdTable += `\n<!-- DYNAMIC_TABLE_START:${loopExpr} -->\n`;

      const rows = Array.from(table.querySelectorAll('tr'));
      rows.forEach((row, rIdx) => {
        const cells = Array.from(row.querySelectorAll('th, td'));

        // Convert chips inside cells to their Jinja representation BEFORE reading innerText
        const cellTexts = cells.map(cell => {
          let text = cell.innerText.trim();
          const chip = cell.querySelector('.j-var-chip');
          if (chip) {
            const raw = chip.getAttribute('data-raw') || '';
            text = `{{ ${raw} }}`;
          }
          return text;
        });

        let rowStr = "| " + cellTexts.join(" | ") + " |\n";

        if (row.classList.contains('j-row-loop')) {
          mdTable += `{% for ${loopExpr} %}\n${rowStr}{% endfor %}\n`;
        } else {
          mdTable += rowStr;
        }

        if (rIdx === 0 || row.querySelector('th')) {
          mdTable += "| " + cells.map(th => {
            const align = th.getAttribute('data-align') || 'left';
            return align === 'center' ? ':---:' : (align === 'right' ? '---:' : '---');
          }).join(" | ") + " |\n";
        }
      });
      mdTable += "<!-- DYNAMIC_TABLE_END -->\n";
    } else if (colLoopCell) {
      // Transposed Table
      const loopExpr = colLoopCell.getAttribute('data-jinja-col-loop') || '';
      let colHeaderKey = '';
      let rowKeys = [];
      const thLoop = table.querySelector('th[data-jinja-col-loop]');
      const thChip = thLoop ? thLoop.querySelector('.j-var-chip') : null;
      if (thChip) {
        let raw = (thChip.getAttribute('data-raw') || '').trim();
        if (raw.endsWith('.')) raw = raw.slice(0, -1);
        colHeaderKey = raw.split('.').pop();
      }

      table.querySelectorAll('tbody tr').forEach(r => {
        const tdLoop = r.querySelector('td[data-jinja-col-loop]');
        if (tdLoop) {
          const chip = tdLoop.querySelector('.j-var-chip');
          if (chip) {
            let raw = (chip.getAttribute('data-raw') || '').trim();
            if (raw.endsWith('.')) raw = raw.slice(0, -1);
            rowKeys.push(raw.split('.').pop());
          }
        }
      });

      mdTable += `\n<!-- TRANSPOSED_TABLE_START:${loopExpr};colHeader=${colHeaderKey};rows=${rowKeys.join(',')} -->\n`;

      const rows = Array.from(table.querySelectorAll('tr'));
      rows.forEach((row, rIdx) => {
        const cells = Array.from(row.querySelectorAll('th, td'));
        let rowStr = "| ";
        cells.forEach(cell => {
          const colLoop = cell.getAttribute('data-jinja-col-loop');

          let cellText = cell.innerText.trim();
          const chip = cell.querySelector('.j-var-chip');
          if (chip) {
            let raw = (chip.getAttribute('data-raw') || '').trim();
            if (raw.endsWith('.')) raw = raw.slice(0, -1);
            cellText = `{{ ${raw} }}`;
          }

          if (colLoop) {
            rowStr += `{% for ${colLoop} %}${cellText} | {% endfor %}`;
          } else {
            rowStr += `${cellText} | `;
          }
        });
        rowStr += "\n";
        mdTable += rowStr;

        if (rIdx === 0 || row.querySelector('th')) {
          let divStr = "| ";
          cells.forEach(cell => {
            const colLoop = cell.getAttribute('data-jinja-col-loop');
            const align = cell.getAttribute('data-align') || 'left';
            const alignStr = align === 'center' ? ':---:' : (align === 'right' ? '---:' : '---');
            if (colLoop) {
              divStr += `{% for ${colLoop} %}${alignStr} | {% endfor %}`;
            } else {
              divStr += `${alignStr} | `;
            }
          });
          divStr += "\n";
          mdTable += divStr;
        }
      });
      mdTable += "<!-- TRANSPOSED_TABLE_END -->\n";
    } else {
      // Manual Table
      mdTable += "\n";
      const rows = Array.from(table.querySelectorAll('tr'));
      rows.forEach((row, rIdx) => {
        const cells = Array.from(row.querySelectorAll('th, td'));
        mdTable += "| " + cells.map(c => c.innerText.trim()).join(" | ") + " |\n";
        if (rIdx === 0 || row.querySelector('th')) {
          mdTable += "| " + cells.map(th => {
            const align = th.getAttribute('data-align') || 'left';
            return align === 'center' ? ':---:' : (align === 'right' ? '---:' : '---');
          }).join(" | ") + " |\n";
        }
      });
      mdTable += "\n";
    }

    tablePlaceholders[idx] = mdTable;
    const placeholderText = document.createTextNode(`\n\n__TABLE_PLACEHOLDER_${idx}__\n\n`);
    table.parentNode.replaceChild(placeholderText, table);
  });

  // Replace logical cards in reverse order (innermost first)
  const blockPlaceholders = [];
  const blocks = Array.from(clone.querySelectorAll('.jinja-block'));
  for (let idx = blocks.length - 1; idx >= 0; idx--) {
    const block = blocks[idx];
    let code = "";

    const isInline = block.classList.contains('inline') || block.getAttribute('data-layout') === 'inline';

    if (isInline) {
      const type = block.getAttribute('data-type') || block.querySelector('.j-head')?.getAttribute('data-type') || 'if';
      const cond = block.getAttribute('data-cond') || (block.querySelector('.j-cond-text')?.getAttribute('data-cond') || '');
      const contentEl = block.querySelector('.j-content');
      let contentMd = contentEl ? convertHtmlToMarkdown(contentEl) : '';

      code = `{% ${type} ${cond} %}${contentMd.trim()}{% end${type === 'for' ? 'for' : 'endif'} %}`;
    } else {
      const type = block.getAttribute('data-type') || block.querySelector('.j-head')?.getAttribute('data-type') || 'if';
      const cond = block.getAttribute('data-cond') || (block.querySelector('.j-cond-text')?.getAttribute('data-cond') || '');

      code += `{% ${type} ${cond} %}\n`;

      Array.from(block.childNodes).forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.classList.contains('j-content')) {
            const innerMd = convertHtmlToMarkdown(node).trim();
            if (innerMd) {
              code += innerMd + '\n';
            }
          } else if (node.classList.contains('j-branch')) {
            const bType = node.getAttribute('data-type');
            if (bType === 'else') {
              code += `{% else %}\n`;
            } else {
              const bCond = node.querySelector('.j-cond-text')?.getAttribute('data-cond') || '';
              code += `{% ${bType} ${bCond} %}\n`;
            }
          }
        }
      });

      code += type === 'for' ? `{% endfor %}` : `{% endif %}`;
    }

    blockPlaceholders[idx] = code;
    const placeholderText = document.createTextNode(isInline ? `__BLOCK_PLACEHOLDER_${idx}__` : `\n__BLOCK_PLACEHOLDER_${idx}__\n`);
    block.parentNode.replaceChild(placeholderText, block);
  }

  // Now convert the remaining document (which now only has text, placeholders and standard tags)
  let markdown = convertHtmlToMarkdown(clone);

  // Restore Placeholders in forward order (parent outermost first, introducing child placeholders, then innermost)
  for (let idx = 0; idx < blockPlaceholders.length; idx++) {
    const code = blockPlaceholders[idx];
    if (code === undefined) continue;
    markdown = markdown.replace(new RegExp(`__BLOCK_PLACEHOLDER_${idx}__`, 'g'), () => code);
  }
  tablePlaceholders.forEach((mdTable, idx) => {
    markdown = markdown.replace(new RegExp(`__TABLE_PLACEHOLDER_${idx}__`, 'g'), () => mdTable);
  });

  let cleanBody = markdown.replace(/\n{3,}/g, '\n\n').trim();
  cleanBody = cleanBody.replace(/(?<!\n\n)\n(#{1,6}\s+.*)/g, '\n\n$1');
  return pandocYamlHeader ? pandocYamlHeader + cleanBody : cleanBody;
};

/**
 * Bidirectional Markdown <-> Jinja2 <-> HTML compiler used by the visual editor.
 * Groups the functions together because they call each other directly
 * (compileMarkdownToHtml -> parseCommentTablesToHtml/parseMarkdownTablesToHtml ->
 * renderTableRowsToHtml/convertJinjaToChips -> createJinjaVarChip -> isVariableDefinedInSchema),
 * so splitting them further would only add indirection without reducing coupling.
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

    // Resolve active loop iterator prefixes (e.g., "lot.NomLot" in loop for lot in objecte.lots)
    let resolvedExpr = cleanExpr;
    const parts = cleanExpr.split('.');
    if (parts.length > 1 && loopStack && loopStack.length > 0) {
      const iter = parts[0];
      const subPath = parts.slice(1).join('.');
      const loopMatch = loopStack.find(l => l && l.iterator === iter);
      if (loopMatch) {
        resolvedExpr = `${loopMatch.arrayPath}.${subPath}`;
      }
    }

    // 1. Direct evaluation in Excel JSON Data
    if (gData) {
      const directVal = resolvePath(gData, resolvedExpr);
      if (directVal !== null && directVal !== undefined) return true;
    }

    // 2. Metadata Schema evaluation (exact path or scoped match)
    const metaMatch = metas.some(m => {
      if (!m || !m.element) return false;
      const fullMetaPath = m.group ? `${m.group}.${m.element}` : m.element;
      if (fullMetaPath === resolvedExpr || m.element === resolvedExpr) return true;
      if (m.group && resolvedExpr.endsWith(`${m.group}.${m.element}`)) return true;
      return false;
    });
    if (metaMatch) return true;

    // 3. Fallback root key check in gData
    if (gData && gData[cleanExpr] !== undefined) return true;

    return false;
  };

  // Helper: Create HTML chip element with visual highlight for undefined variables
  const createJinjaVarChip = (v, loopStack = []) => {
    const vars = v.split('|');
    const expr = vars[0].trim();
    const filter = vars.length > 1 ? vars.slice(1).join('|').trim() : '';
    const displayLabel = resolveFieldLabel(v);
    const isDefined = isVariableDefinedInSchema(expr, loopStack);
    const rawAttr = `${expr}${filter ? '|' + filter : ''}`;

    if (!isDefined && hasCheckedTemplate.value) {
      return `<span class="j-var-chip undefined-var" contenteditable="false" data-raw="${rawAttr}" title="⚠️ Atenció: La variable '${expr}' no està definida a l'esquema de dades!"><span class="warn-icon">⚠️</span>${displayLabel}</span>`;
    }

    return `<span class="j-var-chip" contenteditable="false" data-raw="${rawAttr}">${displayLabel}</span>`;
  };

  // Helper: Convert inner cell templates to chips
  const convertJinjaToChips = (text, loopStack = []) => {
    return text.replace(/\{\{\s*(.*?)\s*\}\}/g, (m, v) => createJinjaVarChip(v, loopStack));
  };

  const findBestKeyMatch = (arrayPath, label) => {
    if (!store.excelJsonData || !arrayPath || !label) return '';
    const arr = resolvePath(store.excelJsonData, arrayPath);
    if (!arr || !Array.isArray(arr) || arr.length === 0) return '';

    const keys = Object.keys(arr[0]);
    const normLabel = label.toLowerCase().replace(/[^a-z0-9]/g, '');

    for (const k of keys) {
      if (k.toLowerCase().replace(/[^a-z0-9]/g, '') === normLabel) {
        return k;
      }
    }
    for (const k of keys) {
      if (k.toLowerCase().includes(normLabel) || normLabel.includes(k.toLowerCase())) {
        return k;
      }
    }
    return keys[0] || '';
  };

  const findColHeaderKeyMatch = (arrayPath, values) => {
    if (!store.excelJsonData || !arrayPath || !values || values.length === 0) return '';
    const arr = resolvePath(store.excelJsonData, arrayPath);
    if (!arr || !Array.isArray(arr) || arr.length === 0) return '';

    const keys = Object.keys(arr[0]);
    for (const k of keys) {
      const sampleVals = arr.map(item => String(item[k]).trim().toLowerCase());
      const matchCount = values.filter(v => sampleVals.includes(v.trim().toLowerCase())).length;
      if (matchCount > 0) {
        return k;
      }
    }
    return keys[0] || '';
  };

  // Parse framed tables (transposed/dynamic) using metadata tags
  const parseCommentTablesToHtml = (md) => {
    let processed = md;

    // 1. Parse Transposed Tables
    processed = processed.replace(/<!--\s*TRANSPOSED_TABLE_START:(.*?)\s*-->([\s\S]*?)<!--\s*TRANSPOSED_TABLE_END\s*-->/g, (match, meta, tableContent) => {
      const parts = meta.split(';');
      const loopExpr = parts[0].trim();
      let colHeader = '';
      let rowsStr = '';
      parts.slice(1).forEach(p => {
        const [k, v] = p.split('=');
        if (k === 'colHeader') colHeader = v;
        if (k === 'rows') rowsStr = v;
      });
      const rowKeys = rowsStr ? rowsStr.split(',') : [];

      const lines = tableContent.trim().split('\n').filter(l => l.trim().startsWith('|'));
      if (lines.length < 2) return match;

      const splitLine = (line) => {
        const clean = line.trim().replace(/^\|/, '').replace(/\|$/, '');
        return clean.split('|').map(c => c.trim());
      };

      const headers = splitLine(lines[0]);
      const headerValues = headers.slice(1);

      const loopVar = loopExpr.split(' ')[0];
      const afterIn = loopExpr.split(' in ')[1] || '';
      const arrayPath = afterIn.split(' if ')[0].trim();

      // Auto-healing fallback for column header key
      if (!colHeader) {
        colHeader = findColHeaderKeyMatch(arrayPath, headerValues);
      }

      const aligns = [];
      if (lines[1]) {
        splitLine(lines[1]).forEach(div => {
          if (div.startsWith(':') && div.endsWith(':')) aligns.push('center');
          else if (div.endsWith(':')) aligns.push('right');
          else aligns.push('left');
        });
      }

      let html = '<table><thead><tr>';
      html += '<th data-align="left">Dada</th>';
      const headJinjaMatch = lines[0].match(/\{\{\s*([^\}]+)\s*\}\}/);
      const headChipRaw = headJinjaMatch ? headJinjaMatch[1].trim() : `${loopVar}.${colHeader}`;
      html += `<th data-align="center" style="text-align: center;" data-jinja-col-loop="${loopExpr}"><span class="j-var-chip" contenteditable="false" data-raw="${headChipRaw}">${resolveFieldLabel(headChipRaw)}</span></th>`;
      html += '</tr></thead><tbody>';

      const bodyLines = lines.slice(2);
      const parsedRowKeys = [...rowKeys];
      bodyLines.forEach((bl, idx) => {
        const cells = splitLine(bl);
        const rowLabel = cells[0] || 'Dada';
        if (!parsedRowKeys[idx]) {
          parsedRowKeys[idx] = findBestKeyMatch(arrayPath, rowLabel);
        }

        const key = parsedRowKeys[idx] || '';
        const jinjaMatch = bl.match(/\{\{\s*([^\}]+)\s*\}\}/);
        const cellChipRaw = jinjaMatch ? jinjaMatch[1].trim() : (key.includes('.') ? key : `${loopVar}.${key}`);
        const align = aligns[1] || 'left';

        html += '<tr>';
        html += `<td>${rowLabel}</td>`;
        html += `<td style="text-align: ${align};" data-jinja-col-loop="${loopExpr}"><span class="j-var-chip" contenteditable="false" data-raw="${cellChipRaw}">${resolveFieldLabel(cellChipRaw)}</span></td>`;
        html += '</tr>';
      });
      html += '</tbody></table>';
      return html;
    });

    // 2. Parse Dynamic Tables
    processed = processed.replace(/<!--\s*DYNAMIC_TABLE_START:(.*?)\s*-->([\s\S]*?)<!--\s*DYNAMIC_TABLE_END\s*-->/g, (match, loopExpr, tableContent) => {
      const lines = tableContent.trim().split('\n').filter(l => l.trim().startsWith('|') || l.trim().startsWith('{%'));

      const headerLine = lines.find(l => l.startsWith('|') && !l.includes('---'));
      const dividerLine = lines.find(l => l.startsWith('|') && l.includes('---'));
      const bodyLine = lines.find(l => l.startsWith('|') && l.includes('{{'));

      if (!headerLine) return match;

      const splitLine = (line) => {
        const clean = line.trim().replace(/^\|/, '').replace(/\|$/, '');
        return clean.split('|').map(c => c.trim());
      };

      const headers = splitLine(headerLine);
      const aligns = [];
      if (dividerLine) {
        splitLine(dividerLine).forEach(div => {
          if (div.startsWith(':') && div.endsWith(':')) aligns.push('center');
          else if (div.endsWith(':')) aligns.push('right');
          else aligns.push('left');
        });
      }

      let html = '<table><thead><tr>';
      headers.forEach((h, idx) => {
        const align = aligns[idx] || 'left';
        html += `<th data-align="${align}" style="text-align: ${align};">${h}</th>`;
      });
      html += '</tr></thead><tbody>';

      html += `<tr class="j-row-loop" data-jinja-for="${loopExpr.trim()}">`;
      if (bodyLine) {
        splitLine(bodyLine).forEach((cell, idx) => {
          const align = aligns[idx] || 'left';
          const chipHtml = convertJinjaToChips(cell);
          html += `<td style="text-align: ${align};">${chipHtml}</td>`;
        });
      }
      html += '</tr></tbody></table>';
      return html;
    });

    return processed;
  };

  // Parser: Restore remaining standard Markdown tables to Visual HTML tables
  const parseMarkdownTablesToHtml = (md) => {
    const lines = md.split('\n');
    let result = [];
    let inTable = false;
    let tableRows = [];

    for (let line of lines) {
      const isRow = line.trim().startsWith('|') && line.trim().endsWith('|');
      if (isRow) {
        inTable = true;
        tableRows.push(line.trim());
      } else {
        if (inTable) {
          result.push(renderTableRowsToHtml(tableRows));
          inTable = false;
          tableRows = [];
        }
        result.push(line);
      }
    }
    if (inTable) {
      result.push(renderTableRowsToHtml(tableRows));
    }
    return result.join('\n');
  };

  const renderTableRowsToHtml = (rows) => {
    if (rows.length < 2) return rows.join('\n');

    const isDivider = (r) => r.replace(/[\s\|:\-]/g, '') === '';

    let headerRow = rows[0];
    let dividerRow = rows[1];
    let bodyRows = rows.slice(2);

    if (!isDivider(dividerRow)) {
      bodyRows = rows.slice(1);
      dividerRow = '';
    }

    const splitLine = (line) => {
      let safe = line.replace(/\{%.*?%\}/g, (m) => m.replace(/\|/g, '__PIPE__'));
      safe = safe.trim().replace(/^\|/, '').replace(/\|$/, '');
      return safe.split('|').map(cell => cell.replace(/__PIPE__/g, '|').trim());
    };

    const headers = splitLine(headerRow);
    const alignments = [];
    if (dividerRow) {
      const divs = splitLine(dividerRow);
      divs.forEach(div => {
        let cleanDiv = div;
        const loopMatch = div.match(/\{%\s*for\s+.*?\s*%\}(.*?)\{%\s*endfor\s*%\}/);
        if (loopMatch) {
          cleanDiv = loopMatch[1].trim();
        }

        if (cleanDiv.startsWith(':') && cleanDiv.endsWith(':')) {
          alignments.push('center');
        } else if (cleanDiv.endsWith(':')) {
          alignments.push('right');
        } else {
          alignments.push('left');
        }
      });
    }

    let html = '<table><thead><tr>';
    headers.forEach((h, idx) => {
      const align = alignments[idx] || 'left';
      const loopMatch = h.match(/\{%\s*for\s+(.*?)\s*%\}(.*?)\|\s*\{%\s*endfor\s*%\}/) || h.match(/\{%\s*for\s+(.*?)\s*%\}(.*?)\{%\s*endfor\s*%\}/);

      if (loopMatch) {
        const cond = loopMatch[1].trim();
        const innerVal = loopMatch[2].trim();
        const chipHtml = convertJinjaToChips(innerVal);
        html += `<th data-align="${align}" style="text-align: ${align};" data-jinja-col-loop="${cond}">${chipHtml}</th>`;
      } else {
        const chipHtml = convertJinjaToChips(h);
        html += `<th data-align="${align}" style="text-align: ${align};">${chipHtml}</th>`;
      }
    });
    html += '</tr></thead><tbody>';

    bodyRows.forEach(r => {
      const rowLoopMatch = r.match(/^\{%\s*for\s+(.*?)\s*%\}(.*)\{%\s*endfor\s*%\}$/);
      let loopCond = '';
      let rowContent = r;
      if (rowLoopMatch) {
        loopCond = rowLoopMatch[1].trim();
        rowContent = rowLoopMatch[2].trim();
      }

      const cells = splitLine(rowContent);
      html += loopCond ? `<tr class="j-row-loop" data-jinja-for="${loopCond}">` : '<tr>';

      cells.forEach((cell, idx) => {
        const align = alignments[idx] || 'left';
        const colLoopMatch = cell.match(/\{%\s*for\s+(.*?)\s*%\}(.*?)\|\s*\{%\s*endfor\s*%\}/) || cell.match(/\{%\s*for\s+(.*?)\s*%\}(.*?)\{%\s*endfor\s*%\}/);

        if (colLoopMatch) {
          const cond = colLoopMatch[1].trim();
          const innerVal = colLoopMatch[2].trim();
          const chipHtml = convertJinjaToChips(innerVal);
          html += `<td style="text-align: ${align};" data-jinja-col-loop="${cond}">${chipHtml}</td>`;
        } else {
          const chipHtml = convertJinjaToChips(cell);
          html += `<td style="text-align: ${align};">${chipHtml}</td>`;
        }
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  };

  // 2. Compile raw Markdown + Jinja back to HTML visual tree
  const compileMarkdownToHtml = (markdownText) => {
    let processed = markdownText || '';

    // 0. Extract leading Pandoc YAML metadata block if present
    let yamlHeaderHtml = '';
    const yamlMatch = processed.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (yamlMatch) {
      const rawYaml = yamlMatch[1];
      processed = processed.slice(yamlMatch[0].length);
      yamlHeaderHtml = `<div class="pandoc-metadata-chip" contenteditable="false" data-raw="${encodeURIComponent(rawYaml)}" style="background-color: var(--bg-tertiary); border: 1px dashed var(--color-primary); border-radius: 6px; padding: 8px 12px; margin-bottom: 1rem; user-select: none;">
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
    }

    // 1. Extract math formulas and replace with placeholders to avoid double-parsing variables inside them
    const mathPlaceholders = [];

    // Extract double dollar formulas (display math)
    processed = processed.replace(/\$\$(.*?)\$\$/gs, (m, expr) => {
      const idx = mathPlaceholders.length;
      mathPlaceholders.push({ expr: expr.trim(), type: 'display' });
      return `__MATH_PLACEHOLDER_${idx}__`;
    });

    // Extract single dollar formulas (inline math)
    processed = processed.replace(/\$(.*?)\$/g, (m, expr) => {
      const idx = mathPlaceholders.length;
      mathPlaceholders.push({ expr: expr.trim(), type: 'inline' });
      return `__MATH_PLACEHOLDER_${idx}__`;
    });

    // Run table parsers on the clean text (with math hidden)
    processed = parseCommentTablesToHtml(processed);
    processed = parseMarkdownTablesToHtml(processed);

    // 2. Parse Jinja control tags
    const tokens = processed.split(/(\{%.*?%\})/g);
    let htmlResult = '';
    let stack = [];

    for (let idx = 0; idx < tokens.length; idx++) {
      const chunk = tokens[idx];
      const matchTag = chunk.match(/\{%\s*(.*?)\s*%\}/);
      if (matchTag) {
        const expr = matchTag[1].trim();
        if (expr.startsWith('for ')) {
          const cond = expr.substring(4).trim();

          // Detect layout mode: block if tag is on its own line
          const prevChunk = idx > 0 ? tokens[idx - 1] : '';
          const nextChunk = idx < tokens.length - 1 ? tokens[idx + 1] : '';
          const isBlock = (idx === 0 || /\n\s*$/.test(prevChunk)) && (idx === tokens.length - 1 || /^\s*\n/.test(nextChunk));

          if (isBlock) {
            htmlResult += `<div class="jinja-block" contenteditable="false" data-layout="block" data-type="for" data-cond="${cond}"><div class="j-head" data-type="for"><div style="display:flex;align-items:center;gap:4px;"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg> <span style="font-weight:700;color:var(--color-primary);">PER CADA:</span> <span class="j-cond-text" data-cond="${cond}">${cond}</span></div><div class="j-actions"><button class="j-btn-mini btn-layout" style="background-color:var(--color-primary);color:white;border:none;display:inline-flex;align-items:center;gap:3px;" title="Canvia a mode integrat al text (Inline)"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> <span>Inline</span></button><button class="j-btn-mini btn-trash" style="background-color:var(--color-danger);color:white;border:none;display:inline-flex;align-items:center;justify-content:center;" title="Elimina el bucle"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div></div><div class="j-content" contenteditable="true">`;
            stack.push('for');
          } else {
            htmlResult += `<span class="jinja-block inline" contenteditable="false" data-layout="inline" data-type="for" data-cond="${cond}"><span class="j-inline-tag" contenteditable="false" title="Fes clic per passar a BLOC">{% for ${cond} %}</span><span class="j-content" contenteditable="true">`;
            stack.push('for-inline');
          }
        } else if (expr.startsWith('if ')) {
          const cond = expr.substring(3).trim();

          // Detect layout mode: block if tag is on its own line
          const prevChunk = idx > 0 ? tokens[idx - 1] : '';
          const nextChunk = idx < tokens.length - 1 ? tokens[idx + 1] : '';
          const isBlock = (idx === 0 || /\n\s*$/.test(prevChunk)) && (idx === tokens.length - 1 || /^\s*\n/.test(nextChunk));

          if (isBlock) {
            htmlResult += `<div class="jinja-block" contenteditable="false" data-layout="block" data-type="if" data-cond="${cond}"><div class="j-head" data-type="if"><div style="display:flex;align-items:center;gap:4px;"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg> <span style="font-weight:700;color:#b45309;">SI:</span> <span class="j-cond-text" data-cond="${cond}">${cond}</span></div><div class="j-actions"><button class="j-btn-mini btn-layout" style="background-color:var(--color-primary);color:white;border:none;display:inline-flex;align-items:center;gap:3px;" title="Canvia a mode integrat al text (Inline)"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> <span>Inline</span></button><button class="j-btn-mini btn-elif" title="Afegeix branca O SI (ELIF)">+ ELIF</button><button class="j-btn-mini btn-else" title="Afegeix branca EN CAS CONTRARI (ELSE)">+ ELSE</button><button class="j-btn-mini btn-trash" style="background-color:var(--color-danger);color:white;border:none;display:inline-flex;align-items:center;justify-content:center;" title="Elimina el condicional"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div></div><div class="j-content" contenteditable="true">`;
            stack.push('if');
          } else {
            htmlResult += `<span class="jinja-block inline" contenteditable="false" data-layout="inline" data-type="if" data-cond="${cond}"><span class="j-inline-tag" contenteditable="false" title="Fes clic per passar a BLOC">{% if ${cond} %}</span><span class="j-content" contenteditable="true">`;
            stack.push('if-inline');
          }
        } else if (expr.startsWith('elif ')) {
          const cond = expr.substring(5).trim();
          const parentType = stack[stack.length - 1];
          if (parentType === 'if-inline') {
            htmlResult += `</span><span class="j-inline-tag" contenteditable="false">{% elif ${cond} %}</span><span class="j-content" contenteditable="true">`;
          } else {
            htmlResult += `</div><div class="j-branch" data-type="elif"><div style="display:flex;align-items:center;gap:4px;"><span style="font-weight:700;color:#b45309;">O SI:</span> <span class="j-cond-text" data-cond="${cond}">${cond}</span></div><button class="j-btn-mini btn-branch-trash" style="background-color:var(--color-danger);color:white;border:none;display:inline-flex;align-items:center;justify-content:center;" title="Elimina la branca"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div><div class="j-content" contenteditable="true">`;
          }
        } else if (expr === 'else') {
          const parentType = stack[stack.length - 1];
          if (parentType === 'if-inline') {
            htmlResult += `</span><span class="j-inline-tag" contenteditable="false">{% else %}</span><span class="j-content" contenteditable="true">`;
          } else {
            htmlResult += `</div><div class="j-branch" data-type="else"><div style="display:flex;align-items:center;gap:4px;"><span style="font-weight:700;color:#b45309;">EN CAS CONTRARI</span></div><button class="j-btn-mini btn-branch-trash" style="background-color:var(--color-danger);color:white;border:none;display:inline-flex;align-items:center;justify-content:center;" title="Elimina la branca"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div><div class="j-content" contenteditable="true">`;
          }
        } else if (expr === 'endif' || expr === 'endfor') {
          const parentType = stack.pop();
          if (parentType === 'for-inline' || parentType === 'if-inline') {
            const type = parentType === 'for-inline' ? 'for' : 'if';
            htmlResult += `</span><span class="j-inline-tag" contenteditable="false" title="Fes clic per passar a BLOC">{% end${type} %}</span></span>`;
          } else {
            const label = parentType === 'for' ? 'FINAL BUCLE' : 'FINAL CONDICIONAL';
            htmlResult += `</div><div class="j-footer"><span>${label}</span></div></div>`;
          }
        }
      } else {
        let blockText = chunk.replace(/\{\{\s*(.*?)\s*\}\}/g, (m, v) => createJinjaVarChip(v, activeLoopStack.value || []));

        blockText = blockText.replace(/^###### (.*)$/gm, '<h6>$1</h6>')
                             .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
                             .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
                             .replace(/^### (.*)$/gm, '<h3>$1</h3>')
                             .replace(/^## (.*)$/gm, '<h2>$1</h2>')
                             .replace(/^# (.*)$/gm, '<h1>$1</h1>');

        blockText = blockText.replace(/^- (.*)$/gm, '<ul><li>$1</li></ul>')
                             .replace(/<\/ul>\s*<ul>/g, '')
                             .replace(/\n/g, '<br>');
        htmlResult += blockText;
      }
    }

    // 3. Restore and compile math placeholders
    mathPlaceholders.forEach((ph, idx) => {
      let render = '';
      const expr = ph.expr;
      const type = ph.type;
      try {
        const cleanExpr = expr.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, p1) => {
          const escaped = p1.trim().replace(/_/g, '\\_');
          return `\\text{[${escaped}]}`;
        });
        render = katex.renderToString(cleanExpr, { displayMode: type === 'display', throwOnError: false });
      } catch (_) {
        render = expr;
      }

      const replacement = type === 'display'
        ? `<div class="latex-chip display-math" contenteditable="false" data-type="display" data-expr="${expr}">${render}</div>\n`
        : `<span class="latex-chip inline-math" contenteditable="false" data-type="inline" data-expr="${expr}">${render}</span>`;

      htmlResult = htmlResult.replace(`__MATH_PLACEHOLDER_${idx}__`, replacement);
    });

    return yamlHeaderHtml + htmlResult;
  };

  return {
    isVariableDefinedInSchema,
    createJinjaVarChip,
    convertJinjaToChips,
    findBestKeyMatch,
    findColHeaderKeyMatch,
    parseCommentTablesToHtml,
    parseMarkdownTablesToHtml,
    renderTableRowsToHtml,
    compileMarkdownToHtml,
  };
}
