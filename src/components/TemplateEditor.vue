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
import { useMarkdownJinjaCompiler, htmlToMarkdown, splitTableLine, alignFromDivider, friendlyTotalLabel, TRANSPOSED_TABLE_RE, DYNAMIC_TABLE_RE } from '../composables/useMarkdownJinjaCompiler';
import { useWasmEngines } from '../composables/useWasmEngines';
import { useEditHistory } from '../composables/useEditHistory';
import { EditorState as CmEditorState, StateField as CmStateField, StateEffect as CmStateEffect } from '@codemirror/state';
import { EditorView as CmEditorView, keymap as CmKeymap, lineNumbers as CmLineNumbers, Decoration as CmDecoration, ViewPlugin as CmViewPlugin, WidgetType as CmWidgetType, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap as cmDefaultKeymap } from '@codemirror/commands';
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
const { previewExpression, validateTemplateSyntax } = useWasmEngines();
const activeEditorTab = ref('visual'); // 'visual' or 'code'

const editorText = ref(props.isCellMode ? (props.modelValue || '') : (store.templateText || props.modelValue || ''));

// Undo/redo history — ONE shared stack regardless of mode, since Visual and
// Codi both read/write the same editorText: an edit made from either tab
// pushes into the same stack, and Undo/Redo work no matter which tab is
// currently active. See useEditHistory.js for why this is a separate
// mechanism from useVersionHistory.js's hourly/manual checkpoints.
const editHistory = useEditHistory(editorText.value);
// Guards the watch(editorText, ...) below from re-pushing the very value
// undo()/redo() just applied back onto the stack as if it were a new edit
// (which would silently cancel the undo/redo the instant it happened).
let isApplyingHistory = false;

const undoEdit = () => {
  const prev = editHistory.undo();
  if (prev === undefined) return;
  isApplyingHistory = true;
  editorText.value = prev;
  nextTick(() => {
    syncCodeToVisual();
    isApplyingHistory = false;
  });
};

const redoEdit = () => {
  const next = editHistory.redo();
  if (next === undefined) return;
  isApplyingHistory = true;
  editorText.value = next;
  nextTick(() => {
    syncCodeToVisual();
    isApplyingHistory = false;
  });
};

// Watch props.modelValue if in cell mode
if (props.isCellMode) {
  watch(() => props.modelValue, (newVal) => {
    if (editorText.value !== newVal) {
      editorText.value = newVal || '';
      // A genuinely new external value means a *different* cell/field is
      // now being edited (openCellEditor() in DataInspector.vue) — undo
      // history from whatever was open before must never carry over.
      editHistory.reset(newVal || '');
      nextTick(() => {
        syncCodeToVisual();
      });
    }
  }, { immediate: true });

  watch(editorText, (newVal) => {
    emit('update:modelValue', newVal);
    if (!isApplyingHistory) editHistory.push(newVal);
  });
} else {
  // Main Template Mode: Single Source of Truth is store.templateText
  watch(() => store.templateText, (newVal) => {
    if (editorText.value !== newVal) {
      editorText.value = newVal || '';
      // Same reasoning as the cell-mode branch above: templateText changing
      // out from under us means a different document/project/version-history
      // restore just loaded, not an edit — reset, don't accumulate.
      editHistory.reset(newVal || '');
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
    if (!isApplyingHistory) editHistory.push(newVal);
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
// textareaRef is NOT a template ref here: it starts null, then
// createCodeMirrorView() (see the CodeMirror setup below) assigns it the
// textarea-shaped adapter object described there.
const textareaRef = ref(null);
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

// Filter chain: variables can carry several filters piped one after another
// ({{ x | trim | upper | default('N/A') }}), so the modal builds a list of
// steps instead of a single dropdown. Catalog covers elips' own Catalan
// formatting filters (coin/number/percent/words/prefix/sort/where/cert/fals,
// all registered in engine.py) plus the standard Jinja2 filters most useful
// in prose documents; anything not listed here can still be typed by hand
// via the 'custom' step, which round-trips through the parser below like
// any other step.
const ROUND_METHOD_OPTIONS = [
  { value: 'common', label: 'Comú (arrodoniment normal)' },
  { value: 'ceil', label: 'Sostre (sempre cap amunt)' },
  { value: 'floor', label: 'Terra (sempre cap avall)' },
];
const FILTER_CATALOG = [
  { name: 'coin', label: 'coin — Format Moneda (ex: 15.250,50 €)', group: 'Formats numèrics i moneda', params: [] },
  { name: 'number', label: 'number — Format Numèric', group: 'Formats numèrics i moneda', params: [{ key: 'precision', label: 'Decimals', type: 'number', default: '2' }] },
  { name: 'percent', label: 'percent — Format Percentatge', group: 'Formats numèrics i moneda', params: [{ key: 'precision', label: 'Decimals', type: 'number', default: '2' }] },
  { name: 'words', label: 'words — Número a Text en Català (ex: 3 -> tres)', group: 'Formats numèrics i moneda', params: [] },
  { name: 'round', label: 'round — Arrodoneix un número', group: 'Formats numèrics i moneda', params: [{ key: 'precision', label: 'Decimals', type: 'number', default: '0' }, { key: 'method', label: 'Mètode', type: 'select', options: ROUND_METHOD_OPTIONS, default: 'common' }] },
  { name: 'abs', label: 'abs — Valor absolut', group: 'Formats numèrics i moneda', params: [] },
  { name: 'int', label: 'int — Converteix a número enter', group: 'Formats numèrics i moneda', params: [{ key: 'default', label: 'Valor si no es pot convertir', type: 'number', default: '0' }] },
  { name: 'float', label: 'float — Converteix a número decimal', group: 'Formats numèrics i moneda', params: [{ key: 'default', label: 'Valor si no es pot convertir', type: 'number', default: '0' }] },

  { name: 'prefix', label: "prefix — Apostrofació Automàtica (de / d')", group: 'Gramàtica i text en català', params: [{ key: 'fallback', label: 'Prefix Normal', default: 'de' }, { key: 'elided', label: "Prefix Apostrofat", default: "d'" }] },
  { name: 'cert', label: 'cert — Interpreta com a booleà CERT', group: 'Gramàtica i text en català', params: [] },
  { name: 'fals', label: 'fals — Interpreta com a booleà FALS', group: 'Gramàtica i text en català', params: [] },
  { name: 'upper', label: 'upper — Tot Majúscules', group: 'Gramàtica i text en català', params: [] },
  { name: 'lower', label: 'lower — Tot Minúscules', group: 'Gramàtica i text en català', params: [] },
  { name: 'capitalize', label: 'capitalize — Primera lletra majúscula', group: 'Gramàtica i text en català', params: [] },
  { name: 'title', label: 'title — Majúscula per cada paraula', group: 'Gramàtica i text en català', params: [] },
  { name: 'trim', label: 'trim — Eliminar espais en blanc', group: 'Gramàtica i text en català', params: [] },
  { name: 'replace', label: 'replace — Reemplaçar text', group: 'Gramàtica i text en català', params: [{ key: 'old', label: 'Text a Cercar', default: '' }, { key: 'new', label: 'Nou Text', default: '' }, { key: 'count', label: 'Màxim de reemplaços (buit = tots)', type: 'number', default: '', omitIfEmpty: true }] },
  { name: 'truncate', label: 'truncate — Escurça el text', group: 'Gramàtica i text en català', params: [{ key: 'length', label: 'Longitud màxima', type: 'number', default: '255' }, { key: 'end', label: 'Sufix', default: '...' }, { key: 'killwords', label: 'Talla paraules a mig camí', type: 'boolean', default: false }] },
  { name: 'wordwrap', label: 'wordwrap — Ajusta salts de línia', group: 'Gramàtica i text en català', params: [{ key: 'width', label: 'Amplada (caràcters)', type: 'number', default: '79' }, { key: 'break_long_words', label: 'Talla paraules més llargues que l\'amplada', type: 'boolean', default: true }] },
  { name: 'striptags', label: 'striptags — Elimina etiquetes HTML', group: 'Gramàtica i text en català', params: [] },
  { name: 'wordcount', label: 'wordcount — Compta paraules', group: 'Gramàtica i text en català', params: [] },

  { name: 'sort', label: 'sort — Ordena una llista', group: 'Llistes i sub-taules', params: [{ key: 'by', label: "Camp (buit = pel valor; '-camp' per ordre descendent)", default: '' }] },
  { name: 'where', label: 'where — Filtra registres per criteri', group: 'Llistes i sub-taules', params: [{ key: 'raw', label: "Criteri (ex: actiu=True)", raw: true }] },
  { name: 'length', label: 'length — Compta caràcters o elements', group: 'Llistes i sub-taules', params: [] },
  { name: 'first', label: 'first — Primer element', group: 'Llistes i sub-taules', params: [] },
  { name: 'last', label: 'last — Últim element', group: 'Llistes i sub-taules', params: [] },
  { name: 'join', label: 'join — Uneix una llista en text', group: 'Llistes i sub-taules', params: [{ key: 'd', label: 'Separador', default: ', ' }, { key: 'attribute', label: 'Camp a extreure (buit = element sencer)', default: '', omitIfEmpty: true }] },
  { name: 'min', label: 'min — Valor mínim', group: 'Llistes i sub-taules', params: [{ key: 'attribute', label: 'Camp a comparar (buit = el valor)', default: '', omitIfEmpty: true }] },
  { name: 'max', label: 'max — Valor màxim', group: 'Llistes i sub-taules', params: [{ key: 'attribute', label: 'Camp a comparar (buit = el valor)', default: '', omitIfEmpty: true }] },
  { name: 'sum', label: 'sum — Suma els valors', group: 'Llistes i sub-taules', params: [{ key: 'attribute', label: 'Camp a sumar (buit = el valor)', default: '', omitIfEmpty: true }, { key: 'start', label: 'Valor inicial', type: 'number', default: '0' }] },
  { name: 'unique', label: 'unique — Elimina duplicats', group: 'Llistes i sub-taules', params: [{ key: 'attribute', label: 'Camp a comparar (buit = el valor)', default: '', omitIfEmpty: true }] },
  { name: 'reverse', label: "reverse — Inverteix l'ordre", group: 'Llistes i sub-taules', params: [] },

  { name: 'default', label: 'default — Valor alternatiu si està buit', group: 'Control i altres', params: [{ key: 'default_value', label: 'Text o valor si la variable és buida', default: 'Sense dades' }, { key: 'boolean', label: "També si el valor és fals/0/buit (no només indefinit)", type: 'boolean', default: false }] },
  { name: 'string', label: 'string — Converteix a text', group: 'Control i altres', params: [] },
  { name: 'safe', label: 'safe — No escapar HTML', group: 'Control i altres', params: [] },
  { name: 'custom', label: 'Lliure — escriu el filtre manualment', group: 'Control i altres', params: [{ key: 'raw', label: 'Filtre complet (nom i arguments)', placeholder: "selectattr('actiu')", raw: true }] },
];
const FILTER_GROUPS = ['Formats numèrics i moneda', 'Gramàtica i text en català', 'Llistes i sub-taules', 'Control i altres'];
const FILTER_DEFS = Object.fromEntries(FILTER_CATALOG.map(f => [f.name, f]));
const groupedFilterCatalog = FILTER_GROUPS.reduce((acc, g) => {
  acc[g] = FILTER_CATALOG.filter(f => f.group === g);
  return acc;
}, {});
const filterParamDefs = (name) => FILTER_DEFS[name]?.params || [];

const filterChain = ref([]); // [{ id, name, params: {...} }]
let filterChainIdSeq = 0;

const paramDefaultForUi = (p) => (p.type === 'boolean' ? p.default === true : (p.default ?? ''));

const onFilterStepNameChange = (item) => {
  const params = {};
  filterParamDefs(item.name).forEach((p) => { params[p.key] = paramDefaultForUi(p); });
  item.params = params;
};

const addFilterChainStep = () => {
  filterChain.value.push({ id: ++filterChainIdSeq, name: '', params: {} });
};

const removeFilterChainStep = (id) => {
  filterChain.value = filterChain.value.filter((f) => f.id !== id);
};

const moveFilterChainStep = (id, dir) => {
  const idx = filterChain.value.findIndex((f) => f.id === id);
  const newIdx = idx + dir;
  if (idx < 0 || newIdx < 0 || newIdx >= filterChain.value.length) return;
  const arr = filterChain.value.slice();
  [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
  filterChain.value = arr;
};

// A param's JS value -> the Jinja2/Python literal text it's written as.
// Keyword args (key=literal) are used for every multi-param filter, rather
// than positional ones: the keyword name IS the underlying Python
// function's real parameter name (kept in sync with engine.py/Jinja2's own
// filter signatures), so params can be added/reordered in the catalog
// without the meaning of an existing template silently shifting to a
// different position — and it lets a boolean/select param stay unambiguous
// without inventing a placeholder value for every earlier positional slot.
const formatParamLiteral = (v, p) => {
  if (p.type === 'number') return String(v);
  if (p.type === 'boolean') return (v === true || v === 'true') ? 'True' : 'False';
  return `'${String(v).replace(/'/g, "\\'")}'`;
};

const buildFilterExprForStep = (item) => {
  const def = FILTER_DEFS[item.name];
  if (!def) return '';
  if (item.name === 'custom') return (item.params.raw || '').trim();
  if (!def.params || def.params.length === 0) return item.name;
  if (def.params.length === 1 && def.params[0].raw) {
    const v = (item.params[def.params[0].key] ?? '').trim();
    return v ? `${item.name}(${v})` : item.name;
  }
  const argParts = [];
  def.params.forEach((p) => {
    const raw = item.params[p.key];
    const isEmpty = raw === undefined || raw === null || raw === '';
    // omitIfEmpty params (e.g. join's optional `attribute`) map to Jinja2's
    // own None default when left blank — emitting an explicit '' instead
    // would be a different, wrong value (Jinja2 would try `getattr(x, '')`
    // rather than "no attribute at all"), so the kwarg is skipped entirely.
    if (isEmpty && p.omitIfEmpty) return;
    const v = isEmpty ? (p.default ?? '') : raw;
    argParts.push(`${p.key}=${formatParamLiteral(v, p)}`);
  });
  return `${item.name}(${argParts.join(', ')})`;
};

const computedModalFilter = computed(() => {
  return filterChain.value
    .map(buildFilterExprForStep)
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(' | ');
});

// Splits a "filter1 | filter2(args)" string on its top-level '|'/','
// separators only, ignoring any that appear inside quoted strings or
// parentheses (e.g. replace('a, b', 'c') or a where() criteria containing
// a comma) — a small hand-rolled scanner rather than a real parser, but
// filter arguments in practice are always this simple.
const splitTopLevel = (s, sep) => {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '(') { depth++; cur += c; continue; }
    if (c === ')') { depth--; cur += c; continue; }
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '' || parts.length > 0) parts.push(cur);
  return parts.map((p) => p.trim());
};

const parseParamLiteral = (raw, p) => {
  if (p.type === 'boolean') return /^true$/i.test(raw);
  if (p.type === 'number') return raw;
  const qm = raw.match(/^(['"])([\s\S]*)\1$/);
  return qm ? qm[2] : raw;
};

const parseFilterStep = (piece) => {
  const m = piece.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\((.*)\))?$/s);
  if (!m || !FILTER_DEFS[m[1]]) return { id: ++filterChainIdSeq, name: 'custom', params: { raw: piece } };
  const name = m[1];
  const def = FILTER_DEFS[name];
  const argsStr = m[2] !== undefined ? m[2] : null;
  if (!def.params || def.params.length === 0) return { id: ++filterChainIdSeq, name, params: {} };
  if (def.params.length === 1 && def.params[0].raw) {
    return { id: ++filterChainIdSeq, name, params: { [def.params[0].key]: argsStr ?? '' } };
  }

  const params = {};
  def.params.forEach((p) => { params[p.key] = paramDefaultForUi(p); });

  // Accepts BOTH the keyword-argument style this modal now writes
  // (name='X') and plain positional args (how earlier versions of this
  // modal wrote them, or how anyone hand-typing Jinja2 would) — a
  // positional arg is assigned to whichever param sits at that same index
  // in the catalog, exactly like calling the underlying Python function.
  splitTopLevel(argsStr || '', ',').forEach((part, i) => {
    if (!part) return;
    const kw = part.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([\s\S]*)$/);
    const matchedParam = kw && def.params.find((p) => p.key === kw[1]);
    const p = matchedParam || def.params[i];
    if (!p) return;
    const rawVal = matchedParam ? kw[2] : part;
    params[p.key] = parseParamLiteral(rawVal.trim(), p);
  });

  return { id: ++filterChainIdSeq, name, params };
};

const parseFilterChainFromRaw = (raw) => {
  if (!raw) return [];
  return splitTopLevel(raw, '|').filter(Boolean).map(parseFilterStep);
};

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
// {from, to} of the exact "$...$"/"$$...$$" span being edited via a Phase E
// InlineMathWidget/DisplayMathWidget double-click, or null when inserting a
// fresh formula -- same pattern as activeVarChipRange/activeBlockEditRange.
let activeMathEditRange = null;

// Table Configuration Modal State
// Table modal: form state (mode/columns/array/iterator) lives in
// TableModal.vue; only the "which canvas node am I editing" pointer and the
// config used to initialize the modal's form on open stay here.
const tableModalInitialConfig = ref({});
const tableModalIsEditing = ref(false);
let activeEditTableNode = null;
// {from, to} of the exact table TEXT SPAN being edited via a Phase F
// TableWidget's "Edita taula" button, or null when inserting a brand new
// table at the cursor -- same pattern as activeVarChipRange/
// activeBlockEditRange/activeMathEditRange.
let activeTableEditRange = null;

// Cursor Selection Management
let savedRange = null;
let activeEditNode = null;
let activeBlockForNewBranch = null; // Pointer to block when adding a new ELIF branch
// {from, to} of the exact "{{ ... }}" span being edited via a VarChipWidget
// double-click (Phase C of the Visual-editor rewrite), or null when
// inserting a fresh variable -- a plain text range, not a DOM node like
// activeEditNode above (which Phase D's block widgets will use instead).
let activeVarChipRange = null;
// {from, to, kind} of a Jinja2 block-tag TEXT SPAN being edited via a
// Phase D block widget: kind 'condition' replaces an existing open/elif
// tag's inner expression (e.g. just "item in pres.parts", not the "{% for
// "/" %}" around it); kind 'new-elif' inserts a brand new "{% elif ... %}"
// line at a zero-width point (always right before the block's close tag --
// see addElifBranch). null when the modal is being used for its other,
// older purposes (a fresh top-level block insertion, or the dead
// DOM-node-based edit path).
let activeBlockEditRange = null;

const linesCount = computed(() => {
  return editorText.value.split('\n').length;
});

// Scroll-fraction based sync (Visual<->Codi tab switches, reload
// persistence, and the two DocumentPreview panes) — proportional rather
// than pixel-exact, since two views of "the same document" (raw source vs.
// compiled HTML; clean Markdown vs. rendered HTML preview) render at very
// different total heights. Matching the same *fraction* scrolled keeps you
// looking at roughly the same part of the document in both.
const getScrollFraction = (el) => {
  if (!el) return 0;
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
};

const setScrollFraction = (el, fraction) => {
  if (!el) return;
  const max = el.scrollHeight - el.clientHeight;
  el.scrollTop = max > 0 ? fraction * max : 0;
};

// ============================================================================
// Code tab: CodeMirror 6, replacing an earlier hand-rolled "invisible
// textarea + syntax-highlight <pre> behind it + a separately-measured
// line-number gutter" -- a design that needed three parallel pieces (text,
// highlight markup, per-line pixel heights) kept in sync by hand on every
// edit/scroll/resize, and was the direct cause of a real desync bug (the
// gutter's cached heights going stale after editing from the Visual tab).
// CodeMirror owns gutter + wrapping + highlighting as ONE rendering pass,
// so there is no second data structure that can fall out of sync with the
// text by construction.
//
// Every OTHER function in this file that manipulates the code editor was
// written against a plain <textarea>'s API (.value, .selectionStart/End,
// .setSelectionRange(), .focus(), .scrollTop/scrollHeight/clientWidth) --
// rewriting each of those ~30 call sites to CodeMirror's own
// state/Transaction API individually would multiply the same handful of
// translations across a dozen+ functions for no real benefit (they already
// follow the exact "read selection -> compute new text+position -> write
// text -> restore selection" shape this maps onto). Instead, `textareaRef`
// (used everywhere else unchanged) holds a plain object that implements
// just the subset of that API actually used, backed by the real
// CodeMirror EditorView -- an adapter, not a live DOM node.
// ============================================================================
let codeMirrorView = null;
const codeMirrorContainerRef = ref(null);
// Visual tab's own CodeMirror instance (Phase A of the Visual-editor
// rewrite) -- a second view over the exact same editorText, not a
// contenteditable canvas. See createVisualCodeMirrorView below.
let visualCodeMirrorView = null;
const visualCodeMirrorContainerRef = ref(null);
const visualTextareaRef = ref(null);

const makeTextareaShim = (view) => ({
  get value() { return view.state.doc.toString(); },
  set value(v) {
    const cur = view.state.doc.toString();
    if (cur === v) return;
    view.dispatch({ changes: { from: 0, to: cur.length, insert: v || '' } });
  },
  get selectionStart() { return view.state.selection.main.from; },
  // A real textarea allows assigning .selectionStart/.selectionEnd directly
  // (not just via setSelectionRange()) — one call site in this file does
  // `txt.selectionStart = txt.selectionEnd = x` to collapse the cursor,
  // so both need real setters, not just getters.
  set selectionStart(v) { this.setSelectionRange(v, Math.max(v, view.state.selection.main.to)); },
  get selectionEnd() { return view.state.selection.main.to; },
  set selectionEnd(v) { this.setSelectionRange(Math.min(view.state.selection.main.from, v), v); },
  setSelectionRange(start, end) {
    const len = view.state.doc.length;
    const a = Math.max(0, Math.min(start ?? 0, len));
    const b = Math.max(0, Math.min(end ?? a, len));
    view.dispatch({ selection: { anchor: a, head: b }, scrollIntoView: true });
  },
  focus() { view.focus(); },
  get scrollTop() { return view.scrollDOM.scrollTop; },
  set scrollTop(v) { view.scrollDOM.scrollTop = v; },
  get scrollHeight() { return view.scrollDOM.scrollHeight; },
  get clientHeight() { return view.scrollDOM.clientHeight; },
  get clientWidth() { return view.scrollDOM.clientWidth; },
  // The one piece of real DOM identity this shim can't fake: code that
  // compares document.activeElement against "the code editor" needs
  // CodeMirror's actual editable DOM node, not this synthetic object.
  get contentDOM() { return view.contentDOM; },
});

// Best-effort, single-pass Jinja2/Markdown syntax highlighter -- a
// lightweight regex tokenizer, not a real grammar (ported unchanged from
// the previous backdrop-based implementation; only the output shape
// changed, from an HTML string to CodeMirror decoration ranges). Tokens
// never nest (e.g. a {{ var }} inside a heading line is swallowed whole by
// the heading token) -- an accepted trade-off for staying simple, and
// harmless by construction: a decoration is purely a visual class added on
// top of the real text CodeMirror already holds, it can never corrupt or
// lose content the way a parsing mistake in a real grammar might.
const HIGHLIGHT_TOKEN_RE = /(<!--[\s\S]*?-->)|(\{%[\s\S]*?%\})|(\{\{[\s\S]*?\}\})|(\$\$[\s\S]*?\$\$)|(\$[^$\n]+\$)|(^#{1,6}\s.*$)|(\*\*[^\n*]+\*\*)|(\*[^\n*]+\*)/gm;

// Shared by computeHighlightDecorations/computeMarkdownStyleDecorations/
// computeVarChipDecorations below (Phase D): a collapsed {% macro %}/
// {% set %} block hides its whole body inside ONE block-level replace
// widget (see jinjaBlockField further down), so none of these three
// plugins may ALSO try to place a decoration inside that same span --
// CodeMirror rejects two replace decorations (even a small inline chip
// nested inside a bigger block one) that overlap. Recomputed
// independently by each caller (not shared mutable state) so this stays
// correct regardless of extension/plugin registration order.
const isInsideAnyRange = (pos, ranges) => ranges.some(([f, t]) => pos >= f && pos < t);

const computeHighlightDecorations = (text, collapsedRanges = []) => {
  const decos = [];
  let m;
  HIGHLIGHT_TOKEN_RE.lastIndex = 0;
  while ((m = HIGHLIGHT_TOKEN_RE.exec(text)) !== null) {
    const [full, comment, block, variable, mathDisplay, mathInline, header, bold, italic] = m;
    if (full.length === 0) { HIGHLIGHT_TOKEN_RE.lastIndex++; continue; }
    if (isInsideAnyRange(m.index, collapsedRanges)) continue;
    let cls = '';
    if (comment) cls = 'tok-comment';
    else if (block) cls = 'tok-jinja-block';
    else if (variable) cls = 'tok-jinja-var';
    else if (mathDisplay || mathInline) cls = 'tok-math';
    else if (header) cls = 'tok-header';
    else if (bold) cls = 'tok-bold';
    else if (italic) cls = 'tok-italic';
    if (cls) decos.push(CmDecoration.mark({ class: cls }).range(m.index, m.index + full.length));
  }
  return CmDecoration.set(decos, true);
};

// Phase B of the Visual-editor rewrite (plain Markdown live-preview):
// visually styles headings/bold/italic/list markers the way the rendered
// document actually looks (real font-weight/size, not just syntax-colored
// text like jinjaHighlightPlugin above) -- Decoration.mark only, same as
// the tokenizer above, so the raw "#"/"**"/"-" characters stay visible and
// editable, just no longer plain monospace text. Visual-tab only (added to
// createVisualCodeMirrorView's extensions, not Codi's) -- Codi keeps
// today's plain syntax-highlighting look. Hiding the markers themselves
// when the cursor is elsewhere is a later, optional refinement, not
// required for this phase.
const MD_STYLE_TOKEN_RE = /(^#{1,6}\s.*$)|(\*\*[^\n*]+\*\*)|(\*[^\n*]+\*)/gm;
const MD_LIST_MARKER_RE = /^\s*(?:[-*+]|\d+\.)\s+/gm;

const computeMarkdownStyleDecorations = (text, collapsedRanges = []) => {
  const decos = [];
  let m;
  MD_STYLE_TOKEN_RE.lastIndex = 0;
  while ((m = MD_STYLE_TOKEN_RE.exec(text)) !== null) {
    const [full, header, bold, italic] = m;
    if (full.length === 0) { MD_STYLE_TOKEN_RE.lastIndex++; continue; }
    if (isInsideAnyRange(m.index, collapsedRanges)) continue;
    let cls = '';
    if (header) cls = `cm-md-heading cm-md-h${header.match(/^#{1,6}/)[0].length}`;
    else if (bold) cls = 'cm-md-bold';
    else if (italic) cls = 'cm-md-italic';
    if (cls) decos.push(CmDecoration.mark({ class: cls }).range(m.index, m.index + full.length));
  }
  MD_LIST_MARKER_RE.lastIndex = 0;
  while ((m = MD_LIST_MARKER_RE.exec(text)) !== null) {
    if (m[0].length === 0) { MD_LIST_MARKER_RE.lastIndex++; continue; }
    if (isInsideAnyRange(m.index, collapsedRanges)) continue;
    decos.push(CmDecoration.mark({ class: 'cm-md-list-marker' }).range(m.index, m.index + m[0].length));
  }
  return CmDecoration.set(decos, true);
};

const markdownStylePlugin = CmViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = computeMarkdownStyleDecorations(view.state.doc.toString(), computeExcludedInlineRanges(view.state));
  }
  update(update) {
    if (update.docChanged || update.startState.field(jinjaExpandedField, false) !== update.state.field(jinjaExpandedField, false)) {
      this.decorations = computeMarkdownStyleDecorations(update.state.doc.toString(), computeExcludedInlineRanges(update.state));
    }
  }
}, {
  decorations: (v) => v.decorations,
});

// Phase C of the Visual-editor rewrite: {{ expr | filters }} rendered as an
// inline chip widget (Decoration.replace, not just styled like
// jinjaHighlightPlugin's tok-jinja-var) -- the raw "{{ ... }}" text stays
// exactly where it is in the document underneath, only its on-screen
// appearance changes. Visual-tab only (Codi keeps showing the raw tag
// text, same as today). Double-click opens the existing variable modal
// (openVarModal), now redesigned to take a plain {from, to, raw} text
// range instead of a DOM node -- applyVariable's edit path dispatches a
// precise view.dispatch({changes:{from,to,insert}}) over exactly that
// range, never a DOM write.
//
// No eq()/updateDOM() override: every decoration recompute (on any
// docChanged) rebuilds every chip's DOM from scratch, so the from/to this
// widget captures for its dblclick handler are always correct for the
// *current* document -- reusing DOM across recomputes would risk a chip
// whose closure still points at a stale, pre-edit offset. Harmless
// performance cost at this app's document sizes.
//
// Loop-context-aware "is this variable defined in the schema" checking
// (the undefined-var warning style) needs cursor-offset-based loop-context
// resolution, which isn't ready until Phase H (useLoopContext.js still
// walks canvas DOM ancestors, which no longer exist) -- chips render as
// plain/defined for now rather than risk false "undefined" warnings on
// legitimate loop-relative variables like "part.nom".
// `.` (no `s`/dotall flag) never matches `\n`, so an unterminated `{{` can
// never greedily swallow a later, unrelated `{{ ... }}` across a line
// break while the user is mid-typing -- matches the existing single-line
// assumption already used by convertJinjaToChips in
// useMarkdownJinjaCompiler.js.
const VAR_CHIP_RE = /\{\{\s*(.*?)\s*\}\}/g;

class VarChipWidget extends CmWidgetType {
  constructor(raw, label, from, to) {
    super();
    this.raw = raw;
    this.label = label;
    this.from = from;
    this.to = to;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'j-var-chip';
    span.textContent = this.label;
    span.title = `{{ ${this.raw} }}`;
    span.addEventListener('mousedown', (e) => e.preventDefault());
    span.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      openVarModal({ from: this.from, to: this.to, raw: this.raw });
    });
    return span;
  }
  ignoreEvent() { return true; }
}

