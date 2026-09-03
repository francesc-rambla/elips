<!--
  elips — Editor de LIcitacions PúbliqueS
  Copyright (C) 2026  Francesc Rambla i Marigot

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
-->

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { isNonEmptySchema, universalFindSchema } from '../composables/useSchemaResolver';
import { useLoopContext } from '../composables/useLoopContext';
import { useMarkdownJinjaCompiler, htmlToMarkdown } from '../composables/useMarkdownJinjaCompiler';
import katex from 'katex';
import { latexSymbols } from './latexSymbols';
import SpecialCharPickerModal from './template-editor/SpecialCharPickerModal.vue';
import MetadataModal from './template-editor/MetadataModal.vue';
import MathModal from './template-editor/MathModal.vue';
import TableModal from './template-editor/TableModal.vue';
import BlockModal from './template-editor/BlockModal.vue';

const props = defineProps({
  modelValue: { type: String, default: '' },
  isCellMode: { type: Boolean, default: false }
});

const emit = defineEmits(['update:modelValue', 'generate']);

const store = useWorkspaceStore();
const activeEditorTab = ref('visual'); // 'visual' or 'code'

const editorText = ref(props.isCellMode ? (props.modelValue || '') : (store.templateText || props.modelValue || ''));

// Local cell history stack for isCellMode
const cellHistory = ref([]);
const cellHistoryIndex = ref(-1);

const canCellUndo = computed(() => props.isCellMode && cellHistoryIndex.value > 0);
const canCellRedo = computed(() => props.isCellMode && cellHistoryIndex.value < cellHistory.value.length - 1);

const cellUndo = () => {
  if (canCellUndo.value) {
    cellHistoryIndex.value--;
    const prev = cellHistory.value[cellHistoryIndex.value];
    editorText.value = prev;
    nextTick(() => syncCodeToVisual());
  }
};

const cellRedo = () => {
  if (canCellRedo.value) {
    cellHistoryIndex.value++;
    const next = cellHistory.value[cellHistoryIndex.value];
    editorText.value = next;
    nextTick(() => syncCodeToVisual());
  }
};

// Watch props.modelValue if in cell mode
if (props.isCellMode) {
  watch(() => props.modelValue, (newVal) => {
    if (editorText.value !== newVal) {
      editorText.value = newVal || '';
      if (cellHistory.value.length === 0) {
        cellHistory.value = [newVal || ''];
        cellHistoryIndex.value = 0;
      }
      nextTick(() => {
        syncCodeToVisual();
      });
    }
  }, { immediate: true });

  watch(editorText, (newVal) => {
    emit('update:modelValue', newVal);
    if (newVal !== undefined && cellHistory.value[cellHistoryIndex.value] !== newVal) {
      if (cellHistoryIndex.value < cellHistory.value.length - 1) {
        cellHistory.value = cellHistory.value.slice(0, cellHistoryIndex.value + 1);
      }
      cellHistory.value.push(newVal);
      cellHistoryIndex.value = cellHistory.value.length - 1;
    }
  });
} else {
  // Main Template Mode: Single Source of Truth is store.templateText
  watch(() => store.templateText, (newVal) => {
    if (editorText.value !== newVal) {
      editorText.value = newVal || '';
      nextTick(() => {
        syncCodeToVisual();
      });
    }
  }, { immediate: true });
  
  watch(editorText, (newVal) => {
    emit('update:modelValue', newVal);
    if (store.templateText !== newVal) {
      store.templateText = newVal;
    }
    if (newVal && newVal.trim().length > 0) {
      const pName = localStorage.getItem('currentProjectName') || 'Default';
      localStorage.setItem(`${pName}:templateText_backup`, newVal);
      localStorage.setItem('templateText_backup', newVal);
    }
  });
}

const hasBackupTemplate = computed(() => {
  const pName = localStorage.getItem('currentProjectName') || 'Default';
  return !!(localStorage.getItem(`${pName}:templateText_backup`) || localStorage.getItem('templateText_backup'));
});

const restoreBackupTemplate = () => {
  const pName = localStorage.getItem('currentProjectName') || 'Default';
  const backup = localStorage.getItem(`${pName}:templateText_backup`) || localStorage.getItem('templateText_backup');
  if (backup) {
    editorText.value = backup;
    store.templateText = backup;
    store.addLog("S'ha restaurat la plantilla des de la còpia de seguretat automàtica.", "success");
    nextTick(() => {
      syncCodeToVisual();
    });
  }
};


// DOM refs
const canvasRef = ref(null);
const textareaRef = ref(null);
const codeGutterRef = ref(null);
const codeHighlightRef = ref(null);
const mathModalRef = ref(null); // Extracted-modal component refs (for the global Ctrl+Enter apply shortcut)
const tableModalRef = ref(null);
const blockModalRef = ref(null);

// Modals state
const isVarModalOpen = ref(false);
const isBlockModalOpen = ref(false);
const isMathModalOpen = ref(false);
const isTableModalOpen = ref(false);
const isSpecialCharModalOpen = ref(false);

const modalTitle = ref('');
const blockType = ref('if'); // 'if', 'for', 'elif'
const modalExpr = ref('');
const modalFilter = ref('');

// Advanced Filter Selection State
const selectedFilterType = ref(''); // '', 'coin', 'number', 'words', 'prefix', 'upper', 'lower', 'capitalize', 'title', 'default', 'length', 'replace', 'trim', 'custom'
const filterParamFallback = ref('de');
const filterParamElided = ref("d'");
const filterParamDefault = ref('Sense dades');
const filterParamReplaceOld = ref('');
const filterParamReplaceNew = ref('');
const filterCustomText = ref('');

const computedModalFilter = computed(() => {
  const t = selectedFilterType.value;
  if (!t) return '';
  if (t === 'coin') return 'coin';
  if (t === 'number') return 'number';
  if (t === 'words') return 'words';
  if (t === 'prefix') {
    const f = filterParamFallback.value || 'de';
    const e = filterParamElided.value || "d'";
    return `prefix('${f}', "${e}")`;
  }
  if (t === 'upper') return 'upper';
  if (t === 'lower') return 'lower';
  if (t === 'capitalize') return 'capitalize';
  if (t === 'title') return 'title';
  if (t === 'default') {
    const d = filterParamDefault.value || '';
    return `default('${d}')`;
  }
  if (t === 'length') return 'length';
  if (t === 'trim') return 'trim';
  if (t === 'replace') {
    const o = filterParamReplaceOld.value || '';
    const n = filterParamReplaceNew.value || '';
    return `replace('${o}', '${n}')`;
  }
  if (t === 'custom') {
    return filterCustomText.value;
  }
  return t;
});

// Block modal: form state (expr/forItemVar/forArrayVar) lives in
// BlockModal.vue; only the initial values used to populate it on open stay
// here, since they come from parsing the canvas node being edited.
const blockModalInitialExpr = ref('');
const blockModalInitialForItemVar = ref('item');
const blockModalInitialForArrayVar = ref('');

// Math modal: form state (expr/type/category/caret) lives in MathModal.vue;
// only the "which canvas node am I editing" pointer stays here, since it's
// about DOM insertion, a canvas-level concern.
const mathModalInitialExpr = ref('');
const mathModalInitialType = ref('inline');
let activeMathNode = null;

// Table Configuration Modal State
// Table modal: form state (mode/columns/array/iterator) lives in
// TableModal.vue; only the "which canvas node am I editing" pointer and the
// config used to initialize the modal's form on open stay here.
const tableModalInitialConfig = ref({});
const tableModalIsEditing = ref(false);
let activeEditTableNode = null;

// Cursor Selection Management
let savedRange = null;
let activeEditNode = null;
let activeBlockForNewBranch = null; // Pointer to block when adding a new ELIF branch

const linesCount = computed(() => {
  return editorText.value.split('\n').length;
});

// Keeps the line-number gutter and the syntax-highlight backdrop scrolled
// exactly with the (invisible-text) textarea sitting on top of them.
const onCodeScroll = () => {
  if (!textareaRef.value) return;
  const { scrollTop, scrollLeft } = textareaRef.value;
  if (codeGutterRef.value) codeGutterRef.value.scrollTop = scrollTop;
  if (codeHighlightRef.value) {
    codeHighlightRef.value.scrollTop = scrollTop;
    codeHighlightRef.value.scrollLeft = scrollLeft;
  }
};

