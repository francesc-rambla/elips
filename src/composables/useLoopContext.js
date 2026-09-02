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

import { ref } from 'vue';
import { universalFindSchema } from './useSchemaResolver';

/**
 * Resolves Jinja `{% for %}` loop context inside TemplateEditor.vue: given the
 * user's current cursor position (visual canvas or code textarea), figures out
 * which loop(s) it's nested in, what data array each one iterates, and what
 * columns/fields are available on that array — used to build the variable
 * sidebar, the loop-aware autocomplete, and to resolve relative paths like
 * "part.import" back to "pres.parts.import" while inside a loop.
 *
 * A factory (not plain exports) because `getActiveLoopStack` needs read access
 * to the editor's DOM refs and to `activeEditNode`/`savedRange` — two plain
 * `let` variables in TemplateEditor.vue (not reactive refs) that track the
 * last-focused editable node/selection Range. They can't be passed by
 * reference, so the caller passes getter functions instead; JS closures keep
 * these live without needing Vue reactivity.
 *
 * `activeLoopStack`/`activeLoopContext` are created here and returned so
 * TemplateEditor.vue's template and other functions can keep reading/writing
 * them exactly as before (this is the same ref, not a copy).
 */
export function useLoopContext({
  canvasRef,
  textareaRef,
  editorText,
  activeEditorTab,
  store,
  getActiveEditNode,
  getSavedRange,
}) {
  const activeLoopContext = ref(null); // { iterator, arrayPath, columns }
  const activeLoopStack = ref([]); // Stack of active loop contexts [{ iterator, arrayPath, columns }] ordered by depth (innermost first)

  const isInternalMetadataKey = (k) => {
    return k === 'editor_metadata' || k === '_hierarchy_schema';
  };

  // Resolve nested object path inside excelJsonData
  const resolvePath = (obj, path, currentStack = null) => {
    if (!obj || !path) return null;

    let effectivePath = path;
    const stackToUse = currentStack || activeLoopStack.value || [];

    if (stackToUse.length > 0) {
      for (const loopCtx of stackToUse) {
        const iter = loopCtx.iterator;
        if (effectivePath === iter) {
          effectivePath = loopCtx.arrayPath;
          break;
        } else if (effectivePath.startsWith(`${iter}.`)) {
          const sub = effectivePath.slice(iter.length + 1);
          effectivePath = `${loopCtx.arrayPath}.${sub}`;
          break;
        }
      }
    }

    // 1. Try direct evaluation of path
    const evaluateDirect = (pStr) => {
      const parts = pStr.split('.');
      let cur = obj;
      for (const p of parts) {
        if (cur && typeof cur === 'object') {
          if (Array.isArray(cur)) {
            if (cur.length > 0) {
              cur = cur[0][p];
            } else {
              return null;
            }
          } else {
            cur = cur[p];
          }
        } else {
          return null;
        }
      }
      return cur;
    };

    let res = evaluateDirect(effectivePath);
    if (res !== null && res !== undefined) return res;

    // 2. Fallback: Search inside all root sheets if path omitted root sheet prefix (e.g., "parts.activitats" -> "pres.parts.activitats")
    if (typeof obj === 'object' && obj !== null) {
      for (const rootKey of Object.keys(obj)) {
        if (isInternalMetadataKey(rootKey)) continue;
        const fullPathWithRoot = `${rootKey}.${effectivePath}`;
        res = evaluateDirect(fullPathWithRoot);
        if (res !== null && res !== undefined) return res;
      }
    }

    // 3. Fallback: Search by sheet/array name directly
    const lastSeg = effectivePath.split('.').pop();
    if (typeof obj === 'object' && obj !== null) {
      for (const [rootKey, rootVal] of Object.entries(obj)) {
        if (rootKey === lastSeg && Array.isArray(rootVal)) return rootVal;
        if (typeof rootVal === 'object' && rootVal !== null && lastSeg in rootVal && Array.isArray(rootVal[lastSeg])) {
          return rootVal[lastSeg];
        }
      }
    }

    return null;
  };

  // Recursive helper: Find array in excelJsonData by key name regardless of depth
  const findAnyArrayByName = (obj, targetName) => {
    if (!obj || typeof obj !== 'object' || !targetName) return null;
    const cleanTarget = targetName.split('.').pop().toLowerCase();

    const search = (item) => {
      if (!item || typeof item !== 'object') return null;
      if (Array.isArray(item)) {
        for (const el of item) {
          const found = search(el);
          if (found) return found;
        }
        return null;
      }

      for (const [k, v] of Object.entries(item)) {
        if (isInternalMetadataKey(k)) continue;
        if (k.toLowerCase() === cleanTarget && Array.isArray(v) && v.length > 0) {
          return v;
        }
        if (typeof v === 'object' && v !== null) {
          const found = search(v);
          if (found) return found;
        }
      }
      return null;
    };

    return search(obj);
  };

  // Helper: Map transient Jinja iterator variables (e.g. "part.activitats") to canonical schema paths (e.g. "pres.parts.activitats")
  const resolvePathToSchemaPath = (rawPath, stack) => {
    if (!rawPath) return '';
    let effectivePath = rawPath;

    if (stack && stack.length > 0) {
      for (const loopCtx of stack) {
        const iter = loopCtx.iterator;
        const parentSchemaPath = loopCtx.fullSchemaPath || loopCtx.arrayPath;
        if (effectivePath === iter) {
          effectivePath = parentSchemaPath;
          break;
        } else if (effectivePath.startsWith(`${iter}.`)) {
          const sub = effectivePath.slice(iter.length + 1);
          effectivePath = `${parentSchemaPath}.${sub}`;
          break;
        }
      }
    }

    return effectivePath;
  };

  // Helper: Extract primitive column keys for an array path across ALL array items and schema metadata
  const resolveColumnsForArray = (rawPath, iterator, currentStack) => {
    const columnSet = new Set();
    const fullSchemaPath = resolvePathToSchemaPath(rawPath, currentStack);
    const lastKey = fullSchemaPath.split('.').pop();

    // 1. PRIMARY STRATEGY: Consult Hierarchical Data Schema (store.hierarchySchema)
    if (store.hierarchySchema && typeof store.hierarchySchema === 'object') {
      const schema = universalFindSchema(fullSchemaPath, store.hierarchySchema) || universalFindSchema(lastKey, store.hierarchySchema);
      if (schema && Array.isArray(schema.fields) && schema.fields.length > 0) {
        schema.fields.forEach(f => {
          if (f && f !== '_hierarchy_schema' && !isInternalMetadataKey(f)) {
            columnSet.add(f);
          }
        });
      }
    }

    // 2. PRIMARY STRATEGY PART B: Consult Editor Group Metadata (store.editorMetadata)
    const allMeta = [
      ...(store.editorMetadata || []),
      ...(store.excelJsonData?.editor_metadata || [])
    ];
    if (allMeta.length > 0) {
      const rawP = (fullSchemaPath || '').trim().toLowerCase();
      const lastP = (lastKey || '').trim().toLowerCase();
      allMeta.forEach(m => {
        if (m && m.element) {
          const grp = (m.group || '').trim().toLowerCase();
          if (grp === rawP || grp === lastP || grp.endsWith(`.${lastP}`)) {
            if (!isInternalMetadataKey(m.element)) {
              columnSet.add(m.element);
            }
          }
        }
      });
    }

    // 3. SECONDARY STRATEGY: Inspect Data Rows in store.excelJsonData (union across all array items)
    const arr = resolvePath(store.excelJsonData, rawPath, currentStack) || findAnyArrayByName(store.excelJsonData, rawPath);
    if (arr && Array.isArray(arr) && arr.length > 0) {
      for (const item of arr) {
        if (item && typeof item === 'object' && item !== null) {
          Object.entries(item).forEach(([k, v]) => {
            if (!isInternalMetadataKey(k) && !Array.isArray(v)) {
              columnSet.add(k);
            }
          });
        }
      }
    }

    // 4. TERTIARY STRATEGY: Inspect Template Text for {{ iterator.field }}
    const iterPrefix = `${iterator}.`;
    const rawText = editorText.value || '';
    const matches = rawText.matchAll(/\{\{\s*([a-zA-Z0-9_\.]+)/g);
    for (const m of matches) {
      const vPath = m[1].trim();
      if (vPath.startsWith(iterPrefix)) {
        const colName = vPath.slice(iterPrefix.length).split('.')[0].split('|')[0].trim();
        if (colName && !isInternalMetadataKey(colName)) {
          columnSet.add(colName);
        }
      }
    }

    return Array.from(columnSet);
  };

  // Traverse upwards to see if a node or selection is inside a FOR loop block (returns full stack ordered by depth)
  const getActiveLoopStack = (targetNode = null) => {
    const rawLoopBlocks = [];

    if (activeEditorTab.value === 'visual') {
      let node = targetNode;
      if (!node) {
        const activeEditNode = getActiveEditNode();
        const savedRange = getSavedRange();
        if (activeEditNode) {
          node = activeEditNode;
        } else if (savedRange) {
          node = savedRange.commonAncestorContainer;
        } else {
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0) {
            node = sel.getRangeAt(0).commonAncestorContainer;
          }
        }
      }

      while (node && canvasRef.value && node !== canvasRef.value) {
        const el = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
        if (el) {
          let condStr = '';

          if (el.getAttribute && el.getAttribute('data-type') === 'for') {
            condStr = el.getAttribute('data-cond') || '';
            if (!condStr) {
              const condTextNode = el.querySelector('.j-cond-text');
              if (condTextNode) condStr = condTextNode.getAttribute('data-cond') || condTextNode.textContent || '';
            }
          } else if (el.getAttribute && el.getAttribute('data-jinja-for')) {
            condStr = el.getAttribute('data-jinja-for') || '';
          } else if (el.getAttribute && el.getAttribute('data-jinja-col-loop')) {
            condStr = el.getAttribute('data-jinja-col-loop') || '';
          }

          if (condStr) {
            const match = condStr.match(/(\w+)\s+in\s+([^%\}\n]+)/);
            if (match) {
              const iterator = match[1].trim();
              const rawPath = match[2].trim().split('|')[0].trim();

              if (!rawLoopBlocks.some(s => s.iterator === iterator)) {
                rawLoopBlocks.push({
                  iterator,
                  arrayPath: rawPath
                });
              }
            }
          }
        }
        node = node.parentNode;
      }
    } else {
      // Code Mode stack parser based on cursor position in textareaRef
      if (textareaRef.value) {
        const pos = textareaRef.value.selectionStart || 0;
        const nextNewline = editorText.value.indexOf('\n', pos);
        const endOfLinePos = nextNewline !== -1 ? nextNewline : editorText.value.length;
        const codeBefore = editorText.value.substring(0, endOfLinePos);

        const regex = /\{%\s*(for\s+([a-zA-Z0-9_\.]+)\s+in\s+([^%\}]+)|endfor)\s*%\}/g;
        let m;
        const forStack = [];
        while ((m = regex.exec(codeBefore)) !== null) {
          if (m[1].startsWith('for')) {
            const iter = m[2].trim();
            const rawPath = m[3].trim().split('|')[0].trim();
            forStack.push({ iterator: iter, arrayPath: rawPath });
          } else if (m[1] === 'endfor') {
            forStack.pop();
          }
        }

        for (let i = forStack.length - 1; i >= 0; i--) {
          const item = forStack[i];
          if (!rawLoopBlocks.some(s => s.iterator === item.iterator)) {
            rawLoopBlocks.push({
              iterator: item.iterator,
              arrayPath: item.arrayPath
            });
          }
        }
      }
    }

    // Resolve columns and path references sequentially from outermost to innermost
    const outerFirstBlocks = [...rawLoopBlocks].reverse();
    const resolvedStack = [];
    for (const block of outerFirstBlocks) {
      const fullSchemaPath = resolvePathToSchemaPath(block.arrayPath, resolvedStack);
      const columns = resolveColumnsForArray(block.arrayPath, block.iterator, resolvedStack);
      resolvedStack.push({
        iterator: block.iterator,
        arrayPath: block.arrayPath,
        fullSchemaPath: fullSchemaPath,
        columns
      });
    }

    // Return stack ordered by depth (innermost first) for sidebar display
    return resolvedStack.reverse();
  };

  const getActiveLoopContext = (targetNode = null) => {
    const stack = getActiveLoopStack(targetNode);
    return stack.length > 0 ? stack[0] : null;
  };

  const updateActiveLoopContext = () => {
    const stack = getActiveLoopStack();
    activeLoopStack.value = stack;
    activeLoopContext.value = stack.length > 0 ? stack[0] : null;
  };

  const getSubArraysForArray = (arrayPath, currentStack = null) => {
    if (!arrayPath) return [];
    const subArraysMap = new Map();
    const fullSchemaPath = resolvePathToSchemaPath(arrayPath, currentStack);
    const lastKey = fullSchemaPath.split('.').pop();

    // 1. PRIMARY STRATEGY: Consult Hierarchical Data Schema (store.hierarchySchema)
    if (store.hierarchySchema && typeof store.hierarchySchema === 'object') {
      const schema = universalFindSchema(fullSchemaPath, store.hierarchySchema) || universalFindSchema(lastKey, store.hierarchySchema);
      if (schema && schema.children) {
        const childObj = schema.children;
        const childKeys = Array.isArray(childObj) ? childObj : (typeof childObj === 'object' ? Object.keys(childObj) : []);
        childKeys.forEach(ck => {
          if (typeof ck === 'string' && ck !== '_hierarchy_schema') {
            const childSchema = universalFindSchema(`${fullSchemaPath}.${ck}`, store.hierarchySchema) || universalFindSchema(ck, store.hierarchySchema);
            const fields = childSchema && Array.isArray(childSchema.fields) ? childSchema.fields : [];
            const iterName = ck.replace(/s$/, '').replace(/es$/, '') || 'item';
            subArraysMap.set(ck, { key: ck, iteratorName: iterName, value: [], fields });
          }
        });
      }
    }

    // 2. PRIMARY STRATEGY PART B: Consult Editor Group Metadata (store.editorMetadata)
    const allMeta = [
      ...(store.editorMetadata || []),
      ...(store.excelJsonData?.editor_metadata || [])
    ];
    allMeta.forEach(m => {
      if (m && m.group && m.group !== lastKey && m.group !== fullSchemaPath) {
        const lastP = (lastKey || '').trim().toLowerCase();
        const rawP = (fullSchemaPath || '').trim().toLowerCase();
        const grp = m.group.trim().toLowerCase();

        if (grp.startsWith(`${lastP}.`) || grp.startsWith(`${rawP}.`)) {
          const subName = m.group.split('.').pop();
          const iterName = subName.replace(/s$/, '').replace(/es$/, '') || 'item';
          if (!subArraysMap.has(subName)) {
            subArraysMap.set(subName, { key: subName, iteratorName: iterName, value: [], fields: [m.element] });
          } else {
            const existing = subArraysMap.get(subName);
            if (existing.fields && !existing.fields.includes(m.element)) {
              existing.fields.push(m.element);
            }
          }
        }
      }
    });

    // 3. SECONDARY STRATEGY: Inspect Data Rows in store.excelJsonData across ALL items
    const arr = resolvePath(store.excelJsonData, arrayPath, currentStack) || findAnyArrayByName(store.excelJsonData, arrayPath);
    if (arr && Array.isArray(arr)) {
      for (const item of arr) {
        if (item && typeof item === 'object' && item !== null) {
          Object.entries(item).forEach(([k, v]) => {
            if (isInternalMetadataKey(k)) return;
            if (Array.isArray(v)) {
              const iterName = k.replace(/s$/, '').replace(/es$/, '') || 'item';
              const childFieldsSet = new Set();
              for (const childItem of v) {
                if (childItem && typeof childItem === 'object' && childItem !== null) {
                  Object.keys(childItem).forEach(ck => {
                    if (!isInternalMetadataKey(ck) && !Array.isArray(childItem[ck])) {
                      childFieldsSet.add(ck);
                    }
                  });
                }
              }
              if (!subArraysMap.has(k)) {
                subArraysMap.set(k, { key: k, iteratorName: iterName, value: v, fields: Array.from(childFieldsSet) });
              } else {
                const existing = subArraysMap.get(k);
                childFieldsSet.forEach(f => {
                  if (!existing.fields.includes(f)) existing.fields.push(f);
                });
              }
            }
          });
        }
      }
    }

    return Array.from(subArraysMap.values());
  };

  return {
    activeLoopContext,
    activeLoopStack,
    isInternalMetadataKey,
    resolvePath,
    findAnyArrayByName,
    resolvePathToSchemaPath,
    resolveColumnsForArray,
    getActiveLoopStack,
    getActiveLoopContext,
    updateActiveLoopContext,
    getSubArraysForArray,
  };
}