const computeVarChipDecorations = (text, collapsedRanges = []) => {
  const decos = [];
  let m;
  VAR_CHIP_RE.lastIndex = 0;
  while ((m = VAR_CHIP_RE.exec(text)) !== null) {
    if (isInsideAnyRange(m.index, collapsedRanges)) continue;
    const raw = m[1];
    const label = resolveFieldLabel(raw);
    decos.push(CmDecoration.replace({ widget: new VarChipWidget(raw, label, m.index, m.index + m[0].length) }).range(m.index, m.index + m[0].length));
  }
  return CmDecoration.set(decos, true);
};

const varChipPlugin = CmViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = computeVarChipDecorations(view.state.doc.toString(), computeExcludedInlineRanges(view.state));
  }
  update(update) {
    if (update.docChanged || update.startState.field(jinjaExpandedField, false) !== update.state.field(jinjaExpandedField, false)) {
      this.decorations = computeVarChipDecorations(update.state.doc.toString(), computeExcludedInlineRanges(update.state));
    }
  }
}, {
  decorations: (v) => v.decorations,
  // Skipping over the whole chip on arrow-key motion / backspace-deleting
  // it as one unit -- the declarative CodeMirror replacement for this
  // app's old isAtomicChip/getParentAtomicChip manual keydown handling.
  provide: (plugin) => CmEditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations || CmDecoration.none),
});

const jinjaHighlightPlugin = CmViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = computeHighlightDecorations(view.state.doc.toString(), computeExcludedInlineRanges(view.state));
  }
  update(update) {
    if (update.docChanged || update.startState.field(jinjaExpandedField, false) !== update.state.field(jinjaExpandedField, false)) {
      this.decorations = computeHighlightDecorations(update.state.doc.toString(), computeExcludedInlineRanges(update.state));
    }
  }
}, {
  decorations: (v) => v.decorations,
});

// Same block-tag vocabulary the Visual-canvas compiler recognizes
// (useMarkdownJinjaCompiler.js's OPEN_TAG_RE/ELIF_TAG_RE/CLOSE_TAG_RE) --
// for/if/macro/set open a block, elif/else are mid-block branches (if
// only), endfor/endif/endmacro/endset close it. Matched independently of
// the highlighter above: this pass builds a flat, depth-stack-paired list
// of every {% ... %} block tag in the whole document (ignoring line breaks,
// so same-line/nested tags pair correctly too), so that CodeMirror can
// highlight a block's whole tag family (open + any elif/else + close) the
// way bracket-matching highlights a pair of ()/[]/{} -- CodeMirror's own
// bracketMatching (@codemirror/language) can't do this itself: its
// syntax-tree mode needs a real language grammar (we only have a regex
// highlighter, no Jinja2 grammar), and its plain-text fallback only pairs
// single literal characters, never multi-character keyword tags like
// "{% for %}"/"{% endfor %}".
//
// {% set name = expr %} (the single-line assignment form) is deliberately
// NOT an "open" tag here -- like the compiler's OPEN_TAG_RE, only the bare
// "{% set name %}" block-capture form (no "=") pairs with {% endset %};
// the assignment form is self-contained and would otherwise show up as a
// permanently "unmatched" open tag.
const JINJA_TAG_SCAN_RE = /\{%[\s\S]*?%\}/g;
const JINJA_TAG_OPEN_KEYWORD_RE = /^\{%\s*(for|if|macro)\s+[\s\S]+?\s*%\}$/;
const JINJA_TAG_OPEN_SET_RE = /^\{%\s*set\s+[A-Za-z_]\w*\s*%\}$/;
const JINJA_TAG_ELIF_RE = /^\{%\s*elif\s+[\s\S]+?\s*%\}$/;
const JINJA_TAG_ELSE_RE = /^\{%\s*else\s*%\}$/;
const JINJA_TAG_CLOSE_RE = /^\{%\s*(endfor|endif|endmacro|endset)\s*%\}$/;
const JINJA_TAG_CLOSE_TYPE = { endfor: 'for', endif: 'if', endmacro: 'macro', endset: 'set' };
// Which mid-block branch keywords are valid per open type -- same rule as
// the compiler's ALLOWED_BRANCH_KEYWORDS (useMarkdownJinjaCompiler.js):
// 'if' has elif+else, 'for' has only a trailing else (Jinja2's for-else, for
// an empty iterable), macro/set have neither. Duplicated here (not shared
// across the two files) same as the rest of this vocabulary -- keep in sync.
const JINJA_TAG_ALLOWED_BRANCHES = { if: new Set(['elif', 'else']), for: new Set(['else']) };

const jinjaTagOpenType = (raw) => {
  const m = raw.match(JINJA_TAG_OPEN_KEYWORD_RE);
  if (m) return m[1];
  return JINJA_TAG_OPEN_SET_RE.test(raw) ? 'set' : null;
};

const computeJinjaTagRanges = (text) => {
  const tags = [];
  JINJA_TAG_SCAN_RE.lastIndex = 0;
  let m;
  while ((m = JINJA_TAG_SCAN_RE.exec(text)) !== null) {
    const raw = m[0].trim();
    const openType = jinjaTagOpenType(raw);
    const closeMatch = raw.match(JINJA_TAG_CLOSE_RE);
    let kind = null;
    if (openType) kind = 'open';
    else if (JINJA_TAG_ELIF_RE.test(raw)) kind = 'elif';
    else if (JINJA_TAG_ELSE_RE.test(raw)) kind = 'else';
    else if (closeMatch) kind = 'close';
    if (kind) tags.push({ from: m.index, to: m.index + m[0].length, kind, openType, closeType: closeMatch ? JINJA_TAG_CLOSE_TYPE[closeMatch[1]] : null, groupId: null });
  }
  // Pairs each family via a type-aware stack, exactly like the compiler's
  // own scanJinjaBlock/readBlock -- a close tag only closes the block
  // currently on top of the stack when its OWN type matches (e.g. a
  // "{% for %}" is never satisfied by "{% endif %}"): on a mismatch the
  // stack is left untouched (the open block keeps waiting for its real
  // close) and the wrong close tag is left as its own single-member,
  // permanently-unmatched group -- surfaced as an error (red) rather than
  // silently paired with a block it doesn't actually belong to. Likewise an
  // elif/else the open type doesn't support (JINJA_TAG_ALLOWED_BRANCHES)
  // is left ungrouped, inert, without disturbing the stack.
  let nextGroupId = 0;
  const stack = [];
  tags.forEach((tag) => {
    if (tag.kind === 'open') {
      const frame = { id: nextGroupId++, type: tag.openType };
      tag.groupId = frame.id;
      stack.push(frame);
    } else if (tag.kind === 'elif' || tag.kind === 'else') {
      const top = stack[stack.length - 1];
      if (top && JINJA_TAG_ALLOWED_BRANCHES[top.type]?.has(tag.kind)) tag.groupId = top.id;
    } else if (tag.kind === 'close') {
      const top = stack[stack.length - 1];
      if (top && top.type === tag.closeType) {
        stack.pop();
        tag.groupId = top.id;
      }
    }
  });
  return tags;
};

const jinjaTagMatchDecoClass = (matched) => (matched ? 'cm-jinja-tag-match' : 'cm-jinja-tag-nomatch');

