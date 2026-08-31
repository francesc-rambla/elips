<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import VisualGridEditorModal from './VisualGridEditorModal.vue';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  groupName: { type: String, default: '' },
  configList: { type: Array, default: () => [] },
  groupLabel: { type: String, default: '' },
  selectedLayout: { type: String, default: 'vertical' },
  itemTitleFormula: { type: String, default: '' }
});

const emit = defineEmits(['update:modelValue', 'save', 'copyGroup', 'pasteGroup']);

const store = useWorkspaceStore();

const localGroupLabel = ref('');
const localSelectedLayout = ref('vertical');
const localItemTitleFormula = ref('');
const localConfigList = ref([]);
const isVisualGridModalOpen = ref(false);

// Formula Modal State - declared below near helper functions

const handleKeydown = (e) => {
  if (!props.modelValue) return;
  if (isVisualGridModalOpen.value) return;

  if (isFormulaModalOpen.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      isFormulaModalOpen.value = false;
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.target?.tagName?.toLowerCase() !== 'textarea')) {
      e.preventDefault();
      saveFormulaModal();
    }
    return;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal();
  } else if (e.key === 'Enter') {
    const tag = e.target?.tagName?.toLowerCase();
    if (tag === 'textarea' && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    handleSave();
  }
};

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
});

watch(() => props.modelValue, (newVal) => {
  if (newVal) {
    localGroupLabel.value = props.groupLabel || '';
    localSelectedLayout.value = props.selectedLayout || 'vertical';
    localItemTitleFormula.value = props.itemTitleFormula || '';
    localConfigList.value = (props.configList || []).map(item => {
      let fn = item.calcFn;
      const isCalc = item.isCalculated === true || 
                     item.sourceType === 'computed' || 
                     item.type === 'Computed' || 
                     Boolean(item.calcFormula && item.calcFormula.trim() !== '') || 
                     (Boolean(fn) && fn !== 'NONE' && fn !== '');
      if (!fn) {
        fn = isCalc ? 'FORMULA' : 'NONE';
      }
      if (fn === 'CUSTOM') fn = 'FORMULA';
      if (fn === 'AVG') fn = 'AVERAGE';
      return {
        ...item,
        isCalculated: isCalc,
        calcFn: fn,
        calcFormula: item.calcFormula || ''
      };
    });
  }
});

const insertFieldIntoTitleFormula = (fieldName) => {
  if (!localItemTitleFormula.value || localItemTitleFormula.value.trim() === '') {
    localItemTitleFormula.value = fieldName;
  } else if (localItemTitleFormula.value.includes('CONCAT(') || localItemTitleFormula.value.includes('CONCATENA(')) {
    const lastParen = localItemTitleFormula.value.lastIndexOf(')');
    if (lastParen !== -1) {
      const before = localItemTitleFormula.value.substring(0, lastParen).trim();
      const sep = (before.endsWith('(') || before.endsWith(';') || before.endsWith(',')) ? '' : '; ';
      localItemTitleFormula.value = before + sep + fieldName + ')';
    } else {
      localItemTitleFormula.value += '; ' + fieldName;
    }
  } else {
    localItemTitleFormula.value = `CONCAT(${localItemTitleFormula.value}; " - "; ${fieldName})`;
  }
};

const wrapTitleFormulaWithConcat = () => {
  const cur = localItemTitleFormula.value.trim();
  if (!cur) {
    const firstTwo = localConfigList.value.slice(0, 2).map(x => x.element);
    if (firstTwo.length >= 2) {
      localItemTitleFormula.value = `CONCAT(${firstTwo[0]}; " - "; ${firstTwo[1]})`;
    } else if (firstTwo.length === 1) {
      localItemTitleFormula.value = `CONCAT(${firstTwo[0]}; ; import)`;
    } else {
      localItemTitleFormula.value = `CONCAT(titol; ; import)`;
    }
  } else if (!cur.startsWith('CONCAT(') && !cur.startsWith('CONCATENA(')) {
    localItemTitleFormula.value = `CONCAT(${cur})`;
  }
};

const onCalculatedToggle = (item) => {
  if (item.isCalculated) {
    item.sourceType = 'computed';
    if (!item.calcFn || item.calcFn === 'NONE') {
      item.calcFn = 'FORMULA';
    }
  } else {
    if (item.type !== 'Select') {
      item.sourceType = 'static';
    }
    item.calcFn = 'NONE';
    if (item.type !== 'Computed') {
      item.calcFormula = '';
    }
  }
};

const closeModal = () => {
  emit('update:modelValue', false);
};

