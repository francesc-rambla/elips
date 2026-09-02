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

import { ref, computed, nextTick } from 'vue';
import { isPrimitive } from './useSchemaResolver';

/**
 * The built-in functions offered by the CUSTOM formula mini-language (used
 * both for calculated fields and for `itemTitleFormula`). Static, shared
 * verbatim by every formula editor in the app (GroupConfigModal, NestedDataNode,
 * DataInspector) — kept here as the single source of truth for the autocomplete
 * menu's function list.
 */
export const builtinFunctions = [
  { name: 'SI(condició; cert; fals)', insert: 'SI(condició; cert; fals)', label: 'SI / IF (Condicional)', category: 'Funció' },
  { name: 'ARRODONEIX(valor; decimals)', insert: 'ARRODONEIX(valor; 2)', label: 'ARRODONEIX / ROUND', category: 'Funció' },
  { name: 'ABS(valor)', insert: 'ABS(valor)', label: 'Valor absolut', category: 'Funció' },
  { name: 'MIN(val1; val2)', insert: 'MIN(val1; val2)', label: 'Mínim de valors', category: 'Funció' },
  { name: 'MAX(val1; val2)', insert: 'MAX(val1; val2)', label: 'Màxim de valors', category: 'Funció' },
  { name: 'PERCENT(valor)', insert: 'PERCENT(valor)', label: 'Escala percentatge (* 100)', category: 'Funció' },
  { name: 'ISNULL(valor)', insert: 'ISNULL(valor)', label: 'Comprova si és nul', category: 'Funció' },
  { name: 'CONCAT(text1; text2)', insert: 'CONCAT(text1; text2)', label: 'Concatena text', category: 'Funció' },
  { name: 'TEXT(valor)', insert: 'TEXT(valor)', label: 'Converteix a text', category: 'Funció' },
  { name: 'REMPLAÇA(text; vell; nou)', insert: 'REMPLAÇA(text; vell; nou)', label: 'Reemplaça text', category: 'Funció' },
  { name: 'UPPER(text)', insert: 'UPPER(text)', label: 'Majúscules', category: 'Funció' },
  { name: 'LOWER(text)', insert: 'LOWER(text)', label: 'Minúscules', category: 'Funció' },
];

/**
 * Measures where the caret sits inside a `<textarea>` by mirroring its text
 * and computed styles into an off-screen div, so the autocomplete popup can
 * be positioned right under the cursor. There is no native browser API for
 * this — it's a well-known DOM-mirroring technique, not a project-specific
 * heuristic.
 */
export function getCaretCoordinates(element, position) {
  const div = document.createElement('div');
  const style = getComputedStyle(element);

  const properties = [
    'direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
    'fontSizeAdjust', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform',
    'textIndent', 'textDecoration', 'letterSpacing', 'wordSpacing', 'tabSize'
  ];

  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';

  properties.forEach(prop => {
    div.style[prop] = style[prop];
  });

  div.textContent = element.value.substring(0, position);

  const span = document.createElement('span');
  span.textContent = element.value.substring(position) || '.';
  div.appendChild(span);

  document.body.appendChild(div);

  const coordinates = {
    top: span.offsetTop + parseInt(style.borderTopWidth || 0) - element.scrollTop,
    left: span.offsetLeft + parseInt(style.borderLeftWidth || 0) - element.scrollLeft,
    height: parseInt(style.lineHeight) || 20
  };

  document.body.removeChild(div);
  return coordinates;
}

/**
 * Lists `group.field` paths for every primitive field of every top-level
 * group in `store.excelJsonData`, so a formula in one group can reference a
 * value from another (e.g. `pres.anualitat`). Shared by DataInspector.vue and
 * NestedDataNode.vue, which both snapshot this list once when a formula
 * editor opens (GroupConfigModal.vue instead keeps it live via a `computed`,
 * so it doesn't use this helper).
 */
export function getGlobalFormulaPaths(store) {
  if (!store.excelJsonData) return [];
  const paths = [];
  Object.keys(store.excelJsonData).forEach(groupKey => {
    if (groupKey === 'editor_metadata' || groupKey === '_hierarchy_schema' || groupKey === '_sheet_info') return;
    const groupData = store.excelJsonData[groupKey];
    if (Array.isArray(groupData) && groupData.length > 0 && typeof groupData[0] === 'object') {
      Object.keys(groupData[0]).forEach(field => {
        if (field !== '_hierarchy_schema' && isPrimitive(groupData[0][field])) {
          paths.push(`${groupKey}.${field}`);
        }
      });
    } else if (typeof groupData === 'object' && !Array.isArray(groupData)) {
      Object.keys(groupData).forEach(field => {
        if (field !== '_hierarchy_schema' && isPrimitive(groupData[field])) {
          paths.push(`${groupKey}.${field}`);
        }
      });
    }
  });
  return paths;
}

/**
 * The "type a few letters, see a dropdown of fields/paths/functions" editor
 * used by every CUSTOM-formula textarea in the app (calculated fields,
 * item-title formulas). Callers own the actual textarea state (`formulaTextBuffer`,
 * `formulaTextareaRef`) and how they source suggestions (`availableFormulaFields`,
 * `globalFormulaPaths`) — this composable only owns the popup's own UI state
 * and the caret-relative insert/replace mechanics, which are identical
 * everywhere it's used.
 *
 * `isFormulaModalOpen` / `editingFormulaItem` / `store` are optional: pass
 * them to also get `openFormulaModal`/`saveFormulaModal` (the "snapshot
 * fields, open the modal" / "write calcFormula back, close" pair shared
 * verbatim by DataInspector.vue and NestedDataNode.vue). Omit them if the
 * caller manages opening/saving itself (as GroupConfigModal.vue does, since
 * its field list is a live `computed` rather than a snapshot).
 */