const computeJinjaTagMatchDecorations = (view, tags) => {
  const pos = view.state.selection.main.head;
  const hit = tags.find((t) => pos >= t.from && pos <= t.to);
  if (!hit) return CmDecoration.none;
  const family = hit.groupId == null ? [hit] : tags.filter((t) => t.groupId === hit.groupId);
  const matched = hit.groupId != null && family.some((t) => t.kind === 'close');
  const cls = jinjaTagMatchDecoClass(matched);
  return CmDecoration.set(family.map((t) => CmDecoration.mark({ class: cls }).range(t.from, t.to)), true);
};

const jinjaTagMatchPlugin = CmViewPlugin.fromClass(class {
  constructor(view) {
    this.tags = computeJinjaTagRanges(view.state.doc.toString());
    this.decorations = computeJinjaTagMatchDecorations(view, this.tags);
  }
  update(update) {
    if (update.docChanged) this.tags = computeJinjaTagRanges(update.state.doc.toString());
    if (update.docChanged || update.selectionSet) {
      this.decorations = computeJinjaTagMatchDecorations(update.view, this.tags);
    }
  }
}, {
  decorations: (v) => v.decorations,
});

// Phase D of the Visual-editor rewrite: for/if/macro/set blocks. A block is
// built from THREE independent pieces, never one monolithic widget (see
// the plan's "Disseny dels blocs Jinja2"): the open-tag line becomes a
// header widget, each elif/else line becomes its own branch widget, and
// the close-tag line becomes a footer widget -- all Decoration.replace
// with block:true, i.e. whole-line swaps. The BODY in between stays real,
// still-editable document text, touched only by Decoration.line (adding a
// CSS class for the left-border/indent look), so nested blocks/chips
// inside a body keep rendering recursively through these exact same
// plugins, with no special-casing.
//
// Only a tag that sits ALONE on its own line (ignoring surrounding
// whitespace -- the same "block layout" convention the compiler already
// uses to tell block from inline shape) is turned into a widget; one that
// shares its line with other content is left as plain text, already
// colored by jinjaHighlightPlugin. Rendering an inline-layout block with
// its own widget is a later refinement (see the plan: "Bloc-layout
// primer... inline-layout després") -- not required for this phase, and
// deliberately not attempted here.
const JINJA_BLOCK_ICON = { for: '🔁', if: '🔀', macro: 'ƒ', set: '=' };
const JINJA_BLOCK_LABEL = { for: 'FOR', if: 'SI', macro: 'MACRO', set: 'SET' };
// Only macro/set default to collapsed (see the plan) -- for/if are always
// fully expanded, there is no view-only "folded" state for them.
const JINJA_BLOCK_COLLAPSIBLE = new Set(['macro', 'set']);

// A tag only becomes a widget when its own physical line contains nothing
// else -- returns that Line, or null when the tag shares its line with
// other text (inline layout) or itself spans a line break (never true for
// a real "{% ... %}" tag, but guarded against a pathological match anyway).
const wholeLineTag = (doc, from, to) => {
  const line = doc.lineAt(from);
  if (doc.lineAt(to).number !== line.number) return null;
  return line.text.trim() === doc.sliceString(from, to).trim() ? line : null;
};

const toggleJinjaExpandEffect = CmStateEffect.define();

// View-only state (no textual representation -- see the plan): the set of
// open-tag `from` offsets whose macro/set block the user has expanded.
// Mapped across every edit via tr.changes so it survives typing elsewhere
// in the document; a stale leftover offset (its block deleted, or the tag
// itself edited away) simply never matches any current tag again --
// harmless, not cleaned up explicitly.
const jinjaExpandedField = CmStateField.define({
  create() { return new Set(); },
  update(value, tr) {
    if (tr.docChanged) {
      const mapped = new Set();
      value.forEach((pos) => mapped.add(tr.changes.mapPos(pos, -1)));
      value = mapped;
    }
    for (const effect of tr.effects) {
      if (effect.is(toggleJinjaExpandEffect)) {
        const next = new Set(value);
        if (next.has(effect.value)) next.delete(effect.value); else next.add(effect.value);
        value = next;
      }
    }
    return value;
  },
});

// Every well-formed (open+close both present, type-matched) block-layout
// {% macro %}/{% set %} group that is CURRENTLY collapsed, as [from, to)
// document ranges covering their whole open-line..close-line span -- shared
// by computeHighlightDecorations/computeMarkdownStyleDecorations/
// computeVarChipDecorations above so none of them ever tries to decorate
// (chip, style, highlight) text that's actually hidden inside this Phase D
// plugin's own collapsed block-replace widget. `state.field(..., false)`
// (not the throwing 2-arg form) makes this safe to call on the Codi view
// too, which never installs jinjaExpandedField -- it simply reports nothing
// collapsed there, which is correct (Codi never renders block widgets).
const computeCollapsedJinjaRanges = (state) => {
  const expanded = state.field(jinjaExpandedField, false);
  if (!expanded) return [];
  const doc = state.doc;
  const tags = computeJinjaTagRanges(doc.toString());
  const byGroup = new Map();
  tags.forEach((t) => {
    if (t.groupId == null) return;
    if (!byGroup.has(t.groupId)) byGroup.set(t.groupId, []);
    byGroup.get(t.groupId).push(t);
  });
  const ranges = [];
  byGroup.forEach((members) => {
    const open = members.find((t) => t.kind === 'open');
    const close = members.find((t) => t.kind === 'close');
    if (!open || !close || !JINJA_BLOCK_COLLAPSIBLE.has(open.openType) || expanded.has(open.from)) return;
    const openLine = wholeLineTag(doc, open.from, open.to);
    const closeLine = wholeLineTag(doc, close.from, close.to);
    if (!openLine || !closeLine) return;
    ranges.push([openLine.from, closeLine.to]);
  });
  return ranges;
};

// Parses just the "condition" span of an open/elif tag's raw text -- e.g.
// "item in pres.parts" out of "{% for item in pres.parts %}" -- as an
// offset into the FULL DOCUMENT (docFrom + the match's local index), so an
// edit coming back from the modal can dispatch a precise replace over only
// that inner span, leaving the surrounding "{% for "/" %}" delimiters
// completely untouched.
const BLOCK_COND_RE = {
  for: /^\{%\s*for\s+([\s\S]+?)\s*%\}$/,
  if: /^\{%\s*if\s+([\s\S]+?)\s*%\}$/,
  elif: /^\{%\s*elif\s+([\s\S]+?)\s*%\}$/,
  macro: /^\{%\s*macro\s+([\s\S]+?)\s*%\}$/,
  set: /^\{%\s*set\s+([\s\S]+?)\s*%\}$/,
};

const parseBlockTagCondition = (raw, kind, docFrom) => {
  const re = BLOCK_COND_RE[kind];
  const m = re && raw.match(re);
  if (!m) return null;
  const condStart = raw.indexOf(m[1]);
  return { text: m[1], from: docFrom + condStart, to: docFrom + condStart + m[1].length };
};

// Both "afegir ELIF" and "afegir ELSE" always insert their new branch
// immediately before the block's close tag, regardless of where inside the
// block the header button was clicked -- the plan's deliberate
// simplification over the old canvas system's cursor-aware insertion.
const addElseBranch = (closeTag) => {
  const view = visualCodeMirrorView;
  if (!view) return;
  const closeLine = view.state.doc.lineAt(closeTag.from);
  view.dispatch({ changes: { from: closeLine.from, to: closeLine.from, insert: '{% else %}\n\n' } });
};

const addElifBranch = (type, closeTag) => {
  const view = visualCodeMirrorView;
  if (!view) return;
  const closeLine = view.state.doc.lineAt(closeTag.from);
  openBlockModalForRange('elif', { from: closeLine.from, to: closeLine.from, kind: 'new-elif', text: '' });
};

// "Elimina aquest bloc": removes the open tag's whole line through the
// close tag's whole line (its trailing newline too, so no blank line is
// left behind), including every line of body/branches/nested blocks in
// between -- confirmed first, same convention as the rest of this app's
// destructive actions (e.g. the pending-changes prompt in DataInspector's
// nested-modal Escape handling).
const deleteJinjaBlock = (open, close) => {
  const view = visualCodeMirrorView;
  if (!view) return;
  if (!confirm('Vols eliminar aquest bloc Jinja2 sencer (etiquetes i contingut)?')) return;
  const doc = view.state.doc;
  const openLine = doc.lineAt(open.from);
  const closeLine = doc.lineAt(close.from);
  const to = closeLine.to < doc.length ? closeLine.to + 1 : closeLine.to;
  view.dispatch({ changes: { from: openLine.from, to, insert: '' } });
};

// "Canvia a format en línia": a plain text transform, independent of widget
// rendering -- joins every body line (trimmed) with a single space and
// rewrites the open..close span as one line. Once inline, the block
// naturally stops being widgetized on the next decoration recompute
// (wholeLineTag returns null for a tag that no longer sits alone on its
// line) and falls back to plain highlighted text -- correct, since Phase D
// only widgetizes block-layout occurrences in the first place; there is no
// widget offering the reverse (inline -> block) direction yet.
const toggleJinjaBlockToInline = (open, close) => {
  const view = visualCodeMirrorView;
  if (!view) return;
  const doc = view.state.doc;
  const openLine = doc.lineAt(open.from);
  const closeLine = doc.lineAt(close.from);
  const bodyFrom = Math.min(openLine.to + 1, closeLine.from);
  const bodyRaw = doc.sliceString(bodyFrom, closeLine.from);
  const joined = bodyRaw.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  const openRaw = doc.sliceString(open.from, open.to);
  const closeRaw = doc.sliceString(close.from, close.to);
  view.dispatch({ changes: { from: openLine.from, to: closeLine.to, insert: `${openRaw}${joined}${closeRaw}` } });
};

class JinjaHeadWidget extends CmWidgetType {
  constructor(type, openRaw, open, close, branches, collapsible, isExpanded) {
    super();
    this.type = type;
    this.openRaw = openRaw;
    this.open = open;
    this.close = close;
    this.branches = branches;
    this.collapsible = collapsible;
    this.isExpanded = isExpanded;
  }
  toDOM() {
    const cond = parseBlockTagCondition(this.openRaw, this.type, this.open.from);
    const row = document.createElement('div');
    row.className = `j-block-head j-block-head-${this.type}`;

    if (this.collapsible) {
      const chevron = document.createElement('button');
      chevron.type = 'button';
      chevron.className = 'j-block-btn j-block-chevron';
      chevron.textContent = '▾';
      chevron.title = 'Col·lapsa';
      chevron.addEventListener('mousedown', (e) => e.preventDefault());
      chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        visualCodeMirrorView?.dispatch({ effects: toggleJinjaExpandEffect.of(this.open.from) });
      });
      row.appendChild(chevron);
    }

    const icon = document.createElement('span');
    icon.className = 'j-block-icon';
    icon.textContent = JINJA_BLOCK_ICON[this.type] || '{%';
    const label = document.createElement('span');
    label.className = 'j-block-label';
    label.textContent = JINJA_BLOCK_LABEL[this.type] || this.type.toUpperCase();
    row.append(icon, label);

    const condSpan = document.createElement('span');
    condSpan.className = 'j-block-cond';
    condSpan.textContent = cond ? cond.text : this.openRaw;
    condSpan.title = this.openRaw;
    if (cond) {
      condSpan.addEventListener('mousedown', (e) => e.preventDefault());
      condSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        openBlockModalForRange(this.type, { from: cond.from, to: cond.to, kind: 'condition', text: cond.text });
      });
    }
    row.appendChild(condSpan);

    const actions = document.createElement('span');
    actions.className = 'j-block-actions';
    const allowed = JINJA_TAG_ALLOWED_BRANCHES[this.type];
    const hasElse = this.branches.some((b) => b.kind === 'else');
    if (allowed?.has('elif') && !hasElse) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'j-block-btn'; btn.textContent = '+ ELIF';
      btn.title = 'Afegeix una branca ELIF al final del bloc';
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', (e) => { e.stopPropagation(); addElifBranch(this.type, this.close); });
      actions.appendChild(btn);
    }
    if (allowed?.has('else') && !hasElse) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'j-block-btn'; btn.textContent = '+ ELSE';
      btn.title = 'Afegeix una branca ELSE al final del bloc';
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', (e) => { e.stopPropagation(); addElseBranch(this.close); });
      actions.appendChild(btn);
    }
    if (!this.collapsible) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'j-block-btn'; btn.textContent = '⇄';
      btn.title = 'Canvia a format en línia';
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', (e) => { e.stopPropagation(); toggleJinjaBlockToInline(this.open, this.close); });
      actions.appendChild(btn);
    }
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'j-block-btn j-block-delete'; delBtn.textContent = '🗑';
    delBtn.title = 'Elimina aquest bloc sencer';
    delBtn.addEventListener('mousedown', (e) => e.preventDefault());
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteJinjaBlock(this.open, this.close); });
    actions.appendChild(delBtn);
    row.appendChild(actions);

    return row;
  }
  ignoreEvent() { return true; }
}

class JinjaBranchWidget extends CmWidgetType {
  constructor(type, branchTag, branchRaw) {
    super();
    this.type = type;
    this.branchTag = branchTag;
    this.branchRaw = branchRaw;
  }
  toDOM() {
    const row = document.createElement('div');
    row.className = `j-block-branch j-block-head-${this.type}`;
    const label = document.createElement('span');
    label.className = 'j-block-label';
    label.textContent = this.branchTag.kind === 'elif' ? 'ALTRAMENT SI' : 'ALTRAMENT';
    row.appendChild(label);
    if (this.branchTag.kind === 'elif') {
      const cond = parseBlockTagCondition(this.branchRaw, 'elif', this.branchTag.from);
      const condSpan = document.createElement('span');
      condSpan.className = 'j-block-cond';
      condSpan.textContent = cond ? cond.text : this.branchRaw;
      condSpan.title = this.branchRaw;
      if (cond) {
        condSpan.addEventListener('mousedown', (e) => e.preventDefault());
        condSpan.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          openBlockModalForRange('elif', { from: cond.from, to: cond.to, kind: 'condition', text: cond.text });
        });
      }
      row.appendChild(condSpan);
    }
    return row;
  }
  ignoreEvent() { return true; }
}

class JinjaFootWidget extends CmWidgetType {
  constructor(type) {
    super();
    this.type = type;
  }
  toDOM() {
    const row = document.createElement('div');
    row.className = `j-block-foot j-block-head-${this.type}`;
    const label = document.createElement('span');
    label.className = 'j-block-label';
    label.textContent = `FI ${JINJA_BLOCK_LABEL[this.type] || this.type.toUpperCase()}`;
    row.appendChild(label);
    return row;
  }
  ignoreEvent() { return true; }
}

class JinjaCollapsedWidget extends CmWidgetType {
  constructor(type, open, openRaw) {
    super();
    this.type = type;
    this.open = open;
    this.openRaw = openRaw;
  }
  toDOM() {
    const row = document.createElement('div');
    row.className = `j-block-collapsed j-block-head-${this.type}`;
    const chevron = document.createElement('button');
    chevron.type = 'button'; chevron.className = 'j-block-btn j-block-chevron'; chevron.textContent = '▸';
    chevron.title = 'Expandeix';
    chevron.addEventListener('mousedown', (e) => e.preventDefault());
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      visualCodeMirrorView?.dispatch({ effects: toggleJinjaExpandEffect.of(this.open.from) });
    });
    const icon = document.createElement('span');
    icon.className = 'j-block-icon';
    icon.textContent = JINJA_BLOCK_ICON[this.type] || '{%';
    const label = document.createElement('span');
    label.className = 'j-block-label';
    label.textContent = JINJA_BLOCK_LABEL[this.type] || this.type.toUpperCase();
    const sig = document.createElement('span');
    sig.className = 'j-block-cond';
    sig.textContent = this.openRaw;
    row.append(chevron, icon, label, sig);
    return row;
  }
  ignoreEvent() { return true; }
}

const computeJinjaBlockDecorations = (state) => {
  const doc = state.doc;
  const tags = computeJinjaTagRanges(doc.toString());
  const expanded = state.field(jinjaExpandedField, false) || new Set();
  const byGroup = new Map();
  tags.forEach((t) => {
    if (t.groupId == null) return;
    if (!byGroup.has(t.groupId)) byGroup.set(t.groupId, []);
    byGroup.get(t.groupId).push(t);
  });

  const ranges = [];
  byGroup.forEach((members) => {
    const open = members.find((t) => t.kind === 'open');
    const close = members.find((t) => t.kind === 'close');
    if (!open || !close) return; // unterminated/mismatched -- left as plain text, surfaced elsewhere as an error
    const type = open.openType;

    const openLine = wholeLineTag(doc, open.from, open.to);
    const closeLine = wholeLineTag(doc, close.from, close.to);
    if (!openLine || !closeLine) return; // inline layout (or mixed) -- deferred, see file header comment

    const branches = members.filter((t) => t.kind === 'elif' || t.kind === 'else').sort((a, b) => a.from - b.from);
    const branchLines = [];
    let allBranchesOk = true;
    for (const b of branches) {
      const bl = wholeLineTag(doc, b.from, b.to);
      if (!bl) { allBranchesOk = false; break; }
      branchLines.push({ tag: b, line: bl });
    }
    if (!allBranchesOk) return;

    const collapsible = JINJA_BLOCK_COLLAPSIBLE.has(type);
    const isExpanded = !collapsible || expanded.has(open.from);

    if (collapsible && !isExpanded) {
      ranges.push(CmDecoration.replace({
        widget: new JinjaCollapsedWidget(type, open, doc.sliceString(open.from, open.to)),
        block: true,
      }).range(openLine.from, closeLine.to));
      return;
    }

    ranges.push(CmDecoration.replace({
      widget: new JinjaHeadWidget(type, doc.sliceString(open.from, open.to), open, close, branches, collapsible, isExpanded),
      block: true,
    }).range(openLine.from, openLine.to));

    branchLines.forEach(({ tag, line }) => {
      ranges.push(CmDecoration.replace({
        widget: new JinjaBranchWidget(type, tag, doc.sliceString(tag.from, tag.to)),
        block: true,
      }).range(line.from, line.to));
    });

    ranges.push(CmDecoration.replace({
      widget: new JinjaFootWidget(type),
      block: true,
    }).range(closeLine.from, closeLine.to));

    const boundaries = [openLine, ...branchLines.map((b) => b.line), closeLine];
    for (let i = 0; i < boundaries.length - 1; i++) {
      for (let ln = boundaries[i].number + 1; ln < boundaries[i + 1].number; ln++) {
        const bodyLine = doc.line(ln);
        ranges.push(CmDecoration.line({ attributes: { class: `cm-jinja-body cm-jinja-body-${type}` } }).range(bodyLine.from));
      }
    }
  });

  return CmDecoration.set(ranges, true);
};