const restoreFromExcel = async () => {
  if (store.dataActions?.restoreConfigFromExcel) {
    const ok = await store.dataActions.restoreConfigFromExcel();
    if (ok) {
      const metaList = (store.editorMetadata || []).filter(m => m.group === props.groupName);
      if (metaList.length > 0) {
        const groupHeader = metaList.find(m => m.isGroupHeader);
        if (groupHeader) {
          if (groupHeader.label) localGroupLabel.value = groupHeader.label;
          if (groupHeader.groupLayout) localSelectedLayout.value = groupHeader.groupLayout;
          if (groupHeader.itemTitleFormula) localItemTitleFormula.value = groupHeader.itemTitleFormula;
        }
        const fieldMetas = metaList.filter(m => !m.isGroupHeader);
        if (fieldMetas.length > 0) {
          localConfigList.value = fieldMetas.map(item => ({
            ...item,
            isCalculated: item.type === 'Computed' || item.sourceType === 'computed' || (item.calcFn && item.calcFn !== 'NONE') || Boolean(item.calcFormula)
          }));
        }
      }
    }
  }
};

const handleSave = () => {
  const cleanedList = localConfigList.value.map(item => {
    const copy = { ...item };
    if (copy.type === 'Computed') {
      copy.isCalculated = true;
      copy.sourceType = 'computed';
    }
    
    if (copy.isCalculated) {
      copy.isCalculated = true;
      copy.sourceType = 'computed';
      if (copy.calcFn === 'FORMULA') {
        copy.calcFn = 'CUSTOM';
      } else if (copy.calcFn === 'AVERAGE') {
        copy.calcFn = 'AVG';
      } else if (!copy.calcFn || copy.calcFn === 'NONE') {
        copy.calcFn = 'CUSTOM';
      }
    } else {
      copy.isCalculated = false;
      if (copy.type !== 'Select') {
        copy.sourceType = 'static';
      }
      copy.calcFn = 'NONE';
      if (copy.type !== 'Computed') {
        copy.calcFormula = '';
      }
    }
    return copy;
  });

  emit('save', {
    groupLabel: localGroupLabel.value,
    selectedLayout: localSelectedLayout.value,
    itemTitleFormula: localItemTitleFormula.value,
    configList: cleanedList
  });
  closeModal();
};

const addNewFieldToConfig = () => {
  const key = prompt("Introdueix el nom del nou camp/clau (es sanititzarà automàticament):");
  if (!key) return;
  const cleanKey = key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  
  if (!localConfigList.value.some(i => i.element === cleanKey)) {
    localConfigList.value.push({
      element: cleanKey,
      label: '',
      type: 'Text',
      isCalculated: false,
      sourceType: 'static',
      optionsRaw: '',
      vectorPath: '',
      displayField: '',
      valueField: '',
      multiple: false,
      width: '',
      calcFn: 'NONE',
      calcVector: '',
      calcTargetCol: '',
      calcFormula: '',
      gridRow: '',
      gridOrder: '',
      gridFill: false
    });
  }
};

const removeFieldFromConfig = (idx) => {
  if (confirm(`Estàs segur de voler eliminar el camp '${localConfigList.value[idx]?.element}' d'aquesta configuració?`)) {
    localConfigList.value.splice(idx, 1);
  }
};

const getAvailableTables = () => {
  const result = new Set();

  if (!store.excelJsonData) return [];

  // Helper to recursively discover all array keys in an object tree
  const findArrayKeys = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 10) return;
    
    if (Array.isArray(obj)) {
      obj.forEach(item => {
        if (item && typeof item === 'object') {
          Object.keys(item).forEach(k => {
            if (!k.startsWith('_') && Array.isArray(item[k])) {
              result.add(k);
              findArrayKeys(item[k], depth + 1);
            }
          });
        }
      });
    } else {
      Object.keys(obj).forEach(k => {
        if (!k.startsWith('_')) {
          if (Array.isArray(obj[k])) {
            result.add(k);
            findArrayKeys(obj[k], depth + 1);
          } else if (typeof obj[k] === 'object' && obj[k] !== null) {
            findArrayKeys(obj[k], depth + 1);
          }
        }
      });
    }
  };

  // 1. Search in store.excelJsonData for the current group first
  if (props.groupName && store.excelJsonData[props.groupName]) {
    findArrayKeys(store.excelJsonData[props.groupName]);
  }

  // 2. Deep search across the entire store.excelJsonData tree
  findArrayKeys(store.excelJsonData);

  // 3. Search in store.editorMetadata for any fields defined as type === 'Table' or having vectorPath
  if (Array.isArray(store.editorMetadata)) {
    store.editorMetadata.forEach(meta => {
      if (meta.type === 'Table' && meta.element) {
        result.add(meta.element);
      }
      if (meta.vectorPath) {
        result.add(meta.vectorPath);
      }
    });
  }

  return Array.from(result);
};