const escapeHtmlForHighlight = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Best-effort, single-pass Jinja2/Markdown syntax highlighter for the code
// editor's backdrop — a lightweight regex tokenizer, not a real grammar.
// Tokens never nest (e.g. a {{ var }} inside a heading line is swallowed
// whole by the heading token, not separately colored) — an accepted
// trade-off for staying simple and never at risk of corrupting anything,
// since this only ever produces a purely decorative backdrop layer; the
// actual editable text always lives untouched in the real <textarea>.
const HIGHLIGHT_TOKEN_RE = /(<!--[\s\S]*?-->)|(\{%[\s\S]*?%\})|(\{\{[\s\S]*?\}\})|(\$\$[\s\S]*?\$\$)|(\$[^$\n]+\$)|(^#{1,6}\s.*$)|(\*\*[^\n*]+\*\*)|(\*[^\n*]+\*)/gm;

const highlightJinjaMarkdown = (text) => {
  let html = '';
  let lastIndex = 0;
  let m;
  HIGHLIGHT_TOKEN_RE.lastIndex = 0;
  while ((m = HIGHLIGHT_TOKEN_RE.exec(text)) !== null) {
    const [full, comment, block, variable, mathDisplay, mathInline, header, bold, italic] = m;
    if (full.length === 0) { HIGHLIGHT_TOKEN_RE.lastIndex++; continue; }
    html += escapeHtmlForHighlight(text.slice(lastIndex, m.index));
    let cls = '';
    if (comment) cls = 'tok-comment';
    else if (block) cls = 'tok-jinja-block';
    else if (variable) cls = 'tok-jinja-var';
    else if (mathDisplay || mathInline) cls = 'tok-math';
    else if (header) cls = 'tok-header';
    else if (bold) cls = 'tok-bold';
    else if (italic) cls = 'tok-italic';
    html += `<span class="${cls}">${escapeHtmlForHighlight(full)}</span>`;
    lastIndex = m.index + full.length;
  }
  html += escapeHtmlForHighlight(text.slice(lastIndex));
  return html;
};

const highlightedCodeHtml = computed(() => highlightJinjaMarkdown(editorText.value || ''));

// Check if document generation is ready to run
const isGenerateReady = computed(() => {
  return (store.excelFile || store.excelJsonData) && editorText.value.trim().length > 0 && store.enginesReady;
});

const emitGenerate = () => {
  emit('generate');
};

// Loop-context resolution (which {% for %} loop the cursor is inside, its
// data array, and its columns) lives in useLoopContext.js — extracted since
// it doesn't depend on any DOM-wiring/modal-opening logic, only on the editor's
// own refs and store. activeEditNode/savedRange are plain `let`s (mutated by
// selection-tracking code below), not reactive refs, so the composable
// receives getters instead of the values themselves.
const {
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
} = useLoopContext({
  canvasRef,
  textareaRef,
  editorText,
  activeEditorTab,
  store,
  getActiveEditNode: () => activeEditNode,
  getSavedRange: () => savedRange,
});


// Metadata label resolution helpers for template chips and variable tree
const getFieldCustomLabel = (keyName) => {
  if (!keyName || typeof keyName !== 'string') return keyName;
  let foundLabel = '';
  if (store.editorMetadata && Array.isArray(store.editorMetadata)) {
    const meta = store.editorMetadata.find(m => m.element === keyName && m.label && m.label.trim());
    if (meta) foundLabel = meta.label.trim();
  }
  if (!foundLabel && store.excelJsonData?.editor_metadata) {
    const metaList = store.excelJsonData.editor_metadata;
    if (Array.isArray(metaList)) {
      const meta = metaList.find(m => m.element === keyName && m.label && m.label.trim());
      if (meta) foundLabel = meta.label.trim();
    }
  }
  return foundLabel || keyName;
};

const resolveFieldLabel = (rawExpr) => {
  if (!rawExpr || typeof rawExpr !== 'string') return rawExpr;
  const vars = rawExpr.trim().split('|');
  const expr = vars[0].trim();
  const filter = vars.length > 1 ? vars.slice(1).join('|').trim() : '';

  const segments = expr.split('.');
  const lastKey = segments[segments.length - 1];

  const customLabel = getFieldCustomLabel(lastKey);
  const baseDisplay = customLabel !== lastKey ? customLabel : expr;
  return filter ? `${baseDisplay} | ${filter}` : baseDisplay;
};

// Computed properties for the modal data browser
const availableVariables = computed(() => {
  if (!store.excelJsonData) return [];
  const list = [];
  
  // 1. Contextual variables if cursor or node is inside an active FOR loop
  if (activeLoopContext.value) {
    const ctx = activeLoopContext.value;
    for (const col of ctx.columns) {
      if (isInternalMetadataKey(col)) continue;
      const cLabel = getFieldCustomLabel(col);
      list.push({ 
        path: `${ctx.iterator}.${col}`, 
        label: cLabel !== col ? `${cLabel} (${ctx.iterator}.${col})` : `Bucle actiu (${ctx.iterator}.${col})`, 
        category: 'loopContext',
        isContext: true 
      });
    }
  }

  // 2. All sheets, arrays, array expressions, and scalar variables
  const walkVars = (obj, pathPrefix = '') => {
    if (!obj || typeof obj !== 'object') return;
    
    if (Array.isArray(obj)) {
      if (pathPrefix) {
        list.push({ path: pathPrefix, label: `Llista ${pathPrefix}`, category: 'array', isContext: false });
        list.push({ path: `${pathPrefix}|length`, label: `Nombre d'elements a ${pathPrefix}`, category: 'arrayExpr', isContext: false });
      }
      if (obj.length > 0 && typeof obj[0] === 'object' && obj[0] !== null) {
        Object.entries(obj[0]).forEach(([k, v]) => {
          if (isInternalMetadataKey(k)) return;
          const childP = pathPrefix ? `${pathPrefix}.${k}` : k;
          if (Array.isArray(v)) {
            walkVars(v, childP);
          } else {
            const cLabel = getFieldCustomLabel(k);
            list.push({ path: `${pathPrefix}[0].${k}`, label: cLabel !== k ? `${cLabel} (${pathPrefix}[0].${k})` : `Primer element (${pathPrefix}[0].${k})`, category: 'arrayItem', isContext: false });
          }
        });
      }
    } else {
      Object.entries(obj).forEach(([k, v]) => {
        if (isInternalMetadataKey(k)) return;
        const childP = pathPrefix ? `${pathPrefix}.${k}` : k;
        if (Array.isArray(v)) {
          walkVars(v, childP);
        } else if (typeof v === 'object' && v !== null) {
          walkVars(v, childP);
        } else {
          const cLabel = getFieldCustomLabel(k);
          list.push({ path: childP, label: cLabel !== k ? `${cLabel} (${childP})` : childP, category: 'scalar', isContext: false });
        }
      });
    }
  };

  walkVars(store.excelJsonData, '');
  return list;
});

const availableArrays = computed(() => {
  if (!store.excelJsonData) return [];
  const setList = new Set();
  
  const walkArrays = (obj, pathPrefix = '') => {
    if (!obj || typeof obj !== 'object') return;
    
    if (Array.isArray(obj)) {
      if (pathPrefix) setList.add(pathPrefix);
      if (obj.length > 0 && typeof obj[0] === 'object' && obj[0] !== null) {
        Object.entries(obj[0]).forEach(([k, v]) => {
          if (isInternalMetadataKey(k)) return;
          const childP = pathPrefix ? `${pathPrefix}.${k}` : k;
          if (Array.isArray(v)) {
            setList.add(childP);
            walkArrays(v, childP);
          }
        });
      }
    } else {
      Object.entries(obj).forEach(([k, v]) => {
        if (isInternalMetadataKey(k)) return;
        const childP = pathPrefix ? `${pathPrefix}.${k}` : k;
        if (Array.isArray(v)) {
          setList.add(childP);
          walkArrays(v, childP);
        } else if (typeof v === 'object' && v !== null) {
          walkArrays(v, childP);
        }
      });
    }
  };

  walkArrays(store.excelJsonData, '');

  // Add iterator-relative array options if inside an active FOR loop!
  if (activeLoopStack.value && activeLoopStack.value.length > 0) {
    activeLoopStack.value.forEach(ctx => {
      const subArrays = getSubArraysForArray(ctx.arrayPath);
      subArrays.forEach(sub => {
        setList.add(`${ctx.iterator}.${sub.key}`);
      });
    });
  }

  return Array.from(setList);
});

const sidebarTree = computed(() => {
  if (!store.excelJsonData) return [];
  const result = [];

  for (const [sheetName, sheetData] of Object.entries(store.excelJsonData)) {
    if (isInternalMetadataKey(sheetName)) continue;

    if (Array.isArray(sheetData)) {
      const sample = sheetData.length > 0 ? sheetData[0] : {};
      const fields = [];
      const subArrays = [];

      if (sample && typeof sample === 'object' && sample !== null) {
        Object.entries(sample).forEach(([k, v]) => {
          if (isInternalMetadataKey(k)) return;
          if (Array.isArray(v)) {
            const childSample = v.length > 0 ? v[0] : {};
            const childFields = [];
            if (childSample && typeof childSample === 'object' && childSample !== null) {
              Object.keys(childSample).forEach(ck => {
                if (!isInternalMetadataKey(ck) && !Array.isArray(childSample[ck])) {
                  childFields.push(ck);
                }
              });
            }
            subArrays.push({
              key: k,
              fullPath: `${sheetName}.${k}`,
              iteratorName: k.replace(/s$/, '').replace(/es$/, '') || 'item',
              fields: childFields,
              subArrays: []
            });
          } else {
            fields.push(k);
          }
        });
      }

      result.push({
        name: sheetName,
        kind: 'array',
        path: sheetName,
        iteratorName: 'item',
        fields,
        subArrays
      });
    } else if (typeof sheetData === 'object' && sheetData !== null) {
      const fields = [];
      const subArrays = [];

      const walkObject = (obj, pathPrefix) => {
        Object.entries(obj).forEach(([k, v]) => {
          if (isInternalMetadataKey(k)) return;
          const fullPath = pathPrefix ? `${pathPrefix}.${k}` : `${sheetName}.${k}`;

          if (Array.isArray(v)) {
            const sample = v.length > 0 ? v[0] : {};
            const childFields = [];
            const childSubArrays = [];

            if (sample && typeof sample === 'object' && sample !== null) {
              Object.entries(sample).forEach(([subK, subV]) => {
                if (isInternalMetadataKey(subK)) return;
                if (Array.isArray(subV)) {
                  const grandSample = subV.length > 0 ? subV[0] : {};
                  const grandFields = [];
                  if (grandSample && typeof grandSample === 'object' && grandSample !== null) {
                    Object.keys(grandSample).forEach(gk => {
                      if (!isInternalMetadataKey(gk) && !Array.isArray(grandSample[gk])) {
                        grandFields.push(gk);
                      }
                    });
                  }
                  childSubArrays.push({
                    key: subK,
                    fullPath: `${fullPath}.${subK}`,
                    iteratorName: subK.replace(/s$/, '').replace(/es$/, '') || 'subItem',
                    fields: grandFields,
                    subArrays: []
                  });
                } else {
                  childFields.push(subK);
                }
              });
            }

            subArrays.push({
              key: k,
              fullPath,
              iteratorName: k.replace(/s$/, '').replace(/es$/, '') || 'item',
              fields: childFields,
              subArrays: childSubArrays
            });
          } else if (typeof v === 'object' && v !== null) {
            walkObject(v, fullPath);
          } else {
            fields.push({ key: k, fullPath });
          }
        });
      };

      walkObject(sheetData, '');

      result.push({
        name: sheetName,
        kind: 'kv',
        fields,
        subArrays
      });
    }
  }

  return result;
});

// Save cursor range inside the visual canvas
const saveSelection = () => {
  const sel = window.getSelection();
  if (sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    if (canvasRef.value && canvasRef.value.contains(range.commonAncestorContainer)) {
      savedRange = range.cloneRange();
    }
  }
};

const restoreSelection = () => {
  if (savedRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }
};

// Formatting commands for Code Mode
const formatCodeText = (cmd, arg = null) => {
  const el = textareaRef.value;
  if (!el) return;
  el.focus();
  const start = el.selectionStart || 0;
  const end = el.selectionEnd || 0;
  const fullText = editorText.value || '';
  const selectedText = fullText.substring(start, end);

  let replacement = '';
  let newCursorPos = start;

  if (cmd === 'bold') {
    replacement = `**${selectedText || 'negreta'}**`;
    newCursorPos = selectedText ? start + replacement.length : start + 2;
  } else if (cmd === 'italic') {
    replacement = `*${selectedText || 'cursiva'}*`;
    newCursorPos = selectedText ? start + replacement.length : start + 1;
  } else if (cmd === 'insertUnorderedList') {
    const lines = (selectedText || 'Element de llista').split('\n');
    replacement = lines.map(line => line.startsWith('- ') ? line : `- ${line}`).join('\n');
    newCursorPos = start + replacement.length;
  } else if (cmd === 'insertOrderedList') {
    const lines = (selectedText || 'Element de llista').split('\n');
    replacement = lines.map((line, i) => /^\d+\.\s/.test(line) ? line : `${i + 1}. ${line}`).join('\n');
    newCursorPos = start + replacement.length;
  } else if (cmd === 'formatBlock') {
    const tag = (arg || '').toUpperCase().replace(/[<>]/g, '');
    const prefixes = { 'H1': '# ', 'H2': '## ', 'H3': '### ', 'H4': '#### ', 'H5': '##### ', 'H6': '###### ', 'P': '' };
    const pfx = prefixes[tag] !== undefined ? prefixes[tag] : '';
    const lines = (selectedText || 'Títol').split('\n');
    replacement = lines.map(line => {
      const clean = line.replace(/^#{1,6}\s*/, '');
      return pfx ? `${pfx}${clean}` : clean;
    }).join('\n');
    newCursorPos = start + replacement.length;
  }

  if (replacement) {
    editorText.value = fullText.substring(0, start) + replacement + fullText.substring(end);
    nextTick(() => {
      el.focus();
      el.setSelectionRange(newCursorPos, newCursorPos);
      syncCodeToVisual();
    });
  }
};

const formatDoc = (cmd) => {
  if (activeEditorTab.value === 'code') {
    formatCodeText(cmd);
    return;
  }
  if (canvasRef.value) {
    canvasRef.value.focus();
    restoreSelection();
  }
  document.execCommand(cmd, false, null);
  saveSelection();
  syncVisualToCode();
};

const insertList = (type) => {
  const cmd = (type === 'ordered' || type === 'insertOrderedList') ? 'insertOrderedList' : 'insertUnorderedList';
  if (activeEditorTab.value === 'code') {
    formatCodeText(cmd);
    return;
  }
  if (canvasRef.value) {
    canvasRef.value.focus();
    restoreSelection();
  }
  document.execCommand(cmd, false, null);
  saveSelection();
  syncVisualToCode();
};

const formatBlock = (headerTag) => {
  if (!headerTag) return;
  if (activeEditorTab.value === 'code') {
    formatCodeText('formatBlock', headerTag);
    return;
  }
  if (canvasRef.value) {
    canvasRef.value.focus();
    restoreSelection();
  }
  const cleanTag = headerTag.toUpperCase().replace(/[<>]/g, '');
  const tag = `<${cleanTag}>`;
  document.execCommand('formatBlock', false, tag);
  saveSelection();
  syncVisualToCode();
};

// Variable Modals Trigger
const openVarModal = (node = null) => {
  saveSelection();
  activeLoopContext.value = getActiveLoopContext(node);
  let rawFilter = '';
  if (node && node.tagName === 'SPAN') {
    activeEditNode = node;
    const raw = node.getAttribute('data-raw') || '';
    const parts = raw.split('|');
    modalExpr.value = parts[0].trim();
    rawFilter = parts.slice(1).join('|').trim();
    modalFilter.value = rawFilter;
    modalTitle.value = "Editar Variable";
  } else {
    activeEditNode = null;
    modalExpr.value = '';
    rawFilter = '';
    modalFilter.value = '';
    modalTitle.value = "Inserir Variable";
  }

  // Parse rawFilter to set selectedFilterType and param inputs
  if (!rawFilter) {
    selectedFilterType.value = '';
  } else if (rawFilter === 'coin') {
    selectedFilterType.value = 'coin';
  } else if (rawFilter === 'number') {
    selectedFilterType.value = 'number';
  } else if (rawFilter === 'words') {
    selectedFilterType.value = 'words';
  } else if (rawFilter === 'upper') {
    selectedFilterType.value = 'upper';
  } else if (rawFilter === 'lower') {
    selectedFilterType.value = 'lower';
  } else if (rawFilter === 'capitalize') {
    selectedFilterType.value = 'capitalize';
  } else if (rawFilter === 'title') {
    selectedFilterType.value = 'title';
  } else if (rawFilter === 'length') {
    selectedFilterType.value = 'length';
  } else if (rawFilter === 'trim') {
    selectedFilterType.value = 'trim';
  } else if (rawFilter.startsWith('prefix')) {
    selectedFilterType.value = 'prefix';
    const match = rawFilter.match(/prefix\(\s*['"](.*?)['"]\s*,\s*['"](.*?)['"]\s*\)/);
    if (match) {
      filterParamFallback.value = match[1];
      filterParamElided.value = match[2];
    } else {
      filterParamFallback.value = 'de';
      filterParamElided.value = "d'";
    }
  } else if (rawFilter.startsWith('default')) {
    selectedFilterType.value = 'default';
    const match = rawFilter.match(/default\(\s*['"](.*?)['"]\s*\)/);
    if (match) {
      filterParamDefault.value = match[1];
    } else {
      filterParamDefault.value = 'Sense dades';
    }
  } else if (rawFilter.startsWith('replace')) {
    selectedFilterType.value = 'replace';
    const match = rawFilter.match(/replace\(\s*['"](.*?)['"]\s*,\s*['"](.*?)['"]\s*\)/);
    if (match) {
      filterParamReplaceOld.value = match[1];
      filterParamReplaceNew.value = match[2];
    } else {
      filterParamReplaceOld.value = '';
      filterParamReplaceNew.value = '';
    }
  } else {
    selectedFilterType.value = 'custom';
    filterCustomText.value = rawFilter;
  }

  isVarModalOpen.value = true;
};

// Logic Blocks Modals Trigger
const openBlockModal = (type, node = null) => {
  saveSelection();
  blockType.value = type;
  activeLoopContext.value = getActiveLoopContext(node);
  
  if (type === 'elif' && !node) {
    activeEditNode = null;
    blockModalInitialExpr.value = '';
    modalTitle.value = "Afegir branca O SI (ELIF)";
  } else if (node && (node.tagName === 'SPAN' || node.classList?.contains('j-cond-text'))) {
    activeEditNode = node;
    const raw = node.getAttribute('data-cond') || '';
    if (type === 'for') {
      const parts = raw.split(/\s+in\s+/);
      blockModalInitialForItemVar.value = parts[0] ? parts[0].trim() : 'item';
      blockModalInitialForArrayVar.value = parts[1] ? parts[1].trim() : '';
      blockModalInitialExpr.value = raw;
    } else {
      blockModalInitialExpr.value = raw;
    }
    modalTitle.value = type === 'for' ? "Editar Bucle (FOR)" : (type === 'elif' ? "Editar branca O SI (ELIF)" : "Editar Condició (IF)");
  } else {
    activeEditNode = null;
    if (type === 'for') {
      blockModalInitialForItemVar.value = 'item';
      blockModalInitialForArrayVar.value = '';
      blockModalInitialExpr.value = 'item in ';
    } else {
      blockModalInitialExpr.value = '';
    }
    modalTitle.value = type === 'for' ? "Nou Bucle (FOR)" : "Nova Condició (IF)";
  }
  isBlockModalOpen.value = true;
};

// Math Modal Trigger
const openMathModal = (node = null) => {
  saveSelection();
  if (node && (node.tagName === 'SPAN' || node.tagName === 'DIV' || node.classList.contains('latex-chip'))) {
    activeMathNode = node;
    mathModalInitialExpr.value = node.getAttribute('data-expr') || '';
    mathModalInitialType.value = node.getAttribute('data-type') || 'inline';
  } else {
    activeMathNode = null;
    mathModalInitialExpr.value = '';
    mathModalInitialType.value = 'inline';
  }
  isMathModalOpen.value = true;
};

// MathModal.vue owns the expr/type form state and reports the final values on
// apply; inserting/updating the .latex-chip in the canvas (or wrapping the
// expression in $.../$$...$$ in Code mode) stays here since it needs
// activeMathNode/savedRange/canvasRef — canvas-level state.
const onMathApply = ({ expr, type }) => {
  if (!expr) {
    if (activeMathNode) {
      activeMathNode.remove();
      syncVisualToCode();
    }
    return;
  }

  let render = '';
  try {
    // Replace Jinja2 placeholders with a clean LaTeX representation for editor preview
    const cleanExpr = expr.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, p1) => {
      const escaped = p1.trim().replace(/_/g, '\\_');
      return `\\text{[${escaped}]}`;
    });
    render = katex.renderToString(cleanExpr, { displayMode: type === 'display', throwOnError: false });
  } catch (_) {
    render = expr;
  }

  if (activeEditorTab.value === 'visual') {
    restoreSelection();

    const tagName = type === 'display' ? 'div' : 'span';
    const typeChanged = activeMathNode && activeMathNode.tagName.toLowerCase() !== tagName;

    if (activeMathNode && !typeChanged) {
      activeMathNode.setAttribute('data-expr', expr);
      activeMathNode.setAttribute('data-type', type);
      activeMathNode.className = `latex-chip ${type}-math`;
      activeMathNode.innerHTML = render;
    } else {
      const el = document.createElement(tagName);
      el.className = `latex-chip ${type}-math`;
      el.setAttribute('contenteditable', 'false');
      el.setAttribute('data-expr', expr);
      el.setAttribute('data-type', type);
      el.innerHTML = render;

      el.ondblclick = (e) => {
        e.stopPropagation();
        openMathModal(el);
      };

      if (activeMathNode && typeChanged) {
        activeMathNode.parentNode.replaceChild(el, activeMathNode);
      } else {
        const space = document.createTextNode(' ');
        if (savedRange) {
          savedRange.deleteContents();
          savedRange.insertNode(el);
          el.after(space);
        } else {
          canvasRef.value.appendChild(el);
          canvasRef.value.appendChild(space);
        }

        const newRange = document.createRange();
        newRange.setStart(space, 1);
        newRange.collapse(true);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(newRange);
        }
        savedRange = newRange.cloneRange();
      }
    }
    syncVisualToCode();
  } else if (textareaRef.value) {
    const txt = textareaRef.value;
    const start = txt.selectionStart;
    const end = txt.selectionEnd;
    const wrapExpr = type === 'display' ? `$$\n${expr}\n$$` : `$${expr}$`;
    editorText.value = editorText.value.substring(0, start) + wrapExpr + editorText.value.substring(end);
  }
};


// Advanced Table Modal Trigger
const openTableModal = (table = null) => {
  saveSelection();
  activeEditTableNode = table;
  tableModalIsEditing.value = !!table;

  if (table) {
    const rowLoop = table.querySelector('.j-row-loop');
    const colLoopCell = table.querySelector('[data-jinja-col-loop]');

    if (rowLoop) {
      const loopExpr = rowLoop.getAttribute('data-jinja-for') || '';
      const match = loopExpr.match(/^(\w+)\s+in\s+([\w\.\_]+)/);
      if (match) {
        const iteratorVar = match[1].trim();
        const selectedArray = match[2].trim();
        const headers = Array.from(table.querySelectorAll('th'));
        const cells = Array.from(rowLoop.querySelectorAll('td'));

        const columns = cells.map((cell, idx) => {
          const varChip = cell.querySelector('.j-var-chip');
          const rawPath = varChip ? varChip.getAttribute('data-raw') : '';
          const parts = rawPath.split('|');
          const expr = parts[0].trim();
          const filter = parts.slice(1).join('|').trim();
          const key = expr.split('.').pop() || '';
          const th = headers[idx];
          return {
            key,
            header: th ? th.innerText.trim() : key,
            align: cell.style.textAlign || 'left',
            selected: true,
            filter,
            totalFormula: '',
            totalCustomExpr: '',
          };
        });

        // Recognize an existing totals row's per-column aggregate, matching
        // it back to one of the built-in formulas TableModal.vue's
        // buildTotalExpr() generates (falling back to 'custom' verbatim for
        // anything else) — same index order as the loop row's own cells.
        const totalsRow = table.querySelector('.j-totals-row');
        if (totalsRow) {
          const totalsCells = Array.from(totalsRow.querySelectorAll('td'));
          const arr = selectedArray.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          columns.forEach((col, idx) => {
            const chip = totalsCells[idx]?.querySelector('.j-var-chip');
            if (!chip) return;
            const raw = chip.getAttribute('data-raw') || '';
            let m = raw.match(new RegExp(`^\\(${arr}\\s*\\|\\s*sum\\(attribute='[^']+'\\)\\)(?:\\s*\\|\\s*.+)?$`));
            if (m) { col.totalFormula = 'sum'; return; }
            m = raw.match(new RegExp(`^\\(\\(${arr}\\s*\\|\\s*sum\\(attribute='[^']+'\\)\\)\\s*/\\s*\\(${arr}\\s*\\|\\s*length\\)\\)(?:\\s*\\|\\s*.+)?$`));
            if (m) { col.totalFormula = 'avg'; return; }
            m = raw.match(new RegExp(`^\\(${arr}\\s*\\|\\s*length\\)(?:\\s*\\|\\s*.+)?$`));
            if (m) { col.totalFormula = 'count'; return; }
            col.totalFormula = 'custom';
            col.totalCustomExpr = raw;
          });
        }

        tableModalInitialConfig.value = { mode: 'dynamic', iteratorVar, selectedArray, columns, totalsRow: !!totalsRow };
      }
    } else if (colLoopCell) {
      const loopExpr = colLoopCell.getAttribute('data-jinja-col-loop') || '';
      const match = loopExpr.match(/^(\w+)\s+in\s+([\w\.\_]+)/);
      if (match) {
        const iteratorVar = match[1].trim();
        const selectedArray = match[2].trim();
        let selectedColHeaderKey = '';

        const thLoop = table.querySelector('th[data-jinja-col-loop]');
        const thChip = thLoop ? thLoop.querySelector('.j-var-chip') : null;
        if (thChip) {
          const headRaw = thChip.getAttribute('data-raw') || '';
          selectedColHeaderKey = headRaw.split('|')[0].trim().split('.').pop();
        }

        const rows = Array.from(table.querySelectorAll('tbody tr'));
        const columns = rows.map(r => {
          const td1 = r.querySelector('td:first-child');
          const td2 = r.querySelector('td[data-jinja-col-loop]');
          const chip = td2 ? td2.querySelector('.j-var-chip') : null;
          const raw = chip ? chip.getAttribute('data-raw') || '' : '';
          const parts = raw.split('|');
          const expr = parts[0].trim();
          const filter = parts.slice(1).join('|').trim();
          const key = expr.split('.').pop() || '';
          return {
            key,
            header: td1 ? td1.innerText.trim() : key,
            align: td2 ? td2.style.textAlign || 'left' : 'left',
            selected: true,
            filter
          };
        });
        tableModalInitialConfig.value = { mode: 'transposed', iteratorVar, selectedArray, selectedColHeaderKey, columns };
      }
    } else {
      tableModalInitialConfig.value = {
        mode: 'manual',
        manualRows: table.querySelectorAll('tr').length,
        manualCols: table.querySelector('tr') ? table.querySelector('tr').children.length : 3,
      };
    }
  } else {
    tableModalInitialConfig.value = { mode: 'dynamic', selectedArray: availableArrays.value[0] || '', columns: [] };
  }
  isTableModalOpen.value = true;
};

// TableModal.vue owns the mode/columns/array/iterator form state and
// computes the <table> HTML on apply; inserting it into (or replacing a node
// in) the canvas, and re-wiring the resulting th click / dblclick handlers,
// stays here since it needs activeEditTableNode/canvasRef — canvas-level state.
const onTableApply = (html) => {
  if (activeEditorTab.value !== 'visual') return;
  restoreSelection();
  if (activeEditTableNode) {
    const div = document.createElement('div');
    div.innerHTML = html;
    const newTable = div.querySelector('table');
    const newEditBtn = div.querySelector('.table-edit-btn');

    newTable.querySelectorAll('th').forEach(th => {
      th.onclick = () => toggleTableAlignment(th);
    });

    newTable.ondblclick = (e) => {
      e.stopPropagation();
      openTableModal(newTable);
    };
    if (newEditBtn) newEditBtn.onclick = (e) => { e.stopPropagation(); openTableModal(newTable); };

    // TABLE_EDIT_BTN_HTML is a sibling right before <table>, not a
    // descendant — replaceChild below only swaps the <table> node itself,
    // so its old edit-button sibling (if any) needs removing and the new
    // one inserting in the real DOM separately.
    const oldEditBtn = activeEditTableNode.previousElementSibling;
    if (oldEditBtn?.classList.contains('table-edit-btn')) oldEditBtn.remove();
    if (newEditBtn) activeEditTableNode.parentNode.insertBefore(newEditBtn, activeEditTableNode);

    activeEditTableNode.parentNode.replaceChild(newTable, activeEditTableNode);
  } else {
    document.execCommand('insertHTML', false, html);
    nextTick(() => {
      canvasRef.value.querySelectorAll('table').forEach(table => {
        table.querySelectorAll('th').forEach(th => {
          th.onclick = () => toggleTableAlignment(th);
        });
        table.ondblclick = (e) => {
          e.stopPropagation();
          openTableModal(table);
        };
        const editBtn = table.previousElementSibling;
        if (editBtn?.classList.contains('table-edit-btn')) {
          editBtn.onclick = (e) => { e.stopPropagation(); openTableModal(table); };
        }
      });
    });
  }
  syncVisualToCode();
};


// Apply Variable Chip to canvas or textarea
const applyVariable = () => {
  const expr = modalExpr.value.trim();
  const filter = computedModalFilter.value.trim();
  if (!expr) {
    if (activeEditNode) {
      activeEditNode.remove();
      syncVisualToCode();
    }
    isVarModalOpen.value = false;
    return;
  }

  const rawJinja = filter ? `{{ ${expr} | ${filter} }}` : `{{ ${expr} }}`;
  const displayLabel = resolveFieldLabel(filter ? `${expr} | ${filter}` : `${expr}`);

  if (activeEditorTab.value === 'visual') {
    restoreSelection();
    if (activeEditNode) {
      activeEditNode.setAttribute('data-raw', expr + (filter ? `|${filter}` : ''));
      activeEditNode.textContent = displayLabel;
    } else {
      const chip = document.createElement('span');
      chip.className = 'j-var-chip';
      chip.setAttribute('contenteditable', 'false');
      chip.setAttribute('data-raw', expr + (filter ? `|${filter}` : ''));
      chip.textContent = displayLabel;
      
      chip.ondblclick = (e) => {
        e.stopPropagation();
        openVarModal(chip);
      };

      const space = document.createTextNode(' ');
      if (savedRange) {
        savedRange.deleteContents();
        savedRange.insertNode(chip);
        chip.after(space);
      } else {
        canvasRef.value.appendChild(chip);
        canvasRef.value.appendChild(space);
      }

      // Position caret immediately after the space following the variable chip
      const newRange = document.createRange();
      newRange.setStart(space, 1);
      newRange.collapse(true);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
      savedRange = newRange.cloneRange();
    }
    syncVisualToCode();
  } else {
    if (textareaRef.value) {
      const txt = textareaRef.value;
      const start = txt.selectionStart;
      const end = txt.selectionEnd;
      editorText.value = editorText.value.substring(0, start) + rawJinja + editorText.value.substring(end);
    }
  }
  isVarModalOpen.value = false;
};

// Helper for inserting loop blocks cleanly
const sidebarInsertLoop = (subKey, fullPath, iteratorName, fields) => {
  let effectiveFields = fields || [];
  if (effectiveFields.length === 0) {
    effectiveFields = resolveColumnsForArray(fullPath, iteratorName, activeLoopStack.value);
  }
  
  let blockCode = '';
  if (effectiveFields && effectiveFields.length > 0) {
    const firstField = effectiveFields[0];
    blockCode = `{% for ${iteratorName} in ${fullPath} %}\n- {{ ${iteratorName}.${firstField} }}\n{% endfor %}`;
  } else {
    blockCode = `{% for ${iteratorName} in ${fullPath} %}\n\n{% endfor %}`;
  }
  
  sidebarCopyInsert(blockCode);
};

// Sidebar copy insert variable / block handler
const sidebarCopyInsert = (expr) => {
  const isBlock = expr.includes('{%') || expr.includes('\n');

  if (activeEditorTab.value === 'code') {
    if (textareaRef.value) {
      const txt = textareaRef.value;
      const start = txt.selectionStart || 0;
      const end = txt.selectionEnd || 0;
      const insertText = isBlock ? `\n\n${expr.trim()}\n\n` : (expr.startsWith('{{') ? expr : `{{ ${expr} }}`);
      editorText.value = editorText.value.substring(0, start) + insertText + editorText.value.substring(end);
      setTimeout(() => {
        txt.focus();
        txt.selectionStart = txt.selectionEnd = start + insertText.length;
        updateActiveLoopContext();
      }, 50);
    }
  } else {
    // Visual Mode DOM Range Insertion
    restoreSelection();
    
    if (isBlock) {
      // 1. Insert Block (Jinja loop or condition block)
      const html = compileMarkdownToHtml(expr);
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = html;
      
      const frag = document.createDocumentFragment();
      let lastNode = null;
      while (tempDiv.firstChild) {
        lastNode = tempDiv.firstChild;
        frag.appendChild(lastNode);
      }
      
      if (savedRange && canvasRef.value && canvasRef.value.contains(savedRange.commonAncestorContainer)) {
        savedRange.deleteContents();
        savedRange.insertNode(frag);
      } else if (canvasRef.value) {
        canvasRef.value.appendChild(frag);
      }
      
      if (lastNode) {
        const newRange = document.createRange();
        newRange.setStartAfter(lastNode);
        newRange.collapse(true);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(newRange);
        }
        savedRange = newRange.cloneRange();
      }
    } else {
      // 2. Insert Single Variable Chip
      let clean = expr.replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '').trim();
      const parts = clean.split('|');
      const varRaw = parts[0].trim();
      const filterRaw = parts.slice(1).join('|').trim();
      
      const chip = document.createElement('span');
      chip.className = 'j-var-chip';
      chip.setAttribute('contenteditable', 'false');
      chip.setAttribute('data-raw', varRaw + (filterRaw ? `|${filterRaw}` : ''));
      chip.textContent = resolveFieldLabel(clean);
      
      chip.ondblclick = (e) => {
        e.stopPropagation();
        openVarModal(chip);
      };

      const space = document.createTextNode(' ');
      
      if (savedRange && canvasRef.value && canvasRef.value.contains(savedRange.commonAncestorContainer)) {
        savedRange.deleteContents();
        savedRange.insertNode(chip);
        chip.after(space);
      } else if (canvasRef.value) {
        canvasRef.value.appendChild(chip);
        canvasRef.value.appendChild(space);
      }

      const newRange = document.createRange();
      newRange.setStart(space, 1);
      newRange.collapse(true);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
      savedRange = newRange.cloneRange();
    }

    // Sync visual canvas DOM back to Markdown editorText
    syncVisualToCode();
    
    nextTick(() => {
      updateActiveLoopContext();
    });
  }
};

// Insert variables at cursor inside the IF condition box in the modal
// Helper to insert ELIF / ELSE branch at the current cursor location inside an IF block
const insertBranchAtCursorOrFooter = (ifBlock, branchElement, bodyElement) => {
  let targetContent = null;
  const sel = window.getSelection();
  
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    let node = range.commonAncestorContainer;
    while (node && node !== ifBlock) {
      if (node.nodeType === Node.ELEMENT_NODE && node.classList && node.classList.contains('j-content')) {
        targetContent = node;
        break;
      }
      node = node.parentNode;
    }
  }
  
  if (!targetContent && savedRange) {
    let node = savedRange.commonAncestorContainer;
    while (node && node !== ifBlock) {
      if (node.nodeType === Node.ELEMENT_NODE && node.classList && node.classList.contains('j-content')) {
        targetContent = node;
        break;
      }
      node = node.parentNode;
    }
  }
  
  if (targetContent && targetContent.parentNode === ifBlock) {
    targetContent.after(branchElement);
    branchElement.after(bodyElement);
  } else {
    const footer = ifBlock.querySelector('.j-footer');
    if (footer) {
      footer.before(branchElement);
      footer.before(bodyElement);
    } else {
      ifBlock.appendChild(branchElement);
      ifBlock.appendChild(bodyElement);
    }
  }
};

// BlockModal.vue owns the expr/forItemVar/forArrayVar form state and reports
// the final expression string on apply; inserting/updating the
// .jinja-block/.j-branch DOM in the canvas stays here since it needs
// activeEditNode/activeBlockForNewBranch/savedRange/canvasRef — canvas-level
// state, and this logic is also reused by the canvas's own rendered
// "+ELIF"/"+ELSE" button handlers below.
const onBlockApply = (expr) => {
  if (!expr) return;

  if (activeEditorTab.value === 'visual') {
    restoreSelection();
    
    if (activeEditNode) {
      activeEditNode.setAttribute('data-cond', expr);
      activeEditNode.textContent = expr;
      syncVisualToCode();
    } else if (blockType.value === 'elif') {
      if (activeBlockForNewBranch) {
        const branch = document.createElement('div');
        branch.className = 'j-branch';
        branch.setAttribute('data-type', 'elif');
        branch.innerHTML = `
          <div style="display:flex;align-items:center;gap:4px;"><span style="font-weight:700;color:#b45309;">O SI:</span> <span class="j-cond-text" data-cond="${expr}">${expr}</span></div>
          <button class="j-btn-mini btn-branch-trash" style="background-color:var(--color-danger);color:white;border:none;display:inline-flex;align-items:center;justify-content:center;" title="Elimina la branca"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        `;
        
        branch.querySelector('.j-cond-text').onclick = (e) => {
          e.stopPropagation();
          openBlockModal('elif', e.target);
        };
        
        branch.querySelector('.btn-branch-trash').onclick = () => {
          if (branch.nextElementSibling && branch.nextElementSibling.classList.contains('j-content')) {
            branch.nextElementSibling.remove();
          }
          branch.remove();
          syncVisualToCode();
        };
        
        const body = document.createElement('div');
        body.className = 'j-content';
        body.setAttribute('contenteditable', 'true');
        body.innerHTML = '<br>';
        
        insertBranchAtCursorOrFooter(activeBlockForNewBranch, branch, body);
        syncVisualToCode();
      }
    } else {
      const isFor = blockType.value === 'for';
      const block = document.createElement('div');
      block.className = 'jinja-block';
      block.setAttribute('contenteditable', 'false');
      block.setAttribute('data-type', blockType.value);
      
      block.innerHTML = `
        <div class="j-head" data-type="${blockType.value}">
          <div style="display:flex;align-items:center;gap:4px;">
            ${isFor ? '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg> <span style="font-weight:700;color:var(--color-primary);">PER CADA:</span>' : '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg> <span style="font-weight:700;color:#b45309;">SI:</span>'} 
            <span class="j-cond-text" data-cond="${expr}">${expr}</span>
          </div>
          <div class="j-actions">
            <button class="j-btn-mini btn-layout" style="background-color:var(--color-primary);color:white;border:none;display:inline-flex;align-items:center;gap:3px;" title="Canvia a mode integrat al text (Inline)"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> <span>Inline</span></button>
            ${isFor ? '' : '<button class="j-btn-mini btn-elif" title="Afegeix branca O SI (ELIF)">+ ELIF</button><button class="j-btn-mini btn-else" title="Afegeix branca EN CAS CONTRARI (ELSE)">+ ELSE</button>'}
            <button class="j-btn-mini btn-trash" style="background-color:var(--color-danger);color:white;border:none;display:inline-flex;align-items:center;justify-content:center;" title="Elimina el bloc"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
          </div>
        </div>
        <div class="j-content" contenteditable="true"><br></div>
        <div class="j-footer"><span>${isFor ? 'FINAL BUCLE' : 'FINAL CONDICIONAL'}</span></div>
      `;
      
      block.querySelector('.j-cond-text').onclick = (e) => {
        e.stopPropagation();
        openBlockModal(blockType.value, e.target);
      };
      
      block.querySelector('.btn-trash').onclick = () => {
        block.remove();
        syncVisualToCode();
      };
      
      if (!isFor) {
        block.querySelector('.btn-elif').onclick = (e) => {
          e.stopPropagation();
          saveSelection();
          activeBlockForNewBranch = block;
          openBlockModal('elif');
        };

        block.querySelector('.btn-else').onclick = (e) => {
          e.stopPropagation();
          saveSelection();
          e.target.style.display = 'none';
          const branch = document.createElement('div');
          branch.className = 'j-branch';
          branch.setAttribute('data-type', 'else');
          branch.innerHTML = `
            <div style="display:flex;align-items:center;gap:4px;"><span style="font-weight:700;color:#b45309;">EN CAS CONTRARI</span></div>
            <button class="j-btn-mini btn-branch-trash" style="background-color:var(--color-danger);color:white;border:none;display:inline-flex;align-items:center;justify-content:center;" title="Elimina la branca"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
          `;
          
          branch.querySelector('.btn-branch-trash').onclick = () => {
            block.querySelector('.btn-else').style.display = 'inline-block';
            if (branch.nextElementSibling && branch.nextElementSibling.classList.contains('j-content')) {
              branch.nextElementSibling.remove();
            }
            branch.remove();
            syncVisualToCode();
          };
          
          const body = document.createElement('div');
          body.className = 'j-content';
          body.setAttribute('contenteditable', 'true');
          body.innerHTML = '<br>';
          
          insertBranchAtCursorOrFooter(block, branch, body);
          syncVisualToCode();
        };
      }

      if (savedRange) {
        savedRange.insertNode(block);
      } else {
        canvasRef.value.appendChild(block);
      }
      ensureTrailingEditableLine(canvasRef.value);
      syncVisualToCode();
    }
  }
  isBlockModalOpen.value = false;
};

const toggleTableAlignment = (th) => {
  const cur = th.getAttribute('data-align') || 'left';
  const nextAlign = cur === 'left' ? 'center' : (cur === 'center' ? 'right' : 'left');
  th.setAttribute('data-align', nextAlign);
  th.style.textAlign = nextAlign;
  
  const thIdx = Array.from(th.parentNode.children).indexOf(th);
  th.closest('table').querySelectorAll('tr').forEach(row => {
    const cell = row.children[thIdx];
    if (cell) cell.style.textAlign = nextAlign;
  });
  
  syncVisualToCode();
};

// Set Row Loops (Jinja Row Repeat in Tables)
const configureRowLoop = () => {
  saveSelection();
  if (!savedRange) return;
  
  let node = savedRange.startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  const tr = node.closest('tr');
  
  if (!tr || tr.parentNode.tagName === 'THEAD') {
    alert("Situa el cursor a dins d'una fila normal de la taula.");
    return;
  }
  
  const currentFor = tr.getAttribute('data-jinja-for') || '';
  const loopExpr = prompt("Expressió del bucle FOR (ex: lot in objecte.lots):", currentFor);
  
  if (loopExpr === null) return;
  
  if (loopExpr.trim() === '') {
    tr.removeAttribute('data-jinja-for');
    tr.classList.remove('j-row-loop');
  } else {
    tr.setAttribute('data-jinja-for', loopExpr);
    tr.classList.add('j-row-loop');
  }
  syncVisualToCode();
};

// BI-DIRECTIONAL PARSERS: HTML DOM ⇄ MARKDOWN + JINJA2
// htmlToMarkdown lives in useMarkdownJinjaCompiler.js (imported above).

// Static AST extractor for loop stacks at any point in template text (independent of user caret position!)
const extractVariablesWithStaticContext = (text) => {
  if (!text) return [];
  const varsWithContext = [];
  const tagRegex = /(\{\{[\s\S]*?\}\}|\{%\s*for\s+[\s\S]*?%\}|\{%\s*endfor\s*%\}|\{%\s*(?:if|elif)\s+[\s\S]*?%\})/g;

  let currentLoopStack = [];
  let match;

  while ((match = tagRegex.exec(text)) !== null) {
    const fullTag = match[0];
    const matchIndex = match.index;

    if (/^\{%\s*for\s+/.test(fullTag)) {
      const forMatch = fullTag.match(/\{%\s*for\s+(\w+)\s+in\s+([a-zA-Z_][a-zA-Z0-9_.]*)/);
      if (forMatch) {
        currentLoopStack.push({
          iterator: forMatch[1],
          arrayPath: forMatch[2],
          startIndex: matchIndex
        });
      }
    } else if (/^\{%\s*endfor\s*%\}$/.test(fullTag.replace(/\s+/g, ''))) {
      if (currentLoopStack.length > 0) {
        currentLoopStack.pop();
      }
    } else if (fullTag.startsWith('{{')) {
      const inner = fullTag.slice(2, -2).trim();
      varsWithContext.push({
        type: 'var',
        raw: inner,
        expr: inner.split('|')[0].trim(),
        index: matchIndex,
        loopStack: [...currentLoopStack]
      });
    } else if (/^\{%\s*(if|elif)\s+/.test(fullTag)) {
      const blockMatch = fullTag.match(/^\{%\s*(if|elif)\s+(.*?)\s*%\}/);
      if (blockMatch) {
        const exprBody = blockMatch[2];
        const terms = exprBody.split(/==|!=|>=|<=|>|<|\band\b|\bor\b|\bnot\b|\bin\b|\bis\b/).map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        for (const t of terms) {
          if (t && /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(t)) {
            varsWithContext.push({
              type: 'block',
              raw: t,
              expr: t,
              index: matchIndex,
              loopStack: [...currentLoopStack]
            });
          }
        }
      }
    }
  }

  return varsWithContext;
};

// On-demand reactive state for undefined variables (updated ONLY when "Comprova Plantilla" button is clicked)
const undefinedVariablesList = ref([]);
const hasCheckedTemplate = ref(false);

// Markdown<->Jinja2<->HTML compiler cluster (isVariableDefinedInSchema, createJinjaVarChip, table
// parsers, compileMarkdownToHtml...) lives in useMarkdownJinjaCompiler.js since these functions call
// each other directly and are not meaningfully separable.
const {
  isVariableDefinedInSchema,
  createJinjaVarChip,
  convertJinjaToChips,
  findBestKeyMatch,
  findColHeaderKeyMatch,
  parseCommentTablesToHtml,
  parseMarkdownTablesToHtml,
  renderTableRowsToHtml,
  compileMarkdownToHtml,
} = useMarkdownJinjaCompiler({
  store,
  activeLoopStack,
  hasCheckedTemplate,
  resolveFieldLabel,
  resolvePath,
});

const checkTemplateVariables = () => {
  const text = editorText.value || '';
  const varsWithCtx = extractVariablesWithStaticContext(text);
  const undefinedList = [];

  for (const item of varsWithCtx) {
    if (item.expr && !isVariableDefinedInSchema(item.expr, item.loopStack)) {
      if (!undefinedList.includes(item.expr)) {
        undefinedList.push(item.expr);
      }
    }
  }

  undefinedVariablesList.value = undefinedList;
  hasCheckedTemplate.value = true;

  if (undefinedList.length === 0) {
    store.addLog("✓ Verificació de plantilla completada: Totes les variables i bucles estan definits a l'esquema!", "success");
  } else {
    store.addLog(`⚠️ S'han detectat ${undefinedList.length} variables no definides a la plantilla: ${undefinedList.join(', ')}`, "warning");
  }
  
  syncCodeToVisual();
};

// Sync loops
// syncVisualToCode/syncCodeToVisual and the ~5 other modal blocks below are intentionally left in
// this file for this refactor phase: syncCodeToVisual alone wires ~15 other component functions as
// DOM event handlers (.onclick/.ondblclick) on the compiled canvas, so it is too tightly coupled to
// extract without changing behavior. Left as a candidate for a future dedicated phase.
const syncVisualToCode = () => {
  if (canvasRef.value && activeEditorTab.value === 'visual') {
    const parsed = htmlToMarkdown(canvasRef.value);
    // Safety guard: do not overwrite editorText with empty text if canvas was blanked due to error
    if (parsed || !editorText.value) {
      editorText.value = parsed;
    }
  }
};

const syncCodeToVisual = () => {
  if (canvasRef.value) {
    // Rebuilding innerHTML below wipes the browser's selection. If the canvas
    // currently holds focus (i.e. this rebuild was triggered by an in-place
    // interactive edit — ELIF/ELSE/trash/layout-toggle/"Comprova Plantilla" —
    // rather than an external content swap like a tab switch or undo/redo),
    // capture the caret offset now and restore it after the rebuild so the
    // user doesn't lose their editing position on every small structural edit.
    const shouldPreserveCaret = !!(document.activeElement && canvasRef.value.contains(document.activeElement));
    const caretOffset = shouldPreserveCaret ? getCaretCharacterOffsetWithin(canvasRef.value) : 0;

    try {
      const html = compileMarkdownToHtml(editorText.value);
      if (html !== undefined && html !== null) {
        canvasRef.value.innerHTML = html;
      }
    } catch (err) {
      console.error("Error al compilar la plantilla visual:", err);
    }
    
    canvasRef.value.querySelectorAll('.pandoc-metadata-chip').forEach(c => {
      c.onclick = (e) => { e.stopPropagation(); openMetadataModal(); };
      const btn = c.querySelector('.btn-edit-metadata');
      if (btn) btn.onclick = (e) => { e.stopPropagation(); openMetadataModal(); };
    });
    
    canvasRef.value.querySelectorAll('.j-var-chip').forEach(c => {
      c.ondblclick = (e) => { e.stopPropagation(); openVarModal(c); };
    });
    
    canvasRef.value.querySelectorAll('.latex-chip').forEach(c => {
      c.ondblclick = (e) => { e.stopPropagation(); openMathModal(c); };
    });
    
    canvasRef.value.querySelectorAll('table').forEach(table => {
      table.querySelectorAll('th').forEach(th => {
        th.onclick = () => toggleTableAlignment(th);
      });
      table.ondblclick = (e) => {
        e.stopPropagation();
        openTableModal(table);
      };
      const editBtn = table.previousElementSibling;
      if (editBtn?.classList.contains('table-edit-btn')) {
        editBtn.onclick = (e) => { e.stopPropagation(); openTableModal(table); };
      }
    });

    canvasRef.value.querySelectorAll('.jinja-block').forEach(block => {
      const isInline = block.classList.contains('inline') || block.getAttribute('data-layout') === 'inline';
      const type = block.getAttribute('data-type') || 'if';
      
      if (isInline) {
        const switchToBlock = (e) => {
          e.stopPropagation();
          block.setAttribute('data-layout', 'block');
          block.classList.remove('inline');
          syncVisualToCode();
          syncCodeToVisual();
        };
        block.querySelectorAll('.j-inline-tag').forEach(tag => {
          tag.onclick = switchToBlock;
        });
        const toBlockBtn = block.querySelector('.btn-to-block');
        if (toBlockBtn) toBlockBtn.onclick = switchToBlock;
      } else {
        const condText = block.querySelector('.j-cond-text');
        if (condText) {
          condText.onclick = (e) => {
            e.stopPropagation();
            openBlockModal(type, e.target);
          };
        }
        
        const trashBtn = block.querySelector('.btn-trash');
        if (trashBtn) {
          trashBtn.onclick = () => {
            block.remove();
            syncVisualToCode();
          };
        }
        
        const layoutBtn = block.querySelector('.btn-layout');
        if (layoutBtn) {
          layoutBtn.onclick = (e) => {
            e.stopPropagation();
            block.setAttribute('data-layout', 'inline');
            block.classList.add('inline');
            syncVisualToCode();
            syncCodeToVisual();
          };
        }
        
        const elifBtn = block.querySelector('.btn-elif');
        if (elifBtn) {
          elifBtn.onclick = (e) => {
            e.stopPropagation();
            saveSelection();
            activeBlockForNewBranch = block;
            openBlockModal('elif');
          };
        }

        const elseBtn = block.querySelector('.btn-else');
        if (elseBtn) {
          elseBtn.onclick = (e) => {
            e.stopPropagation();
            saveSelection();
            elseBtn.style.display = 'none';
            const branch = document.createElement('div');
            branch.className = 'j-branch';
            branch.setAttribute('data-type', 'else');
            branch.innerHTML = `
              <div style="display:flex;align-items:center;gap:4px;">🛑 <span style="font-weight:700;color:#b45309;">EN CAS CONTRARI</span></div>
              <button class="j-btn-mini btn-branch-trash" style="background-color:var(--color-danger);color:white;border:none;" title="Elimina la branca">🗑️</button>
            `;
            branch.querySelector('.btn-branch-trash').onclick = () => {
              elseBtn.style.display = 'inline-block';
              if (branch.nextElementSibling && branch.nextElementSibling.classList.contains('j-content')) {
                branch.nextElementSibling.remove();
              }
              branch.remove();
              syncVisualToCode();
            };
            
            const body = document.createElement('div');
            body.className = 'j-content';
            body.setAttribute('contenteditable', 'true');
            body.innerHTML = '<br>';
            
            insertBranchAtCursorOrFooter(block, branch, body);
            syncVisualToCode();
          };
        }
        
        block.querySelectorAll('.j-branch').forEach(b => {
          const bType = b.getAttribute('data-type');
          if (bType === 'elif') {
            b.querySelector('.j-cond-text').onclick = (e) => {
              e.stopPropagation();
              openBlockModal('elif', e.target);
            };
          }
          b.querySelector('.btn-branch-trash').onclick = () => {
            if (bType === 'else' && elseBtn) elseBtn.style.display = 'inline-block';
            b.nextElementSibling.remove();
            b.remove();
            syncVisualToCode();
          };
        });
      }
    });

    ensureTrailingEditableLine(canvasRef.value);

    if (shouldPreserveCaret && caretOffset > 0) {
      canvasRef.value.focus();
      setCaretCharacterOffsetWithin(canvasRef.value, caretOffset);
    }
  }
};

// Handle Tab Switches
const switchTab = (tab) => {
  if (tab === activeEditorTab.value) return;

  // Capture the caret's position in terms of editorText — the one thing
  // both representations share — *before* switching, so it can be
  // translated into the new tab's own terms once it's rendered.
  const sourceOffset = tab === 'code'
    ? sourceOffsetFromVisualCaret()
    : (textareaRef.value?.selectionStart ?? 0);

  if (tab === 'code') {
    syncVisualToCode();
  } else {
    syncCodeToVisual();
  }
  activeEditorTab.value = tab;

  nextTick(() => {
    if (tab === 'code' && textareaRef.value) {
      textareaRef.value.focus();
      textareaRef.value.setSelectionRange(sourceOffset, sourceOffset);
    } else if (tab === 'visual' && canvasRef.value) {
      canvasRef.value.focus();
      visualCaretFromSourceOffset(sourceOffset);
      scrollCaretIntoView();
    }
    updateActiveLoopContext();
  });
};

// Helper to identify atomic visual chips (variables, math formulas, inline tags)
const isAtomicChip = (node) => {
  return node && node.nodeType === Node.ELEMENT_NODE && (
    node.classList.contains('j-var-chip') || 
    node.classList.contains('latex-chip') || 
    node.classList.contains('j-inline-tag')
  );
};

const getParentAtomicChip = (node) => {
  let curr = node;
  while (curr && curr !== canvasRef.value) {
    if (isAtomicChip(curr)) return curr;
    curr = curr.parentNode;
  }
  return null;
};

const moveCaretBefore = (el) => {
  let prev = el.previousSibling;
  if (!prev || prev.nodeType !== Node.TEXT_NODE) {
    prev = document.createTextNode('');
    el.parentNode.insertBefore(prev, el);
  }
  const range = document.createRange();
  range.setStart(prev, prev.textContent.length);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  saveSelection();
};

const moveCaretAfter = (el) => {
  let next = el.nextSibling;
  if (!next || next.nodeType !== Node.TEXT_NODE) {
    next = document.createTextNode('');
    el.parentNode.insertBefore(next, el.nextSibling);
  }
  const range = document.createRange();
  range.setStart(next, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  saveSelection();
};

// Keystrokes observers inside canvas to handle atomic chips & backspaces properly
const onCanvasKeyDown = (e) => {
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode) return;
  
  const currentChip = getParentAtomicChip(sel.anchorNode);
  
  // If caret is inside or on an atomic chip element
  if (currentChip) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveCaretAfter(currentChip);
      return;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveCaretBefore(currentChip);
      return;
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      currentChip.remove();
      syncVisualToCode();
      return;
    }
  }

  const node = sel.anchorNode;
  const offset = sel.anchorOffset;

  if (e.key === 'ArrowRight') {
    if (node.nodeType === Node.TEXT_NODE && offset === node.textContent.length) {
      if (isAtomicChip(node.nextSibling)) {
        e.preventDefault();
        moveCaretAfter(node.nextSibling);
        return;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const childAtOffset = node.childNodes[offset];
      if (isAtomicChip(childAtOffset)) {
        e.preventDefault();
        moveCaretAfter(childAtOffset);
        return;
      }
    }
  } else if (e.key === 'ArrowLeft') {
    if (node.nodeType === Node.TEXT_NODE && offset === 0) {
      if (isAtomicChip(node.previousSibling)) {
        e.preventDefault();
        moveCaretBefore(node.previousSibling);
        return;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE && offset > 0) {
      const childBeforeOffset = node.childNodes[offset - 1];
      if (isAtomicChip(childBeforeOffset)) {
        e.preventDefault();
        moveCaretBefore(childBeforeOffset);
        return;
      }
    }
  } else if (e.key === 'Backspace') {
    if (node.nodeType === Node.TEXT_NODE && offset === 0) {
      if (isAtomicChip(node.previousSibling)) {
        e.preventDefault();
        node.previousSibling.remove();
        syncVisualToCode();
        return;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE && offset > 0) {
      const target = node.childNodes[offset - 1];
      if (isAtomicChip(target)) {
        e.preventDefault();
        target.remove();
        syncVisualToCode();
        return;
      }
    }
  } else if (e.key === 'Delete') {
    if (node.nodeType === Node.TEXT_NODE && offset === node.textContent.length) {
      if (isAtomicChip(node.nextSibling)) {
        e.preventDefault();
        node.nextSibling.remove();
        syncVisualToCode();
        return;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const target = node.childNodes[offset];
      if (isAtomicChip(target)) {
        e.preventDefault();
        target.remove();
        syncVisualToCode();
        return;
      }
    }
  }
};

const ensureTrailingEditableLine = (canvas) => {
  if (!canvas) return;
  const lastChild = canvas.lastElementChild || canvas.lastChild;
  
  if (!lastChild || (lastChild.nodeType === Node.ELEMENT_NODE && (
    lastChild.classList.contains('jinja-block') ||
    lastChild.tagName === 'TABLE' ||
    lastChild.classList.contains('pandoc-metadata-chip') ||
    lastChild.getAttribute('contenteditable') === 'false'
  ))) {
    const p = document.createElement('p');
    p.className = 'trailing-editable-line';
    p.innerHTML = '<br>';
    canvas.appendChild(p);
  }
};

const moveCaretToElementEnd = (el) => {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  saveSelection();
};

const onCanvasClick = (e) => {
  saveSelection();
  updateActiveLoopContext();
  
  if (canvasRef.value) {
    ensureTrailingEditableLine(canvasRef.value);
    const lastChild = canvasRef.value.lastElementChild;
    if (lastChild) {
      const rect = lastChild.getBoundingClientRect();
      if (e.clientY > rect.bottom) {
        moveCaretToElementEnd(lastChild);
      }
    }
  }
};

const onCanvasMouseUp = () => {
  saveSelection();
  updateActiveLoopContext();
};

// Markdown/Jinja2 is the priority representation for the clipboard, not HTML:
// copying/cutting from the canvas puts the underlying source text on the
// clipboard (not styled HTML), and pasted HTML/rich text is always converted
// to Markdown via htmlToMarkdown *before* it ever enters editorText — never
// preserved as HTML inside the contenteditable DOM. This replaces the old
// sanitizePasteHtml DOM-surgery approach entirely.
const onCanvasCopyOrCut = (e) => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return; // nothing selected: let default happen
  const range = sel.getRangeAt(0);
  const md = htmlToMarkdown(range.cloneContents());
  e.clipboardData.setData('text/plain', md);
  e.preventDefault();
  if (e.type === 'cut') {
    range.deleteContents();
    saveSelection();
    syncVisualToCode();
  }
};

const onCanvasPaste = (e) => {
  e.preventDefault();
  if (!canvasRef.value) return;

  const html = e.clipboardData.getData('text/html');
  let pastedMarkdown;
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    pastedMarkdown = htmlToMarkdown(doc.body);
  } else {
    pastedMarkdown = e.clipboardData.getData('text/plain') || '';
  }
  if (!pastedMarkdown) return;

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const insertAt = sourceOffsetFromVisualCaret();

  syncVisualToCode(); // ensure editorText reflects the canvas exactly before splicing
  const current = editorText.value || '';
  const at = Math.min(insertAt, current.length);
  editorText.value = current.slice(0, at) + pastedMarkdown + current.slice(at);

  nextTick(() => syncCodeToVisual());
};

// --- Pandoc YAML Metadata Modal State & Logic ---
const isMetadataModalOpen = ref(false);
const metadataModalRef = ref(null);

const openMetadataModal = () => {
  saveSelection();
  isMetadataModalOpen.value = true;
};

// MetadataModal.vue computes the new full template text (it owns its own form
// state and YAML parsing); writing it back into the shared editor state and
// re-rendering the canvas stays a parent concern, same split as every other
// extracted modal.
const onMetadataApply = (newText) => {
  store.templateText = newText;
  editorText.value = newText;
  syncCodeToVisual();
  store.addLog("Bloc de metadades Pandoc actualitzat a la plantilla.", "success");
};

// Special Characters Configuration & Handler
const specialCharCategories = [
  {
    name: 'Puntuació i Tipografia',
    chars: [
      { char: '—', name: 'Guió llarg (Em Dash)', code: '&mdash;' },
      { char: '–', name: 'Guió mitjà (En Dash)', code: '&ndash;' },
      { char: '\u00A0', label: '[Espai No Sep.]', name: 'Espai no separable', code: '&nbsp;' },
      { char: '‑', label: '[Guió No Sep.]', name: 'Guió no separable', code: '&#8209;' },
      { char: '…', name: 'Punts suspensius', code: '&hellip;' },
      { char: '•', name: 'Punt de llista (Bullet)', code: '&bull;' },
      { char: '§', name: 'Secció / Article', code: '&sect;' },
      { char: '¶', name: 'Símbol de paràgraf', code: '&para;' },
    ]
  },
  {
    name: 'Cometes i Marques',
    chars: [
      { char: '«', name: 'Cometa llatina esquerra', code: '&laquo;' },
      { char: '»', name: 'Cometa llatina dreta', code: '&raquo;' },
      { char: '“', name: 'Cometa doble esquerra', code: '&ldquo;' },
      { char: '”', name: 'Cometa doble dreta', code: '&rdquo;' },
      { char: '‘', name: 'Cometa simple esquerra', code: '&lsquo;' },
      { char: '’', name: 'Cometa simple dreta', code: '&rsquo;' },
      { char: '©', name: 'Copyright', code: '&copy;' },
      { char: '®', name: 'Marca registrada', code: '&reg;' },
      { char: '™', name: 'Trademark', code: '&trade;' },
    ]
  },
  {
    name: 'Matemàtics i Símbols',
    chars: [
      { char: '€', name: 'Euro', code: '&euro;' },
      { char: '°', name: 'Grau', code: '&deg;' },
      { char: '±', name: 'Més/Menys', code: '&plusmn;' },
      { char: '×', name: 'Multiplicació', code: '&times;' },
      { char: '÷', name: 'Divisió', code: '&divide;' },
      { char: '≠', name: 'No igual', code: '&ne;' },
      { char: '≤', name: 'Menor o igual', code: '&le;' },
      { char: '≥', name: 'Major o igual', code: '&ge;' },
      { char: '≈', name: 'Aproximadament igual', code: '&asymp;' },
      { char: '‰', name: 'Per mil', code: '&permil;' },
    ]
  }
];

const openSpecialCharModal = () => {
  saveSelection();
  isSpecialCharModalOpen.value = true;
};

const insertSpecialChar = (item) => {
  const char = item.char;
  if (activeEditorTab.value === 'visual') {
    restoreSelection();
    document.execCommand('insertText', false, char);
    saveSelection();
    syncVisualToCode();
  } else {
    if (textareaRef.value) {
      const el = textareaRef.value;
      el.focus();
      const start = el.selectionStart || 0;
      const end = el.selectionEnd || 0;
      const text = editorText.value || '';
      editorText.value = text.substring(0, start) + char + text.substring(end);
      nextTick(() => {
        el.setSelectionRange(start + char.length, start + char.length);
        syncCodeToVisual();
      });
    }
  }
  isSpecialCharModalOpen.value = false;
};

// Initialize canvas on mount
const handleGlobalKeyDown = (e) => {
  const isAnyModalOpen = isVarModalOpen.value || isBlockModalOpen.value || isMathModalOpen.value || isTableModalOpen.value || isMetadataModalOpen.value || isSpecialCharModalOpen.value;

  // Handle Ctrl+1 .. Ctrl+6 shortcuts for Headings H1..H6 and Ctrl+B / Ctrl+I
  if ((e.ctrlKey || e.metaKey) && !isAnyModalOpen) {
    if (['1', '2', '3', '4', '5', '6'].includes(e.key)) {
      e.preventDefault();
      formatBlock(`H${e.key}`);
      return;
    }
    if (e.key.toLowerCase() === 'b') {
      e.preventDefault();
      formatDoc('bold');
      return;
    }
    if (e.key.toLowerCase() === 'i') {
      e.preventDefault();
      formatDoc('italic');
      return;
    }
  }

  if (!isAnyModalOpen) return;
  
  if (e.key === 'Escape') {
    e.preventDefault();
    isVarModalOpen.value = false;
    isBlockModalOpen.value = false;
    isMathModalOpen.value = false;
    isTableModalOpen.value = false;
    isMetadataModalOpen.value = false;
    isSpecialCharModalOpen.value = false;
  } else if (e.key === 'Enter') {
    if (isVarModalOpen.value) {
      e.preventDefault();
      applyVariable();
    } else if (isBlockModalOpen.value) {
      e.preventDefault();
      blockModalRef.value?.apply();
    } else if (isMathModalOpen.value) {
      e.preventDefault();
      mathModalRef.value?.apply();
    } else if (isTableModalOpen.value) {
      e.preventDefault();
      tableModalRef.value?.apply();
    } else if (isMetadataModalOpen.value && e.ctrlKey) {
      e.preventDefault();
      metadataModalRef.value?.apply();
    }
  }
};

// Helper to get character offset inside contenteditable
const getCaretCharacterOffsetWithin = (element) => {
  let caretOffset = 0;
  let targetRange = null;
  const sel = window.getSelection();
  
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0);
    if (element && element.contains(r.commonAncestorContainer)) {
      targetRange = r;
    }
  }
  
  if (!targetRange && savedRange && element && element.contains(savedRange.commonAncestorContainer)) {
    targetRange = savedRange;
  }
  
  if (targetRange && element) {
    try {
      const preCaretRange = targetRange.cloneRange();
      preCaretRange.selectNodeContents(element);
      preCaretRange.setEnd(targetRange.endContainer, targetRange.endOffset);
      caretOffset = preCaretRange.toString().length;
    } catch (err) {
      console.warn("Could not calculate caret offset", err);
    }
  }
  
  return caretOffset;
};

// Helper to set character offset inside contenteditable
const setCaretCharacterOffsetWithin = (element, offset) => {
  if (!element || offset <= 0) return;
  let charCount = 0;
  const range = document.createRange();
  range.setStart(element, 0);
  range.collapse(true);

  const nodeStack = [element];
  let node;
  let found = false;

  while (!found && (node = nodeStack.pop())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const nextCharCount = charCount + node.length;
      if (offset <= nextCharCount) {
        range.setStart(node, offset - charCount);
        range.collapse(true);
        found = true;
      }
      charCount = nextCharCount;
    } else {
      let i = node.childNodes.length;
      while (i--) {
        nodeStack.push(node.childNodes[i]);
      }
    }
  }

  if (found) {
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    savedRange = range.cloneRange();
  }
};

// Approximates the offset within editorText (the Markdown+Jinja2 source)
// corresponding to the current caret position in the visual canvas: the
// length of the Markdown that the canvas content *up to the caret* converts
// to via htmlToMarkdown — the same conversion that keeps editorText in sync
// with the canvas everywhere else (originally inlined in onCanvasPaste),
// so it's exact for plain text and a close best-effort near chip/block
// boundaries. Never destructive — worst case a restored caret lands a
// character or two off, self-correcting on the next edit.
const sourceOffsetFromVisualCaret = () => {
  if (!canvasRef.value) return 0;
  const sel = window.getSelection();
  let range = null;
  if (sel && sel.rangeCount > 0 && canvasRef.value.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    range = sel.getRangeAt(0);
  } else if (savedRange && canvasRef.value.contains(savedRange.commonAncestorContainer)) {
    range = savedRange;
  }
  if (!range) return 0;
  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(canvasRef.value);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  return htmlToMarkdown(prefixRange.cloneContents()).length;
};

// The inverse: approximates where in the rendered visual canvas a given
// offset within editorText (source) lands, by compiling just the text up to
// that offset and measuring how much rendered text it produces. Assumes
// canvasRef already holds the *full*, correctly rendered document — only
// the measured prefix length varies.
const visualCaretFromSourceOffset = (offset) => {
  if (!canvasRef.value) return;
  const prefixText = (editorText.value || '').slice(0, offset);
  let renderedLength = 0;
  try {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = compileMarkdownToHtml(prefixText);
    renderedLength = (tempDiv.textContent || '').length;
  } catch (err) {
    console.warn('Could not estimate visual caret position', err);
    return;
  }
  setCaretCharacterOffsetWithin(canvasRef.value, renderedLength);
};

// Scrolls the visual canvas so the current selection is visible. The code
// textarea doesn't need this — browsers already scroll a <textarea> to the
// caret on focus()+setSelectionRange() — but a contenteditable doesn't
// reliably auto-scroll after a programmatic Range change.
const scrollCaretIntoView = () => {
  if (activeEditorTab.value !== 'visual') return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const node = sel.getRangeAt(0).startContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  el?.scrollIntoView({ block: 'nearest' });
};

// A single canonical position — an offset into editorText, the Markdown+
// Jinja2 source that's the one real source of truth regardless of which tab
// is active — replaces the old, disjoint caretCode/caretVisual keys (each
// mode's own last position, never translated into the other's terms).
// Skipped entirely in cell mode: DataInspector.vue's hidden cell-editing
// instance shares this component but not a document identity, and already
// has its own undo history (cellHistory) — it has no business reading or
// writing the main document's cursor-position keys (the same reasoning as
// the store.editorActions !isCellMode guard elsewhere in this file).
const saveCaretState = () => {
  if (props.isCellMode) return;
  const pName = store.currentProjectName || localStorage.getItem('currentProjectName') || 'Default';
  const dName = store.activeDocName || localStorage.getItem(`${pName}:activeDocName`) || 'Document Principal';

  const pos = activeEditorTab.value === 'code' && textareaRef.value
    ? (textareaRef.value.selectionStart || 0)
    : sourceOffsetFromVisualCaret();
  localStorage.setItem(`${pName}:doc:${dName}:sourceCaretOffset`, pos);
  localStorage.setItem(`${pName}:doc:${dName}:activeEditorTab`, activeEditorTab.value);
};

const restoreCaretState = () => {
  if (props.isCellMode) return;
  const pName = store.currentProjectName || localStorage.getItem('currentProjectName') || 'Default';
  const dName = store.activeDocName || localStorage.getItem(`${pName}:activeDocName`) || 'Document Principal';

  const savedTab = localStorage.getItem(`${pName}:doc:${dName}:activeEditorTab`);
  if (savedTab && (savedTab === 'visual' || savedTab === 'code')) {
    activeEditorTab.value = savedTab;
  }

  const savedOffset = parseInt(localStorage.getItem(`${pName}:doc:${dName}:sourceCaretOffset`) || '0', 10);
  if (!savedOffset) return;

  nextTick(() => {
    if (activeEditorTab.value === 'code' && textareaRef.value) {
      textareaRef.value.focus();
      textareaRef.value.setSelectionRange(savedOffset, savedOffset);
    } else if (activeEditorTab.value === 'visual' && canvasRef.value) {
      visualCaretFromSourceOffset(savedOffset);
      scrollCaretIntoView();
    }
  });
};

const handleSelectionChange = () => {
  saveSelection();
  saveCaretState();
  updateActiveLoopContext();
};

const onCanvasFocus = () => {
  saveSelection();
  updateActiveLoopContext();
};

const onCanvasKeyUp = () => {
  saveSelection();
  updateActiveLoopContext();
};

watch(() => activeEditorTab.value, () => {
  nextTick(() => {
    updateActiveLoopContext();
  });
});

watch(() => editorText.value, () => {
  if (activeEditorTab.value === 'code') {
    updateActiveLoopContext();
  }
});

onMounted(() => {
  window.__openPandocMetadataModal = openMetadataModal;
  const scrollToLine = (target) => {
    const lineIndex = typeof target === 'number' ? target : (target && target.lineIndex !== undefined ? target.lineIndex : 0);
    const headingIndex = typeof target === 'object' && target ? target.headingIndex : undefined;
    const rawTitle = typeof target === 'object' && target ? target.rawTitle : '';
    const textTitle = typeof target === 'object' && target ? target.text : '';

    // Strategy A: Visual WYSIWYG Mode Canvas
    if (activeEditorTab.value === 'visual' && canvasRef.value) {
      const headings = Array.from(canvasRef.value.querySelectorAll('h1, h2, h3, h4, h5, h6'));
      if (headings.length > 0) {
        let el = headingIndex !== undefined ? headings[headingIndex] : null;
        if (!el && textTitle) {
          el = headings.find(h => h.textContent.includes(textTitle) || (rawTitle && h.textContent.includes(rawTitle)));
        }
        if (!el) {
          el = headings[Math.min(lineIndex, headings.length - 1)];
        }
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('heading-highlight');
          setTimeout(() => el.classList.remove('heading-highlight'), 2000);
          return;
        }
      }
    }

    // Strategy B: Raw Code Textarea Mode
    if (textareaRef.value) {
      const text = editorText.value || '';
      const lines = text.split(/\r?\n/);
      let targetLine = lineIndex;
      
      if (typeof target === 'object') {
        const foundIdx = lines.findIndex((l) => {
          if (!/^(#{1,6})\s+/.test(l)) return false;
          if (rawTitle && l.includes(rawTitle)) return true;
          if (textTitle && l.includes(textTitle)) return true;
          return false;
        });
        if (foundIdx !== -1) {
          targetLine = foundIdx;
        }
      }

      let charOffset = 0;
      for (let i = 0; i < Math.min(targetLine, lines.length); i++) {
        charOffset += lines[i].length + 1;
      }
      
      const targetLineText = lines[targetLine] || '';
      textareaRef.value.focus();
      textareaRef.value.setSelectionRange(charOffset, charOffset + targetLineText.length);
      
      const totalLines = Math.max(lines.length, 1);
      const computedLineHeight = textareaRef.value.scrollHeight / totalLines;
      const scrollPos = Math.max(0, (targetLine * computedLineHeight) - 80);
      
      textareaRef.value.scrollTop = scrollPos;
    }
  };

  // DataInspector.vue also always mounts a second, normally-hidden
  // TemplateEditor instance (isCellMode) for cell editing. Only the main
  // (non-cell-mode) instance may claim this shared store slot — otherwise
  // whichever instance happens to mount last wins it, and the App.vue
  // ribbon buttons can silently end up driving the hidden cell-mode editor
  // instead of the visible one.
  if (!props.isCellMode) {
    store.editorActions = {
      switchEditorTab: (tab) => switchTab(tab),
      openMetadataModal: () => openMetadataModal(),
      formatBlock: (val) => formatBlock(val),
      formatDoc: (cmd) => formatDoc(cmd),
      insertList: (type) => insertList(type),
      openTableModal: () => openTableModal(),
      openBlockModal: (type) => openBlockModal(type),
      openMathModal: () => openMathModal(),
      openVarModal: () => openVarModal(),
      openSpecialCharModal: () => openSpecialCharModal(),
      openVersionHistoryModal: () => { window.__openVersionHistoryModal && window.__openVersionHistoryModal(); },
      checkTemplateVariables: () => checkTemplateVariables(),
      emitGenerate: () => emitGenerate(),
      getActiveTab: () => activeEditorTab.value,
      scrollToLine: (lineIndex) => scrollToLine(lineIndex),
    };
  }
  syncCodeToVisual();
  window.addEventListener('keydown', handleGlobalKeyDown);
  document.addEventListener('selectionchange', handleSelectionChange);
  restoreCaretState();
  updateActiveLoopContext();
});

onUnmounted(() => {
  delete window.__openPandocMetadataModal;
  window.removeEventListener('keydown', handleGlobalKeyDown);
  document.removeEventListener('selectionchange', handleSelectionChange);
});
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 0.5rem; height: 100%; max-height: 100%; min-height: 0; flex: 1;">
    <!-- Compact Single-Line Horizontal Toolbar (shown when isCellMode is true) -->
    <div 
      v-if="isCellMode" 
      class="editor-cell-toolbar" 
      style="display: flex; align-items: center; gap: 4px; padding: 4px 6px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); width: 100%; max-width: 100%; box-sizing: border-box; flex-shrink: 0;"
    >
      <!-- Group 1: Visual / Code Switcher -->
      <div class="segmented-control" style="display: inline-flex; border: 1px solid var(--border-color); border-radius: 4px; padding: 1px; background: var(--bg-primary); flex-shrink: 0;">
        <button 
          type="button"
          class="btn-segment" 
          :class="{ active: activeEditorTab === 'visual' }"
          @click="switchTab('visual')"
          style="padding: 2px 6px; font-size: 0.72rem; border: none; background: transparent; cursor: pointer; border-radius: 3px; color: var(--text-primary); display: inline-flex; align-items: center; gap: 3px; width: auto;"
          title="Editor Visual (WYSIWYG)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          <span>Visual</span>
        </button>
        <button 
          type="button"
          class="btn-segment" 
          :class="{ active: activeEditorTab === 'code' }"
          @click="switchTab('code')"
          style="padding: 2px 6px; font-size: 0.72rem; border: none; background: transparent; cursor: pointer; border-radius: 3px; color: var(--text-primary); display: inline-flex; align-items: center; gap: 3px; width: auto;"
          title="Codi Raw Markdown + Jinja2"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
          <span>Codi</span>
        </button>
      </div>

      <div style="height: 16px; width: 1px; background: var(--border-color); margin: 0 1px; flex-shrink: 0;"></div>

      <!-- Group 2: Formatting Tools -->
      <template v-if="activeEditorTab === 'visual'">
        <select 
          style="width: 85px; height: 26px; padding: 1px 3px; font-size: 0.72rem; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); flex-shrink: 0;" 
          @change="formatBlock($event.target.value); $event.target.value = '';" 
          title="Format de paràgraf (Títols H1-H6 o Paràgraf)"
        >
          <option value="">Format...</option>
          <option value="H1">Títol 1 (#)</option>
          <option value="H2">Títol 2 (##)</option>
          <option value="H3">Títol 3 (###)</option>
          <option value="H4">Títol 4 (####)</option>
          <option value="H5">Títol 5 (#####)</option>
          <option value="H6">Títol 6 (######)</option>
          <option value="P">Paràgraf (p)</option>
        </select>
        
        <button type="button" class="btn btn-secondary btn-tb" @click="formatDoc('bold')" title="Negreta (Ctrl+B)"><b>B</b></button>
        <button type="button" class="btn btn-secondary btn-tb" @click="formatDoc('italic')" title="Cursiva (Ctrl+I)"><i>I</i></button>
        <button type="button" class="btn btn-secondary btn-tb" @click="insertList('unordered')" title="Llista de punts">•</button>
        <button type="button" class="btn btn-secondary btn-tb" @click="insertList('ordered')" title="Llista numerada">1.</button>

        <div style="height: 16px; width: 1px; background: var(--border-color); margin: 0 1px; flex-shrink: 0;"></div>
      </template>

      <!-- Group 3: Insertion Tools -->
      <button type="button" class="btn btn-secondary btn-tb" style="display: inline-flex; align-items: center; gap: 3px;" @click="openTableModal()" title="Insereix taula automàtica des de l'Excel">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>
        <span>Taula</span>
      </button>

      <button type="button" class="btn btn-secondary btn-tb" style="display: inline-flex; align-items: center; gap: 3px;" @click="openMathModal()" title="Insereix fórmula LaTeX / KaTeX">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 4H6l6 8-6 8h12"/></svg>
        <span>Equació</span>
      </button>

      <button type="button" class="btn btn-secondary btn-tb" style="display: inline-flex; align-items: center; gap: 3px;" @click="openBlockModal('if')" title="Insereix condicional IF">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
        <span>IF</span>
      </button>

      <button type="button" class="btn btn-secondary btn-tb" style="display: inline-flex; align-items: center; gap: 3px;" @click="openBlockModal('for')" title="Insereix bucle FOR">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>
        <span>FOR</span>
      </button>

      <button type="button" class="btn btn-secondary btn-tb" style="font-weight: bold; color: var(--color-primary);" @click="openSpecialCharModal()" title="Insereix caràcters especials (guió llarg, espai no separable, etc.)">
        <span>Ω</span>
      </button>

      <div style="height: 16px; width: 1px; background: var(--border-color); margin: 0 1px; flex-shrink: 0;"></div>

      <!-- Cell-Exclusive History Buttons -->
      <button 
        type="button" 
        class="btn btn-secondary btn-tb" 
        :disabled="!canCellUndo"
        @click="cellUndo" 
        title="Històric exclusiu de la cel·la: Desfer darrer canvi"
        style="display: inline-flex; align-items: center; gap: 3px;"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
        <span>Desfés Cel·la</span>
      </button>
      <button 
        type="button" 
        class="btn btn-secondary btn-tb" 
        :disabled="!canCellRedo"
        @click="cellRedo" 
        title="Històric exclusiu de la cel·la: Refer canvi"
        style="display: inline-flex; align-items: center; gap: 3px;"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/></svg>
        <span>Refés Cel·la</span>
      </button>
    </div>

    <!-- Template Grid: Left Column Editor Container + Right Column Data Schema Sidebar -->
    <div class="template-grid">
      <!-- Editor Canvas Wrapper -->
      <div class="editor-container">

        <!-- Visual WYSIWYG Editor Canvas -->
        <div 
          v-show="activeEditorTab === 'visual'"
          ref="canvasRef"
          class="editor-textarea" 
          contenteditable="true"
          style="outline: none;"
          @input="syncVisualToCode"
          @keydown="onCanvasKeyDown"
          @keyup="onCanvasKeyUp"
          @paste="onCanvasPaste"
          @copy="onCanvasCopyOrCut"
          @cut="onCanvasCopyOrCut"
          @blur="saveSelection"
          @click="onCanvasClick"
          @mouseup="onCanvasMouseUp"
          @focus="onCanvasFocus"
        ></div>

        <!-- Code Raw Editor: line-number gutter + syntax-highlighted backdrop
             behind a transparent-text textarea (the textarea itself is the
             one and only place the real text lives — the backdrop is a
             purely visual, regenerated-on-every-keystroke layer, so a
             highlighting bug can never corrupt or lose content). -->
        <div v-show="activeEditorTab === 'code'" class="code-editor-wrapper">
          <div ref="codeGutterRef" class="code-gutter">
            <span v-for="n in linesCount" :key="n">{{ n }}</span>
          </div>
          <div class="code-editor-scroll-area">
            <pre ref="codeHighlightRef" class="code-highlight-backdrop" aria-hidden="true"><code v-html="highlightedCodeHtml"></code></pre>
            <textarea
              ref="textareaRef"
              class="editor-textarea code-editor-textarea"
              v-model="editorText"
              placeholder="Escriu o edita la teva plantilla Jinja2 en Markdown aquí..."
              spellcheck="false"
              @click="updateActiveLoopContext"
              @keyup="updateActiveLoopContext"
              @keydown="updateActiveLoopContext"
              @select="updateActiveLoopContext"
              @focus="updateActiveLoopContext"
              @input="updateActiveLoopContext"
              @scroll="onCodeScroll"
            ></textarea>
          </div>
        </div>
      </div>

      <!-- Variable Clipboard Helper (Sidebar) -->
      <div class="variables-sidebar">
      <div class="variables-title">Esquema de Dades</div>

      <!-- Manual Template Verification Trigger Card -->
      <div style="background: var(--bg-tertiary); border: 1px solid var(--border-color); padding: 8px 10px; border-radius: var(--radius-sm); margin-bottom: 0.5rem; display: flex; flex-direction: column; gap: 6px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span style="font-size: 0.72rem; font-weight: 700; color: var(--text-primary);">Verificació de Plantilla</span>
          <span v-if="hasCheckedTemplate" :style="{ color: undefinedVariablesList.length === 0 ? '#10b981' : '#d97706' }" style="font-size: 0.68rem; font-weight: 700;">
            {{ undefinedVariablesList.length === 0 ? '✓ Sense errors' : `⚠️ ${undefinedVariablesList.length} d'errors` }}
          </span>
        </div>
        <button 
          type="button" 
          class="btn btn-secondary btn-sm" 
          style="font-size: 0.75rem; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; gap: 6px; width: 100%; padding: 5px 8px; background: var(--bg-card); color: var(--color-primary); border-color: var(--color-primary); cursor: pointer;"
          @click="checkTemplateVariables"
          title="Comprova totes les variables i bucles de la plantilla respecte a l'esquema de dades"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <span>Comprova Plantilla</span>
        </button>
      </div>
      
      <!-- Warning Card for Undefined Variables in Template -->
      <div v-if="undefinedVariablesList.length > 0" style="background-color: var(--color-warning-light, #fffbeb); border: 1px solid var(--color-warning, #f59e0b); padding: 0.5rem; border-radius: var(--radius-sm); margin-bottom: 0.5rem; display: flex; flex-direction: column; gap: 0.35rem;">
        <div style="font-size: 0.7rem; font-weight: 700; color: var(--color-warning-hover, #d97706); display: flex; align-items: center; justify-content: space-between;">
          <span style="display: flex; align-items: center; gap: 4px;">
            ⚠️ {{ undefinedVariablesList.length }} {{ undefinedVariablesList.length === 1 ? 'variable no trobada' : 'variables no trobades' }}
          </span>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 3px; max-height: 90px; overflow-y: auto;">
          <span 
            v-for="uVar in undefinedVariablesList" 
            :key="uVar" 
            style="font-size: 0.65rem; font-family: var(--font-mono); background: #fef3c7; color: #92400e; border: 1px solid #f59e0b; padding: 1px 4px; border-radius: 3px; font-weight: 600; cursor: help;"
            :title="`⚠️ La variable '${uVar}' està inserida a la plantilla però no existeix a l'esquema de dades`"
          >
            ⚠️ {{ uVar }}
          </span>
        </div>
      </div>
      
      <!-- Active Loop Stack Cards (ordered by depth: innermost loop first) -->
      <div v-for="(ctx, idx) in activeLoopStack" :key="ctx.iterator + idx" style="background-color: var(--color-primary-light); padding: 0.5rem; border-radius: var(--radius-sm); border: 1px solid var(--border-focus); margin-bottom: 0.5rem; display: flex; flex-direction: column; gap: 0.35rem;">
        <div style="font-size: 0.68rem; font-weight: bold; color: var(--color-primary); text-transform: uppercase; display: flex; align-items: center; justify-content: space-between;">
          <span style="display: flex; align-items: center; gap: 4px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            Iterador #{{ idx + 1 }}: {{ ctx.iterator }}
          </span>
          <span class="variable-badge present" style="background-color: var(--color-primary); color: white; font-size: 0.58rem;">for {{ ctx.iterator }} in {{ ctx.arrayPath }}</span>
        </div>
        
        <div style="display:flex; flex-direction:column; gap:0.25rem; margin-top:0.2rem;">
          <!-- Primitive fields of active iterator -->
          <div 
            v-for="col in ctx.columns" 
            :key="col"
            class="variable-item present"
            style="background-color: var(--bg-card); margin: 0; font-size: 0.72rem; padding: 2px 6px; justify-content: space-between;"
            @click="sidebarCopyInsert(`{{ ${ctx.iterator}.${col} }}`)"
            :title="`Insereix variable ${ctx.iterator}.${col}`"
          >
            <span style="font-weight: 600;" :title="ctx.iterator + '.' + col">{{ getFieldCustomLabel(col) }}</span>
            <span class="variable-badge present" style="font-size:0.58rem; background-color: var(--color-primary); color: white;">{{ ctx.iterator }}.{{ col }}</span>
          </div>

          <!-- Child Sub-Arrays for active iterator (if any) -->
          <div 
            v-for="subArray in getSubArraysForArray(ctx.arrayPath)" 
            :key="subArray.key"
            class="variable-item present"
            style="background-color: var(--color-primary-light); margin: 2px 0 0 0; font-size: 0.72rem; padding: 3px 6px; justify-content: space-between;"
            @click="sidebarInsertLoop(subArray.key, `${ctx.iterator}.${subArray.key}`, subArray.iteratorName, subArray.fields)"
            :title="`Insereix bucle d'iteració per a ${ctx.iterator}.${subArray.key}`"
          >
            <span style="font-weight: 700; color: var(--color-primary);">Itera {{ ctx.iterator }}.{{ subArray.key }}</span>
            <span class="variable-badge present" style="background-color: var(--color-primary); color: white; font-size: 0.58rem;">Bucle</span>
          </div>
        </div>
      </div>

      <div v-if="!store.excelJsonData" style="font-size:0.75rem; color:var(--text-muted); font-style:italic">
        Carrega un Excel per generar la llista de variables disponibles.
      </div>
      <div v-else style="display:flex; flex-direction:column; gap:0.6rem; flex: 1; overflow-y: auto; min-height: 0;">
        <!-- Root Data Model Card -->
        <div v-for="node in sidebarTree" :key="node.name" style="margin-bottom:0.5rem;">
          <div style="font-size: 0.78rem; font-weight: 700; color: var(--text-secondary); margin-bottom: 0.25rem; border-bottom: 1px solid var(--border-color); padding-bottom: 2px;">
            Model: {{ node.name }}
          </div>
          
          <!-- Top-level Primitive Keys -->
          <div 
            v-for="f in node.fields" 
            :key="typeof f === 'string' ? f : f.fullPath" 
            class="variable-item present"
            style="margin-bottom: 0.25rem;"
            @click="sidebarCopyInsert(`{{ ${typeof f === 'string' ? node.name + '.' + f : f.fullPath} }}`)"
            title="Clica per copiar i inserir variable"
          >
            <span :title="typeof f === 'string' ? f : f.key">{{ getFieldCustomLabel(typeof f === 'string' ? f : f.key) }}</span>
            <span class="variable-badge present">Clau</span>
          </div>

          <!-- Top-level Sub-Arrays (e.g. parts) -->
          <div v-for="sub in node.subArrays" :key="sub.key" style="margin-top: 0.3rem;">
            <div 
              class="variable-item present"
              style="background-color: var(--color-primary-light); padding: 3px 6px;"
              @click="sidebarInsertLoop(sub.key, sub.fullPath, sub.iteratorName, sub.fields)"
              title="Clica per copiar i inserir bucle Jinja"
            >
              <span style="font-weight: 700; color: var(--color-primary);">Itera {{ sub.key }}</span>
              <span class="variable-badge present" style="background-color: var(--color-primary); color: white; font-size: 0.58rem;">Bucle</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 1. Variable Configuration Modal -->
    <div class="modal-overlay" :style="{ display: isVarModalOpen ? 'flex' : 'none' }">
      <div class="modal-content" style="max-width: 500px; width: 95%;">
        <div class="modal-header">
          <h3 style="border: none; padding-bottom: 0; margin: 0;">{{ modalTitle }}</h3>
          <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem;" @click="isVarModalOpen = false">&times;</button>
        </div>
        <div class="modal-body" style="display: flex; flex-direction: column; gap: 1rem;">
          <div class="form-row">
            <label style="font-weight: bold; font-size: 0.8rem; margin-bottom: 4px; display: block;">Ruta de la Variable</label>
            <input type="text" v-model="modalExpr" placeholder="meta.expedient" style="font-family: var(--font-mono); width: 100%; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border-color); font-size: 0.85rem;">
          </div>

          <div class="form-row">
            <label style="font-weight: bold; font-size: 0.8rem; margin-bottom: 4px; display: block;">Filtre Jinja2 (Opcional)</label>
            <select v-model="selectedFilterType" style="width: 100%; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border-color); font-size: 0.85rem; background: var(--bg-primary); color: var(--text-primary);">
              <option value="">-- Sense filtre --</option>
              <optgroup label="Formats Numèrics i Moneda">
                <option value="coin">💶 coin — Format Moneda (ex: 15.250,50 €)</option>
                <option value="number">🔢 number — Format Numèric (ex: 15.250,50)</option>
                <option value="words">🔤 words — Número a Text en Català (ex: 3 -> tres)</option>
              </optgroup>
              <optgroup label="Gramàtica i Text en Català">
                <option value="prefix">🔤 prefix — Apostrofació Automàtica (de / d')</option>
                <option value="upper">🔠 upper — Tot Majúscules</option>
                <option value="lower">🔡 lower — Tot Minúscules</option>
                <option value="capitalize">Capitalize — Primera lletra majúscula</option>
                <option value="title">Title — Majúscula per cada paraula</option>
                <option value="replace">🔄 replace — Reemplaçar text</option>
                <option value="trim">✂️ trim — Eliminar espais en blanc</option>
              </optgroup>
              <optgroup label="Control i Altres">
                <option value="default">❓ default — Valor alternatiu si està buit</option>
                <option value="length">📏 length — Comptar caràcters o elements</option>
                <option value="custom">✏️ custom — Personalitzat / Codi lliure</option>
              </optgroup>
            </select>
          </div>

          <!-- Parameter Inputs Based on Selected Filter -->
          <div v-if="selectedFilterType === 'prefix'" style="padding: 10px; background: var(--bg-tertiary, #f8f9fa); border-radius: 6px; border: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 8px;">
            <div style="font-size: 0.75rem; font-weight: bold; color: var(--color-primary);">PARÀMETRES D'APOSTROFACIÓ</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
              <div>
                <label style="font-size: 0.7rem; color: var(--text-muted); display: block;">Prefix Normal</label>
                <input type="text" v-model="filterParamFallback" placeholder="de" style="width: 100%; padding: 4px 8px; font-size: 0.8rem; font-family: var(--font-mono);">
              </div>
              <div>
                <label style="font-size: 0.7rem; color: var(--text-muted); display: block;">Prefix Apostrofat</label>
                <input type="text" v-model="filterParamElided" placeholder="d'" style="width: 100%; padding: 4px 8px; font-size: 0.8rem; font-family: var(--font-mono);">
              </div>
            </div>
          </div>

          <div v-if="selectedFilterType === 'default'" style="padding: 10px; background: var(--bg-tertiary, #f8f9fa); border-radius: 6px; border: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 8px;">
            <div style="font-size: 0.75rem; font-weight: bold; color: var(--color-primary);">VALOR PER DEFECTE</div>
            <div>
              <label style="font-size: 0.7rem; color: var(--text-muted); display: block;">Text o valor si la variable és buida</label>
              <input type="text" v-model="filterParamDefault" placeholder="Sense dades" style="width: 100%; padding: 4px 8px; font-size: 0.8rem; font-family: var(--font-mono);">
            </div>
          </div>

          <div v-if="selectedFilterType === 'replace'" style="padding: 10px; background: var(--bg-tertiary, #f8f9fa); border-radius: 6px; border: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 8px;">
            <div style="font-size: 0.75rem; font-weight: bold; color: var(--color-primary);">PARÀMETRES DE REEMPLAÇAMENT</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
              <div>
                <label style="font-size: 0.7rem; color: var(--text-muted); display: block;">Text a Cerca</label>
                <input type="text" v-model="filterParamReplaceOld" placeholder="Text vell" style="width: 100%; padding: 4px 8px; font-size: 0.8rem; font-family: var(--font-mono);">
              </div>
              <div>
                <label style="font-size: 0.7rem; color: var(--text-muted); display: block;">Nou Text</label>
                <input type="text" v-model="filterParamReplaceNew" placeholder="Nou text" style="width: 100%; padding: 4px 8px; font-size: 0.8rem; font-family: var(--font-mono);">
              </div>
            </div>
          </div>

          <div v-if="selectedFilterType === 'custom'" style="padding: 10px; background: var(--bg-tertiary, #f8f9fa); border-radius: 6px; border: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 8px;">
            <div style="font-size: 0.75rem; font-weight: bold; color: var(--color-primary);">FILTRE PERSONALITZAT / COMBINAT</div>
            <input type="text" v-model="filterCustomText" placeholder="upper | default('N/A')" style="width: 100%; padding: 4px 8px; font-size: 0.8rem; font-family: var(--font-mono);">
          </div>

          <!-- Live Code Preview -->
          <div style="padding: 8px 12px; background: rgba(0, 122, 255, 0.08); border: 1px solid rgba(0, 122, 255, 0.2); border-radius: 6px; display: flex; align-items: center; justify-content: space-between;">
            <span style="font-size: 0.72rem; font-weight: bold; color: var(--color-primary); text-transform: uppercase;">Vista Prèvia Jinja2:</span>
            <code style="font-family: var(--font-mono); font-size: 0.82rem; font-weight: bold; color: var(--text-primary);">&#123;&#123; {{ modalExpr || 'variable' }}{{ computedModalFilter ? ' | ' + computedModalFilter : '' }} &#125;&#125;</code>
          </div>
        </div>
        <div class="modal-footer" style="margin-top: 1rem;">
          <button class="btn btn-secondary" style="width: auto;" @click="isVarModalOpen = false">Cancel·lar</button>
          <button class="btn btn-primary" style="width: auto;" @click="applyVariable">Aplicar</button>
        </div>
      </div>
    </div>

    <!-- 2. Logic Block Configuration Modal -->
    <BlockModal
      ref="blockModalRef"
      v-model="isBlockModalOpen"
      :block-type="blockType"
      :title="modalTitle"
      :initial-expr="blockModalInitialExpr"
      :initial-for-item-var="blockModalInitialForItemVar"
      :initial-for-array-var="blockModalInitialForArrayVar"
      :available-variables="availableVariables"
      :available-arrays="availableArrays"
      @apply="onBlockApply"
    />

    <!-- 3. Math Equation Configuration Modal -->
    <MathModal
      ref="mathModalRef"
      v-model="isMathModalOpen"
      :initial-expr="mathModalInitialExpr"
      :initial-type="mathModalInitialType"
      :active-loop-context="activeLoopContext"
      @apply="onMathApply"
    />

    <!-- 4. Table Configuration Modal -->
    <TableModal
      ref="tableModalRef"
      v-model="isTableModalOpen"
      :is-editing="tableModalIsEditing"
      :initial-config="tableModalInitialConfig"
      :available-arrays="availableArrays"
      :resolve-path="resolvePath"
      :resolve-field-label="resolveFieldLabel"
      @apply="onTableApply"
    />

    <!-- Pandoc Metadata Modal -->
    <MetadataModal
      ref="metadataModalRef"
      v-model="isMetadataModalOpen"
      :template-text="store.templateText"
      @apply="onMetadataApply"
    />

    <!-- Special Characters Modal -->
    <SpecialCharPickerModal
      v-model="isSpecialCharModalOpen"
      :categories="specialCharCategories"
      @select="insertSpecialChar"
    />

  </div>
  </div>
</template>

<style>
/* Visual Heading Level Badges for WYSIWYG Editor */
.editor-textarea h1,
.editor-textarea h2,
.editor-textarea h3,
.editor-textarea h4,
.editor-textarea h5,
.editor-textarea h6 {
  position: relative;
  line-height: 1.4;
  margin: 1.5em 0 0.6em 0;
}

.editor-textarea h1:first-child,
.editor-textarea h2:first-child,
.editor-textarea h3:first-child,
.editor-textarea h4:first-child,
.editor-textarea h5:first-child,
.editor-textarea h6:first-child {
  margin-top: 0;
}

.editor-textarea p {
  margin: 0.75em 0;
}

.editor-textarea p:first-child {
  margin-top: 0;
}

.editor-textarea p:last-child {
  margin-bottom: 0;
}

/* Code editor: line-number gutter + syntax-highlight backdrop. The gutter
   and the highlighted <pre> are purely visual — the real, only copy of the
   text lives in the (transparent-text) textarea layered on top, so nothing
   here can ever corrupt or lose content, only mis-color it in an edge case. */
.code-editor-wrapper {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
  background-color: var(--bg-card);
}

.code-gutter {
  flex: 0 0 auto;
  overflow: hidden;
  padding: 1rem 0.6rem 1rem 0;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 0.9rem;
  line-height: 1.6;
  color: var(--text-muted);
  background-color: var(--bg-tertiary);
  border-right: 1px solid var(--border-color);
  user-select: none;
}

.code-gutter span {
  display: block;
}

.code-editor-scroll-area {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.code-highlight-backdrop {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: 1rem;
  font-family: var(--font-mono);
  font-size: 0.9rem;
  line-height: 1.6;
  white-space: pre;
  overflow: hidden;
  pointer-events: none;
  color: var(--text-primary);
}

.code-highlight-backdrop code {
  font-family: inherit;
  background: none;
}

/* Line numbers require each source line to occupy exactly one visual row,
   so wrapping is off here (standard for code editors) — long lines scroll
   horizontally instead, kept in sync with the backdrop above. */
.editor-textarea.code-editor-textarea {
  position: relative;
  z-index: 1;
  background: transparent;
  color: transparent;
  caret-color: var(--text-primary);
  white-space: pre;
  overflow: auto;
  resize: none;
  width: 100%;
  height: 100%;
}

[data-theme="dark"] .editor-textarea.code-editor-textarea,
body.dark-theme .editor-textarea.code-editor-textarea {
  background-color: transparent !important;
  color: transparent !important;
  caret-color: #f8fafc !important;
}

.tok-comment { color: var(--text-muted); font-style: italic; }
.tok-jinja-block { color: #b45309; font-weight: 600; }
.tok-jinja-var { color: var(--color-primary); font-weight: 600; }
.tok-math { color: #7c3aed; font-weight: 600; }
.tok-header { color: var(--text-primary); font-weight: 700; }
.tok-bold { font-weight: 700; }
.tok-italic { font-style: italic; }

.editor-textarea h1::before {
  content: "H1";
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.65rem;
  font-weight: 800;
  font-family: var(--font-mono, monospace);
  background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
  color: #ffffff;
  padding: 1px 6px;
  border-radius: 4px;
  margin-right: 8px;
  vertical-align: middle;
  user-select: none;
  pointer-events: none;
  box-shadow: 0 1px 2px rgba(0,0,0,0.15);
}

.editor-textarea h2::before {
  content: "H2";
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.65rem;
  font-weight: 800;
  font-family: var(--font-mono, monospace);
  background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
  color: #ffffff;
  padding: 1px 6px;
  border-radius: 4px;
  margin-right: 8px;
  vertical-align: middle;
  user-select: none;
  pointer-events: none;
  box-shadow: 0 1px 2px rgba(0,0,0,0.15);
}

.editor-textarea h3::before {
  content: "H3";
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.65rem;
  font-weight: 800;
  font-family: var(--font-mono, monospace);
  background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%);
  color: #ffffff;
  padding: 1px 6px;
  border-radius: 4px;
  margin-right: 8px;
  vertical-align: middle;
  user-select: none;
  pointer-events: none;
  box-shadow: 0 1px 2px rgba(0,0,0,0.15);
}

.editor-textarea h4::before {
  content: "H4";
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.65rem;
  font-weight: 800;
  font-family: var(--font-mono, monospace);
  background: linear-gradient(135deg, #16a34a 0%, #15803d 100%);
  color: #ffffff;
  padding: 1px 6px;
  border-radius: 4px;
  margin-right: 8px;
  vertical-align: middle;
  user-select: none;
  pointer-events: none;
  box-shadow: 0 1px 2px rgba(0,0,0,0.15);
}

.editor-textarea h5::before {
  content: "H5";
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.65rem;
  font-weight: 800;
  font-family: var(--font-mono, monospace);
  background: linear-gradient(135deg, #d97706 0%, #b45309 100%);
  color: #ffffff;
  padding: 1px 6px;
  border-radius: 4px;
  margin-right: 8px;
  vertical-align: middle;
  user-select: none;
  pointer-events: none;
  box-shadow: 0 1px 2px rgba(0,0,0,0.15);
}

.editor-textarea h6::before {
  content: "H6";
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.65rem;
  font-weight: 800;
  font-family: var(--font-mono, monospace);
  background: linear-gradient(135deg, #4b5563 0%, #374151 100%);
  color: #ffffff;
  padding: 1px 6px;
  border-radius: 4px;
  margin-right: 8px;
  vertical-align: middle;
  user-select: none;
  pointer-events: none;
  box-shadow: 0 1px 2px rgba(0,0,0,0.15);
}

/* Local overrides for visual blocks in editor contenteditable */
.j-var-chip {
  display: inline-flex;
  align-items: center;
  background-color: var(--color-primary-light);
  color: var(--color-primary);
  border: 1px solid var(--border-focus);
  border-radius: 3px;
  padding: 0 4px;
  height: 18px;
  line-height: 18px;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 600;
  margin: 0 2px;
  vertical-align: baseline;
  cursor: pointer;
  user-select: none;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  transition: all 0.15s ease;
}

.j-var-chip:hover {
  background-color: var(--color-primary);
  color: white;
}

.j-var-chip.undefined-var {
  background-color: #fffbeb !important;
  color: #d97706 !important;
  border: 1.5px solid #f59e0b !important;
  box-shadow: 0 0 4px rgba(245, 158, 11, 0.3);
}

.j-var-chip.undefined-var:hover {
  background-color: #f59e0b !important;
  color: #ffffff !important;
}

.j-var-chip .warn-icon {
  margin-right: 3px;
  font-size: 0.78rem;
  vertical-align: middle;
}

.latex-chip {
  cursor: pointer;
  user-select: none;
}

.latex-chip.inline-math {
  display: inline-flex;
  align-items: center;
  background-color: var(--color-warning-light);
  border: 1px solid var(--color-warning);
  color: #b45309;
  padding: 0 4px;
  height: 18px;
  line-height: 18px;
  border-radius: 3px;
  font-size: 0.72rem;
  font-weight: 600;
  margin: 0 2px;
  vertical-align: baseline;
}

.latex-chip.display-math {
  display: block;
  background-color: var(--color-warning-light);
  border: 2px solid var(--color-warning);
  color: #b45309;
  padding: 0.75rem;
  border-radius: 6px;
  margin: 1rem auto;
  text-align: center;
  width: fit-content;
  max-width: 90%;
}

.jinja-block {
  border: 1.5px solid var(--border-color);
  border-left: 4px solid var(--color-primary, #0284c7);
  border-radius: 6px;
  margin: 1.5rem 0 1.25rem 0;
  background-color: var(--bg-card);
  display: flex;
  flex-direction: column;
  position: relative;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.jinja-block[data-type="if"] {
  border-left-color: #d97706;
}

.jinja-block[data-type="for"] {
  border-left-color: var(--color-primary, #0284c7);
}

.jinja-block:hover {
  border-color: rgba(2, 132, 199, 0.4);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
}

.jinja-block.inline {
  display: inline-flex !important;
  flex-direction: row !important;
  align-items: center;
  border: 1px dashed var(--color-primary, #0284c7) !important;
  padding: 1px 4px !important;
  border-radius: 6px !important;
  background-color: rgba(2, 132, 199, 0.03) !important;
  margin: 0 4px !important;
  vertical-align: middle;
}

.jinja-block.inline .j-content {
  padding: 0 4px !important;
  min-height: auto !important;
  background-color: transparent !important;
  display: inline-block !important;
  outline: none;
}

.j-inline-tag {
  background-color: rgba(2, 132, 199, 0.1);
  color: var(--color-primary, #0284c7);
  padding: 1px 4px;
  font-size: 0.75rem;
  font-weight: 700;
  border-radius: 4px;
  margin: 0 2px;
  font-family: var(--font-mono, monospace);
  user-select: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}

/* Inline if/for tags identify themselves by icon only — the literal
   "{% ... %}" text stays in the title tooltip instead of cluttering
   running text. */
.j-inline-tag-icon {
  display: inline-flex;
  align-items: center;
}

.j-inline-tag-text {
  display: none;
}

/* Toolbar (just the switch-to-block button) for an inline block, tucked
   away below the element and revealed only while the cursor is inside it. */
.j-inline-toolbar {
  display: none;
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  background-color: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 3px 6px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
  z-index: 5;
  white-space: nowrap;
}

.jinja-block.inline:focus-within .j-inline-toolbar {
  display: inline-flex;
}

.j-head {
  position: absolute;
  top: -13px;
  left: 12px;
  background-color: var(--bg-tertiary);
  color: var(--text-primary);
  padding: 1px 8px;
  height: 24px;
  font-size: 0.72rem;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.08);
  z-index: 2;
  user-select: none;
}

/* Collapsed by default: the block identifies itself by icon alone. The
   label, condition text and the action toolbar only appear while the
   cursor is inside the block, so the canvas isn't permanently cluttered
   with controls for every if/for on the page. */
.j-head > div:first-child > span {
  display: none;
}

.j-actions {
  display: none;
  align-items: center;
  gap: 4px;
}

.jinja-block:focus-within .j-head > div:first-child > span {
  display: inline;
}

.jinja-block:focus-within .j-actions {
  display: inline-flex;
}

.j-branch {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 1px;
  border-top: 1px dashed #d97706;
  margin: 14px 0 10px 0;
  background: transparent;
  user-select: none;
}

.j-branch > div:first-child {
  position: absolute;
  left: 12px;
  top: -12px;
  background-color: var(--bg-tertiary);
  color: #b45309;
  padding: 1px 8px;
  height: 22px;
  font-size: 0.7rem;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid #d97706;
  border-radius: 11px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.j-branch .btn-branch-trash {
  position: absolute;
  right: 12px;
  top: -10px;
}

.j-cond-text {
  font-family: var(--font-mono);
  background-color: rgba(0, 0, 0, 0.06);
  padding: 0 5px;
  border-radius: 4px;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  color: var(--color-primary);
}

.jinja-block[data-type="if"] .j-cond-text {
  color: #b45309;
}

.j-content {
  padding: 0.6rem 0.75rem;
  min-height: 26px;
  background-color: var(--bg-card);
  outline: none;
}

.j-footer {
  position: absolute;
  bottom: -10px;
  left: 12px;
  background-color: var(--bg-tertiary);
  color: var(--text-muted);
  padding: 0 6px;
  font-size: 0.62rem;
  font-weight: 700;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  height: 18px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  z-index: 2;
}

.j-btn-mini {
  padding: 0 4px;
  font-size: 0.65rem;
  font-weight: 700;
  border-radius: 4px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-primary);
  cursor: pointer;
  margin-left: 2px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  transition: all 0.15s ease;
}

.j-btn-mini:hover {
  filter: brightness(0.95);
  transform: translateY(-1px);
}

/* ==========================================================================
   High-Contrast Dark Mode Overrides for Visual Editor & Logic Elements
   ========================================================================== */
[data-theme="dark"] .editor-textarea,
body.dark-theme .editor-textarea {
  background-color: #111827 !important;
  color: #f8fafc !important;
}

[data-theme="dark"] .j-var-chip,
body.dark-theme .j-var-chip {
  background-color: rgba(14, 165, 233, 0.3) !important;
  color: #ffffff !important;
  border: 1.5px solid #38bdf8 !important;
  font-weight: 700 !important;
  box-shadow: 0 0 8px rgba(56, 189, 248, 0.4);
}

[data-theme="dark"] .j-var-chip:hover,
body.dark-theme .j-var-chip:hover {
  background-color: #38bdf8 !important;
  color: #0b0f19 !important;
}

[data-theme="dark"] .j-var-chip.undefined-var,
body.dark-theme .j-var-chip.undefined-var {
  background-color: rgba(245, 158, 11, 0.25) !important;
  color: #fbbf24 !important;
  border: 1.5px solid #f59e0b !important;
  font-weight: 700 !important;
  box-shadow: 0 0 8px rgba(245, 158, 11, 0.4) !important;
}

[data-theme="dark"] .j-var-chip.undefined-var:hover,
body.dark-theme .j-var-chip.undefined-var:hover {
  background-color: #f59e0b !important;
  color: #0f172a !important;
}

[data-theme="dark"] .jinja-block,
body.dark-theme .jinja-block {
  background-color: #161e2e !important;
  border-color: #334155 !important;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}

[data-theme="dark"] .jinja-block[data-type="if"],
body.dark-theme .jinja-block[data-type="if"] {
  border-left-color: #fbbf24 !important;
}

[data-theme="dark"] .jinja-block[data-type="for"],
body.dark-theme .jinja-block[data-type="for"] {
  border-left-color: #38bdf8 !important;
}

[data-theme="dark"] .j-head,
body.dark-theme .j-head {
  background-color: #1e293b !important;
  color: #ffffff !important;
  border-color: #475569 !important;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4) !important;
}

[data-theme="dark"] .j-branch,
body.dark-theme .j-branch {
  border-top-color: #fbbf24 !important;
}

[data-theme="dark"] .j-branch > div:first-child,
body.dark-theme .j-branch > div:first-child {
  background-color: #1e293b !important;
  color: #fef08a !important;
  border-color: #fbbf24 !important;
}

[data-theme="dark"] .j-cond-text,
body.dark-theme .j-cond-text {
  background-color: rgba(14, 165, 233, 0.3) !important;
  color: #ffffff !important;
  border: 1px solid #38bdf8 !important;
  font-weight: 700 !important;
}

[data-theme="dark"] .jinja-block[data-type="if"] .j-cond-text,
body.dark-theme .jinja-block[data-type="if"] .j-cond-text {
  background-color: rgba(245, 158, 11, 0.3) !important;
  color: #ffffff !important;
  border: 1px solid #fbbf24 !important;
  font-weight: 700 !important;
}

[data-theme="dark"] .j-inline-tag,
body.dark-theme .j-inline-tag {
  background-color: rgba(14, 165, 233, 0.3) !important;
  color: #ffffff !important;
  border: 1px solid #38bdf8 !important;
}

[data-theme="dark"] .j-content,
body.dark-theme .j-content {
  background-color: #161e2e !important;
  color: #f8fafc !important;
}

[data-theme="dark"] .j-footer,
body.dark-theme .j-footer {
  background-color: #1e293b !important;
  color: #e2e8f0 !important;
  border-color: #475569 !important;
}

[data-theme="dark"] .j-btn-mini,
body.dark-theme .j-btn-mini {
  background-color: #1e293b !important;
  color: #ffffff !important;
  border-color: #475569 !important;
}

[data-theme="dark"] .j-btn-mini:hover,
body.dark-theme .j-btn-mini:hover {
  background-color: #334155 !important;
}

.j-row-loop {
  outline: 2px solid var(--color-primary);
  background-color: var(--color-primary-light) !important;
}

.j-row-loop td:first-child::before {
  content: "🔁 FOR: " attr(data-jinja-for);
  display: block;
  font-size: 0.65rem;
  background: var(--color-primary);
  color: white;
  padding: 1px 4px;
  border-radius: 3px;
  margin-bottom: 4px;
  font-weight: bold;
}

table {
  border-collapse: collapse;
  width: 100%;
  margin: 1rem 0;
}

table th, table td {
  border: 1px solid var(--border-color);
  padding: 0.5rem;
  min-width: 40px;
}

table th {
  background-color: var(--bg-tertiary);
  font-weight: bold;
}

.j-totals-row td {
  font-weight: 700;
  border-top: 2px solid var(--border-color);
  background-color: var(--bg-tertiary);
}

/* Dedicated edit affordance for dynamic/transposed tables, sitting right
   above the table like a small attached tab — double-clicking the header
   also works, but a double-click is two single clicks first, which
   silently toggles that column's alignment twice as a side effect. */
.table-edit-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--color-primary);
  background-color: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  padding: 2px 8px;
  cursor: pointer;
  user-select: none;
  margin: 0.5rem 0 -1px 0;
}

.table-edit-btn:hover {
  background-color: var(--color-primary-light);
}

/* Only the header shows the loop-column badge — every body cell in a
   transposed table also carries data-jinja-col-loop (it's how the "which
   column loops" info round-trips to Markdown), but repeating the badge on
   every row added noise without new information. */
th[data-jinja-col-loop]::before {
  content: "🔄 LOOP COL: " attr(data-jinja-col-loop);
  display: block;
  font-size: 0.6rem;
  background-color: #8b5cf6;
  color: white;
  padding: 1px 4px;
  border-radius: 3px;
  margin-bottom: 4px;
  font-weight: bold;
  font-family: var(--font-sans);
}
</style>