// A StateField, NOT a ViewPlugin -- CodeMirror requires block-level
// (block:true) replace decorations to come from a StateField
// ("Block decorations may not be specified via plugins" is a hard runtime
// error otherwise), unlike the plain inline mark/replace decorations the
// other Phase B/C plugins above provide. tr.effects is checked directly
// (rather than comparing jinjaExpandedField's old/new value) since the
// collapse toggle is the ONLY thing that can change this field without
// also changing the document.
const jinjaBlockField = CmStateField.define({
  create(state) { return computeJinjaBlockDecorations(state); },
  update(value, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(toggleJinjaExpandEffect))) {
      return computeJinjaBlockDecorations(tr.state);
    }
    return value;
  },
  provide: (f) => [
    CmEditorView.decorations.from(f),
    CmEditorView.atomicRanges.of((view) => view.state.field(f, false) || CmDecoration.none),
  ],
});

// Phase E of the Visual-editor rewrite: the "{% set name = expr %}"
// single-line assignment chip, and KaTeX math ($...$ inline, $$...$$
// display).

// Single-line-safe variant of the compiler's own SET_INLINE_RE
// (useMarkdownJinjaCompiler.js) -- ".*?" (no "s"/dotall flag) can never
// swallow a later, unrelated tag across a line break while the user is
// mid-typing, same fix as VAR_CHIP_RE (Phase C).
const SET_INLINE_CM_RE = /\{%\s*set\s+([A-Za-z_]\w*)\s*=\s*(.*?)\s*%\}/g;

// Rendered collapsed to just its variable name by default (matching the
// old canvas system's chip); a plain click toggles showing the full
// "name = expr" -- reusing jinjaExpandedField/toggleJinjaExpandEffect, the
// exact same view-only, edit-mapped mechanism Phase D uses for macro/set
// block collapse (keyed by this tag's own `from`, which can never collide
// with a block-form "{% set name %}" tag's `from` -- they're always
// different, non-overlapping tags).
class SetInlineChipWidget extends CmWidgetType {
  constructor(name, from, to, cond, expanded) {
    super();
    this.name = name;
    this.from = from;
    this.to = to;
    this.cond = cond;
    this.expanded = expanded;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'j-set-chip';
    span.title = "Clica per mostrar/amagar l'assignació; doble clic per editar-la";
    span.textContent = this.expanded ? this.cond.text : this.name;
    span.addEventListener('mousedown', (e) => e.preventDefault());
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      visualCodeMirrorView?.dispatch({ effects: toggleJinjaExpandEffect.of(this.from) });
    });
    span.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      openBlockModalForRange('set-inline', { from: this.cond.from, to: this.cond.to, kind: 'condition', text: this.cond.text });
    });
    return span;
  }
  ignoreEvent() { return true; }
}

const computeSetInlineDecorations = (text, expandedSet, excludedRanges) => {
  const decos = [];
  let m;
  SET_INLINE_CM_RE.lastIndex = 0;
  while ((m = SET_INLINE_CM_RE.exec(text)) !== null) {
    if (isInsideAnyRange(m.index, excludedRanges)) continue;
    const from = m.index;
    const to = from + m[0].length;
    const cond = parseBlockTagCondition(m[0], 'set', from);
    if (!cond) continue;
    decos.push(CmDecoration.replace({ widget: new SetInlineChipWidget(m[1], from, to, cond, expandedSet.has(from)) }).range(from, to));
  }
  return CmDecoration.set(decos, true);
};

const setInlinePlugin = CmViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = computeSetInlineDecorations(view.state.doc.toString(), view.state.field(jinjaExpandedField, false) || new Set(), computeExcludedInlineRanges(view.state));
  }
  update(update) {
    if (update.docChanged || update.startState.field(jinjaExpandedField, false) !== update.state.field(jinjaExpandedField, false)) {
      this.decorations = computeSetInlineDecorations(update.state.doc.toString(), update.state.field(jinjaExpandedField, false) || new Set(), computeExcludedInlineRanges(update.state));
    }
  }
}, {
  decorations: (v) => v.decorations,
  provide: (plugin) => CmEditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations || CmDecoration.none),
});

// Renders a math expression via KaTeX, substituting any embedded Jinja2
// "{{ var }}" with a plain "[var]" placeholder first (KaTeX has no notion
// of Jinja2) -- ported unchanged from the old canvas system's extractMath.
// throwOnError:false means KaTeX itself renders a red error message rather
// than throwing for genuinely invalid TeX; the try/catch is only a last
// resort against KaTeX throwing anyway (a bug in KaTeX itself, or a
// pathological input) so a malformed formula degrades to plain text
// instead of taking the whole decoration pass down with it.
const renderKatexInto = (el, expr, displayMode) => {
  try {
    const cleanExpr = expr.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_m, p1) => `\\text{[${p1.trim().replace(/_/g, '\\_')}]}`);
    el.innerHTML = katex.renderToString(cleanExpr, { displayMode, throwOnError: false });
  } catch (_) {
    el.textContent = expr;
  }
};

class InlineMathWidget extends CmWidgetType {
  constructor(expr, from, to) {
    super();
    this.expr = expr;
    this.from = from;
    this.to = to;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'latex-chip inline-math';
    span.title = `$${this.expr}$`;
    renderKatexInto(span, this.expr, false);
    span.addEventListener('mousedown', (e) => e.preventDefault());
    span.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      openMathModalForRange({ from: this.from, to: this.to, expr: this.expr, type: 'inline' });
    });
    return span;
  }
  ignoreEvent() { return true; }
}

// Only "$" pairs whose content is NON-EMPTY become an inline-math widget --
// a well-formed "$$...$$" display block is naturally seen by this same
// regex as TWO adjacent empty "$$" pairs (it only ever pairs up 2 dollar
// signs at a time), which this skips; that keeps inline math from ever
// stealing/mis-splitting a display block's delimiters even before
// excludedRanges (computed from computeExcludedInlineRanges, which already
// carves out clean display-math blocks) is consulted.
const INLINE_MATH_RE = /\$(.*?)\$/g;

const computeInlineMathDecorations = (text, excludedRanges) => {
  const decos = [];
  let m;
  INLINE_MATH_RE.lastIndex = 0;
  while ((m = INLINE_MATH_RE.exec(text)) !== null) {
    if (isInsideAnyRange(m.index, excludedRanges)) continue;
    const expr = m[1].trim();
    if (!expr) continue;
    decos.push(CmDecoration.replace({ widget: new InlineMathWidget(expr, m.index, m.index + m[0].length) }).range(m.index, m.index + m[0].length));
  }
  return CmDecoration.set(decos, true);
};

const inlineMathPlugin = CmViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = computeInlineMathDecorations(view.state.doc.toString(), computeExcludedInlineRanges(view.state));
  }
  update(update) {
    if (update.docChanged || update.startState.field(jinjaExpandedField, false) !== update.state.field(jinjaExpandedField, false)) {
      this.decorations = computeInlineMathDecorations(update.state.doc.toString(), computeExcludedInlineRanges(update.state));
    }
  }
}, {
  decorations: (v) => v.decorations,
  provide: (plugin) => CmEditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations || CmDecoration.none),
});

class DisplayMathWidget extends CmWidgetType {
  constructor(expr, from, to) {
    super();
    this.expr = expr;
    this.from = from;
    this.to = to;
  }
  toDOM() {
    const div = document.createElement('div');
    div.className = 'latex-chip display-math';
    div.title = `$$${this.expr}$$`;
    renderKatexInto(div, this.expr, true);
    div.addEventListener('mousedown', (e) => e.preventDefault());
    div.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      openMathModalForRange({ from: this.from, to: this.to, expr: this.expr, type: 'display' });
    });
    return div;
  }
  ignoreEvent() { return true; }
}

// Only a "$$...$$" whose opening/closing markers each sit ALONE on their
// own line (exactly the shape onMathApply itself always inserts:
// "$$\n<expr>\n$$") becomes a block widget -- matches the same "clean
// block layout only" rule Phase D applies to for/if/macro/set. An
// inline "$$formula$$" sharing its line with other content is left as
// plain highlighted text.
const DISPLAY_MATH_RE = /\$\$([\s\S]*?)\$\$/g;

const computeDisplayMathBlocks = (state) => {
  const doc = state.doc;
  const text = doc.toString();
  const collapsedJinja = computeCollapsedJinjaRanges(state);
  const tables = computeTableRanges(state);
  const blocks = [];
  DISPLAY_MATH_RE.lastIndex = 0;
  let m;
  while ((m = DISPLAY_MATH_RE.exec(text)) !== null) {
    const from = m.index;
    const to = from + m[0].length;
    if (isInsideAnyRange(from, collapsedJinja) || isInsideAnyRange(from, tables)) continue;
    const startLine = doc.lineAt(from);
    const endLine = doc.lineAt(to - 1);
    if (startLine.text.trim() !== '$$' || endLine.text.trim() !== '$$') continue;
    blocks.push({ from: startLine.from, to: endLine.to, expr: m[1].trim() });
  }
  return blocks;
};

const computeDisplayMathRanges = (state) => computeDisplayMathBlocks(state).map((b) => [b.from, b.to]);

// Combines every kind of "this text is actually hidden inside a bigger
// block-replace widget" range this file knows about -- collapsed
// macro/set blocks (Phase D), tables (Phase F) and clean display-math
// blocks (Phase E) -- into one list, so no OTHER decoration (a {{ }} chip,
// a set-inline chip, markdown styling, the plain highlighter, inline math)
// ever tries to place a decoration of its own inside a span some other
// plugin/field has already replaced -- CodeMirror rejects overlapping
// replace decorations regardless of which plugin/field they came from.
const computeExcludedInlineRanges = (state) => [...computeCollapsedJinjaRanges(state), ...computeTableRanges(state), ...computeDisplayMathRanges(state)];

const computeDisplayMathDecorations = (state) => {
  const ranges = computeDisplayMathBlocks(state).map((b) => CmDecoration.replace({ widget: new DisplayMathWidget(b.expr, b.from, b.to), block: true }).range(b.from, b.to));
  return CmDecoration.set(ranges, true);
};

// A StateField, not a ViewPlugin, for the same reason as jinjaBlockField:
// a "$$...$$" block can span several lines, and CodeMirror requires
// multi-line block:true replace decorations to come from a StateField.
const displayMathField = CmStateField.define({
  create(state) { return computeDisplayMathDecorations(state); },
  update(value, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(toggleJinjaExpandEffect))) {
      return computeDisplayMathDecorations(tr.state);
    }
    return value;
  },
  provide: (f) => [
    CmEditorView.decorations.from(f),
    CmEditorView.atomicRanges.of((view) => view.state.field(f, false) || CmDecoration.none),
  ],
});

// Phase F of the Visual-editor rewrite: tables. Three source shapes, same
// as TableModal.vue's own three modes -- "dynamic" (a row repeated via a
// {% for %} loop) and "transposed" (a column repeated via a {% for %}
// loop) are wrapped in this app's own "<!-- DYNAMIC_TABLE_START:... -->"/
// "<!-- TRANSPOSED_TABLE_START:... -->" HTML-comment markers (parsed with
// the exact same regexes/helpers -- TRANSPOSED_TABLE_RE, DYNAMIC_TABLE_RE,
// splitTableLine, alignFromDivider -- the compiler's own extractCommentTables
// uses, now exported for reuse); "manual" is a plain Markdown grid with no
// markers at all. Every parse works directly off the raw document TEXT, not
// off any rendered DOM -- unlike TableModal.vue's OLD DOM-reading
// openTableModal (still used for the isCellMode/legacy path elsewhere in
// this file... actually fully replaced below), there is no HTML detour on
// the read side either, only on the one-shot, already-justified write side
// (TableModal.vue itself still emits fresh HTML on Apply; onTableApply
// still converts that once via htmlToMarkdown -- never a round-trip of
// EXISTING content, exactly the same reasoning Phase A already established
// for a brand new table's insertion, just now also reused for editing an
// EXISTING one via a precise replace over its exact span).
//
// Only a table whose exact span (comment-to-comment, or header-line to last
// body line) already lines up with clean line boundaries becomes a widget
// -- the same "clean shape only, else plain text" discipline as every
// earlier phase.
const isCleanLineSpan = (doc, from, to) => {
  if (to <= from) return false;
  const fromLine = doc.lineAt(from);
  const toLine = doc.lineAt(to - 1);
  return fromLine.from === from && toLine.to === to;
};

const MANUAL_TABLE_DIVIDER_RE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

// Plain Markdown tables (no "<!-- ..._TABLE_START -->" markers) -- a header
// line immediately followed by a valid divider line, then as many "| ... |"
// body lines as follow. `excludeRanges` keeps this from re-matching a table
// already claimed by a comment-marked dynamic/transposed table above it (both
// are, after all, just "| ... |" lines from this scan's point of view) or
// hidden inside a collapsed macro/set.
const findManualTables = (doc, text, excludeRanges) => {
  const lines = text.split('\n');
  const starts = [];
  let offset = 0;
  for (const l of lines) { starts.push(offset); offset += l.length + 1; }
  const results = [];
  let i = 0;
  while (i < lines.length - 1) {
    const headerLine = lines[i].trim();
    const dividerLineTrim = lines[i + 1].trim();
    if (headerLine.startsWith('|') && MANUAL_TABLE_DIVIDER_RE.test(dividerLineTrim) && !isInsideAnyRange(starts[i], excludeRanges)) {
      const headers = splitTableLine(lines[i]);
      const aligns = splitTableLine(lines[i + 1]).map(alignFromDivider);
      const dividerFrom = starts[i + 1];
      const dividerTo = dividerFrom + lines[i + 1].length;
      let j = i + 2;
      const rows = [];
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        rows.push(splitTableLine(lines[j]));
        j++;
      }
      results.push({
        from: starts[i],
        to: starts[j - 1] + lines[j - 1].length,
        mode: 'manual',
        config: { mode: 'manual', manualRows: rows.length + 1, manualCols: headers.length },
        headers,
        aligns,
        rows,
        dividerFrom,
        dividerTo,
      });
      i = j;
      continue;
    }
    i++;
  }
  return results;
};

// Ports openTableModal's DOM-reading logic (below) to work off the parsed
// {headers, aligns, bodyLine, totalsLine} shape instead -- same resulting
// `config` object TableModal.vue already expects.
const parseDynamicTableMatch = (loopExprRaw, tableContent) => {
  const loopExpr = loopExprRaw.trim();
  const iterMatch = loopExpr.match(/^(\w+)\s+in\s+([\w.]+)/);
  if (!iterMatch) return null;
  const iteratorVar = iterMatch[1];
  const selectedArray = iterMatch[2];

  const lines = tableContent.trim().split('\n').filter((l) => l.trim().startsWith('|') || l.trim().startsWith('{%'));
  const headerLine = lines.find((l) => l.startsWith('|') && !l.includes('---'));
  const dividerLine = lines.find((l) => l.startsWith('|') && l.includes('---'));
  const bodyLine = lines.find((l) => l.startsWith('|') && l.includes('{{'));
  const endforIdx = lines.findIndex((l) => l.trim() === '{% endfor %}');
  const totalsLine = endforIdx !== -1 ? lines.slice(endforIdx + 1).find((l) => l.startsWith('|')) : undefined;
  if (!headerLine || !bodyLine) return null;

  const headers = splitTableLine(headerLine);
  const aligns = dividerLine ? splitTableLine(dividerLine).map(alignFromDivider) : [];
  const bodyCells = splitTableLine(bodyLine);

  const columns = bodyCells.map((cell, idx) => {
    const m = cell.match(/\{\{\s*(.*?)\s*\}\}/);
    const raw = m ? m[1].trim() : '';
    const parts = raw.split('|');
    const expr = parts[0].trim();
    const filter = parts.slice(1).join('|').trim();
    const key = expr.includes('.') ? expr.split('.').pop() : expr;
    return { key, header: headers[idx] || key, align: aligns[idx] || 'left', selected: true, filter, totalFormula: '', totalCustomExpr: '' };
  });

  if (totalsLine) {
    const totalsCells = splitTableLine(totalsLine);
    const arr = selectedArray.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    columns.forEach((col, idx) => {
      const m = (totalsCells[idx] || '').match(/\{\{\s*(.*?)\s*\}\}/);
      const raw = m ? m[1].trim() : '';
      if (!raw) return;
      let mm = raw.match(new RegExp(`^\\(${arr}\\s*\\|\\s*sum\\(attribute='[^']+'\\)\\)(?:\\s*\\|\\s*.+)?$`));
      if (mm) { col.totalFormula = 'sum'; return; }
      mm = raw.match(new RegExp(`^\\(\\(${arr}\\s*\\|\\s*sum\\(attribute='[^']+'\\)\\)\\s*/\\s*\\(${arr}\\s*\\|\\s*length\\)\\)(?:\\s*\\|\\s*.+)?$`));
      if (mm) { col.totalFormula = 'avg'; return; }
      mm = raw.match(new RegExp(`^\\(${arr}\\s*\\|\\s*length\\)(?:\\s*\\|\\s*.+)?$`));
      if (mm) { col.totalFormula = 'count'; return; }
      col.totalFormula = 'custom';
      col.totalCustomExpr = raw;
    });
  }

  return { mode: 'dynamic', config: { mode: 'dynamic', iteratorVar, selectedArray, columns, totalsRow: !!totalsLine } };
};

const parseTransposedTableMatch = (meta, tableContent) => {
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

  const iterMatch = loopExpr.match(/^(\w+)\s+in\s+([\w.]+)/);
  if (!iterMatch) return null;
  const iteratorVar = iterMatch[1];
  const selectedArray = iterMatch[2];

  const lines = tableContent.trim().split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) return null;
  const headers = splitTableLine(lines[0]);
  const headerValues = headers.slice(1);
  const finalColHeader = colHeader || findColHeaderKeyMatch(selectedArray, headerValues);

  const bodyLines = lines.slice(2);
  const columns = bodyLines.map((bl, idx) => {
    const cells = splitTableLine(bl);
    const rowLabel = cells[0] || 'Dada';
    const key = rowKeys[idx] || findBestKeyMatch(selectedArray, rowLabel) || '';
    const m = bl.match(/\{\{\s*(.*?)\s*\}\}/);
    const raw = m ? m[1].trim() : '';
    const filter = raw.split('|').slice(1).join('|').trim();
    return { key, header: rowLabel, align: 'left', selected: true, filter };
  });

  return { mode: 'transposed', config: { mode: 'transposed', iteratorVar, selectedArray, selectedColHeaderKey: finalColHeader, columns } };
};