export function useFormulaAutocomplete({
  formulaTextBuffer,
  formulaTextareaRef,
  availableFormulaFields,
  globalFormulaPaths,
  isFormulaModalOpen = null,
  editingFormulaItem = null,
  store = null,
}) {
  const autocompleteQuery = ref('');
  const autocompleteIndex = ref(0);
  const showAutocomplete = ref(false);
  const autocompletePosition = ref({ left: 10, top: 40 });

  const autocompleteCandidates = computed(() => {
    const q = autocompleteQuery.value.trim().toLowerCase();
    if (!q) return [];

    const results = [];

    availableFormulaFields.value.forEach(field => {
      if (field.toLowerCase().includes(q)) {
        results.push({ name: field, insert: field, label: `Camp: ${field}`, category: '🏷️ Camp' });
      }
    });

    globalFormulaPaths.value.forEach(path => {
      if (path.toLowerCase().includes(q)) {
        results.push({ name: path, insert: path, label: `Ruta: ${path}`, category: '🌐 Global' });
      }
    });

    builtinFunctions.forEach(fn => {
      if (fn.name.toLowerCase().includes(q) || fn.label.toLowerCase().includes(q)) {
        results.push({ name: fn.name, insert: fn.insert, label: fn.label, category: '⚡ Funció' });
      }
    });

    return results.slice(0, 10);
  });

  const insertTokenIntoFormula = (token) => {
    if (!formulaTextareaRef.value) {
      formulaTextBuffer.value += token;
      return;
    }
    const el = formulaTextareaRef.value;
    const start = el.selectionStart || formulaTextBuffer.value.length;
    const end = el.selectionEnd || formulaTextBuffer.value.length;
    const val = formulaTextBuffer.value;
    formulaTextBuffer.value = val.substring(0, start) + token + val.substring(end);
    nextTick(() => {
      el.focus();
      const newPos = start + token.length;
      el.setSelectionRange(newPos, newPos);
    });
  };

  const selectAutocompleteCandidate = (candidate) => {
    const el = formulaTextareaRef.value;
    if (!el) return;
    const pos = el.selectionStart || 0;
    const textBefore = formulaTextBuffer.value.substring(0, pos);
    const textAfter = formulaTextBuffer.value.substring(pos);
    const match = textBefore.match(/([a-zA-Z0-9_.]+)$/);

    if (match) {
      const startPos = pos - match[1].length;
      formulaTextBuffer.value = textBefore.substring(0, startPos) + candidate.insert + textAfter;
      nextTick(() => {
        el.focus();
        const newPos = startPos + candidate.insert.length;
        el.setSelectionRange(newPos, newPos);
      });
    } else {
      insertTokenIntoFormula(candidate.insert);
    }
    showAutocomplete.value = false;
    autocompleteQuery.value = '';
    autocompleteIndex.value = 0;
  };

  const onFormulaInputKey = (e) => {
    const el = formulaTextareaRef.value;
    if (!el) return;

    const pos = el.selectionStart || 0;
    const textBefore = formulaTextBuffer.value.substring(0, pos);
    const match = textBefore.match(/([a-zA-Z0-9_.]+)$/);

    if (match) {
      autocompleteQuery.value = match[1];
      showAutocomplete.value = true;
      try {
        const coords = getCaretCoordinates(el, pos);
        const maxLeft = Math.max(10, el.clientWidth - 300);
        autocompletePosition.value = {
          left: Math.min(Math.max(10, coords.left), maxLeft),
          top: Math.min(coords.top + coords.height + 4, el.clientHeight + 10)
        };
      } catch (err) {
        autocompletePosition.value = { left: 10, top: 40 };
      }
    } else {
      showAutocomplete.value = false;
      autocompleteQuery.value = '';
    }

    if (showAutocomplete.value && autocompleteCandidates.value.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        autocompleteIndex.value = (autocompleteIndex.value + 1) % autocompleteCandidates.value.length;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        autocompleteIndex.value = (autocompleteIndex.value - 1 + autocompleteCandidates.value.length) % autocompleteCandidates.value.length;
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (autocompleteIndex.value < autocompleteCandidates.value.length) {
          e.preventDefault();
          selectAutocompleteCandidate(autocompleteCandidates.value[autocompleteIndex.value]);
        }
      } else if (e.key === 'Escape') {
        showAutocomplete.value = false;
      }
    }
  };

  const openFormulaModal = (item, fields) => {
    if (!isFormulaModalOpen || !editingFormulaItem) return;
    editingFormulaItem.value = item;
    formulaTextBuffer.value = item.calcFormula || '';
    availableFormulaFields.value = (fields || []).filter(f => f !== item.element);
    if (store) globalFormulaPaths.value = getGlobalFormulaPaths(store);
    showAutocomplete.value = false;
    autocompleteQuery.value = '';
    autocompleteIndex.value = 0;
    isFormulaModalOpen.value = true;
  };

  const saveFormulaModal = () => {
    if (!isFormulaModalOpen || !editingFormulaItem) return;
    if (editingFormulaItem.value) {
      editingFormulaItem.value.calcFormula = formulaTextBuffer.value;
    }
    isFormulaModalOpen.value = false;
  };

  return {
    autocompleteQuery,
    autocompleteIndex,
    showAutocomplete,
    autocompletePosition,
    autocompleteCandidates,
    insertTokenIntoFormula,
    onFormulaInputKey,
    selectAutocompleteCandidate,
    openFormulaModal,
    saveFormulaModal,
  };
}