const getChildTableColumns = (vectorName) => {
  if (!vectorName || !store.excelJsonData) return [];

  // 1. Check if vectorName is a top-level key in store.excelJsonData
  if (Array.isArray(store.excelJsonData[vectorName])) {
    const list = store.excelJsonData[vectorName];
    const sample = list.find(item => item && typeof item === 'object') || list[0];
    if (sample && typeof sample === 'object') {
      return Object.keys(sample).filter(k => !k.startsWith('_'));
    }
  }

  // 2. Deep search for array with key `vectorName` anywhere in store.excelJsonData
  let foundSample = null;
  const searchRecursive = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || foundSample || depth > 10) return;
    
    if (Array.isArray(obj)) {
      obj.forEach(item => {
        if (item && typeof item === 'object') {
          if (Array.isArray(item[vectorName]) && item[vectorName].length > 0) {
            foundSample = item[vectorName].find(s => s && typeof s === 'object') || item[vectorName][0];
            return;
          }
          Object.values(item).forEach(val => searchRecursive(val, depth + 1));
        }
      });
    } else {
      if (Array.isArray(obj[vectorName]) && obj[vectorName].length > 0) {
        foundSample = obj[vectorName].find(s => s && typeof s === 'object') || obj[vectorName][0];
        return;
      }
      Object.values(obj).forEach(val => searchRecursive(val, depth + 1));
    }
  };

  searchRecursive(store.excelJsonData);

  if (foundSample && typeof foundSample === 'object') {
    return Object.keys(foundSample).filter(k => !k.startsWith('_'));
  }

  // 3. Search store.editorMetadata for fields configured under group === vectorName
  if (Array.isArray(store.editorMetadata)) {
    const cols = store.editorMetadata
      .filter(m => m.group === vectorName && !m.isGroupHeader && m.element)
      .map(m => m.element);
    if (cols.length > 0) return cols;
  }

  return ['valor'];
};

// Formula Modal State
const isFormulaModalOpen = ref(false);
const editingFormulaItem = ref(null);
const formulaTextBuffer = ref('');
const formulaTextareaRef = ref(null);

const availableFormulaFields = computed(() => {
  if (!editingFormulaItem.value) return [];
  return localConfigList.value
    .map(item => item.element)
    .filter(f => f && f !== editingFormulaItem.value.element);
});

const globalFormulaPaths = computed(() => {
  if (!store.excelJsonData) return [];
  const paths = [];
  const isPrimitive = (val) => val === null || val === undefined || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean';

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
});

// Autocomplete state for formula modal
const autocompleteQuery = ref('');
const autocompleteIndex = ref(0);
const showAutocomplete = ref(false);
const autocompletePosition = ref({ left: 10, top: 40 });

const getCaretCoordinates = (element, position) => {
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
};