// Every table (of any of the three shapes) currently in the document, as
// {from, to, mode, config, ...extra parse data the widget needs to render
// its own preview}. Reused both by the widget-decoration builder below and
// by computeTableRanges (part of computeExcludedInlineRanges), so a
// document is only ever parsed for tables once per recompute.
const computeAllTables = (state) => {
  const doc = state.doc;
  const text = doc.toString();
  const collapsedJinja = computeCollapsedJinjaRanges(state);
  const results = [];

  TRANSPOSED_TABLE_RE.lastIndex = 0;
  let m;
  while ((m = TRANSPOSED_TABLE_RE.exec(text)) !== null) {
    const from = m.index;
    const to = from + m[0].length;
    if (!isCleanLineSpan(doc, from, to) || isInsideAnyRange(from, collapsedJinja)) continue;
    const parsed = parseTransposedTableMatch(m[1], m[2]);
    if (parsed) results.push({ from, to, ...parsed });
  }

  DYNAMIC_TABLE_RE.lastIndex = 0;
  while ((m = DYNAMIC_TABLE_RE.exec(text)) !== null) {
    const from = m.index;
    const to = from + m[0].length;
    if (!isCleanLineSpan(doc, from, to) || isInsideAnyRange(from, collapsedJinja)) continue;
    const parsed = parseDynamicTableMatch(m[1], m[2]);
    if (parsed) results.push({ from, to, ...parsed });
  }

  const claimedRanges = [...collapsedJinja, ...results.map((r) => [r.from, r.to])];
  findManualTables(doc, text, claimedRanges).forEach((t) => results.push(t));

  return results;
};

const computeTableRanges = (state) => computeAllTables(state).map((t) => [t.from, t.to]);

const buildTablePreviewTableEl = (headers, aligns, bodyRows, totalsRow, onHeaderClick) => {
  const table = document.createElement('table');
  table.className = 'j-table-preview';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headers.forEach((h, idx) => {
    const th = document.createElement('th');
    th.textContent = h;
    th.style.textAlign = aligns[idx] || 'left';
    if (onHeaderClick) {
      th.classList.add('j-table-th-clickable');
      th.title = "Clica per canviar l'alineació de la columna";
      th.addEventListener('mousedown', (e) => e.preventDefault());
      th.addEventListener('click', (e) => { e.stopPropagation(); onHeaderClick(idx); });
    }
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  bodyRows.forEach((cells) => {
    const tr = document.createElement('tr');
    cells.forEach((c, idx) => {
      const td = document.createElement('td');
      td.textContent = c;
      td.style.textAlign = aligns[idx] || 'left';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  if (totalsRow) {
    const tr = document.createElement('tr');
    tr.className = 'j-totals-row';
    totalsRow.forEach((c, idx) => {
      const td = document.createElement('td');
      td.textContent = c;
      td.style.textAlign = aligns[idx] || 'left';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
};

const TOTAL_FORMULA_LABEL = { sum: 'Suma', avg: 'Mitjana', count: 'Compte' };

// Only "manual" tables get header-click-to-toggle-alignment in this phase
// (its divider row is unambiguous, single-line, plain text); dynamic/
// transposed tables already expose per-column alignment in TableModal
// itself, which stays the only way to change theirs -- a deliberate scope
// reduction, not an oversight.
const ALIGN_CYCLE = { left: 'center', center: 'right', right: 'left' };
const ALIGN_TO_DIVIDER_CELL = { left: '---', center: ':---:', right: '---:' };

const cycleManualColumnAlign = (entry, idx) => {
  const view = visualCodeMirrorView;
  if (!view) return;
  const dividerText = view.state.doc.sliceString(entry.dividerFrom, entry.dividerTo);
  const cells = splitTableLine(dividerText);
  const current = alignFromDivider(cells[idx] || '---');
  cells[idx] = ALIGN_TO_DIVIDER_CELL[ALIGN_CYCLE[current]];
  view.dispatch({ changes: { from: entry.dividerFrom, to: entry.dividerTo, insert: `| ${cells.join(' | ')} |` } });
};

class TableWidget extends CmWidgetType {
  constructor(entry) {
    super();
    this.entry = entry;
  }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = `j-table-widget j-table-widget-${this.entry.mode}`;

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'table-edit-btn';
    editBtn.textContent = '✎ Edita taula';
    editBtn.title = 'Edita la configuració de la taula';
    editBtn.addEventListener('mousedown', (e) => e.preventDefault());
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTableModalForRange({ from: this.entry.from, to: this.entry.to, config: this.entry.config });
    });
    wrap.appendChild(editBtn);

    if (this.entry.mode === 'manual') {
      wrap.appendChild(buildTablePreviewTableEl(this.entry.headers, this.entry.aligns, this.entry.rows, null, (idx) => cycleManualColumnAlign(this.entry, idx)));
    } else if (this.entry.mode === 'dynamic') {
      const cfg = this.entry.config;
      const activeCols = cfg.columns.filter((c) => c.selected && c.key);
      const badge = document.createElement('div');
      badge.className = 'j-table-loop-badge';
      badge.textContent = `🔁 per cada ${cfg.iteratorVar} de ${cfg.selectedArray}`;
      wrap.appendChild(badge);
      const bodyRow = activeCols.map((c) => resolveFieldLabel(`${cfg.iteratorVar}.${c.key}${c.filter ? ` | ${c.filter}` : ''}`));
      const totalsRow = cfg.totalsRow ? activeCols.map((c) => (c.totalFormula ? (TOTAL_FORMULA_LABEL[c.totalFormula] || 'Fórmula') : '')) : null;
      wrap.appendChild(buildTablePreviewTableEl(activeCols.map((c) => c.header), activeCols.map((c) => c.align), [bodyRow], totalsRow));
    } else if (this.entry.mode === 'transposed') {
      const cfg = this.entry.config;
      const badge = document.createElement('div');
      badge.className = 'j-table-loop-badge';
      badge.textContent = `🔄 columnes per cada ${cfg.iteratorVar} de ${cfg.selectedArray}`;
      wrap.appendChild(badge);
      const headers = ['Dada', resolveFieldLabel(`${cfg.iteratorVar}.${cfg.selectedColHeaderKey}`)];
      const rows = cfg.columns.filter((c) => c.selected && c.key).map((c) => [c.header, resolveFieldLabel(`${cfg.iteratorVar}.${c.key}${c.filter ? ` | ${c.filter}` : ''}`)]);
      wrap.appendChild(buildTablePreviewTableEl(headers, ['left', 'center'], rows, null));
    }

    return wrap;
  }
  ignoreEvent() { return true; }
}

const computeTableDecorations = (state) => {
  const ranges = computeAllTables(state).map((entry) => CmDecoration.replace({ widget: new TableWidget(entry), block: true }).range(entry.from, entry.to));
  return CmDecoration.set(ranges, true);
};

// A StateField, same reason as jinjaBlockField/displayMathField: a table
// spans several lines, and CodeMirror requires multi-line block:true
// replace decorations to come from a StateField.
const tableField = CmStateField.define({
  create(state) { return computeTableDecorations(state); },
  update(value, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(toggleJinjaExpandEffect))) {
      return computeTableDecorations(tr.state);
    }
    return value;
  },
  provide: (f) => [
    CmEditorView.decorations.from(f),
    CmEditorView.atomicRanges.of((view) => view.state.field(f, false) || CmDecoration.none),
  ],
});

// defaultKeymap ships plain editing (cursor movement, delete, indent...);
// Ctrl+Z/Y are deliberately NOT bound here -- undoEdit/redoEdit (below) is
// the single shared history across both tabs, wired directly in
// handleGlobalKeyDown, and letting CodeMirror ALSO bind its own undo would
// create two competing, disconnected history stacks for the same text.
const CM_SAFE_KEYMAP = cmDefaultKeymap.filter((b) => {
  const keys = [b.key, b.mac, b.win, b.linux].filter(Boolean);
  return !keys.some((k) => /^Mod-(z|y)$/i.test(k) || /^Mod-Shift-z$/i.test(k));
});

// Shared factory for both tabs' CodeMirror instances (Phase A of the
// Visual-tab rewrite: Visual is now a second CodeMirror view over the exact
// same editorText, not a contenteditable canvas rebuilt from compiled HTML
// -- see /home/frambla/.claude/plans/unified-nibbling-adleman.md). `extraExtensions`
// is where the two tabs will keep diverging (Visual gains a growing set of
// decoration/widget plugins phase by phase; Codi keeps today's plain
// syntax-highlighting set) -- both share lineNumbers/lineWrapping/the safe
// keymap/the update-listener shape, so that divergence is additive, not a
// fork of this function.
const createCmView = (containerEl, extraExtensions, placeholderText) => {
  const state = CmEditorState.create({
    doc: editorText.value || '',
    extensions: [
      CmLineNumbers(),
      CmEditorView.lineWrapping,
      ...extraExtensions,
      cmPlaceholder(placeholderText),
      CmKeymap.of(CM_SAFE_KEYMAP),
      CmEditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newText = update.state.doc.toString();
          if (editorText.value !== newText) editorText.value = newText;
        }
        if (update.docChanged || update.selectionSet) updateActiveLoopContext();
      }),
      CmEditorView.theme({
        '&': { height: '100%', fontSize: '0.85rem' },
        '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
        '.cm-content, .cm-gutters': { minHeight: '100%' },
      }),
    ],
  });
  const view = new CmEditorView({ state, parent: containerEl });
  view.scrollDOM.addEventListener('scroll', saveScrollState);
  return view;
};

const createCodeMirrorView = () => {
  if (!codeMirrorContainerRef.value || codeMirrorView) return;
  codeMirrorView = createCmView(codeMirrorContainerRef.value, [jinjaHighlightPlugin, jinjaTagMatchPlugin], 'Escriu o edita la teva plantilla Jinja2 en Markdown aquí...');
  textareaRef.value = makeTextareaShim(codeMirrorView);
};

// Visual tab, Phase A: looks exactly like Codi for now (same highlighting/
// tag-matching plugins, no rich decorations yet) -- later phases add
// widget/decoration extensions here without touching the Codi instance.
const createVisualCodeMirrorView = () => {
  if (!visualCodeMirrorContainerRef.value || visualCodeMirrorView) return;
  visualCodeMirrorView = createCmView(visualCodeMirrorContainerRef.value, [jinjaExpandedField, jinjaHighlightPlugin, jinjaTagMatchPlugin, markdownStylePlugin, varChipPlugin, jinjaBlockField, setInlinePlugin, inlineMathPlugin, displayMathField, tableField], 'Escriu la teva plantilla Jinja2 en Markdown aquí...');
  visualTextareaRef.value = makeTextareaShim(visualCodeMirrorView);
};

// The shim (.value/.selectionStart/.setSelectionRange/.scrollTop/.contentDOM
// -- see makeTextareaShim) for whichever tab is currently active. Now that
// both tabs are CodeMirror, every function that used to branch
// activeEditorTab.value === 'code' ? (textarea API) : (contenteditable DOM)
// converges on this single shim instead, parameterized only by which view
// is live.
const activeShim = () => (activeEditorTab.value === 'code' ? textareaRef.value : visualTextareaRef.value);
const activeCmView = () => (activeEditorTab.value === 'code' ? codeMirrorView : visualCodeMirrorView);

// Applies an editorText change that originated OUTSIDE a given CodeMirror
// view (an edit made in the OTHER tab, an undo/redo snapshot, a
// version-history restore, a modal's apply) into that view -- the shim's
// own `.value` setter already no-ops when the text already matches (the
// common case: this fires right after the view's OWN updateListener above
// set editorText.value to match what it already holds).
watch(editorText, (newVal) => {
  if (textareaRef.value) textareaRef.value.value = newVal;
  if (visualTextareaRef.value) visualTextareaRef.value.value = newVal;
});

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

// Live preview of the variable modal's expression + filter chain, evaluated
// for real against sample data via the already-running Pyodide/Jinja2
// engine (see render_expression_preview in engine.py) rather than
// reimplementing every filter's semantics in JS. Best-effort by nature: if
// the expression references a loop iterator (e.g. `part.import`), that
// iterator is bound to the FIRST row of whichever array the active
// `{% for %}` stack says it iterates — a real document would run the
// filter once per row, this only ever shows one sample. A filter can also
// legitimately resolve to a list rather than a scalar (e.g. `parts | sort
// (...)`, or the bare variable itself before any reducing filter is
// applied) — that's rendered as a compact "N elements: ..." summary rather
// than Python's stringified repr.
const filterPreviewState = ref({ status: 'idle', text: '' }); // status: idle | loading | engine-not-ready | error | ok
let filterPreviewDebounceTimer = null;
let filterPreviewRequestId = 0;

const buildSamplePreviewContext = () => {
  const base = (store.excelJsonData && typeof store.excelJsonData === 'object') ? store.excelJsonData : {};
  const ctx = { ...base };
  for (const loopCtx of activeLoopStack.value) {
    const arr = resolvePath(base, loopCtx.arrayPath, activeLoopStack.value) || findAnyArrayByName(base, loopCtx.arrayPath);
    if (Array.isArray(arr) && arr.length > 0 && arr[0] && typeof arr[0] === 'object') {
      ctx[loopCtx.iterator] = arr[0];
    }
  }
  return ctx;
};

const formatPreviewValue = (v) => {
  if (v === null || v === undefined) return '(buit)';
  if (Array.isArray(v)) {
    if (v.length === 0) return '(llista buida)';
    const items = v.slice(0, 5).map((it) => (it && typeof it === 'object') ? JSON.stringify(it) : String(it));
    const suffix = v.length > 5 ? ` … i ${v.length - 5} més` : '';
    return `${v.length} element${v.length === 1 ? '' : 's'}: ${items.join(', ')}${suffix}`;
  }
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'Cert' : 'Fals';
  if (v === '') return '(text buit)';
  return String(v);
};

const runFilterPreview = async () => {
  const expr = modalExpr.value.trim();
  if (!expr) { filterPreviewState.value = { status: 'idle', text: '' }; return; }
  if (!store.enginesReady) { filterPreviewState.value = { status: 'engine-not-ready', text: "El motor de plantilles encara s'està carregant..." }; return; }

  const filter = computedModalFilter.value.trim();
  const fullExpr = filter ? `${expr} | ${filter}` : expr;
  const myRequestId = ++filterPreviewRequestId;
  filterPreviewState.value = { status: 'loading', text: '' };
  try {
    const sampleCtx = buildSamplePreviewContext();
    const result = await previewExpression(sampleCtx, fullExpr);
    if (myRequestId !== filterPreviewRequestId) return; // a newer request has already superseded this one
    filterPreviewState.value = result.success
      ? { status: 'ok', text: formatPreviewValue(result.result) }
      : { status: 'error', text: result.error };
  } catch (e) {
    if (myRequestId !== filterPreviewRequestId) return;
    filterPreviewState.value = { status: 'error', text: e?.message || String(e) };
  }
};

const scheduleFilterPreview = () => {
  if (filterPreviewDebounceTimer) clearTimeout(filterPreviewDebounceTimer);
  filterPreviewDebounceTimer = setTimeout(runFilterPreview, 300);
};

watch([modalExpr, filterChain], () => {
  if (isVarModalOpen.value) scheduleFilterPreview();
}, { deep: true });

watch(isVarModalOpen, (open) => {
  if (open) {
    scheduleFilterPreview();
  } else {
    if (filterPreviewDebounceTimer) clearTimeout(filterPreviewDebounceTimer);
    filterPreviewState.value = { status: 'idle', text: '' };
  }
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

// Search box for the "Esquema de Dades" sidebar — models routinely have
// dozens/hundreds of fields several levels deep, so scrolling the tree to
// find one is impractical. Search runs over the already-flattened
// availableVariables/availableArrays (built once for BlockModal's own data
// browser) rather than the nested sidebarTree, so a match surfaces
// regardless of how deep the field is or whether its parent loop is
// currently active in the cursor's context.
const varSearchQuery = ref('');
const normalizeSearchText = (s) => (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const filteredVariableSearchResults = computed(() => {
  const q = normalizeSearchText(varSearchQuery.value.trim());
  if (!q) return [];
  return availableVariables.value.filter((v) => v.category !== 'array' && (
    normalizeSearchText(v.label).includes(q) || normalizeSearchText(v.path).includes(q)
  ));
});

const filteredArraySearchResults = computed(() => {
  const q = normalizeSearchText(varSearchQuery.value.trim());
  if (!q) return [];
  return availableArrays.value.filter((p) => normalizeSearchText(p).includes(q));
});

const sidebarSearchInsertArray = (arrayPath) => {
  const key = arrayPath.split('.').pop();
  const iteratorName = key.replace(/s$/, '').replace(/es$/, '') || 'item';
  sidebarInsertLoop(key, arrayPath, iteratorName, []);
};

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
// Formats editorText via a plain string splice against whichever tab is
// active's shim (both tabs are CodeMirror since Phase A of the
// Visual-editor rewrite -- there is no longer a separate contenteditable
// document.execCommand path for the Visual tab; formatDoc/insertList/
// formatBlock below all funnel into this one implementation now).
const formatCodeText = (cmd, arg = null) => {
  const el = activeShim();
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

const formatDoc = (cmd) => formatCodeText(cmd);

const insertList = (type) => {
  const cmd = (type === 'ordered' || type === 'insertOrderedList') ? 'insertOrderedList' : 'insertUnorderedList';
  formatCodeText(cmd);
};

const formatBlock = (headerTag) => {
  if (!headerTag) return;
  formatCodeText('formatBlock', headerTag);
};

// Variable Modal Trigger. `range`, when editing an existing chip, is a
// plain { from, to, raw } text span (see VarChipWidget) -- not a DOM node
// like the old canvas-based version of this function took. applyVariable
// below dispatches the edited result back over exactly that range.
const openVarModal = (range = null) => {
  saveSelection();
  activeLoopContext.value = getActiveLoopContext();
  let rawFilter = '';
  if (range) {
    activeVarChipRange = range;
    const parts = (range.raw || '').split('|');
    modalExpr.value = parts[0].trim();
    rawFilter = parts.slice(1).join('|').trim();
    modalTitle.value = "Editar Variable";
  } else {
    activeVarChipRange = null;
    modalExpr.value = '';
    rawFilter = '';
    modalTitle.value = "Inserir Variable";
  }

  filterChain.value = parseFilterChainFromRaw(rawFilter);

  isVarModalOpen.value = true;
};

// Logic Blocks Modals Trigger
// Edit-modal titles for a block whose header/chip is being edited (existing
// node) vs. inserted fresh (no node yet — only reachable for 'for'/'if'
// today, since macro/set have no toolbar "insert" button, only in-place
// editing of tags already present in the source).
const EDIT_TITLES = { for: 'Editar Bucle (FOR)', elif: 'Editar branca O SI (ELIF)', macro: 'Editar Macro', set: 'Editar Bloc SET', 'set-inline': 'Editar Assignació (SET)' };
const NEW_TITLES = { for: 'Nou Bucle (FOR)', macro: 'Nou Macro', set: 'Nou Bloc SET' };

const openBlockModal = (type, node = null) => {
  saveSelection();
  blockType.value = type;
  activeBlockEditRange = null;
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
    modalTitle.value = EDIT_TITLES[type] || 'Editar Condició (IF)';
  } else {
    activeEditNode = null;
    if (type === 'for') {
      blockModalInitialForItemVar.value = 'item';
      blockModalInitialForArrayVar.value = '';
      blockModalInitialExpr.value = 'item in ';
    } else {
      blockModalInitialExpr.value = '';
    }
    modalTitle.value = NEW_TITLES[type] || 'Nova Condició (IF)';
  }
  isBlockModalOpen.value = true;
};

// Counterpart to openBlockModal above, but for the Phase D block widgets:
// they don't have a DOM node to pass (there is none, only plain text
// offsets), and they're editing a precise TEXT SPAN, not "the block's
// whole condition attribute" -- see activeBlockEditRange's own comment.
// range.kind 'condition' pre-fills the existing expression (editing an
// open/elif tag already in the source); 'new-elif' opens the modal empty,
// for a branch that doesn't exist yet (see addElifBranch).
const openBlockModalForRange = (type, range) => {
  saveSelection();
  blockType.value = type;
  activeEditNode = null;
  activeBlockEditRange = range;
  activeLoopContext.value = getActiveLoopContext();
  const raw = range.kind === 'condition' ? range.text : '';
  if (type === 'for') {
    const parts = raw.split(/\s+in\s+/);
    blockModalInitialForItemVar.value = parts[0] ? parts[0].trim() : 'item';
    blockModalInitialForArrayVar.value = parts[1] ? parts[1].trim() : '';
    blockModalInitialExpr.value = raw || 'item in ';
  } else {
    blockModalInitialExpr.value = raw;
  }
  modalTitle.value = range.kind === 'condition' ? (EDIT_TITLES[type] || 'Editar Condició') : (EDIT_TITLES.elif || 'Afegir branca O SI (ELIF)');
  isBlockModalOpen.value = true;
};

// Math Modal Trigger
const openMathModal = (node = null) => {
  saveSelection();
  activeMathEditRange = null;
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

// Counterpart to openMathModal above, for Phase E's InlineMathWidget/
// DisplayMathWidget double-click: there's no DOM node to pass, only the
// exact "$...$"/"$$...$$" TEXT SPAN being edited (see activeMathEditRange).
const openMathModalForRange = (range) => {
  saveSelection();
  activeMathNode = null;
  activeMathEditRange = range;
  mathModalInitialExpr.value = range.expr;
  mathModalInitialType.value = range.type;
  isMathModalOpen.value = true;
};

// MathModal.vue owns the expr/type form state and reports the final values
// on apply. Editing an EXISTING formula (activeMathEditRange, set by
// double-clicking a Phase E math widget) dispatches a precise
// view.dispatch({changes:{from,to,insert}}) over that exact span; inserting
// a brand NEW one is still a plain text splice at the cursor (whichever
// tab's shim is active) -- activeMathNode (a DOM node) is dead, nothing
// sets it anymore.
const onMathApply = ({ expr, type }) => {
  if (!expr) { activeMathEditRange = null; return; }
  const wrapExpr = type === 'display' ? `$$\n${expr}\n$$` : `$${expr}$`;
  if (activeMathEditRange) {
    const range = activeMathEditRange;
    activeMathEditRange = null;
    visualCodeMirrorView?.dispatch({ changes: { from: range.from, to: range.to, insert: wrapExpr } });
    return;
  }
  const el = activeShim();
  if (!el) return;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  editorText.value = editorText.value.substring(0, start) + wrapExpr + editorText.value.substring(end);
  nextTick(() => el.setSelectionRange(start + wrapExpr.length, start + wrapExpr.length));
};


// Advanced Table Modal Trigger
const openTableModal = (table = null) => {
  saveSelection();
  activeEditTableNode = table;
  activeTableEditRange = null;
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

// Counterpart to openTableModal above, for Phase F's TableWidget "Edita
// taula" button: `range.config` already IS the exact shape
// tableModalInitialConfig needs (computed by parseDynamicTableMatch/
// parseTransposedTableMatch/findManualTables straight from the source
// text), so there's no DOM to read at all here, unlike the dead
// DOM-reading branches above.
const openTableModalForRange = (range) => {
  saveSelection();
  activeEditTableNode = null;
  activeTableEditRange = range;
  tableModalIsEditing.value = true;
  tableModalInitialConfig.value = range.config;
  isTableModalOpen.value = true;
};

// TableModal.vue owns the mode/columns/array/iterator form state and
// computes the resulting <table> HTML on apply -- unchanged by Phase F, as
// the plan intended. Editing an EXISTING table (activeTableEditRange, set
// by openTableModalForRange above) replaces its exact [from,to) span;
// inserting a brand NEW one is still a splice at the cursor. Either way the
// HTML TableModal just emitted is converted to Markdown+Jinja2 *once* here
// via htmlToMarkdown (useMarkdownJinjaCompiler.js) -- a one-shot conversion
// of freshly-generated content the modal's own config produced this very
// instant, never a round-trip of a table's previously-existing content
// (which is instead read directly from source text by
// parseDynamicTableMatch/parseTransposedTableMatch/findManualTables above,
// with no HTML detour on that read side at all).
const onTableApply = (html) => {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  const tableMarkdown = htmlToMarkdown(wrapper);
  if (!tableMarkdown) return;
  if (activeTableEditRange) {
    const range = activeTableEditRange;
    activeTableEditRange = null;
    visualCodeMirrorView?.dispatch({ changes: { from: range.from, to: range.to, insert: tableMarkdown.trim() } });
    return;
  }
  const el = activeShim();
  if (!el) return;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const insertText = `\n\n${tableMarkdown.trim()}\n\n`;
  editorText.value = editorText.value.substring(0, start) + insertText + editorText.value.substring(end);
  nextTick(() => el.setSelectionRange(start + insertText.length, start + insertText.length));
};
// Inserting a new {{ expr | filter }} is a text splice at the cursor
// (whichever tab's shim is active); editing an EXISTING one (Phase C:
// double-clicking a VarChipWidget, activeVarChipRange set to its exact
// {from, to}) dispatches a precise replace directly over that span instead
// -- always on the Visual view specifically, since chips only render
// there.
const applyVariable = () => {
  const expr = modalExpr.value.trim();
  const filter = computedModalFilter.value.trim();
  if (!expr) {
    activeVarChipRange = null;
    isVarModalOpen.value = false;
    return;
  }

  const rawJinja = filter ? `{{ ${expr} | ${filter} }}` : `{{ ${expr} }}`;

  if (activeVarChipRange) {
    visualCodeMirrorView?.dispatch({ changes: { from: activeVarChipRange.from, to: activeVarChipRange.to, insert: rawJinja } });
    activeVarChipRange = null;
  } else {
    const el = activeShim();
    if (el) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      editorText.value = editorText.value.substring(0, start) + rawJinja + editorText.value.substring(end);
      nextTick(() => el.setSelectionRange(start + rawJinja.length, start + rawJinja.length));
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

// Sidebar copy insert variable / block handler -- a precise text splice
// into whichever tab's shim is active (Phase A of the Visual-editor
// rewrite: both tabs are CodeMirror now, so the DOM-Range insertion this
// used to do for the Visual tab specifically no longer applies; Phase C/D
// render the chip/block widgets on top of this same raw text).
const sidebarCopyInsert = (expr) => {
  const isBlock = expr.includes('{%') || expr.includes('\n');
  const txt = activeShim();
  if (!txt) return;
  const start = txt.selectionStart || 0;
  const end = txt.selectionEnd || 0;
  const insertText = isBlock ? `\n\n${expr.trim()}\n\n` : (expr.startsWith('{{') ? expr : `{{ ${expr} }}`);
  editorText.value = editorText.value.substring(0, start) + insertText + editorText.value.substring(end);
  setTimeout(() => {
    txt.focus();
    txt.selectionStart = txt.selectionEnd = start + insertText.length;
    updateActiveLoopContext();
  }, 50);
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

// BlockModal.vue owns the expr/forItemVar/forArrayVar form state and
// reports the final expression string on apply. A NEW for/if/macro/set is
// a precise text splice at the cursor (block-layout shape, each tag alone
// on its own line, matching what the compiler's line-based scanner already
// expects). Editing an EXISTING block's condition, or inserting a new
// elif branch, both go through activeBlockEditRange instead (Phase D: set
// by openBlockModalForRange, called from a JinjaHeadWidget/
// JinjaBranchWidget's condition dblclick, or from addElifBranch) -- a
// precise view.dispatch({changes:{from,to,insert}}) over that exact text
// span, never a rebuild of the whole block. activeEditNode (a DOM node)
// is dead -- nothing sets it anymore, kept only because the check is
// harmless and documents the old canvas-era edit path it used to gate.
const onBlockApply = (expr) => {
  if (activeBlockEditRange) {
    const range = activeBlockEditRange;
    activeBlockEditRange = null;
    if (!expr) { isBlockModalOpen.value = false; return; }
    const insert = range.kind === 'new-elif' ? `{% elif ${expr} %}\n\n` : expr;
    visualCodeMirrorView?.dispatch({ changes: { from: range.from, to: range.to, insert } });
    isBlockModalOpen.value = false;
    return;
  }

  if (!expr || blockType.value === 'elif' || activeEditNode) {
    isBlockModalOpen.value = false;
    return;
  }

  const closeTagFor = { for: 'endfor', if: 'endif', macro: 'endmacro', set: 'endset' };
  const endTag = closeTagFor[blockType.value] || 'endif';
  const blockText = `{% ${blockType.value} ${expr} %}\n\n{% ${endTag} %}`;
  const el = activeShim();
  if (el) {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    editorText.value = editorText.value.substring(0, start) + blockText + editorText.value.substring(end);
    nextTick(() => el.setSelectionRange(start + blockText.length, start + blockText.length));
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
// Real Jinja2 syntax error (mismatched/unclosed tags, bad expressions...),
// from validateTemplateSyntax -- also only updated by "Comprova Plantilla".
// null while unchecked or when the last check found nothing wrong.
const templateSyntaxError = ref(null);

// Markdown<->Jinja2<->HTML compiler cluster (isVariableDefinedInSchema, createJinjaVarChip, table
// parsers, compileMarkdownToHtml...) lives in useMarkdownJinjaCompiler.js since these functions call
// each other directly and are not meaningfully separable.
const {
  isVariableDefinedInSchema,
  createJinjaVarChip,
  convertJinjaToChips,
  findBestKeyMatch,
  findColHeaderKeyMatch,
  compileMarkdownToHtml,
} = useMarkdownJinjaCompiler({
  store,
  activeLoopStack,
  hasCheckedTemplate,
  resolveFieldLabel,
  resolvePath,
});

// Jumps to a 1-based Jinja2 error line: switches to the Codi tab (a raw
// line number is far more legible there than in the Visual canvas, whose
// own scrollToLine strategy is heading-based) and scrolls/highlights it.
// scrollToLine itself is only reachable via store.editorActions (it's a
// local const inside onMounted, exposed there for exactly this reason --
// see the App.vue toolbar's own scrollToLine calls, same pattern).
const jumpToTemplateLine = (lineno) => {
  if (!lineno) return;
  if (activeEditorTab.value !== 'code') switchTab('code');
  nextTick(() => store.editorActions?.scrollToLine?.(lineno - 1));
};

const checkTemplateVariables = async () => {
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

  // Real Jinja2 syntax validity -- independent of the schema/variables
  // check above, and of whether an Excel is even loaded (parsing needs no
  // data context). Best-effort: if the engine isn't ready yet, skip it
  // silently rather than blocking the (already useful) variables check.
  templateSyntaxError.value = null;
  if (store.enginesReady) {
    try {
      const result = await validateTemplateSyntax(text);
      if (!result.valid) templateSyntaxError.value = result.error;
    } catch (e) {
      // A validator-internal failure shouldn't be mistaken for a template
      // syntax error -- just skip reporting one for this check.
    }
  }

  hasCheckedTemplate.value = true;

  if (templateSyntaxError.value) {
    const { line, message } = templateSyntaxError.value;
    store.addLog(`❌ La plantilla té un error de sintaxi Jinja2${line ? ` a la línia ${line}` : ''}: ${message}`, "error");
  } else if (undefinedList.length === 0) {
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
    // Rebuilding innerHTML below also resets scrollTop to 0 — preserved
    // regardless of focus (unlike the caret above), since a rebuild can be
    // triggered by something with no connection to what's focused right
    // now (e.g. project/template data finishing an async load a moment
    // after the initial render) and shouldn't silently throw away whatever
    // scroll position — the user's, or one restoreCaretState() just set —
    // was showing.
    const scrollFraction = getScrollFraction(canvasRef.value);

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

    // {% set name = expr %} leaf chip: single click toggles collapsed
    // ("name" only) vs expanded ("name = expr") in place -- no recompile, a
    // pure CSS/attribute toggle, same mechanism as .jinja-block's collapse
    // below. Double-click edits it (mirrors .j-var-chip's own dblclick above).
    canvasRef.value.querySelectorAll('.j-set-chip').forEach(c => {
      c.onclick = (e) => {
        e.stopPropagation();
        c.dataset.collapsed = c.dataset.collapsed === 'true' ? 'false' : 'true';
      };
      c.ondblclick = (e) => { e.stopPropagation(); openBlockModal('set-inline', c); };
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
        // Only the dedicated button (next to the open tag's icon) switches
        // layout now -- clicking the tag itself used to do this too, but
        // per user feedback that was unreliable/easy to miss; a single
        // explicit, always-visible button is clearer.
        const toBlockBtn = block.querySelector('.btn-to-block');
        if (toBlockBtn) {
          toBlockBtn.onclick = (e) => {
            e.stopPropagation();
            block.setAttribute('data-layout', 'block');
            block.classList.remove('inline');
            syncVisualToCode();
            syncCodeToVisual();
          };
        }
      } else {
        // macro/set render collapsed by default (see COLLAPSIBLE_BLOCK_TYPES
        // in useMarkdownJinjaCompiler.js) -- clicking the compact chip, or
        // the head's collapse button once expanded, just flips
        // data-collapsed; CSS alone (.jinja-block[data-collapsed]) handles
        // showing/hiding the head/content/footer vs. the chip. No recompile,
        // so any in-progress body edits are untouched by the toggle.
        const collapsedChip = block.querySelector(':scope > .j-collapsed-chip');
        if (collapsedChip) {
          collapsedChip.onclick = (e) => { e.stopPropagation(); block.dataset.collapsed = 'false'; };
        }
        const collapseBtn = block.querySelector('.btn-collapse');
        if (collapseBtn) {
          collapseBtn.onclick = (e) => { e.stopPropagation(); block.dataset.collapsed = 'true'; };
        }

        const condText = block.querySelector('.j-cond-text');
        if (condText) {
          condText.onclick = (e) => {
            e.stopPropagation();
            openBlockModal(type, e.target);
          };
        }

        // The label/condition are hidden until the block has focus-within
        // (collapsed-to-icon styling) — this button stays visible even then,
        // so there's always a way in to edit the condition.
        const headEditBtn = block.querySelector('.j-head-edit-btn');
        if (headEditBtn && condText) {
          headEditBtn.onclick = (e) => {
            e.stopPropagation();
            openBlockModal(type, condText);
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
    setScrollFraction(canvasRef.value, scrollFraction);
  }
};

// Handle Tab Switches
// Both tabs are CodeMirror over the same editorText since Phase A of the
// Visual-editor rewrite, so "caret position" is already the same character
// offset in both -- no more translating between a DOM Range and a source
// offset (sourceOffsetFromVisualCaret/visualCaretFromSourceOffset), the
// fragile part of this function before. Text itself never needs
// resyncing here either: both views' own updateListener + the shared
// watch(editorText, ...) above already keep it identical at all times.
const switchTab = (tab) => {
  if (tab === activeEditorTab.value) return;

  const fromShim = activeShim();
  const sourceOffset = fromShim?.selectionStart ?? 0;
  const scrollFraction = getScrollFraction(fromShim);

  activeEditorTab.value = tab;

  nextTick(() => {
    const toShim = tab === 'code' ? textareaRef.value : visualTextareaRef.value;
    if (toShim) {
      toShim.focus();
      toShim.setSelectionRange(sourceOffset, sourceOffset);
      // Set *after* focus/selection — a browser's own "scroll the caret
      // into view" reaction to that would otherwise override it.
      setScrollFraction(toShim, scrollFraction);
    }
    updateActiveLoopContext();
  });
};

// Helper to identify atomic visual chips (variables, math formulas, inline tags)
const isAtomicChip = (node) => {
  return node && node.nodeType === Node.ELEMENT_NODE && (
    node.classList.contains('j-var-chip') ||
    node.classList.contains('latex-chip') ||
    node.classList.contains('j-inline-tag') ||
    node.classList.contains('j-set-chip')
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
// onCanvasKeyDown (atomic-chip arrow-key/backspace navigation for the old
// contenteditable canvas) was deleted in Phase A of the Visual-editor
// rewrite along with the canvas itself -- CodeMirror's own atomicRanges
// facet is the planned replacement once Phase C/D introduce chip/block
// widgets to navigate around (see the phased plan). isAtomicChip/
// getParentAtomicChip/moveCaretBefore/moveCaretAfter are left in place,
// unreachable for now (still referenced by the dead-but-not-yet-deleted
// syncCodeToVisual()/getPositionAtomicAncestor() chain below, cleaned up
// together in Phase H).

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

// moveCaretToElementEnd/onCanvasClick/onCanvasMouseUp/onCanvasCopyOrCut/
// onCanvasPaste were deleted in Phase A along with the contenteditable
// canvas: CodeMirror's native selection/click and clipboard handling
// (already relied on, unmodified, by the Codi tab) covers all of this for
// the Visual tab automatically now -- no custom copy/cut/paste code needed
// (Markdown/Jinja2 source text is what a CodeMirror view's clipboard
// already contains, never HTML).

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
  const el = activeShim();
  if (el) {
    el.focus();
    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    const text = editorText.value || '';
    editorText.value = text.substring(0, start) + char + text.substring(end);
    nextTick(() => el.setSelectionRange(start + char.length, start + char.length));
  }
  isSpecialCharModalOpen.value = false;
};

// Initialize canvas on mount
const handleGlobalKeyDown = (e) => {
  const isAnyModalOpen = isVarModalOpen.value || isBlockModalOpen.value || isMathModalOpen.value || isTableModalOpen.value || isMetadataModalOpen.value || isSpecialCharModalOpen.value;

  // Handle Ctrl+1 .. Ctrl+6 shortcuts for Headings H1..H6 and Ctrl+B / Ctrl+I
  if ((e.ctrlKey || e.metaKey) && !isAnyModalOpen) {
    // Undo/Redo, unlike the formatting shortcuts below, is only handled here
    // while this editor (canvas or textarea) is actually focused — Ctrl+Z is
    // a near-universal browser shortcut, and this component stays mounted
    // for the app's whole lifetime (App.vue only CSS-hides it on other
    // tabs), so an unscoped handler would hijack Ctrl+Z away from an
    // unrelated focused input elsewhere on the page.
    const isEditorFocused = document.activeElement === textareaRef.value?.contentDOM || document.activeElement === visualTextareaRef.value?.contentDOM;
    if (isEditorFocused && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoEdit();
      return;
    }
    if (isEditorFocused && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      redoEdit();
      return;
    }
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

  // This component can be embedded inside another modal (DataInspector.vue's
  // cell-text editor), which listens for the SAME Escape/Ctrl+Enter keys on
  // `window` to close/save ITSELF. Without stopping propagation here, one
  // Escape press closes both: this component's own modal (e.g. the table
  // config modal opened from within the cell editor) AND the outer cell
  // editor modal around it, silently discarding whatever the user was
  // editing — Escape must only ever close the topmost (innermost) modal.
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    isVarModalOpen.value = false;
    isBlockModalOpen.value = false;
    isMathModalOpen.value = false;
    isTableModalOpen.value = false;
    isMetadataModalOpen.value = false;
    isSpecialCharModalOpen.value = false;
  } else if (e.key === 'Enter') {
    if (isVarModalOpen.value) {
      e.preventDefault();
      e.stopImmediatePropagation();
      applyVariable();
    } else if (isBlockModalOpen.value) {
      e.preventDefault();
      e.stopImmediatePropagation();
      blockModalRef.value?.apply();
    } else if (isMathModalOpen.value) {
      e.preventDefault();
      e.stopImmediatePropagation();
      mathModalRef.value?.apply();
    } else if (isTableModalOpen.value) {
      e.preventDefault();
      e.stopImmediatePropagation();
      tableModalRef.value?.apply();
    } else if (isMetadataModalOpen.value && e.ctrlKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
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
// A table with a row/column loop (DYNAMIC_TABLE/TRANSPOSED_TABLE) or a
// .jinja-block is serialized to Markdown by a custom turndown rule that
// reads the *whole* element's structure from scratch (dynamicTableToMarkdown,
// transposedTableToMarkdown, jinjaBlockToMarkdown in
// useMarkdownJinjaCompiler.js) rather than concatenating each child's own
// independently-converted text. Handed a *partial* DOM clone (as
// sourceOffsetFromVisualCaret's prefix-range technique does), these rules
// don't know the clone is incomplete — they still emit a fully-formed block,
// unconditionally closed with {% endfor %}/{% endif %}/<!-- ..._END --> —
// so a position landing inside one of these doesn't just approximate, it
// can come out wildly wrong. Treated as atomic here too, snapping to
// whichever edge of the *whole* table/block is closer.
const getPositionAtomicAncestor = (node) => {
  const chip = getParentAtomicChip(node);
  if (chip) return chip;
  let curr = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (curr && curr !== canvasRef.value) {
    if (curr.classList?.contains('jinja-block')) return curr;
    if (curr.tagName === 'TABLE' && (curr.querySelector('[data-jinja-for]') || curr.querySelector('[data-jinja-col-loop]'))) return curr;
    curr = curr.parentElement;
  }
  return null;
};

// Chips are short enough that "inside" isn't a meaningful position anyway
// (contenteditable="false" — a real cursor can never land there even though
// the Range API technically allows constructing one there); tables/blocks
// are treated the same way for the reason above, at the cost of losing
// precision *within* one (landing at its start or end rather than the exact
// row/cell) in exchange for never landing somewhere nonsensical. Given a
// (node, offset) pair that might fall inside either, returns the nearest
// position just before/after the whole element instead; anything else
// passes through unchanged.
const snapOutOfAtomicChip = (node, offset) => {
  const special = getPositionAtomicAncestor(node);
  if (!special || !special.parentNode) return { node, offset };
  let withinOffset = 0;
  if (node.nodeType === Node.TEXT_NODE) {
    const r = document.createRange();
    r.selectNodeContents(special);
    r.setEnd(node, Math.min(offset, node.length));
    withinOffset = r.toString().length;
  } else if (offset > 0) {
    withinOffset = (special.textContent || '').length;
  }
  const totalLen = (special.textContent || '').length;
  const closerToStart = withinOffset <= totalLen / 2;
  const parent = special.parentNode;
  const specialIndex = Array.prototype.indexOf.call(parent.childNodes, special);
  return { node: parent, offset: closerToStart ? specialIndex : specialIndex + 1 };
};

const setCaretCharacterOffsetWithin = (element, offset) => {
  if (!element || offset <= 0) return;
  let charCount = 0;
  const range = document.createRange();
  range.setStart(element, 0);
  range.collapse(true);

  const nodeStack = [element];
  let node;
  let found = false;
  let targetNode = null;
  let targetOffset = 0;

  while (!found && (node = nodeStack.pop())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const nextCharCount = charCount + node.length;
      if (offset <= nextCharCount) {
        targetNode = node;
        targetOffset = offset - charCount;
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
    const snapped = snapOutOfAtomicChip(targetNode, targetOffset);
    range.setStart(snapped.node, snapped.offset);
    range.collapse(true);

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
  const snapped = snapOutOfAtomicChip(range.startContainer, range.startOffset);
  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(canvasRef.value);
  prefixRange.setEnd(snapped.node, snapped.offset);
  return htmlToMarkdown(prefixRange.cloneContents()).length;
};

// The inverse: approximates where in the rendered visual canvas a given
// offset within editorText (source) lands. Compiling *just the prefix* up
// to that offset (the first version of this function) breaks down for any
// multi-line construct that needs its own closing marker to parse at all —
// a source offset inside a {% for %}...{% endfor %} loop, a DYNAMIC_TABLE/
// TRANSPOSED_TABLE block, or a math block truncates before the closing
// {% endfor %}/<!-- ..._END --> the prefix never reaches, so it renders as
// something wildly different (often empty) rather than "the same document,
// cut short". Instead, splice a unique marker into the *full* text (whose
// structure is always complete) and find where markdown-it/htmlToMarkdown
// placed it in the rendered text — accurate whenever the marker lands in
// ordinary text or inside a {{ variable }} expression (it becomes part of
// the chip's own label, which still contains the marker string); falls back
// to the coarser prefix-length approximation only if the marker doesn't
// survive intact (e.g. it landed inside a {% tag %} or an HTML comment).
const VISUAL_CARET_MARKER = '◈JCURSORMARK◈';

const visualCaretFromSourceOffset = (offset) => {
  if (!canvasRef.value) return;
  const fullText = editorText.value || '';
  const at = Math.min(Math.max(offset, 0), fullText.length);
  let renderedLength = 0;
  try {
    const markedText = fullText.slice(0, at) + VISUAL_CARET_MARKER + fullText.slice(at);
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = compileMarkdownToHtml(markedText);
    const markerIdx = (tempDiv.textContent || '').indexOf(VISUAL_CARET_MARKER);
    if (markerIdx !== -1) {
      renderedLength = markerIdx;
    } else {
      const prefixDiv = document.createElement('div');
      prefixDiv.innerHTML = compileMarkdownToHtml(fullText.slice(0, at));
      renderedLength = (prefixDiv.textContent || '').length;
    }
  } catch (err) {
    console.warn('Could not estimate visual caret position', err);
    return;
  }
  setCaretCharacterOffsetWithin(canvasRef.value, renderedLength);
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
const getCaretStorageKeys = () => {
  const pName = store.currentProjectName || localStorage.getItem('currentProjectName') || 'Default';
  const dName = store.activeDocName || localStorage.getItem(`${pName}:activeDocName`) || 'Document Principal';
  return { pName, dName };
};

// Persists only the scroll position (not the caret) — called from plain
// scroll events, which fire far more often than selectionchange.
const saveScrollState = () => {
  if (props.isCellMode) return;
  const { pName, dName } = getCaretStorageKeys();
  localStorage.setItem(`${pName}:doc:${dName}:scrollFraction`, getScrollFraction(activeShim()));
};

const saveCaretState = () => {
  if (props.isCellMode) return;
  const { pName, dName } = getCaretStorageKeys();

  const pos = activeShim()?.selectionStart || 0;
  localStorage.setItem(`${pName}:doc:${dName}:sourceCaretOffset`, pos);
  localStorage.setItem(`${pName}:doc:${dName}:activeEditorTab`, activeEditorTab.value);
  saveScrollState();
};

const restoreCaretState = () => {
  if (props.isCellMode) return;
  const { pName, dName } = getCaretStorageKeys();

  const savedTab = localStorage.getItem(`${pName}:doc:${dName}:activeEditorTab`);
  if (savedTab && (savedTab === 'visual' || savedTab === 'code')) {
    activeEditorTab.value = savedTab;
  }

  const savedOffset = parseInt(localStorage.getItem(`${pName}:doc:${dName}:sourceCaretOffset`) || '0', 10);
  const savedScrollFraction = parseFloat(localStorage.getItem(`${pName}:doc:${dName}:scrollFraction`) || '0');

  nextTick(() => {
    const shim = activeShim();
    if (shim) {
      if (savedOffset) {
        shim.focus();
        shim.setSelectionRange(savedOffset, savedOffset);
      }
      // Set *after* focus/selection — a browser's own "scroll the caret
      // into view" reaction to that would otherwise override it.
      setScrollFraction(shim, savedScrollFraction);
    }
  });
};

// selectionchange is a *document*-level event — it fires for any selection
// change anywhere on the page, not just within this editor, including ones
// this component itself causes indirectly. Without this check, such a
// spurious event's handler would read stale/unrelated selection state as
// if it were real and overwrite the correctly-persisted values with it —
// this is what broke reload-restored scroll position: a late data-load
// re-render fired well after restoreCaretState() had already applied it
// correctly.
const isSelectionWithinActiveEditor = () => document.activeElement === activeShim()?.contentDOM;

const handleSelectionChange = () => {
  saveSelection();
  if (isSelectionWithinActiveEditor()) saveCaretState();
  updateActiveLoopContext();
};

// onCanvasFocus/onCanvasKeyUp deleted along with the contenteditable canvas
// in Phase A -- the Visual tab's CodeMirror view's own updateListener
// (selectionSet) already calls updateActiveLoopContext(), same as Codi's.

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

// TemplateEditor stays mounted for the app's whole lifetime — App.vue only
// CSS-hides it (an "active" class toggle) when another top-level tab
// ("Dades", "Previsualització"...) is selected, so onMounted's
// restoreCaretState() below only ever runs once, at initial page load.
// Navigating away and back to "Plantilla" otherwise leaves neither editor
// focused (nothing else does it), so the caret becomes invisible even
// though its position hasn't actually changed — restore it again exactly
// as at mount time whenever this tab regains focus.
if (!props.isCellMode) {
  watch(() => store.activeTab, (newTab, oldTab) => {
    if (newTab === 'template' && oldTab !== 'template') {
      restoreCaretState();
    }
  });
}

onMounted(() => {
  window.__openPandocMetadataModal = openMetadataModal;
  const scrollToLine = (target) => {
    const lineIndex = typeof target === 'number' ? target : (target && target.lineIndex !== undefined ? target.lineIndex : 0);
    const headingIndex = typeof target === 'object' && target ? target.headingIndex : undefined;
    const rawTitle = typeof target === 'object' && target ? target.rawTitle : '';
    const textTitle = typeof target === 'object' && target ? target.text : '';

    // Both tabs are CodeMirror since Phase A of the Visual-editor rewrite --
    // scroll/select the currently-active one directly by line/char offset
    // (the old heading-DOM-based "Visual WYSIWYG canvas" strategy is gone
    // along with the canvas; Phase B+ can reintroduce heading-aware
    // scrolling as a decoration-aware refinement if needed).
    const shim = activeShim();
    if (shim) {
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
      shim.focus();
      shim.setSelectionRange(charOffset, charOffset + targetLineText.length);

      // CodeMirror knows the real rendered (wrapped) vertical position of
      // any character offset directly — lineBlockAt() replaces the old
      // hand-measured per-line-height approximation (uniform scrollHeight/
      // totalLines) entirely, and is exact rather than approximate.
      const view = activeCmView();
      if (view) {
        const top = view.lineBlockAt(Math.min(charOffset, view.state.doc.length)).top;
        shim.scrollTop = Math.max(0, top - 80);
      }
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
      undo: () => undoEdit(),
      redo: () => redoEdit(),
      canUndo: () => editHistory.canUndo.value,
      canRedo: () => editHistory.canRedo.value,
    };
  }
  createCodeMirrorView();
  createVisualCodeMirrorView();
  window.addEventListener('keydown', handleGlobalKeyDown);
  document.addEventListener('selectionchange', handleSelectionChange);
  restoreCaretState();
  updateActiveLoopContext();
});

onUnmounted(() => {
  delete window.__openPandocMetadataModal;
  window.removeEventListener('keydown', handleGlobalKeyDown);
  document.removeEventListener('selectionchange', handleSelectionChange);
  codeMirrorView?.destroy();
  codeMirrorView = null;
  visualCodeMirrorView?.destroy();
  visualCodeMirrorView = null;
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

      <button type="button" class="btn btn-secondary btn-tb" style="display: inline-flex; align-items: center; gap: 3px;" @click="openBlockModal('macro')" title="Insereix un bloc MACRO reutilitzable">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        <span>MACRO</span>
      </button>

      <button type="button" class="btn btn-secondary btn-tb" style="display: inline-flex; align-items: center; gap: 3px;" @click="openBlockModal('set')" title="Insereix un bloc SET (captura contingut en una variable)">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="9" x2="19" y2="9"/><line x1="5" y1="15" x2="19" y2="15"/></svg>
        <span>SET</span>
      </button>

      <button type="button" class="btn btn-secondary btn-tb" style="font-weight: bold; color: var(--color-primary);" @click="openSpecialCharModal()" title="Insereix caràcters especials (guió llarg, espai no separable, etc.)">
        <span>Ω</span>
      </button>

      <div style="height: 16px; width: 1px; background: var(--border-color); margin: 0 1px; flex-shrink: 0;"></div>

      <!-- Undo/Redo: one shared history across Visual and Codi (useEditHistory.js) -->
      <button
        type="button"
        class="btn btn-secondary btn-tb"
        :disabled="!editHistory.canUndo.value"
        @click="undoEdit"
        title="Desfer darrer canvi (Ctrl+Z)"
        style="display: inline-flex; align-items: center; gap: 3px;"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
        <span>Desfés</span>
      </button>
      <button
        type="button"
        class="btn btn-secondary btn-tb"
        :disabled="!editHistory.canRedo.value"
        @click="redoEdit"
        title="Refer canvi (Ctrl+Y)"
        style="display: inline-flex; align-items: center; gap: 3px;"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/></svg>
        <span>Refés</span>
      </button>
    </div>

    <!-- Template Grid: Left Column Editor Container + Right Column Data Schema Sidebar -->
    <div class="template-grid">
      <!-- Editor Canvas Wrapper -->
      <div class="editor-container">

        <!-- Visual tab: CodeMirror 6 (see createVisualCodeMirrorView() in
             <script>) — a second view over the exact same editorText as the
             Codi tab below, not a contenteditable canvas rebuilt from
             compiled HTML. Phase A of the Visual-editor rewrite: looks like
             Codi for now (no rich decorations/widgets yet — those land in
             later phases), but every edit is already a precise CodeMirror
             transaction on the one shared document, never a Markdown->HTML
             reconstruction. -->
        <div v-show="activeEditorTab === 'visual'" ref="visualCodeMirrorContainerRef" class="code-editor-wrapper"></div>

        <!-- Code Raw Editor: CodeMirror 6 (see createCodeMirrorView() in
             <script>) — gutter, line wrapping and Jinja2/Markdown
             highlighting are all native to it, mounted once into this
             container and left alone by Vue from then on (CodeMirror owns
             everything inside). -->
        <div v-show="activeEditorTab === 'code'" ref="codeMirrorContainerRef" class="code-editor-wrapper"></div>
      </div>

      <!-- Variable Clipboard Helper (Sidebar) -->
      <div class="variables-sidebar">
      <div class="variables-title">Esquema de Dades</div>

      <!-- Search box: models routinely have many fields several levels deep,
           so scrolling the tree to find one is impractical. -->
      <div v-if="store.excelJsonData" style="position: relative; margin-bottom: 0.5rem;">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: var(--text-muted); pointer-events: none;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input
          type="text"
          v-model="varSearchQuery"
          placeholder="Cerca un camp o una taula..."
          style="width: 100%; padding: 6px 26px 6px 28px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); font-size: 0.78rem; background: var(--bg-primary); color: var(--text-primary); box-sizing: border-box;"
        >
        <button
          v-if="varSearchQuery"
          type="button"
          class="btn-icon-only"
          title="Neteja la cerca"
          @click="varSearchQuery = ''"
          style="position: absolute; right: 4px; top: 50%; transform: translateY(-50%); border: none; background: none; cursor: pointer; font-size: 0.85rem; line-height: 1; color: var(--text-muted);"
        >&times;</button>
      </div>

      <!-- Manual Template Verification Trigger Card -->
      <div style="background: var(--bg-tertiary); border: 1px solid var(--border-color); padding: 8px 10px; border-radius: var(--radius-sm); margin-bottom: 0.5rem; display: flex; flex-direction: column; gap: 6px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span style="font-size: 0.72rem; font-weight: 700; color: var(--text-primary);">Verificació de Plantilla</span>
          <span v-if="hasCheckedTemplate" :style="{ color: templateSyntaxError ? 'var(--color-danger)' : (undefinedVariablesList.length === 0 ? '#10b981' : '#d97706') }" style="font-size: 0.68rem; font-weight: 700;">
            {{ templateSyntaxError ? '✗ Error de sintaxi' : (undefinedVariablesList.length === 0 ? '✓ Sense errors' : `⚠️ ${undefinedVariablesList.length} d'errors`) }}
          </span>
        </div>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          style="font-size: 0.75rem; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; gap: 6px; width: 100%; padding: 5px 8px; background: var(--bg-card); color: var(--color-primary); border-color: var(--color-primary); cursor: pointer;"
          @click="checkTemplateVariables"
          title="Comprova totes les variables i bucles de la plantilla respecte a l'esquema de dades, i la validesa sintàctica del Jinja2"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <span>Comprova Plantilla</span>
        </button>
      </div>

      <!-- Syntax Error Card (real Jinja2 parser, via validateTemplateSyntax
           in useWasmEngines.js -- catches mismatched/unclosed tags etc. that
           the visual canvas's own best-effort compiler silently leaves as
           literal text instead of reporting). Shown before the
           undefined-variables card: a syntax error is the more fundamental
           problem, and the reason the block often won't have rendered as
           expected in the first place. -->
      <div
        v-if="templateSyntaxError"
        style="border: 1px solid var(--color-danger); background: rgba(239, 68, 68, 0.06); padding: 0.5rem; border-radius: var(--radius-sm); margin-bottom: 0.5rem; display: flex; flex-direction: column; gap: 0.35rem; cursor: pointer;"
        @click="jumpToTemplateLine(templateSyntaxError.line)"
        title="Fes clic per anar a la línia de l'error a la pestanya Codi"
      >
        <div style="font-size: 0.7rem; font-weight: 700; color: var(--color-danger); display: flex; align-items: center; gap: 4px;">
          ❌ Error de sintaxi Jinja2{{ templateSyntaxError.line ? ` (línia ${templateSyntaxError.line})` : '' }}
        </div>
        <div style="font-size: 0.68rem; color: var(--text-primary); line-height: 1.35;">{{ templateSyntaxError.message }}</div>
        <div v-if="templateSyntaxError.lineText" style="font-size: 0.65rem; font-family: var(--font-mono); background: var(--bg-tertiary); color: var(--text-primary); padding: 3px 5px; border-radius: 3px; overflow-x: auto; white-space: pre;">{{ templateSyntaxError.lineText }}</div>
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
      
      <div v-if="!store.excelJsonData" style="font-size:0.75rem; color:var(--text-muted); font-style:italic">
        Carrega un Excel per generar la llista de variables disponibles.
      </div>

      <!-- Flat search results: bypasses the tree/loop-context nesting below
           entirely, since a search should find a field no matter how deep
           it lives or whether its parent loop happens to be active. -->
      <div v-else-if="varSearchQuery.trim()" style="display:flex; flex-direction:column; gap:0.6rem; flex: 1; overflow-y: auto; min-height: 0;">
        <div v-if="filteredVariableSearchResults.length === 0 && filteredArraySearchResults.length === 0" style="font-size:0.75rem; color:var(--text-muted); font-style:italic">
          Cap resultat per «{{ varSearchQuery }}».
        </div>
        <div
          v-for="v in filteredVariableSearchResults"
          :key="v.path"
          class="variable-item present"
          :style="v.isContext ? 'margin: 0; font-size: 0.75rem; padding: 4px 6px; background-color: var(--color-success-light); border-left: 3px solid var(--color-success); justify-content: space-between;' : 'margin: 0; font-size: 0.75rem; padding: 4px 6px; justify-content: space-between;'"
          @click="sidebarCopyInsert(`{{ ${v.path} }}`)"
          title="Clica per copiar i inserir variable"
        >
          <span style="font-weight: 600;">{{ v.label }}</span>
          <span class="variable-badge present" style="font-size:0.58rem;">{{ v.path }}</span>
        </div>
        <div
          v-for="arr in filteredArraySearchResults"
          :key="arr"
          class="variable-item present"
          style="background-color: var(--color-primary-light); margin: 0; font-size: 0.75rem; padding: 4px 6px; justify-content: space-between;"
          @click="sidebarSearchInsertArray(arr)"
          title="Clica per copiar i inserir bucle Jinja"
        >
          <span style="font-weight: 700; color: var(--color-primary);">Itera {{ arr }}</span>
          <span class="variable-badge present" style="background-color: var(--color-primary); color: white; font-size: 0.58rem;">Bucle</span>
        </div>
      </div>

      <template v-else>
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

        <div style="display:flex; flex-direction:column; gap:0.6rem; flex: 1; overflow-y: auto; min-height: 0;">
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
      </template>
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
            <label style="font-weight: bold; font-size: 0.8rem; margin-bottom: 4px; display: block;">Filtres Jinja2 (Opcional, encadenables)</label>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              <div
                v-for="(item, idx) in filterChain"
                :key="item.id"
                style="padding: 8px; background: var(--bg-tertiary, #f8f9fa); border-radius: 6px; border: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 6px;"
              >
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span style="font-size: 0.7rem; font-weight: bold; color: var(--text-muted); min-width: 14px;">{{ idx + 1 }}.</span>
                  <select v-model="item.name" @change="onFilterStepNameChange(item)" style="flex: 1; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border-color); font-size: 0.8rem; background: var(--bg-primary); color: var(--text-primary);">
                    <option value="">-- Selecciona un filtre --</option>
                    <optgroup v-for="group in FILTER_GROUPS" :key="group" :label="group">
                      <option v-for="f in groupedFilterCatalog[group]" :key="f.name" :value="f.name">{{ f.label }}</option>
                    </optgroup>
                  </select>
                  <button type="button" class="btn-icon-only" title="Mou amunt" :disabled="idx === 0" @click="moveFilterChainStep(item.id, -1)" style="border: none; background: none; cursor: pointer; opacity: 0.75; display: inline-flex; align-items: center;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
                  </button>
                  <button type="button" class="btn-icon-only" title="Mou avall" :disabled="idx === filterChain.length - 1" @click="moveFilterChainStep(item.id, 1)" style="border: none; background: none; cursor: pointer; opacity: 0.75; display: inline-flex; align-items: center;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                  </button>
                  <button type="button" class="btn-icon-only" title="Elimina aquest filtre" @click="removeFilterChainStep(item.id)" style="border: none; background: none; cursor: pointer; color: var(--color-danger); display: inline-flex; align-items: center;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                </div>
                <div v-if="filterParamDefs(item.name).length" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px;">
                  <div v-for="p in filterParamDefs(item.name)" :key="p.key">
                    <label v-if="p.type !== 'boolean'" style="font-size: 0.7rem; color: var(--text-muted); display: block;">{{ p.label }}</label>
                    <label v-if="p.type === 'boolean'" style="font-size: 0.75rem; color: var(--text-primary); display: flex; align-items: center; gap: 5px; margin-top: 4px; cursor: pointer;">
                      <input type="checkbox" v-model="item.params[p.key]">
                      {{ p.label }}
                    </label>
                    <select v-else-if="p.type === 'select'" v-model="item.params[p.key]" style="width: 100%; padding: 4px 8px; font-size: 0.8rem; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary);">
                      <option v-for="opt in p.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                    </select>
                    <input v-else :type="p.type === 'number' ? 'number' : 'text'" v-model="item.params[p.key]" :placeholder="p.placeholder || p.default || ''" style="width: 100%; padding: 4px 8px; font-size: 0.8rem; font-family: var(--font-mono);">
                  </div>
                </div>
              </div>
              <button type="button" class="btn btn-secondary" style="width: auto; align-self: flex-start; font-size: 0.8rem; padding: 4px 10px;" @click="addFilterChainStep">+ Afegeix filtre</button>
            </div>
          </div>

          <!-- Live Code Preview -->
          <div style="padding: 8px 12px; background: rgba(0, 122, 255, 0.08); border: 1px solid rgba(0, 122, 255, 0.2); border-radius: 6px; display: flex; align-items: center; justify-content: space-between;">
            <span style="font-size: 0.72rem; font-weight: bold; color: var(--color-primary); text-transform: uppercase;">Vista Prèvia Jinja2:</span>
            <code style="font-family: var(--font-mono); font-size: 0.82rem; font-weight: bold; color: var(--text-primary);">&#123;&#123; {{ modalExpr || 'variable' }}{{ computedModalFilter ? ' | ' + computedModalFilter : '' }} &#125;&#125;</code>
          </div>

          <!-- Live Result Preview: evaluates against real sample data via
               the Pyodide/Jinja2 engine, not a JS reimplementation. -->
          <div
            v-if="filterPreviewState.status !== 'idle'"
            style="padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-color); display: flex; align-items: flex-start; gap: 8px;"
            :style="filterPreviewState.status === 'error' ? 'background: var(--color-warning-light, #fffbeb); border-color: var(--color-warning, #f59e0b);' : 'background: var(--bg-tertiary, #f8f9fa);'"
          >
            <span style="font-size: 0.72rem; font-weight: bold; text-transform: uppercase; white-space: nowrap; padding-top: 1px;" :style="filterPreviewState.status === 'error' ? 'color: var(--color-warning-hover, #d97706);' : 'color: var(--text-secondary);'">Resultat:</span>
            <span v-if="filterPreviewState.status === 'loading'" style="font-size: 0.8rem; color: var(--text-muted); font-style: italic;">Calculant...</span>
            <span v-else-if="filterPreviewState.status === 'engine-not-ready'" style="font-size: 0.8rem; color: var(--text-muted); font-style: italic;">{{ filterPreviewState.text }}</span>
            <span v-else-if="filterPreviewState.status === 'error'" style="font-size: 0.78rem; color: var(--color-warning-hover, #d97706);" :title="filterPreviewState.text">No es pot previsualitzar aquí: {{ filterPreviewState.text }}</span>
            <span v-else style="font-size: 0.82rem; font-family: var(--font-mono); color: var(--text-primary); word-break: break-word;">{{ filterPreviewState.text }}</span>
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

/* Code editor: CodeMirror 6 (mounted by createCodeMirrorView() in <script>
   into the plain .code-editor-wrapper container below — gutter, line
   wrapping and content are CodeMirror's own DOM, one rendering pass, so
   nothing here can fall out of sync with anything else by construction,
   unlike the old separately-measured gutter + backdrop it replaced). This
   edits prose (Jinja2/Markdown source), not short code lines, so long
   lines wrap rather than scrolling horizontally like a typical code
   editor would (see EditorView.lineWrapping in createCodeMirrorView()). */
.code-editor-wrapper {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
  background-color: var(--bg-card);
}

.code-editor-wrapper .cm-editor {
  flex: 1;
  min-width: 0;
}

.code-editor-wrapper .cm-scroller {
  overflow: auto;
}

.code-editor-wrapper .cm-gutters {
  background-color: var(--bg-tertiary);
  color: var(--text-muted);
  border-right: 1px solid var(--border-color);
}

.code-editor-wrapper .cm-content {
  padding: 1rem;
  color: var(--text-primary);
  caret-color: var(--text-primary);
}

.code-editor-wrapper .cm-line {
  padding: 0;
}

[data-theme="dark"] .code-editor-wrapper .cm-content,
body.dark-theme .code-editor-wrapper .cm-content {
  caret-color: #f8fafc;
}

.tok-comment { color: var(--text-muted); font-style: italic; }
.tok-jinja-block { color: #b45309; font-weight: 600; }
.tok-jinja-var { color: var(--color-primary); font-weight: 600; }
.tok-math { color: #7c3aed; font-weight: 600; }
.tok-header { color: var(--text-primary); font-weight: 700; }
.tok-bold { font-weight: 700; }
.tok-italic { font-style: italic; }

/* Phase B of the Visual-editor rewrite (markdownStylePlugin, Visual tab
   only): real bold/size, not just syntax coloring -- what the rendered
   document actually looks like, while the raw "#"/"**"/"-" characters
   stay visible and directly editable as plain text. */
.cm-md-heading { font-weight: 700; color: var(--text-primary); }
.cm-md-h1 { font-size: 1.5em; }
.cm-md-h2 { font-size: 1.3em; }
.cm-md-h3 { font-size: 1.15em; }
.cm-md-h4 { font-size: 1.05em; }
.cm-md-h5 { font-size: 1em; }
.cm-md-h6 { font-size: 0.95em; color: var(--text-secondary); }
.cm-md-bold { font-weight: 700; }
.cm-md-italic { font-style: italic; }
.cm-md-list-marker { color: var(--color-primary); font-weight: 700; }

/* Jinja block tag matching (open/elif/else/close), highlighted as a family
   whenever the caret touches one of them -- the same UX as bracket matching
   for ()/[]/{}, applied to our own {% for %}/{% endfor %} vocabulary since
   CodeMirror's built-in bracketMatching can't pair multi-character tags
   (see computeJinjaTagRanges in the <script> above). */
.cm-jinja-tag-match {
  background-color: rgba(180, 83, 9, 0.18);
  border-radius: 3px;
}
.cm-jinja-tag-nomatch {
  background-color: rgba(220, 38, 38, 0.22);
  border-radius: 3px;
}

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

/* Phase D of the Visual-editor rewrite: for/if/macro/set block widgets
   (header/branch/footer line-replacements + collapsed macro/set summary). */
.j-block-head, .j-block-branch, .j-block-foot, .j-block-collapsed {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  border-radius: 4px;
  user-select: none;
}

.j-block-head, .j-block-collapsed { margin-top: 4px; font-weight: 600; }
.j-block-branch { margin-left: 0; }
.j-block-foot { margin-bottom: 4px; opacity: 0.75; }

.j-block-head-for { background-color: var(--color-primary-light); border: 1px solid var(--border-focus); }
.j-block-head-if { background-color: var(--color-warning-light); border: 1px solid var(--color-warning); }
.j-block-head-macro, .j-block-head-set { background-color: var(--bg-tertiary, #f1f3f5); border: 1px solid var(--border-color); }

.j-block-icon { font-size: 0.85rem; }
.j-block-label { font-weight: 700; letter-spacing: 0.02em; opacity: 0.8; }

.j-block-cond {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
  padding: 0 2px;
}
.j-block-cond:hover { text-decoration: underline dotted; }

.j-block-actions { display: inline-flex; gap: 2px; flex-shrink: 0; }

.j-block-btn {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 0.72rem;
  padding: 1px 5px;
  border-radius: 3px;
  opacity: 0.7;
  color: inherit;
}
.j-block-btn:hover { opacity: 1; background-color: rgba(0, 0, 0, 0.08); }
.j-block-chevron { font-size: 0.7rem; }
.j-block-delete:hover { background-color: rgba(220, 38, 38, 0.15); }

/* Body lines between a block's header/branch/footer widgets -- real,
   still-editable text, only ever given a left border + slight indent so
   nested blocks read visually like nested brackets. Multiple decorations
   stack their classes on a deeply-nested line (CodeMirror merges the
   `attributes` of several Decoration.line() ranges at the same line). */
.cm-jinja-body {
  border-left: 2px solid var(--border-color);
  padding-left: 10px;
  margin-left: 4px;
}
.cm-jinja-body-for { border-left-color: var(--color-primary); }
.cm-jinja-body-if { border-left-color: var(--color-warning); }

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

.jinja-block[data-type="macro"] {
  border-left-color: #0e7490;
}

.jinja-block[data-type="set"] {
  border-left-color: #15803d;
}

.jinja-block:hover {
  border-color: rgba(2, 132, 199, 0.4);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
}

/* macro/set render collapsed by default: only the small chip below shows,
   the usual head/content/footer box (border, shadow, absolute-positioned
   pills) is suppressed entirely rather than just hiding its text the way
   for/if's :focus-within rule does above -- there's a real body to hide,
   not just a label. Toggled purely by the data-collapsed attribute
   (TemplateEditor.vue flips it on click, no recompile involved). */
.jinja-block[data-collapsed="true"] {
  display: inline-block;
  border: none;
  border-radius: 0;
  box-shadow: none;
  background: none;
  margin: 0.15rem 0;
}

.jinja-block[data-collapsed="true"] > .j-head,
.jinja-block[data-collapsed="true"] > .j-content,
.jinja-block[data-collapsed="true"] > .j-branch,
.jinja-block[data-collapsed="true"] > .j-footer {
  display: none;
}

.j-collapsed-chip {
  display: none;
  align-items: center;
  gap: 5px;
  background-color: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 2px 8px;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}

.jinja-block[data-collapsed="true"] > .j-collapsed-chip {
  display: inline-flex;
}

.jinja-block[data-type="macro"] > .j-collapsed-chip {
  color: #0e7490;
  border-color: #0e7490;
}

.jinja-block[data-type="set"] > .j-collapsed-chip {
  color: #15803d;
  border-color: #15803d;
}

.j-collapsed-chip:hover {
  filter: brightness(0.95);
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

/* The switch-to-block button sits inside the open tag itself (next to its
   icon, see buildInlineJinjaHtml/btnToBlockHtml in
   useMarkdownJinjaCompiler.js) and is always visible -- no separate
   hover/focus-revealed toolbar needed. */
.btn-to-block {
  margin-left: 1px;
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

.jinja-block[data-type="macro"] .j-cond-text {
  color: #0e7490;
}

.jinja-block[data-type="set"] .j-cond-text {
  color: #15803d;
}

/* {% set name = expr %} leaf chip -- same family as .j-var-chip, green-toned
   to match the "set" block color above. Collapsed by default: only
   .j-cond-text-collapsed ("name") shows; a click flips data-collapsed and
   swaps in .j-cond-text-expanded ("name = expr") instead. */
.j-set-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background-color: rgba(21, 128, 61, 0.08);
  color: #15803d;
  border: 1px solid rgba(21, 128, 61, 0.45);
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
}

.j-set-chip:hover {
  background-color: #15803d;
  color: white;
}

.j-set-chip[data-collapsed="true"] .j-cond-text-expanded {
  display: none;
}

.j-set-chip:not([data-collapsed="true"]) .j-cond-text-collapsed {
  display: none;
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

[data-theme="dark"] .jinja-block[data-type="macro"],
body.dark-theme .jinja-block[data-type="macro"] {
  border-left-color: #22d3ee !important;
}

[data-theme="dark"] .jinja-block[data-type="set"],
body.dark-theme .jinja-block[data-type="set"] {
  border-left-color: #4ade80 !important;
}

[data-theme="dark"] .jinja-block[data-type="macro"] > .j-collapsed-chip,
body.dark-theme .jinja-block[data-type="macro"] > .j-collapsed-chip {
  color: #22d3ee !important;
  border-color: #22d3ee !important;
}

[data-theme="dark"] .jinja-block[data-type="set"] > .j-collapsed-chip,
body.dark-theme .jinja-block[data-type="set"] > .j-collapsed-chip {
  color: #4ade80 !important;
  border-color: #4ade80 !important;
}

[data-theme="dark"] .j-set-chip,
body.dark-theme .j-set-chip {
  background-color: rgba(34, 197, 94, 0.3) !important;
  color: #ffffff !important;
  border: 1.5px solid #4ade80 !important;
  font-weight: 700 !important;
  box-shadow: 0 0 8px rgba(74, 222, 128, 0.4);
}

[data-theme="dark"] .j-set-chip:hover,
body.dark-theme .j-set-chip:hover {
  background-color: #4ade80 !important;
  color: #0b0f19 !important;
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

[data-theme="dark"] .jinja-block[data-type="macro"] .j-cond-text,
body.dark-theme .jinja-block[data-type="macro"] .j-cond-text {
  background-color: rgba(34, 211, 238, 0.3) !important;
  color: #ffffff !important;
  border: 1px solid #22d3ee !important;
  font-weight: 700 !important;
}

[data-theme="dark"] .jinja-block[data-type="set"] .j-cond-text,
body.dark-theme .jinja-block[data-type="set"] .j-cond-text {
  background-color: rgba(74, 222, 128, 0.3) !important;
  color: #ffffff !important;
  border: 1px solid #4ade80 !important;
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

/* Phase F of the Visual-editor rewrite: table widgets (manual/dynamic/
   transposed). The preview <table> itself reuses the generic table/th/td
   rules above -- only the wrapper, the loop badge and the clickable-header
   affordance are new here. */
.j-table-widget {
  margin: 0.4rem 0;
}

.j-table-loop-badge {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--color-primary);
  margin-bottom: 2px;
}

.j-table-preview {
  margin: 0.25rem 0 1rem 0;
}

.j-table-th-clickable {
  cursor: pointer;
}

.j-table-th-clickable:hover {
  background-color: var(--color-primary-light);
}
</style>