const builtinFunctions = [
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

const autocompleteCandidates = computed(() => {
  const q = autocompleteQuery.value.trim().toLowerCase();
  if (!q) return [];

  const results = [];

  // Local fields
  availableFormulaFields.value.forEach(field => {
    if (field.toLowerCase().includes(q)) {
      results.push({ name: field, insert: field, label: `Camp: ${field}`, category: '🏷️ Camp' });
    }
  });

  // Global paths
  globalFormulaPaths.value.forEach(path => {
    if (path.toLowerCase().includes(q)) {
      results.push({ name: path, insert: path, label: `Ruta: ${path}`, category: '🌐 Global' });
    }
  });

  // Builtin functions
  builtinFunctions.forEach(fn => {
    if (fn.name.toLowerCase().includes(q) || fn.label.toLowerCase().includes(q)) {
      results.push({ name: fn.name, insert: fn.insert, label: fn.label, category: '⚡ Funció' });
    }
  });

  return results.slice(0, 10);
});

const openFormulaEditor = (item) => {
  editingFormulaItem.value = item;
  formulaTextBuffer.value = item.calcFormula || '';
  showAutocomplete.value = false;
  autocompleteQuery.value = '';
  autocompleteIndex.value = 0;
  isFormulaModalOpen.value = true;
};

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

const saveFormulaModal = () => {
  if (editingFormulaItem.value) {
    editingFormulaItem.value.calcFormula = formulaTextBuffer.value;
  }
  isFormulaModalOpen.value = false;
};
</script>

<template>
  <div>
    <!-- Main Unified Group Configuration Modal -->
    <div class="modal-overlay" v-if="modelValue" style="display: flex; z-index: 1080;">
      <div class="modal-content" style="max-width: 1400px; width: 95vw; max-height: 90vh; display: flex; flex-direction: column;">
        
        <!-- Modal Header (Fixed) -->
        <div class="modal-header" style="flex-shrink: 0; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding: 0.75rem 1rem;">
          <h3 style="margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary);"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            <span>Configuració del Grup: <strong style="color: var(--color-primary);">{{ groupName }}</strong></span>
          </h3>
          <button type="button" class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="closeModal">&times;</button>
        </div>

        <!-- Fixed Action Controls Bar (Afegir camp + Editor Visual Grid - Always Visible) -->
        <div style="flex-shrink: 0; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border-color); background: var(--bg-secondary); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; z-index: 20;">
          <button 
            type="button" 
            class="btn btn-secondary" 
            style="width: auto; padding: 4px 12px; font-size: 0.75rem; height: 30px; display: inline-flex; align-items: center; gap: 4px;" 
            @click="addNewFieldToConfig"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            <span>Afegir camp/clau al grup</span>
          </button>

          <div style="display: flex; gap: 8px; align-items: center;">
            <button 
              type="button" 
              class="btn btn-secondary" 
              style="width: auto; padding: 4px 12px; font-size: 0.75rem; height: 30px; display: inline-flex; align-items: center; gap: 6px; font-weight: 600;" 
              @click="isVisualGridModalOpen = true"
              title="Editor Visual de Grid: Organitza files, assigna camps i mou-los fàcilment de forma visual"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
              <span>Editor Visual de Grid</span>
            </button>
          </div>
        </div>

        <!-- Group Level Header Configurations (Label, Layout & Title Formula for Intermediate Elements) -->
        <div style="flex-shrink: 0; padding: 0.65rem 1rem; border-bottom: 1px solid var(--border-color); background: var(--bg-tertiary); display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between;">
            <!-- Group Label -->
            <div style="display: flex; align-items: center; gap: 8px; flex: 1 1 240px;">
              <label style="font-size: 0.75rem; font-weight: 700; color: var(--text-primary); white-space: nowrap;">Etiqueta del Grup:</label>
              <input 
                type="text" 
                v-model="localGroupLabel" 
                class="data-input" 
                placeholder="Nom visible del grup..."
                style="flex-grow: 1; height: 28px; font-size: 0.8rem;"
              />
            </div>

            <!-- Group Layout -->
            <div style="display: flex; align-items: center; gap: 8px;">
              <label style="font-size: 0.75rem; font-weight: 700; color: var(--text-primary); white-space: nowrap;">Disposició:</label>
              <select v-model="localSelectedLayout" class="data-input" style="height: 28px; font-size: 0.78rem; width: 140px;">
                <option value="vertical">Vertical (Llista)</option>
                <option value="horizontal">Horitzontal (Graella)</option>
              </select>
            </div>
          </div>

          <!-- Item Title Formula (for intermediate levels & cards) -->
          <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center; background: var(--bg-primary); padding: 6px 10px; border-radius: var(--radius-xs); border: 1px solid var(--border-color);">
            <div style="display: flex; align-items: center; gap: 6px; min-width: 200px;">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary);"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>
              <label style="font-size: 0.75rem; font-weight: 700; color: var(--color-primary); white-space: nowrap;" title="Fórmula o camp que es mostrarà com a títol resum de cada element intermedi">
                Títol dels Elements:
              </label>
            </div>
            
            <input 
              type="text" 
              v-model="localItemTitleFormula" 
              class="data-input" 
              placeholder='ex: CONCAT(titol; " - "; import) o CONCAT(titol; ;import) o {{ titol }}'
              style="flex-grow: 1; height: 28px; font-family: var(--font-mono); font-size: 0.78rem; min-width: 260px;"
            />

            <!-- Quick Pill Inserters for Available Group Fields -->
            <div style="display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
              <span style="font-size: 0.7rem; color: var(--text-muted);">Insereix:</span>
              <button 
                v-for="item in localConfigList.slice(0, 6)" 
                :key="item.element"
                type="button"
                class="btn btn-secondary"
                style="padding: 1px 5px; font-size: 0.7rem; font-family: var(--font-mono); height: 22px; width: auto;"
                @click="insertFieldIntoTitleFormula(item.element)"
                :title="'Afegeix ' + item.element + ' al títol'"
              >
                + {{ item.element }}
              </button>
              <button 
                type="button"
                class="btn btn-secondary"
                style="padding: 1px 5px; font-size: 0.7rem; font-family: var(--font-mono); height: 22px; width: auto; color: var(--color-primary); border-color: var(--color-primary);"
                @click="wrapTitleFormulaWithConcat"
                title="Aplica CONCAT(...) automàticament"
              >
                CONCAT(...)
              </button>
            </div>
          </div>
        </div>

        <!-- Scrollable Modal Body (Only table rows scroll) -->
        <div class="modal-body" style="flex: 1; min-height: 0; overflow-y: auto; padding: 0;">
          <!-- Configuration Fields Table -->
          <table class="inspector-table" style="width: 100%; border-collapse: collapse;">
            <thead style="position: sticky; top: 0; z-index: 10; background: var(--bg-tertiary); box-shadow: 0 1px 3px rgba(0,0,0,0.12);">
              <tr style="background: var(--bg-tertiary);">
                <th style="padding: 8px; text-align: left; width: 140px; background: var(--bg-tertiary);">Element / Camp</th>
                <th style="padding: 8px; text-align: left; width: 200px; background: var(--bg-tertiary);">Etiqueta formulari</th>
                <th style="padding: 8px; text-align: left; width: 140px; background: var(--bg-tertiary);">Tipus Dada</th>
                <th style="padding: 8px; text-align: center; width: 90px; background: var(--bg-tertiary);" title="Activa per calcular automàticament aquest camp amb una fórmula">Calculat?</th>
                <th style="padding: 8px; text-align: left; min-width: 360px; background: var(--bg-tertiary);">Configuració / Propietats / Càlcul</th>
                <th style="padding: 8px; text-align: center; width: 140px; background: var(--bg-tertiary);">Posició Grid</th>
                <th style="padding: 8px; text-align: center; width: 40px; background: var(--bg-tertiary);"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(item, idx) in localConfigList" :key="item.element">
                <!-- Element Name -->
                <td style="padding: 6px 8px; vertical-align: top;">
                  <strong style="font-family: var(--font-mono); font-size: 0.8rem; color: var(--text-primary); display: block; overflow: hidden; text-overflow: ellipsis;">
                    {{ item.element }}
                  </strong>
                </td>

                <!-- Form Label -->
                <td style="padding: 6px 8px; vertical-align: top;">
                  <input 
                    type="text" 
                    v-model="item.label" 
                    class="data-input" 
                    placeholder="Etiqueta visible..."
                    style="width: 100%; min-width: 180px; font-size: 0.8rem; height: 28px;"
                  />
                </td>

                <!-- Type Selector -->
                <td style="padding: 6px 8px; vertical-align: top;">
                  <select v-model="item.type" class="data-input" style="width: 100%; font-size: 0.8rem; height: 28px;">
                    <option value="Text">Text</option>
                    <option value="Number">Número</option>
                    <option value="Percentage">Percentatge (%)</option>
                    <option value="Date">Data</option>
                    <option value="Boolean">Booleà</option>
                    <option value="Select">Desplegable</option>
                    <option value="Computed">Calculat</option>
                    <option value="Table">Taula / Matriu</option>
                  </select>
                </td>

                <!-- Checkbox IsCalculated -->
                <td style="padding: 6px 8px; vertical-align: top; text-align: center;">
                  <label style="display: inline-flex; align-items: center; justify-content: center; gap: 4px; font-size: 0.78rem; cursor: pointer; user-select: none; margin-top: 4px;" title="Marca per activar el càlcul automàtic">
                    <input 
                      type="checkbox" 
                      v-model="item.isCalculated" 
                      @change="onCalculatedToggle(item)"
                    />
                    <span style="font-weight: 700; color: var(--color-primary);" v-if="item.isCalculated">🔒 Sí</span>
                    <span style="color: var(--text-muted);" v-else>No</span>
                  </label>
                </td>

                <!-- Dynamic Type Configuration Properties -->
                <td style="padding: 6px 8px; vertical-align: top;">
                  <!-- Select Config -->
                  <template v-if="item.type === 'Select'">
                    <div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 4px;">
                      <div style="display: flex; gap: 8px; align-items: center;">
                        <label style="font-size: 0.72rem; cursor: pointer;">
                          <input type="radio" value="static" v-model="item.sourceType" /> Estàtic
                        </label>
                        <label style="font-size: 0.72rem; cursor: pointer;">
                          <input type="radio" value="dynamic" v-model="item.sourceType" /> Dinàmic
                        </label>
                        <label style="font-size: 0.72rem; cursor: pointer; margin-left: 6px;" title="Permet seleccionar múltiples opcions">
                          <input type="checkbox" v-model="item.multiple" /> Múltiple
                        </label>
                      </div>

                      <input 
                        v-if="item.sourceType === 'static'"
                        type="text" 
                        v-model="item.optionsRaw" 
                        class="data-input" 
                        placeholder="Opcions separades per comes..."
                        style="width: 100%; font-size: 0.75rem; height: 26px;"
                      />
                      
                      <div v-else style="display: flex; flex-direction: column; gap: 4px;">
                        <select v-model="item.vectorPath" class="data-input" style="width: 100%; font-size: 0.75rem; height: 26px;">
                          <option value="">-- Tria Taula Origen --</option>
                          <option v-for="tbl in getAvailableTables()" :key="tbl" :value="tbl">{{ tbl }}</option>
                        </select>

                        <div v-if="item.vectorPath" style="display: flex; gap: 4px;">
                          <select v-model="item.displayField" class="data-input" style="flex: 1; font-size: 0.72rem; height: 24px;">
                            <option value="">-- Col. Text --</option>
                            <option v-for="col in getChildTableColumns(item.vectorPath)" :key="col" :value="col">{{ col }}</option>
                          </select>
                          <select v-model="item.valueField" class="data-input" style="flex: 1; font-size: 0.72rem; height: 24px;">
                            <option value="">-- Col. Valor --</option>
                            <option v-for="col in getChildTableColumns(item.vectorPath)" :key="col" :value="col">{{ col }}</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  </template>

                  <!-- Table Config -->
                  <template v-else-if="item.type === 'Table'">
                    <select v-model="item.vectorPath" class="data-input" style="width: 100%; font-size: 0.75rem; height: 26px;">
                      <option value="">-- Tria Taula / Matriu --</option>
                      <option v-for="tbl in getAvailableTables()" :key="tbl" :value="tbl">{{ tbl }}</option>
                    </select>
                  </template>

                  <!-- Calculation / Formula Config Section -->
                  <template v-if="item.isCalculated || item.type === 'Computed' || item.calcFormula || (item.calcFn && item.calcFn !== 'NONE')">
                    <div style="display: flex; flex-direction: column; gap: 4px; background: rgba(0,0,0,0.02); padding: 6px; border-radius: 4px; border: 1px solid var(--border-color);">
                      <div style="display: flex; gap: 4px; align-items: center;">
                        <span style="font-size: 0.7rem; font-weight: 700; color: var(--color-primary); white-space: nowrap;">Funció:</span>
                        <select v-model="item.calcFn" class="data-input" style="width: 100%; height: 26px; font-size: 0.75rem;">
                          <option value="FORMULA">FÓRMULA</option>
                          <option value="SUM">SUMA</option>
                          <option value="AVERAGE">MITJANA</option>
                          <option value="COUNT">RECOMPTE</option>
                          <option value="MIN">MÍNIM</option>
                          <option value="MAX">MÀXIM</option>
                          <option value="OR">BOOLEÀ OR / ALGUN (Alguna cert)</option>
                          <option value="AND">BOOLEÀ AND / TOTS (Tots certs)</option>
                          <option value="NONE">-- Sense --</option>
                        </select>
                      </div>

                      <template v-if="item.calcFn === 'FORMULA'">
                        <div style="display: flex; gap: 4px; align-items: center; margin-top: 2px;">
                          <input 
                            type="text" 
                            v-model="item.calcFormula" 
                            class="data-input" 
                            placeholder="ex: preu * unitats"
                            style="flex: 1; min-width: 260px; font-size: 0.75rem; height: 26px; font-family: var(--font-mono);"
                            title="Fórmula personalitzada d'operació"
                          />
                          <button 
                            type="button" 
                            class="btn btn-secondary" 
                            style="width: auto; padding: 2px 6px; font-size: 0.7rem; height: 26px; font-weight: 600; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px;"
                            @click="openFormulaEditor(item)"
                            title="Obre l'editor ampliat de fórmules amb autocompletat"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                            <span>Amplia</span>
                          </button>
                        </div>
                      </template>

                      <!-- If SUM, AVG, COUNT, MIN, MAX: show target sub-table options -->
                      <template v-else-if="item.calcFn && item.calcFn !== 'NONE'">
                        <select v-model="item.calcVector" class="data-input" style="width: 100%; font-size: 0.75rem; height: 26px; margin-top: 2px;">
                          <option value="">-- Tria Sub-taula Origen --</option>
                          <option v-for="tbl in getAvailableTables()" :key="tbl" :value="tbl">{{ tbl }}</option>
                        </select>

                        <select v-if="item.calcFn !== 'COUNT' && item.calcVector" v-model="item.calcTargetCol" class="data-input" style="width: 100%; font-size: 0.75rem; height: 26px; margin-top: 2px;">
                          <option value="">-- Tria Columna a operar --</option>
                          <option v-for="col in getChildTableColumns(item.calcVector)" :key="col" :value="col">{{ col }}</option>
                        </select>
                      </template>
                    </div>
                  </template>
                </td>

                <!-- Grid Position Controls (Row & Order) -->
                <td style="padding: 6px 8px; vertical-align: top; text-align: center;">
                  <div style="display: flex; flex-direction: column; gap: 4px; align-items: center;">
                    <div style="display: flex; gap: 4px; align-items: center; width: 100%;">
                      <span style="font-size: 0.68rem; color: var(--text-muted); width: 28px; text-align: right;">Fila:</span>
                      <input 
                        type="number" 
                        v-model.number="item.gridRow" 
                        min="1"
                        placeholder="1"
                        class="data-input" 
                        style="width: 45px; height: 24px; font-size: 0.75rem; text-align: center;"
                        title="Número de fila visual a la graella"
                      />
                      <span style="font-size: 0.68rem; color: var(--text-muted); width: 28px; text-align: right;">Ordre:</span>
                      <input 
                        type="number" 
                        v-model.number="item.gridOrder" 
                        min="1"
                        placeholder="1"
                        class="data-input" 
                        style="width: 45px; height: 24px; font-size: 0.75rem; text-align: center;"
                        title="Ordre de columna dins de la fila"
                      />
                    </div>
                    <label style="display: flex; align-items: center; gap: 4px; font-size: 0.7rem; color: var(--text-secondary); cursor: pointer;" title="Fes que aquest camp s'expandeixi tot l'ample de la fila">
                      <input type="checkbox" v-model="item.gridFill" /> Ocupa tota la fila
                    </label>
                  </div>
                </td>

                <!-- Row Delete Button -->
                <td style="padding: 6px 4px; vertical-align: top; text-align: center;">
                  <button 
                    type="button" 
                    class="btn-icon-only" 
                    style="color: var(--color-danger); border: none; background: transparent; cursor: pointer; padding: 4px;" 
                    @click="localConfigList.splice(idx, 1)"
                    title="Elimina aquest camp de la configuració"
                  >
                    &times;
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Modal Footer -->
        <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-color); padding-top: 0.5rem;">
          <div>
            <button 
              type="button" 
              class="btn btn-secondary" 
              style="width: auto; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 5px;" 
              @click="restoreFromExcel"
              title="Restaura totes les regles i tipus de dades des del full de càlcul Excel original"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>Restaura de l'Excel</span>
            </button>
          </div>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn btn-secondary" style="width: auto;" @click="closeModal">Cancel·la</button>
            <button type="button" class="btn btn-primary" style="width: auto;" @click="handleSave">Desa Configuració</button>
          </div>
        </div>

      </div>
    </div>

    <!-- Visual Grid Layout Drag&Drop Editor Modal -->
    <VisualGridEditorModal 
      v-model="isVisualGridModalOpen"
      :groupName="groupName" 
      :configList="localConfigList" 
    />

    <!-- Integrated Formula Editor Modal (Wider + Autocomplete + Rich Functions) -->
    <div class="modal-overlay" v-if="isFormulaModalOpen" style="display: flex; z-index: 1200;">
      <div class="modal-content" style="max-width: 1050px; width: 95vw; max-height: 90vh; display: flex; flex-direction: column; gap: 14px; overflow-y: auto;">
        
        <!-- Header -->
        <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 0.75rem;">
          <h3 style="margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary);"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
            <span>Editor Ampliat de Fórmula: <strong style="color: var(--color-primary);">{{ editingFormulaItem?.element }}</strong></span>
          </h3>
          <button type="button" class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="isFormulaModalOpen = false">&times;</button>
        </div>

        <div class="modal-body" style="display: grid; grid-template-columns: 280px 1fr; gap: 16px;">
          <!-- Left Column: Variable & Function Palette -->
          <div style="display: flex; flex-direction: column; gap: 12px; border-right: 1px solid var(--border-color); padding-right: 14px; max-height: 60vh; overflow-y: auto;">
            
            <!-- Row Fields -->
            <div>
              <span style="font-size: 0.78rem; font-weight: 700; color: var(--text-primary); display: block; margin-bottom: 6px;">🏷️ Camps de la fila:</span>
              <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                <button 
                  v-for="col in availableFormulaFields" 
                  :key="col" 
                  type="button" 
                  class="btn btn-secondary" 
                  style="padding: 3px 8px; font-size: 0.73rem; font-family: var(--font-mono); width: auto; background: var(--bg-tertiary);"
                  @click="insertTokenIntoFormula(col)"
                  :title="'Insereix el camp ' + col"
                >
                  + {{ col }}
                </button>
              </div>
            </div>

            <!-- Global Model Paths -->
            <div v-if="globalFormulaPaths.length > 0">
              <span style="font-size: 0.78rem; font-weight: 700; color: var(--text-primary); display: block; margin-bottom: 6px;">🌐 Rutes globals:</span>
              <div style="display: flex; flex-wrap: wrap; gap: 4px; max-height: 120px; overflow-y: auto;">
                <button 
                  v-for="gPath in globalFormulaPaths" 
                  :key="gPath" 
                  type="button" 
                  class="btn btn-secondary" 
                  style="padding: 2px 6px; font-size: 0.72rem; font-family: var(--font-mono); width: auto; border: 1px dashed var(--color-primary); color: var(--color-primary);"
                  @click="insertTokenIntoFormula(gPath)"
                  :title="'Insereix la ruta global ' + gPath"
                >
                  + {{ gPath }}
                </button>
              </div>
            </div>

            <!-- Functions Palette -->
            <div>
              <span style="font-size: 0.78rem; font-weight: 700; color: var(--text-primary); display: block; margin-bottom: 6px;">⚡ Funcions disponibles:</span>
              <div style="display: flex; flex-direction: column; gap: 4px;">
                <button 
                  v-for="fn in builtinFunctions" 
                  :key="fn.name" 
                  type="button" 
                  class="btn btn-secondary" 
                  style="text-align: left; padding: 4px 8px; font-size: 0.72rem; width: 100%; justify-content: flex-start; display: flex; flex-direction: column; gap: 2px;"
                  @click="insertTokenIntoFormula(fn.insert)"
                  :title="fn.label"
                >
                  <strong style="color: var(--color-primary); font-family: var(--font-mono);">{{ fn.name }}</strong>
                  <span style="font-size: 0.68rem; color: var(--text-muted);">{{ fn.label }}</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Right Column: Formula Textarea & Quick Toolbar & Autocomplete -->
          <div style="display: flex; flex-direction: column; gap: 10px; position: relative;">
            
            <!-- Quick Operators Toolbar -->
            <div style="display: flex; flex-wrap: wrap; gap: 4px; background: var(--bg-tertiary); padding: 6px; border-radius: var(--radius-xs); border: 1px solid var(--border-color);">
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' + ')">+</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' - ')">-</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' * ')">*</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' / ')">/</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' % ')">%</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' ^ ')">^</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' ( ')">(</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' ) ')">)</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' == ')">==</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' != ')">!=</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' > ')">&gt;</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' < ')">&lt;</button>
            </div>

            <!-- Formula Textarea with Autocomplete listener -->
            <div style="position: relative; flex-grow: 1;">
              <textarea 
                ref="formulaTextareaRef"
                v-model="formulaTextBuffer" 
                @keyup="onFormulaInputKey"
                @keydown="onFormulaInputKey"
                @click="onFormulaInputKey"
                class="data-input" 
                rows="8" 
                style="width: 100%; font-family: var(--font-mono); font-size: 0.88rem; padding: 10px; line-height: 1.5; resize: vertical;"
                placeholder="Escriu la fórmula. Comença a escriure el nom d'un camp o funció per veure l'autocompletat..."
              ></textarea>

              <!-- Floating Autocomplete Dropdown Panel at Caret Position -->
              <div 
                v-if="showAutocomplete && autocompleteCandidates.length > 0"
                style="position: absolute; z-index: 1300; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 6px; box-shadow: var(--shadow-md); max-height: 220px; overflow-y: auto; min-width: 290px; padding: 4px; transition: top 0.05s, left 0.05s;"
                :style="{ left: autocompletePosition.left + 'px', top: autocompletePosition.top + 'px' }"
              >
                <div style="font-size: 0.68rem; font-weight: 700; color: var(--text-muted); padding: 4px 8px; border-bottom: 1px solid var(--border-color); text-transform: uppercase;">
                  Suggereixis d'autocompletat (Prem Enter o Tab)
                </div>
                <div 
                  v-for="(cand, cIdx) in autocompleteCandidates" 
                  :key="cand.name"
                  @mousedown.prevent="selectAutocompleteCandidate(cand)"
                  style="padding: 6px 10px; font-size: 0.78rem; cursor: pointer; display: flex; align-items: center; justify-content: space-between; border-radius: 4px;"
                  :style="{ background: cIdx === autocompleteIndex ? 'var(--color-primary-light, #e0f2fe)' : 'transparent', color: cIdx === autocompleteIndex ? 'var(--color-primary, #0284c7)' : 'var(--text-primary)' }"
                >
                  <div style="display: flex; align-items: center; gap: 6px; font-family: var(--font-mono);">
                    <span style="font-weight: 700;">{{ cand.insert }}</span>
                  </div>
                  <span style="font-size: 0.68rem; color: var(--text-muted); font-weight: 600;">{{ cand.category }}</span>
                </div>
              </div>
            </div>

            <div style="font-size: 0.72rem; color: var(--text-muted); line-height: 1.4;">
              💡 <strong>Consell d'autocompletat:</strong> Comença a escriure qualsevol lletra (ex: <code>perc</code>, <code>doc.</code>, <code>SI</code>) per veure el menú desplegable. Utilitza les fletxes ⬆️ / ⬇️ i prem <strong>Enter</strong> o <strong>Tab</strong> per autocompletar.
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border-color); padding-top: 0.75rem;">
          <button type="button" class="btn btn-secondary" style="width: auto;" @click="isFormulaModalOpen = false">Cancel·la</button>
          <button type="button" class="btn btn-primary" style="width: auto;" @click="saveFormulaModal">Desa la Fórmula</button>
        </div>
      </div>
    </div>
  </div>
</template>
