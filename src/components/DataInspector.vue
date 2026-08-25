<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { useWasmEngines } from '../composables/useWasmEngines';
import NestedDataNode from './NestedDataNode.vue';
import katex from 'katex';
import { latexSymbols } from './latexSymbols';

const store = useWorkspaceStore();
const { saveExcelData, evaluateComputedFields } = useWasmEngines();
const showJsonView = ref(false);
const openSheets = ref({});
const savingExcel = ref(false);

const isExcelLoaded = computed(() => !!store.excelJsonData);

const viewMode = ref('compact'); // 'complete' or 'compact' (default: compact)
const selectedCompactSheet = ref('');

let isEvaluating = false;

// Auto-initialize selectedCompactSheet and open root sheets when data loads
watch(() => store.excelJsonData, (newVal) => {
  if (newVal && !isEvaluating) {
    isEvaluating = true;
    try {
      evaluateComputedFields(newVal);
    } finally {
      nextTick(() => {
        isEvaluating = false;
      });
    }
    const keys = Object.keys(newVal).filter(k => k !== 'editor_metadata' && k !== '_hierarchy_schema');
    if (keys.length > 0) {
      if (!selectedCompactSheet.value) {
        selectedCompactSheet.value = keys[0];
      }
      keys.forEach(k => {
        if (openSheets.value[k] === undefined) {
          openSheets.value[k] = true;
        }
      });
    }
  }
}, { immediate: true, deep: true });

const toggleSheet = (name) => {
  openSheets.value[name] = !openSheets.value[name];
};

const getSheetType = (sheetData) => {
  return Array.isArray(sheetData) ? 'tabular' : 'kv';
};

const isPrimitive = (val) => {
  return !Array.isArray(val) && (typeof val !== 'object' || val === null);
};

const getKvPrimitiveEntries = (sheetData) => {
  if (!sheetData || typeof sheetData !== 'object' || Array.isArray(sheetData)) return {};
  const res = {};
  Object.keys(sheetData).filter(k => isPrimitive(sheetData[k])).forEach(k => {
    res[k] = sheetData[k];
  });
  return res;
};

const getKvRowBlocks = (sheetData, groupName = '') => {
  if (!sheetData || typeof sheetData !== 'object' || Array.isArray(sheetData)) return [];
  const keys = Object.keys(sheetData).filter(k => isPrimitive(sheetData[k]));
  
  const items = keys.map(key => {
    const meta = getElementMetadata(groupName, key) || {};
    const rowNum = (meta.gridRow !== undefined && meta.gridRow !== null && meta.gridRow !== '') 
      ? parseInt(meta.gridRow, 10) 
      : null;
    const orderNum = (meta.gridOrder !== undefined && meta.gridOrder !== null && meta.gridOrder !== '') 
      ? parseInt(meta.gridOrder, 10) 
      : 999;
    return { key, val: sheetData[key], meta, rowNum, orderNum };
  });

  const rowMap = new Map();
  const autoItems = [];

  items.forEach(item => {
    if (item.rowNum !== null && !isNaN(item.rowNum) && item.rowNum > 0) {
      if (!rowMap.has(item.rowNum)) {
        rowMap.set(item.rowNum, []);
      }
      rowMap.get(item.rowNum).push(item);
    } else {
      autoItems.push(item);
    }
  });

  rowMap.forEach((rowItems) => {
    rowItems.sort((a, b) => a.orderNum - b.orderNum);
  });

  const sortedRowNums = Array.from(rowMap.keys()).sort((a, b) => a - b);
  
  const resultRows = [];
  sortedRowNums.forEach(rNum => {
    resultRows.push(rowMap.get(rNum));
  });

  if (autoItems.length > 0) {
    autoItems.sort((a, b) => a.orderNum - b.orderNum);
    resultRows.push(autoItems);
  }

  return resultRows;
};

const getKvFieldCardStyle = (groupName, item) => {
  const meta = item.meta || getElementMetadata(groupName, item.key) || {};
  const isTop = store.config.labelPosition === 'top';
  
  let baseStyle = isTop 
    ? 'display: flex; flex-direction: column; gap: 4px; background: var(--bg-card); padding: 8px 10px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); box-sizing: border-box;' 
    : 'display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-sm); box-sizing: border-box;';
  
  if (meta.width) {
    const w = String(meta.width).trim();
    const wVal = w.endsWith('%') || w.endsWith('px') || w.endsWith('rem') ? w : `${w}%`;
    baseStyle += ` flex: 0 0 calc(${wVal} - 10px); width: calc(${wVal} - 10px); max-width: 100%;`;
  } else if (meta.gridFill) {
    baseStyle += ' flex: 1 1 240px; min-width: 200px;';
  } else {
    baseStyle += ' flex: 1 1 200px; min-width: 180px;';
  }
  return baseStyle;
};

const formatPercentageDisplay = (val) => {
  if (val === undefined || val === null || val === '') return '';
  let strVal = String(val).replace('%', '').replace(',', '.').trim();
  const num = parseFloat(strVal);
  if (isNaN(num)) return val;
  if (-1.0 <= num && num <= 1.0 && num !== 0) {
    return Math.round(num * 100 * 10000) / 10000;
  }
  return num;
};

const updatePercentageValue = (targetObj, key, eventVal) => {
  if (!targetObj) return;
  if (eventVal === undefined || eventVal === null || eventVal === '') {
    targetObj[key] = '';
    return;
  }
  let strVal = String(eventVal).replace('%', '').replace(',', '.').trim();
  const num = parseFloat(strVal);
  if (isNaN(num)) {
    targetObj[key] = eventVal;
    return;
  }
  // Always store internally as proportion of 1 (0.7 for 70%)
  // If user typed 0.7 or 0,7 (already <= 1.0), store 0.7
  // If user typed 70 (> 1.0), store 70 / 100 = 0.7
  if (-1.0 <= num && num <= 1.0 && num !== 0) {
    targetObj[key] = num;
  } else {
    targetObj[key] = num / 100.0;
  }
};

const isRootSheet = (name) => {
  if (name === 'editor_metadata' || name === '_hierarchy_schema') return false;
  return !name.includes('.');
};

const isNonEmptySchema = (s) => {
  if (!s || typeof s !== 'object') return false;
  const hasFields = Array.isArray(s.fields) && s.fields.length > 0;
  const hasChildren = s.children && (Array.isArray(s.children) ? s.children.length > 0 : Object.keys(s.children).length > 0);
  return hasFields || hasChildren;
};

const universalFindSchema = (targetPath, dict) => {
  if (!dict || !targetPath) return { fields: [], children: {} };
  
  const cleanP = String(targetPath).replace(/\.\d+\b/g, '').replace(/^#?(dades|doc)\./, '');
  
  // 1. Direct match by node's data_path property
  for (const [k, val] of Object.entries(dict)) {
    if (val && typeof val === 'object' && val.data_path === cleanP && isNonEmptySchema(val)) {
      return val;
    }
  }

  // 2. Direct Flat Key Lookup (e.g. dict["pres.parts"])
  if (dict[cleanP] && isNonEmptySchema(dict[cleanP])) {
    return dict[cleanP];
  }
  
  // 3. Direct Tree Path Traversal (e.g. dict["pres"].children["parts"])
  const parts = cleanP.split('.').filter(Boolean);
  let curr = dict;
  let foundTree = null;
  
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (curr && typeof curr === 'object') {
      const node = curr[p] || (curr.children && typeof curr.children === 'object' && !Array.isArray(curr.children) ? curr.children[p] : null);
      if (node) {
        foundTree = node;
        curr = node.children;
      } else {
        foundTree = null;
        break;
      }
    }
  }
  if (isNonEmptySchema(foundTree)) {
    return foundTree;
  }
  
  // 4. Search by key suffix or data_path in flat dict
  const lastKey = parts[parts.length - 1];
  for (const [sKey, sVal] of Object.entries(dict)) {
    if ((sKey === cleanP || sKey === lastKey || sKey.endsWith(`.${lastKey}`) || sVal?.data_path === cleanP || sVal?.data_path?.endsWith(`.${lastKey}`)) && isNonEmptySchema(sVal)) {
      return sVal;
    }
  }
  
  // 5. Deep DFS in recursive tree dict matching data_path or node key
  const dfs = (nodeObj) => {
    if (!nodeObj || typeof nodeObj !== 'object') return null;
    for (const [k, v] of Object.entries(nodeObj)) {
      if ((k === lastKey || k === cleanP || v?.data_path === cleanP) && isNonEmptySchema(v)) {
        return v;
      }
      if (v && v.children && typeof v.children === 'object' && !Array.isArray(v.children)) {
        const sub = dfs(v.children);
        if (sub) return sub;
      }
    }
    return null;
  };
  
  const dfsResult = dfs(dict);
  if (dfsResult) return dfsResult;
  
  return { fields: [], children: {} };
};

const getGroupCleanName = (name) => {
  if (!name) return '';
  return name.includes('.') ? name.split('.').pop() : name;
};

const getTabularColumns = (groupName, sheetData) => {
  const colsSet = new Set();
  const cleanGroup = getGroupCleanName(groupName);

  // 1. Check store.editorMetadata
  if (store.editorMetadata && Array.isArray(store.editorMetadata)) {
    store.editorMetadata
      .filter(m => (m.group === groupName || m.group === cleanGroup) && m.element && !m.element.startsWith('_'))
      .forEach(m => {
        colsSet.add(m.element);
      });
  }

  // 2. Check hierarchySchema
  const schemaNode = universalFindSchema(groupName, store.hierarchySchema || {});
  if (schemaNode && Array.isArray(schemaNode.fields)) {
    schemaNode.fields.forEach(f => {
      if (f && !f.startsWith('_')) colsSet.add(f);
    });
  }

  // 3. Check sheetInfo headers
  if (store.sheetInfo && Array.isArray(store.sheetInfo)) {
    const sInfo = store.sheetInfo.find(s => 
      s.full_path === groupName || 
      s.clean_name === groupName || 
      s.clean_name === cleanGroup ||
      s.raw_name === `OUT_${groupName}` ||
      s.raw_name === groupName
    );
    if (sInfo && Array.isArray(sInfo.headers)) {
      const refK = sInfo.child_ref_key || sInfo.headers[0];
      sInfo.headers.forEach(h => {
        if (h && !h.startsWith('_') && (groupName.indexOf('.') === -1 || h !== refK)) {
          colsSet.add(h);
        }
      });
    }
  }

  // 4. Check actual data rows (if any exist)
  if (Array.isArray(sheetData) && sheetData.length > 0) {
    sheetData.forEach(row => {
      if (row && typeof row === 'object') {
        Object.keys(row).forEach(k => {
          if (isPrimitive(row[k]) && !k.startsWith('_')) {
            colsSet.add(k);
          }
        });
      }
    });
  }

  const result = Array.from(colsSet).filter(c => 
    c !== '_path' && c !== '_sheet_info' && c !== 'editor_metadata' && c !== '_hierarchy_schema' && c !== '_group_label'
  );

  return result;
};

const getTopLevelChildSchemas = (sheetName, sheetData) => {
  const dict = store.hierarchySchema || {};
  const rootS = universalFindSchema(sheetName, dict);
  const children = rootS ? rootS.children : {};
  const res = {};
  
  // 1. Child schemas defined in hierarchySchema
  if (Array.isArray(children)) {
    children.forEach(cKey => {
      if (typeof cKey === 'string') {
        const fullKey = `${sheetName}.${cKey}`;
        res[cKey] = universalFindSchema(fullKey, dict);
      }
    });
  } else if (children && typeof children === 'object') {
    Object.entries(children).forEach(([cKey, cVal]) => {
      if (isNonEmptySchema(cVal)) {
        res[cKey] = cVal;
      } else {
        const fullKey = `${sheetName}.${cKey}`;
        res[cKey] = universalFindSchema(fullKey, dict);
      }
    });
  }
  
  // 2. Non-primitive array keys present on sheetData itself (e.g. sheetData.parts)
  if (sheetData && typeof sheetData === 'object' && !Array.isArray(sheetData)) {
    Object.keys(sheetData).forEach(k => {
      if (k !== '_hierarchy_schema' && !isPrimitive(sheetData[k]) && !(k in res)) {
        res[k] = universalFindSchema(`${sheetName}.${k}`, dict);
      }
    });
  }
  
  // 3. Fallback: Search dict for any keys starting with sheetName (e.g. pres.parts)
  for (const sKey of Object.keys(dict)) {
    if (sKey === sheetName && dict[sKey]?.children) {
      Object.keys(dict[sKey].children).forEach(cK => {
        if (!(cK in res)) {
          res[cK] = universalFindSchema(`${sheetName}.${cK}`, dict);
        }
      });
    } else if (sKey.startsWith(`${sheetName}.`)) {
      const subK = sKey.slice(sheetName.length + 1).split('.')[0];
      if (subK && !(subK in res)) {
        res[subK] = universalFindSchema(`${sheetName}.${subK}`, dict);
      }
    }
  }

  return res;
};

const scrollToTargetDataPath = (path) => {
  if (!path || !store.excelJsonData) return;

  const clean = String(path).replace(/^#?(dades|doc)\./, '').replace(/\[(\d+)\]/g, '.$1');
  const parts = clean.split('.');
  if (parts.length === 0) return;

  const sheetName = parts[0];
  if (!(sheetName in store.excelJsonData)) return;

  if (viewMode.value === 'compact') {
    selectedCompactSheet.value = sheetName;
  }
  openSheets.value[sheetName] = true;

  nextTick(() => {
    let targetEl = document.querySelector(`[data-path="${clean}"]`);
    if (!targetEl) {
      const safeId = 'data-field-' + parts.join('-');
      targetEl = document.getElementById(safeId);
    }
    if (!targetEl && parts.length >= 2) {
      const rowId = `data-row-${sheetName}-${parts[1]}`;
      targetEl = document.getElementById(rowId) || document.querySelector(`[data-sheet="${sheetName}"]`);
    }

    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (typeof targetEl.focus === 'function') {
        targetEl.focus();
      }
      targetEl.classList.remove('highlight-glow');
      void targetEl.offsetWidth;
      targetEl.classList.add('highlight-glow');
      setTimeout(() => {
        targetEl.classList.remove('highlight-glow');
      }, 2500);
    }
  });
};

watch(() => store.targetDataPath, (newPath) => {
  if (newPath) {
    scrollToTargetDataPath(newPath);
  }
}, { immediate: true });

const getRowsCount = (sheetData) => {
  if (!sheetData || typeof sheetData !== 'object') return 0;
  if (Array.isArray(sheetData)) return sheetData.length;
  return Object.keys(getKvPrimitiveEntries(sheetData)).length;
};

const addKvKey = (sheetName) => {
  const key = prompt("Introdueix el nom de la nova clau (es sanititzarà automàticament):");
  if (!key) return;
  const cleanKey = key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (cleanKey in store.excelJsonData[sheetName]) {
    alert("Aquesta clau ja existeix.");
    return;
  }
  store.excelJsonData[sheetName][cleanKey] = '';
  store.addLog(`Clau '${cleanKey}' afegida al full '${sheetName}'.`, 'info');
};

const deleteKvKey = (sheetName, key) => {
  if (confirm(`Segur que vols eliminar la clau '${key}'?`)) {
    delete store.excelJsonData[sheetName][key];
    store.addLog(`Clau '${key}' eliminada del full '${sheetName}'.`, 'info');
  }
};

const isRowAllZerosOrEmpty = (row) => {
  if (!row || typeof row !== 'object') return false;
  const primitiveValues = Object.entries(row)
    .filter(([k, v]) => !k.startsWith('_') && !Array.isArray(v) && (typeof v !== 'object' || v === null))
    .map(([k, v]) => v);
  if (primitiveValues.length === 0) return true;
  return primitiveValues.every(val => val === 0 || val === 0.0 || val === '' || val === null || val === undefined || val === false || val === '0' || val === '0.0');
};

const visibleRowsCount = ref({});

const initVisibleRows = () => {
  if (!store.excelJsonData) return;
  Object.keys(store.excelJsonData).forEach(sheetName => {
    const sheetData = store.excelJsonData[sheetName];
    if (Array.isArray(sheetData)) {
      let lastNonEmptyIdx = -1;
      for (let i = sheetData.length - 1; i >= 0; i--) {
        if (!isRowAllZerosOrEmpty(sheetData[i])) {
          lastNonEmptyIdx = i;
          break;
        }
      }
      const count = sheetData.length > 0 ? Math.max(1, lastNonEmptyIdx + 1) : 0;
      visibleRowsCount.value[sheetName] = count;
    }
  });
};

watch(() => store.excelJsonData, () => {
  initVisibleRows();
}, { immediate: true, deep: false });

const addTabularRow = (sheetName, sheetData) => {
  const currentVisible = visibleRowsCount.value[sheetName] || 0;
  if (currentVisible < sheetData.length) {
    visibleRowsCount.value[sheetName] = currentVisible + 1;
    store.addLog(`S'ha reutilitzat una fila buida pre-existent de l'Excel al full '${sheetName}'.`, 'info');
  } else {
    const cols = getTabularColumns(sheetName, sheetData);
    const newRow = {};
    cols.forEach(k => {
      const meta = getElementMetadata(sheetName, k);
      if (meta && meta.type === 'Table') {
        newRow[k] = [];
      } else {
        newRow[k] = '';
      }
    });
    if (!store.excelJsonData[sheetName]) {
      store.excelJsonData[sheetName] = [];
    }
    store.excelJsonData[sheetName].push(newRow);
    visibleRowsCount.value[sheetName] = currentVisible + 1;
    store.addLog(`S'ha afegit una nova fila al final del full '${sheetName}'.`, 'info');
  }
};

const deleteTabularRow = (sheetName, idx) => {
  if (confirm(`Segur que vols eliminar la fila número ${idx + 1}?`)) {
    store.excelJsonData[sheetName].splice(idx, 1);
    if (visibleRowsCount.value[sheetName] > 0) {
      visibleRowsCount.value[sheetName]--;
    }
    store.addLog(`Fila eliminada del full '${sheetName}'.`, 'info');
  }
};

const exportExcel = async () => {
  if (!store.excelJsonData) return;
  savingExcel.value = true;
  store.addLog("S'està processant la modificació de cel·les i exportant a Excel...", "info");
  try {
    const blob = await saveExcelData(store.excelJsonData);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = store.excelFileName ? store.excelFileName.replace('.xlsx', '_editat.xlsx') : 'contractes_dades_editades.xlsx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    store.addLog("Nou fitxer Excel amb les dades actualitzades desat correctament!", "success");
  } catch (e) {
    store.addLog(`Error exportant Excel: ${e.message}`, "error");
    alert(`Error exportant Excel: ${e.message}`);
  } finally {
    savingExcel.value = false;
  }
};

// Simple syntax highlighting for JSON tree
const highlightedJson = computed(() => {
  if (!store.excelJsonData) return '';
  let str = JSON.stringify(store.excelJsonData, null, 2);
  str = str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return str.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, function (match) {
    let cls = 'json-val-num';
    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        cls = 'json-key';
        return `<span class="${cls}">${match.replace(/:$/, '')}</span>:`;
      } else {
        cls = 'json-val-str';
      }
    } else if (/true|false/.test(match)) {
      cls = 'json-val-bool';
    } else if (/null/.test(match)) {
      cls = 'json-val-null';
    }
    return `<span class="${cls}">${match}</span>`;
  });
});

// Complex Cell Editor Modal Logic
import TemplateEditor from './TemplateEditor.vue';
import VisualGridEditorModal from './VisualGridEditorModal.vue';
import GroupConfigModal from './GroupConfigModal.vue';

const isCellModalOpen = ref(false);
const cellTextValue = ref('');
const activeCellInfo = ref({ sheet: '', keyOrIdx: '', col: null, isKv: true });

const openCellEditor = (sheet, keyOrIdx, col, isKv) => {
  const colName = isKv ? keyOrIdx : col;
  if (getElementType(sheet, colName) !== 'Text') {
    store.addLog("Només els camps de tipus Text es poden editar amb l'editor visual.", "info");
    return;
  }
  activeCellInfo.value = { sheet, keyOrIdx, col, isKv };
  const val = isKv 
    ? store.excelJsonData[sheet][keyOrIdx] 
    : store.excelJsonData[sheet][keyOrIdx][col];
  cellTextValue.value = String(val || '');
  isCellModalOpen.value = true;
};

const saveCellEditor = () => {
  const { sheet, keyOrIdx, col, isKv } = activeCellInfo.value;
  if (isKv) {
    store.excelJsonData[sheet][keyOrIdx] = cellTextValue.value;
  } else {
    store.excelJsonData[sheet][keyOrIdx][col] = cellTextValue.value;
  }
  isCellModalOpen.value = false;
  store.addLog("Cel·la actualitzada correctament.", "success");
};

const handleDataInspectorModalsKeydown = (e) => {
  if (isNewSheetModalOpen.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      isNewSheetModalOpen.value = false;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      createNewSheet();
    }
    return;
  }

  if (isDataSetsModalOpen.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      isDataSetsModalOpen.value = false;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      saveDataSetsConfig();
    }
    return;
  }

  if (isMultiSelectModalOpen.value) {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      isMultiSelectModalOpen.value = false;
    }
    return;
  }

  if (isCellModalOpen.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      isCellModalOpen.value = false;
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveCellEditor();
    }
    return;
  }
};

onMounted(() => {
  window.addEventListener('keydown', handleDataInspectorModalsKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleDataInspectorModalsKeydown);
});

// Metadata Schema helpers for custom types
const getElementMetadata = (groupName, elementName) => {
  if (!store.editorMetadata) return null;
  const shortName = groupName ? groupName.split('.').pop() : '';
  const cleanGroup = groupName ? groupName.replace(/^OUT_/, '') : '';
  const cleanShort = shortName ? shortName.replace(/^OUT_/, '') : '';
  return store.editorMetadata.find(m => 
    m && m.element === elementName && (
      m.group === groupName || 
      m.group === shortName || 
      m.group === cleanGroup || 
      m.group === cleanShort ||
      m.group === `OUT_${cleanGroup}`
    )
  ) || null;
};

const isCalculatedField = (groupName, elementName) => {
  const meta = getElementMetadata(groupName, elementName);
  if (!meta) return false;
  return meta.type === 'Computed' || meta.sourceType === 'computed' || (Boolean(meta.calcFn) && meta.calcFn !== 'NONE') || (Boolean(meta.calcFormula) && meta.calcFormula.trim() !== '');
};

const getElementType = (groupName, elementName) => {
  const meta = getElementMetadata(groupName, elementName);
  if (meta && meta.type) {
    const t = String(meta.type).trim();
    if (t === 'Percentage' || t === 'Percentatge' || t === 'Porcentaje' || t === 'Percent' || t === '%') {
      return 'Percentage';
    }
    if (['Select', 'Computed', 'Table', 'Date', 'Boolean'].includes(t)) {
      return t;
    }
  }

  // Auto-detection by field name / key / label / title if type is not explicitly configured to a complex structure
  const checkStr = `${elementName || ''} ${meta?.label || ''} ${meta?.title || ''}`.toLowerCase();
  if (checkStr.includes('perc') || checkStr.includes('percent') || checkStr.includes('porcent') || checkStr.includes('pct') || checkStr.includes('%')) {
    return 'Percentage';
  }

  return meta ? (meta.type || 'Text') : 'Text';
};

const getElementOptions = (groupName, elementName) => {
  const meta = getElementMetadata(groupName, elementName);
  return meta ? meta.options || [] : [];
};

const resolveDynamicOptionsList = (vectorPath, displayField, valueField) => {
  if (!vectorPath || !store.excelJsonData || !store.excelJsonData[vectorPath]) return [];
  const list = store.excelJsonData[vectorPath];
  if (Array.isArray(list)) {
    return list.map(item => {
      if (item && typeof item === 'object') {
        const valKey = valueField || Object.keys(item)[0] || '';
        return item[valKey] !== undefined ? String(item[valKey]) : '';
      }
      return item !== undefined ? String(item) : '';
    }).filter(x => x !== '');
  }
  return [];
};

const resolveSelectOptions = (meta) => {
  if (!meta || meta.type !== 'Select') return [];
  if (meta.sourceType === 'dynamic' && meta.vectorPath) {
    const list = store.excelJsonData[meta.vectorPath];
    if (Array.isArray(list)) {
      return list.filter(item => {
        if (item && typeof item === 'object') {
          return !Object.values(item).every(val => 
            val === 0 || val === 0.0 || val === '' || val === null || val === undefined || val === false
          );
        }
        return item !== 0 && item !== 0.0 && item !== '' && item !== null && item !== undefined && item !== false;
      }).map(item => {
        if (item && typeof item === 'object') {
          const valKey = meta.valueField || Object.keys(item)[0] || '';
          const lblKey = meta.displayField || Object.keys(item)[0] || '';
          return {
            value: item[valKey] !== undefined ? item[valKey] : '',
            label: item[lblKey] !== undefined ? String(item[lblKey]) : ''
          };
        } else {
          return {
            value: item !== undefined ? item : '',
            label: item !== undefined ? String(item) : ''
          };
        }
      }).filter(opt => opt.value !== '');
    }
    return [];
  } else {
    const opts = Array.isArray(meta.options) ? meta.options : (typeof meta.options === 'string' ? meta.options.split(',').map(x => x.trim()) : []);
    return opts.map(o => ({ value: o, label: o }));
  }
};

const isOptionChecked = (cellValue, optionValue) => {
  if (cellValue === undefined || cellValue === null || cellValue === '') return false;
  if (Array.isArray(cellValue)) {
    return cellValue.includes(optionValue);
  }
  const parts = String(cellValue).split(',').map(x => x.trim());
  return parts.includes(String(optionValue));
};

const toggleOptionValue = (sheetName, isKv, rowIdxOrKey, colKey, optionValue, isChecked) => {
  let currentVal = isKv 
    ? store.excelJsonData[sheetName][rowIdxOrKey] 
    : store.excelJsonData[sheetName][rowIdxOrKey][colKey];
    
  let currentList = [];
  if (currentVal !== undefined && currentVal !== null && currentVal !== '') {
    if (Array.isArray(currentVal)) {
      currentList = [...currentVal];
    } else {
      currentList = String(currentVal).split(',').map(x => x.trim()).filter(x => x);
    }
  }
  
  const optStr = String(optionValue);
  if (isChecked) {
    if (!currentList.includes(optStr)) {
      currentList.push(optStr);
    }
  } else {
    currentList = currentList.filter(x => x !== optStr);
  }
  
  // Keep same format (array or comma string)
  const newVal = Array.isArray(currentVal) ? currentList : currentList.join(', ');
  
  if (isKv) {
    store.excelJsonData[sheetName][rowIdxOrKey] = newVal;
  } else {
    store.excelJsonData[sheetName][rowIdxOrKey][colKey] = newVal;
  }
};

const isMultiSelectModalOpen = ref(false);
const activeMultiSelectCell = ref(null);

const openMultiSelectModal = (sheetName, isKv, rowIdxOrKey, colKey, meta) => {
  activeMultiSelectCell.value = { sheetName, isKv, rowIdxOrKey, colKey, meta };
  isMultiSelectModalOpen.value = true;
};

const getCellValueForActive = () => {
  if (!activeMultiSelectCell.value) return '';
  const { sheetName, isKv, rowIdxOrKey, colKey } = activeMultiSelectCell.value;
  return isKv 
    ? store.excelJsonData[sheetName][rowIdxOrKey] 
    : store.excelJsonData[sheetName][rowIdxOrKey][colKey];
};

const toggleOptionValueForActive = (optValue, isChecked) => {
  if (!activeMultiSelectCell.value) return;
  const { sheetName, isKv, rowIdxOrKey, colKey } = activeMultiSelectCell.value;
  toggleOptionValue(sheetName, isKv, rowIdxOrKey, colKey, optValue, isChecked);
};

const getSelectedPills = (cellValue, meta) => {
  if (cellValue === undefined || cellValue === null || cellValue === '') return [];
  let currentList = [];
  if (Array.isArray(cellValue)) {
    currentList = cellValue.map(String);
  } else {
    currentList = String(cellValue).split(',').map(x => x.trim()).filter(x => x);
  }
  
  const allOpts = resolveSelectOptions(meta);
  return currentList.map(val => {
    const match = allOpts.find(opt => String(opt.value) === val);
    return {
      value: val,
      label: match ? match.label : val
    };
  });
};

const getAvailableTables = () => {
  return Object.keys(store.excelJsonData || {}).filter(name => {
    if (name === 'editor_metadata') return false;
    const data = store.excelJsonData[name];
    return Array.isArray(data) && data.length > 0 && typeof data[0] === 'object';
  });
};

const getTableColumns = (sheetName) => {
  if (!sheetName || !store.excelJsonData || !store.excelJsonData[sheetName]) return [];
  const data = store.excelJsonData[sheetName];
  if (Array.isArray(data) && data.length > 0) {
    return Object.keys(data[0]);
  }
  return [];
};

const onVectorPathChange = (item) => {
  const cols = getTableColumns(item.vectorPath);
  if (cols.length > 0) {
    item.displayField = cols[0];
    item.valueField = cols[0];
  } else {
    item.displayField = '';
    item.valueField = '';
  }
};

const getColumnWidthPct = (groupName, colName) => {
  const meta = getElementMetadata(groupName, colName);
  return meta && meta.width ? meta.width : '';
};

const getColumnWidthStyle = (groupName, colName) => {
  const pct = getColumnWidthPct(groupName, colName);
  return pct ? { width: `${pct}%`, minWidth: `${pct}%` } : {};
};

const addTabularColumn = () => {
  const colName = prompt("Introdueix el nom de la nova columna (només lletres i números):");
  if (!colName) return;
  const cleanColName = colName.trim().replace(/[^A-Za-z0-9_]/g, '_');
  if (!cleanColName) return;
  
  const groupName = activeConfigGroup.value;
  const sheetData = store.excelJsonData[groupName];
  if (!Array.isArray(sheetData)) return;
  
  if (sheetData.length > 0 && sheetData[0].hasOwnProperty(cleanColName)) {
    alert("Aquesta columna ja existeix.");
    return;
  }
  
  if (sheetData.length === 0) {
    sheetData.push({ [cleanColName]: '' });
  } else {
    sheetData.forEach(row => {
      row[cleanColName] = '';
    });
  }
  
  groupConfigList.value.push({
    element: cleanColName,
    type: 'Text',
    sourceType: 'static',
    optionsRaw: '',
    vectorPath: '',
    displayField: '',
    valueField: '',
    multiple: false,
    width: ''
  });
  
  store.addLog(`Columna '${cleanColName}' afegida correctament al grup '${groupName}'.`, 'info');
};

const deleteTabularColumn = (colName) => {
  if (!confirm(`Segur que vols eliminar la columna '${colName}' de la taula? S'esborraran tots els valors d'aquesta columna a totes les files.`)) {
    return;
  }
  
  const groupName = activeConfigGroup.value;
  const sheetData = store.excelJsonData[groupName];
  if (Array.isArray(sheetData)) {
    sheetData.forEach(row => {
      delete row[colName];
    });
  }
  
  groupConfigList.value = groupConfigList.value.filter(item => item.element !== colName);
  
  store.addLog(`Columna '${colName}' eliminada correctament del grup '${groupName}'.`, 'info');
};

const isConfigModalOpen = ref(false);
const activeConfigGroup = ref('');
const groupConfigList = ref([]);
const groupLabelInput = ref('');

const getGroupLabel = (groupName) => {
  if (!groupName) return '';
  if (store.editorMetadata) {
    const meta = store.editorMetadata.find(m => 
      (m.group === groupName || m.group === groupName.split('.').pop()) && 
      (m.element === '_group_label' || m.element === '_group' || m.isGroupHeader) && 
      m.label && m.label.trim()
    );
    if (meta) {
      return meta.label.trim();
    }
  }
  return groupName;
};

const getFieldLabel = (groupName, elementName) => {
  const meta = getElementMetadata(groupName, elementName);
  if (meta && meta.label && meta.label.trim()) {
    return meta.label.trim();
  }
  return elementName;
};

const getAvailableChildVectorsForGroup = (groupName) => {
  if (!store.excelJsonData) return [];
  const result = new Set();

  const searchInObj = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach(item => {
        if (item && typeof item === 'object') {
          Object.keys(item).forEach(k => {
            if (Array.isArray(item[k])) result.add(k);
          });
        }
      });
    } else {
      Object.keys(obj).forEach(k => {
        if (Array.isArray(obj[k])) result.add(k);
      });
    }
  };

  const sheetData = store.excelJsonData[groupName];
  if (sheetData) {
    searchInObj(sheetData);
  }

  // Fallback search across whole excelJsonData tree
  if (result.size === 0) {
    const searchRecursive = (container) => {
      if (!container || typeof container !== 'object') return;
      if (container[groupName]) {
        searchInObj(container[groupName]);
        return;
      }
      if (Array.isArray(container)) {
        container.forEach(item => {
          if (item && typeof item === 'object') {
            if (item[groupName]) searchInObj(item[groupName]);
            else Object.values(item).forEach(v => searchRecursive(v));
          }
        });
      } else {
        Object.values(container).forEach(v => searchRecursive(v));
      }
    };
    searchRecursive(store.excelJsonData);
  }

  // Fallback to top-level sheet names if configuring root KV or root group
  if (result.size === 0) {
    Object.keys(store.excelJsonData).forEach(k => {
      if (k !== groupName && k !== 'editor_metadata' && k !== '_hierarchy_schema' && k !== '_sheet_info') {
        if (Array.isArray(store.excelJsonData[k])) {
          result.add(k);
        }
      }
    });
  }

  return Array.from(result);
};

const getChildTableColumns = (groupName, vectorName) => {
  if (!vectorName || !store.excelJsonData) return [];
  const cols = new Set();

  const checkObj = (obj) => {
    if (obj && Array.isArray(obj[vectorName]) && obj[vectorName].length > 0 && typeof obj[vectorName][0] === 'object') {
      Object.keys(obj[vectorName][0]).forEach(k => {
        if (k !== '_hierarchy_schema' && isPrimitive(obj[vectorName][0][k])) {
          cols.add(k);
        }
      });
      return true;
    }
    return false;
  };

  const searchRecursive = (container) => {
    if (!container || typeof container !== 'object') return;
    if (Array.isArray(container)) {
      container.forEach(item => {
        if (item && typeof item === 'object') {
          checkObj(item);
          searchRecursive(item);
        }
      });
    } else {
      checkObj(container);
      Object.keys(container).forEach(k => {
        if (typeof container[k] === 'object') searchRecursive(container[k]);
      });
    }
  };

  // Direct check top-level sheet
  if (Array.isArray(store.excelJsonData[vectorName]) && store.excelJsonData[vectorName].length > 0 && typeof store.excelJsonData[vectorName][0] === 'object') {
    Object.keys(store.excelJsonData[vectorName][0]).forEach(k => {
      if (k !== '_hierarchy_schema' && isPrimitive(store.excelJsonData[vectorName][0][k])) {
        cols.add(k);
      }
    });
  }

  searchRecursive(store.excelJsonData);

  return Array.from(cols);
};

const isFormulaModalOpen = ref(false);
const editingFormulaItem = ref(null);
const formulaTextBuffer = ref('');
const availableFormulaFields = ref([]);
const globalFormulaPaths = ref([]);
const formulaTextareaRef = ref(null);

const getGlobalFormulaPaths = () => {
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
};

const openFormulaModal = (item, fields) => {
  editingFormulaItem.value = item;
  formulaTextBuffer.value = item.calcFormula || '';
  availableFormulaFields.value = (fields || []).filter(f => f !== item.element);
  globalFormulaPaths.value = getGlobalFormulaPaths();
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

const saveFormulaModal = () => {
  if (editingFormulaItem.value) {
    editingFormulaItem.value.calcFormula = formulaTextBuffer.value;
  }
  isFormulaModalOpen.value = false;
};

const openGroupConfig = (groupName, sheetData) => {
  activeConfigGroup.value = groupName;
  const currentGroupLabel = getGroupLabel(groupName);
  groupLabelInput.value = currentGroupLabel !== groupName ? currentGroupLabel : '';

  const isKv = getSheetType(sheetData) === 'kv';
  const elements = isKv ? Object.keys(sheetData) : getTabularColumns(groupName, sheetData);
  
  groupConfigList.value = elements.map(el => {
    const meta = getElementMetadata(groupName, el) || { type: 'Text' };
    return {
      element: el,
      label: meta.label || '',
      type: meta.type || 'Text',
      sourceType: meta.sourceType || 'static',
      optionsRaw: Array.isArray(meta.options) ? meta.options.join(', ') : (typeof meta.options === 'string' ? meta.options : ''),
      vectorPath: meta.vectorPath || '',
      displayField: meta.displayField || '',
      valueField: meta.valueField || '',
      multiple: !!meta.multiple,
      width: meta.width || '',
      calcFn: meta.calcFn || 'SUM',
      calcVector: meta.calcVector || '',
      calcTargetCol: meta.calcTargetCol || '',
      calcFormula: meta.calcFormula || '',
      gridRow: meta.gridRow || '',
      gridOrder: meta.gridOrder || '',
      gridFill: !!meta.gridFill
    };
  });
  
  isConfigModalOpen.value = true;
};

const addNewFieldToConfig = () => {
  const key = prompt("Introdueix el nom de la nova clau/camp (es sanititzarà automàticament):");
  if (!key) return;
  const cleanKey = key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const groupName = activeConfigGroup.value;
  
  if (store.excelJsonData && store.excelJsonData[groupName]) {
    const sheetData = store.excelJsonData[groupName];
    if (Array.isArray(sheetData)) {
      sheetData.forEach(row => {
        if (!(cleanKey in row)) row[cleanKey] = '';
      });
    } else if (typeof sheetData === 'object') {
      if (!(cleanKey in sheetData)) sheetData[cleanKey] = '';
    }
  }
  
  if (!groupConfigList.value.some(i => i.element === cleanKey)) {
    groupConfigList.value.push({
      element: cleanKey,
      label: '',
      type: 'Text',
      sourceType: 'static',
      optionsRaw: '',
      vectorPath: '',
      displayField: '',
      valueField: '',
      multiple: false,
      width: '',
      calcFn: 'SUM',
      calcVector: '',
      calcTargetCol: '',
      calcFormula: '',
      gridRow: '',
      gridOrder: '',
      gridFill: false
    });
  }
};

const handleSaveGroupConfig = (data) => {
  const groupName = activeConfigGroup.value;
  store.editorMetadata = store.editorMetadata.filter(m => m.group !== groupName);

  // Save group layout & label header
  const groupMeta = {
    group: groupName,
    element: '_group_label',
    isGroupHeader: true,
    groupLayout: data.selectedLayout
  };
  if (data.groupLabel && data.groupLabel.trim()) {
    groupMeta.label = data.groupLabel.trim();
  }
  store.editorMetadata.push(groupMeta);

  // Save field config items
  data.configList.forEach(item => {
    const meta = {
      group: groupName,
      element: item.element,
      type: item.type
    };
    if (item.label && item.label.trim()) {
      meta.label = item.label.trim();
    }
    if (item.type === 'Select') {
      meta.sourceType = item.sourceType;
      meta.multiple = !!item.multiple;
      if (item.sourceType === 'dynamic') {
        meta.vectorPath = item.vectorPath;
        meta.displayField = item.displayField;
        meta.valueField = item.valueField;
      } else {
        meta.options = (item.optionsRaw || '').split(',').map(x => x.trim()).filter(x => x);
      }
    } else if (item.type === 'Computed') {
      meta.calcFn = item.calcFn;
      meta.calcVector = item.calcVector;
      meta.calcTargetCol = item.calcTargetCol;
      meta.calcFormula = item.calcFormula;
    } else if (item.type === 'Table') {
      meta.vectorPath = item.vectorPath;
    }

    if (item.width) meta.width = item.width;
    if (item.gridRow) meta.gridRow = item.gridRow;
    if (item.gridOrder) meta.gridOrder = item.gridOrder;
    if (item.gridFill) meta.gridFill = item.gridFill;

    store.editorMetadata.push(meta);
  });

  isConfigModalOpen.value = false;
  store.addLog(`Configuració desada per al grup '${groupName}'.`, 'success');

  if (store.excelJsonData) {
    store.excelJsonData.editor_metadata = store.editorMetadata;
    evaluateComputedFields(store.excelJsonData);
  }
};

const saveGroupConfig = () => {
  const groupName = activeConfigGroup.value;
  
  // Clear old metadata for this group
  store.editorMetadata = store.editorMetadata.filter(m => m.group !== groupName);
  
  // Save group label if specified
  if (groupLabelInput.value && groupLabelInput.value.trim()) {
    store.editorMetadata.push({
      group: groupName,
      element: '_group_label',
      isGroupHeader: true,
      type: 'Group',
      label: groupLabelInput.value.trim()
    });
  }
  
  // Add new field metadata
  groupConfigList.value.forEach(item => {
    const meta = {
      group: groupName,
      element: item.element,
      type: item.type
    };
    if (item.label && item.label.trim()) {
      meta.label = item.label.trim();
    }
    if (item.type === 'Select') {
      meta.sourceType = item.sourceType;
      meta.multiple = !!item.multiple;
      if (item.sourceType === 'dynamic') {
        meta.vectorPath = item.vectorPath;
        meta.displayField = item.displayField;
        meta.valueField = item.valueField;
        meta.options = resolveDynamicOptionsList(item.vectorPath, item.displayField, item.valueField);
      } else {
        meta.options = item.optionsRaw.split(',').map(x => x.trim()).filter(x => x);
      }
    }
    if (item.type === 'Computed') {
      meta.calcFn = item.calcFn || 'SUM';
      meta.calcVector = item.calcVector || '';
      meta.calcTargetCol = item.calcTargetCol || '';
      meta.calcFormula = item.calcFormula || '';
    }
    if (item.width) {
      meta.width = item.width;
    }
    if (item.gridRow) {
      meta.gridRow = item.gridRow;
    }
    if (item.gridOrder) {
      meta.gridOrder = item.gridOrder;
    }
    if (item.gridFill) {
      meta.gridFill = true;
    }
    if (item.type === 'Table') {
      ensureSubTableSheetExists(groupName, item.element);
    }
    store.editorMetadata.push(meta);
  });
  
  // Update parent JSON metadata key to keep in sync
  if (store.excelJsonData) {
    store.excelJsonData.editor_metadata = store.editorMetadata;
    evaluateComputedFields(store.excelJsonData);
  }
  
  isConfigModalOpen.value = false;
  store.addLog(`Configuració de tipus de dades per al grup '${groupName}' desada i valors calculats avaluats.`, 'success');
};

const ensureSubTableSheetExists = (parentGroup, keyName) => {
  const subPath = `${parentGroup}.${keyName}`;
  const rawSheetName = `OUT_${subPath}`;
  
  if (!store.sheetInfo) store.sheetInfo = [];
  let info = store.sheetInfo.find(s => s.clean_name === subPath || s.raw_name === rawSheetName);
  if (!info) {
    store.sheetInfo.push({
      raw_name: rawSheetName,
      prefix: 'OUT_',
      clean_name: subPath,
      parent_path: parentGroup,
      full_path: subPath,
      kind: 'tabular',
      headers: [],
      parent_ref_key: '',
      child_ref_key: ''
    });
  }

  if (store.excelJsonData) {
    const parentParts = parentGroup.split('.');
    let curr = store.excelJsonData;
    for (let i = 0; i < parentParts.length; i++) {
      const p = parentParts[i];
      if (curr && typeof curr === 'object') {
        if (Array.isArray(curr[p])) {
          curr[p].forEach(row => {
            if (row && typeof row === 'object' && !(keyName in row)) {
              row[keyName] = [];
            }
          });
          return;
        } else if (curr[p] && typeof curr[p] === 'object') {
          curr = curr[p];
        }
      }
    }
    if (curr && typeof curr === 'object') {
      if (!(keyName in curr)) {
        curr[keyName] = [];
      }
    }
  }
};

const isNewSheetModalOpen = ref(false);
const newSheetNameInput = ref('');
const newSheetKindInput = ref('kv');
const newSheetParentInput = ref('');

const availableParentSheets = computed(() => {
  const sheets = new Set();
  if (store.sheetInfo && Array.isArray(store.sheetInfo)) {
    store.sheetInfo.forEach(s => {
      if (s.clean_name) sheets.add(s.clean_name);
    });
  }
  if (store.excelJsonData && typeof store.excelJsonData === 'object') {
    Object.keys(store.excelJsonData).forEach(k => {
      if (k !== 'editor_metadata' && k !== '_hierarchy_schema' && k !== '_sheet_info') {
        sheets.add(k);
      }
    });
  }
  return Array.from(sheets);
});

const openNewSheetModal = () => {
  newSheetNameInput.value = '';
  newSheetKindInput.value = 'kv';
  newSheetParentInput.value = '';
  isNewSheetModalOpen.value = true;
};

const createNewSheet = () => {
  const rawName = newSheetNameInput.value.trim();
  if (!rawName) {
    alert("Introdueix un nom de full/clau vàlid.");
    return;
  }
  const cleanName = rawName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  
  let fullPath = cleanName;
  if (newSheetKindInput.value === 'sub_table' && newSheetParentInput.value) {
    fullPath = `${newSheetParentInput.value}.${cleanName}`;
  }
  
  const rawSheetName = `OUT_${fullPath}`;
  
  if (!store.excelJsonData) {
    store.excelJsonData = {};
  }
  
  const pathParts = fullPath.split('.');
  if (pathParts.length === 1) {
    if (!(fullPath in store.excelJsonData)) {
      store.excelJsonData[fullPath] = (newSheetKindInput.value === 'kv') ? {} : [];
    }
  } else {
    const parentPath = pathParts.slice(0, -1).join('.');
    const subKey = pathParts[pathParts.length - 1];
    ensureSubTableSheetExists(parentPath, subKey);
  }
  
  if (!store.sheetInfo) store.sheetInfo = [];
  if (!store.sheetInfo.some(s => s.clean_name === fullPath)) {
    store.sheetInfo.push({
      raw_name: rawSheetName,
      prefix: 'OUT_',
      clean_name: fullPath,
      parent_path: fullPath.includes('.') ? fullPath.substring(0, fullPath.lastIndexOf('.')) : '',
      full_path: fullPath,
      kind: (newSheetKindInput.value === 'kv') ? 'kv' : 'tabular',
      headers: [],
      parent_ref_key: '',
      child_ref_key: ''
    });
  }
  
  if (!store.editorMetadata) store.editorMetadata = [];
  if (!store.editorMetadata.some(m => m.group === fullPath && m.isGroupHeader)) {
    store.editorMetadata.push({
      group: fullPath,
      element: '_group_label',
      isGroupHeader: true,
      type: 'Group',
      label: fullPath.charAt(0).toUpperCase() + fullPath.slice(1).replace(/\./g, ' ➔ ')
    });
  }
  
  isNewSheetModalOpen.value = false;
  selectedCompactSheet.value = fullPath;
  store.addLog(`Full/Grup de dades '${fullPath}' (${newSheetKindInput.value}) creat correctament.`, 'success');
};

const openOrNavigateToSubTable = (parentGroup, keyName) => {
  const subPath = `${parentGroup}.${keyName}`;
  ensureSubTableSheetExists(parentGroup, keyName);
  selectedCompactSheet.value = subPath;
  openSheets.value[parentGroup] = true;
  openSheets.value[subPath] = true;
};

// --- Copy & Paste Configuration (Individual Group & Global) ---
const isPasteModalOpen = ref(false);
const pasteBufferText = ref('');
const pasteTargetGroup = ref(null);

const copyGroupConfig = async (groupName) => {
  if (!store.editorMetadata) store.editorMetadata = [];
  const groupMetadata = store.editorMetadata.filter(m => m.group === groupName);
  
  if (groupMetadata.length === 0) {
    alert(`El grup '${groupName}' no té cap configuració personalitzada de camps.`);
    return;
  }
  
  const payload = {
    type: 'elips_group_config',
    version: 1,
    group: groupName,
    exportedAt: new Date().toISOString(),
    metadata: groupMetadata
  };
  
  const jsonStr = JSON.stringify(payload, null, 2);
  try {
    await navigator.clipboard.writeText(jsonStr);
    store.addLog(`📋 Configuració del grup '${groupName}' copiada al portaretalls (${groupMetadata.length} regles).`, 'success');
  } catch (err) {
    prompt("Copia aquest text JSON de configuració del grup:", jsonStr);
  }
};

const pasteGroupConfig = async (targetGroupName) => {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch (err) {
    pasteTargetGroup.value = targetGroupName;
    pasteBufferText.value = '';
    isPasteModalOpen.value = true;
    return;
  }
  
  if (text && text.trim()) {
    applyGroupConfigJson(text, targetGroupName);
  } else {
    pasteTargetGroup.value = targetGroupName;
    pasteBufferText.value = '';
    isPasteModalOpen.value = true;
  }
};

const applyGroupConfigJson = (jsonStr, targetGroupName) => {
  try {
    const data = JSON.parse(jsonStr.trim());
    let itemsToApply = [];
    
    if (data.type === 'elips_group_config' && Array.isArray(data.metadata)) {
      itemsToApply = data.metadata;
    } else if (Array.isArray(data)) {
      itemsToApply = data;
    } else if (typeof data === 'object') {
      itemsToApply = [data];
    }
    
    if (!itemsToApply.length) {
      alert("El contingut no és una configuració de grup vàlida.");
      return;
    }

    if (!store.editorMetadata) store.editorMetadata = [];
    
    store.editorMetadata = store.editorMetadata.filter(m => m.group !== targetGroupName);
    
    itemsToApply.forEach(item => {
      const copyItem = JSON.parse(JSON.stringify(item));
      copyItem.group = targetGroupName;
      store.editorMetadata.push(copyItem);
    });
    
    if (store.excelJsonData) {
      store.excelJsonData.editor_metadata = store.editorMetadata;
      evaluateComputedFields(store.excelJsonData);
    }
    
    if (isConfigModalOpen.value && activeConfigGroup.value === targetGroupName) {
      const sheetData = store.excelJsonData ? store.excelJsonData[targetGroupName] : null;
      if (sheetData) openGroupConfig(targetGroupName, sheetData);
    }
    
    isPasteModalOpen.value = false;
    store.addLog(`📥 Configuració aplicada amb èxit al grup '${targetGroupName}'.`, 'success');
  } catch (err) {
    alert(`Error en enganxar la configuració: ${err.message}`);
  }
};

const copyGlobalConfig = async () => {
  if (!store.editorMetadata || store.editorMetadata.length === 0) {
    alert("El projecte no té cap configuració de grups o camps per exportar.");
    return;
  }
  
  const payload = {
    type: 'elips_global_config',
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: store.editorMetadata
  };
  
  const jsonStr = JSON.stringify(payload, null, 2);
  try {
    await navigator.clipboard.writeText(jsonStr);
    store.addLog(`📋 Configuració GLOBAL de TOTS els conjunts de dades copiada al portaretalls (${store.editorMetadata.length} regles).`, 'success');
  } catch (err) {
    prompt("Copia aquest text JSON de la configuració global:", jsonStr);
  }
};

const pasteGlobalConfig = async () => {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch (err) {
    pasteTargetGroup.value = null;
    pasteBufferText.value = '';
    isPasteModalOpen.value = true;
    return;
  }
  
  if (text && text.trim()) {
    applyGlobalConfigJson(text);
  } else {
    pasteTargetGroup.value = null;
    pasteBufferText.value = '';
    isPasteModalOpen.value = true;
  }
};

const applyGlobalConfigJson = (jsonStr) => {
  try {
    const data = JSON.parse(jsonStr.trim());
    let itemsToApply = [];
    
    if (data.type === 'elips_global_config' && Array.isArray(data.metadata)) {
      itemsToApply = data.metadata;
    } else if (Array.isArray(data)) {
      itemsToApply = data;
    }
    
    if (!itemsToApply.length) {
      alert("El contingut no és una configuració global de dades vàlida.");
      return;
    }
    
    store.editorMetadata = itemsToApply;
    if (store.excelJsonData) {
      store.excelJsonData.editor_metadata = store.editorMetadata;
      evaluateComputedFields(store.excelJsonData);
    }
    
    isPasteModalOpen.value = false;
    store.addLog(`📥 Configuració GLOBAL de TOTS els conjunts de dades aplicada al projecte (${itemsToApply.length} regles).`, 'success');
  } catch (err) {
    alert(`Error en enganxar la configuració global: ${err.message}`);
  }
};

const processPasteModalSubmit = () => {
  if (!pasteBufferText.value.trim()) return;
  if (pasteTargetGroup.value) {
    applyGroupConfigJson(pasteBufferText.value, pasteTargetGroup.value);
  } else {
    applyGlobalConfigJson(pasteBufferText.value);
  }
};

const handleCellKeyDown = (e) => {
  if (!isCellModalOpen.value) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    isCellModalOpen.value = false;
  } else if (e.key === 'Enter' && e.ctrlKey) {
    e.preventDefault();
    saveCellEditor();
  }
};

onMounted(() => {
  store.dataActions = {
    setViewMode: (mode) => { viewMode.value = mode; },
    toggleJsonView: () => { showJsonView.value = !showJsonView.value; },
    exportExcel: () => exportExcel(),
    getViewMode: () => viewMode.value,
    getShowJsonView: () => showJsonView.value,
  };
  window.addEventListener('keydown', handleCellKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleCellKeyDown);
});
const loadMockData = () => {
  const mockTreeSchema = {
    "pres": {
      "sheet": "OUT_pres",
      "data_path": "pres",
      "kind": "kv",
      "ref_key": null,
      "fields": ["pressupost", "import", "tipus_iva", "iva"],
      "children": {
        "parts": {
          "sheet": "OUT_pres.parts",
          "data_path": "pres.parts",
          "kind": "tabular",
          "ref_key": null,
          "fields": ["id_partida", "partida", "import", "lot"],
          "children": {
            "activitats": {
              "sheet": "OUT_pres.parts.activitats",
              "data_path": "pres.parts.activitats",
              "kind": "tabular",
              "ref_key": "id_partida",
              "fields": ["id_activitat", "descripcio_activitat", "import"],
              "children": {
                "cost": {
                  "sheet": "OUT_pres.parts.activitats.cost",
                  "data_path": "pres.parts.activitats.cost",
                  "kind": "tabular",
                  "ref_key": "id_activitat",
                  "fields": ["element", "unitats", "preu_unitari", "import"],
                  "children": {}
                }
              }
            }
          }
        }
      }
    }
  };

  store.excelJsonData = {
    "pres": {
      "pressupost": "Pressupost de Prova 2026",
      "import": 25000,
      "tipus_iva": 21,
      "iva": 5250,
      "parts": [
        {
          "id_partida": "PA1",
          "partida": "Partida 1: Obres Generals",
          "import": 15000,
          "lot": "Lot A",
          "activitats": [
            {
              "id_activitat": "ACT1",
              "descripcio_activitat": "Moviment de terres",
              "import": 5000,
              "cost": [
                {
                  "element": "Excavadora",
                  "unitats": 10,
                  "preu_unitari": 300,
                  "import": 3000
                },
                {
                  "element": "Manobre de reforç",
                  "unitats": 40,
                  "preu_unitari": 50,
                  "import": 2000
                }
              ]
            }
          ]
        }
      ]
    }
  };
  
  store.hierarchySchema = mockTreeSchema;
  const pName = localStorage.getItem('currentProjectName') || 'Default';
  localStorage.setItem(`${pName}:hierarchySchema`, JSON.stringify(mockTreeSchema));
};

onMounted(() => {
  store.dataActions = {
    loadMockData: () => loadMockData(),
    setViewMode: (mode) => { viewMode.value = mode; },
    getViewMode: () => viewMode.value,
    toggleJsonView: () => { showJsonView.value = !showJsonView.value; },
    getShowJsonView: () => showJsonView.value,
    exportExcel: () => exportExcel(),
    isExcelLoaded: () => isExcelLoaded.value,
    savingExcel: () => savingExcel.value,
    getSelectedCompactSheet: () => selectedCompactSheet.value,
    setSelectedCompactSheet: (name) => { selectedCompactSheet.value = name; },
    getRootSheetNames: () => {
      if (!store.excelJsonData) return [];
      return Object.keys(store.excelJsonData).filter(n => isRootSheet(n));
    },
    openNewSheetModal: () => openNewSheetModal(),
    openGroupConfigActive: () => {
      const rootNames = Object.keys(store.excelJsonData || {}).filter(n => isRootSheet(n));
      const activeName = selectedCompactSheet.value && rootNames.includes(selectedCompactSheet.value)
        ? selectedCompactSheet.value
        : (rootNames.length > 0 ? rootNames[0] : null);
      
      if (activeName && store.excelJsonData && store.excelJsonData[activeName]) {
        openGroupConfig(activeName, store.excelJsonData[activeName]);
      } else {
        openNewSheetModal();
      }
    },
    copyGroupConfigActive: () => {
      const rootNames = Object.keys(store.excelJsonData || {}).filter(n => isRootSheet(n));
      const activeName = selectedCompactSheet.value && rootNames.includes(selectedCompactSheet.value)
        ? selectedCompactSheet.value
        : (rootNames.length > 0 ? rootNames[0] : null);
      if (activeName) copyGroupConfig(activeName);
    },
    pasteGroupConfigActive: () => {
      const rootNames = Object.keys(store.excelJsonData || {}).filter(n => isRootSheet(n));
      const activeName = selectedCompactSheet.value && rootNames.includes(selectedCompactSheet.value)
        ? selectedCompactSheet.value
        : (rootNames.length > 0 ? rootNames[0] : null);
      if (activeName) pasteGroupConfig(activeName);
    },
    copyGlobalConfig: () => copyGlobalConfig(),
    pasteGlobalConfig: () => pasteGlobalConfig()
  };
});
</script>

<template>
  <div class="workspace-wrapper">

    <!-- Empty State -->
    <div v-if="!isExcelLoaded" class="sheets-accordion">
      <div class="accordion-item" style="border:0; background:none; text-align:center; padding:4rem; color:var(--text-muted)">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:1rem; opacity:0.5"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
        <p>Encara no s'ha carregat cap fitxer Excel.</p>
        <p style="font-size:0.75rem; margin-top: 0.25rem;">Pots carregar un fitxer Excel o bé definir el teu model de dades des de zero directament des d'aquí:</p>
        <div style="margin-top: 1.25rem;">
          <button 
            class="btn btn-primary" 
            style="padding: 6px 14px; font-size: 0.85rem; display: inline-flex; align-items: center; gap: 6px;"
            @click="openNewSheetModal"
          >
            ➕ Crear Nou Full / Grup de Dades
          </button>
        </div>
      </div>
    </div>

    <!-- Spreadsheet Accordion Inspector -->
    <div v-else-if="!showJsonView" class="sheets-accordion">
      <div v-if="store.excelImportInspection" style="margin-bottom: 0.75rem; display: flex; justify-content: flex-end;">
        <button 
          class="btn btn-secondary" 
          style="padding: 5px 12px; font-size: 0.8rem; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border-color); background: var(--bg-card);"
          @click="store.showExcelImportModal = true"
          title="Obre el modal d'inspecció detallada de l'Excel carregat"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><circle cx="11.5" cy="14.5" r="2.5"/><path d="M13.3 16.3 15 18"/></svg>
          <span>Inspecciona Importació Excel</span>
        </button>
      </div>
      
      <div 
        v-for="(sheetData, name) in store.excelJsonData" 
        v-show="isRootSheet(name) && (viewMode === 'complete' || name === selectedCompactSheet)"
        :key="name" 
        :data-sheet="name"
        class="accordion-item"
        :class="{ open: viewMode === 'compact' || openSheets[name], 'compact-card': viewMode === 'compact' }"
      >
        <div 
          class="accordion-header" 
          v-show="viewMode === 'complete'"
          @click="toggleSheet(name)"
        >
          <div class="accordion-header-left">
            <span class="accordion-badge" :class="getSheetType(sheetData)">{{ getSheetType(sheetData) }}</span>
            <span 
              style="font-weight: 600;"
              :style="{ cursor: getGroupLabel(name) !== name ? 'help' : 'default' }"
              :title="getGroupLabel(name) !== name ? 'Clau de grup: ' + name : undefined"
            >
              {{ getGroupLabel(name) }}
            </span>
            <span style="font-size:0.75rem; color:var(--text-muted); font-weight:normal;">({{ getRowsCount(sheetData) }} files/tuples)</span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
              <button 
                class="btn btn-secondary" 
                style="width: auto; padding: 2px 8px; font-size: 0.7rem; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border-color);"
                @click.stop="openGroupConfig(name, sheetData)"
                title="Configura tipus de dades per a aquest grup"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 1 1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
                <span v-if="store.config.showButtonTexts">Configura</span>
              </button>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down"><path d="m6 9 6 6 6-6"/></svg>
            </div>
          </div>
          
          <div class="accordion-content" style="padding: 0.4rem 0;">
            <!-- Compact Mode Header Info -->
            <div v-if="viewMode === 'compact'" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.4rem;">
              <h4 style="margin: 0; font-size: 0.95rem; color: var(--text-primary); font-weight: 700; display: flex; align-items: center; gap: 6px;">
                <span class="accordion-badge" :class="getSheetType(sheetData)">{{ getSheetType(sheetData) }}</span>
                <span 
                  :style="{ cursor: getGroupLabel(name) !== name ? 'help' : 'default' }"
                  :title="getGroupLabel(name) !== name ? 'Clau de grup: ' + name : undefined"
                >
                  {{ getGroupLabel(name) }}
                </span>
              </h4>
              <div style="display: flex; gap: 4px; align-items: center;">
                <button 
                  class="btn btn-secondary" 
                  style="width: auto; padding: 2px 6px; font-size: 0.72rem; border-radius: 4px; display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--border-color);"
                  @click="copyGroupConfig(name)"
                  title="Copia la configuració d'aquest grup al portaretalls"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  <span v-if="store.config.showButtonTexts">Copia</span>
                </button>
                <button 
                  class="btn btn-secondary" 
                  style="width: auto; padding: 2px 6px; font-size: 0.72rem; border-radius: 4px; display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--border-color);"
                  @click="pasteGroupConfig(name)"
                  title="Enganxa la configuració des del portaretalls sobre aquest grup"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
                  <span v-if="store.config.showButtonTexts">Enganxa</span>
                </button>
              </div>
          </div>
          <!-- Tabular Preview -->
          <template v-if="getSheetType(sheetData) === 'tabular'">
            <div style="overflow-x: auto;">
              <table class="inspector-table">
                <thead>
                  <tr>
                    <th 
                      v-for="col in getTabularColumns(name, sheetData)" 
                      :key="col" 
                      :style="getColumnWidthStyle(name, col)"
                    >
                      <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                        <span 
                          style="font-weight: 600;"
                          :style="{ cursor: getFieldLabel(name, col) !== col ? 'help' : 'default' }"
                          :title="getFieldLabel(name, col) !== col ? 'Clau de columna: ' + col : undefined"
                        >
                          {{ getFieldLabel(name, col) }}
                        </span>
                        <span v-if="getColumnWidthPct(name, col)" style="font-size: 0.7rem; font-weight: normal; color: var(--text-muted); padding: 2px 4px; background: rgba(0,0,0,0.05); border-radius: 3px;">
                          {{ getColumnWidthPct(name, col) }}%
                        </span>
                      </div>
                    </th>
                    <th style="width: 50px;">Accions</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-if="sheetData.length === 0">
                    <td :colspan="getTabularColumns(name, sheetData).length + 1" style="text-align: center; color: var(--text-muted); padding: 1.5rem; font-size: 0.82rem;">
                      Aquesta taula no té cap fila de dades. Clica "Afegeix fila" per crear-ne una.
                    </td>
                  </tr>
                  <tr v-for="(row, idx) in sheetData.slice(0, visibleRowsCount[name])" :key="idx" :id="'data-row-' + name + '-' + idx">
                    <td v-for="col in getTabularColumns(name, sheetData)" :key="col" style="padding: 4px;">
                      <span v-if="typeof row[col] === 'object' && row[col] !== null" style="font-size:0.75rem; color:var(--text-muted)">
                        [Complex]
                      </span>
                      <div v-else style="display: flex; gap: 4px; align-items: stretch; width: 100%;">
                        <!-- Calculated Field (Non-editable, Read-only with lock badge and type-specific formatting) -->
                        <div 
                          v-if="isCalculatedField(name, col)" 
                          :id="'data-field-' + name + '-' + idx + '-' + col"
                          :data-path="name + '.' + idx + '.' + col"
                          style="display: flex; align-items: center; gap: 6px; flex-grow: 1; height: 32px; padding: 2px 10px; border: 1px solid var(--border-color); border-radius: var(--radius-xs); background: var(--bg-tertiary); color: var(--text-primary); font-family: var(--font-mono); font-size: 0.82rem; font-weight: 600; cursor: not-allowed;" 
                          title="🔒 Camp calculat automàticament"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary); flex-shrink: 0;"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/></svg>
                          <span style="flex-grow: 1;">
                            {{ getElementType(name, col) === 'Percentage' ? (formatPercentageDisplay(store.excelJsonData[name][idx][col]) + ' %') : (store.excelJsonData[name][idx][col] !== undefined ? store.excelJsonData[name][idx][col] : 0) }}
                          </span>
                          <span style="font-size: 0.65rem; color: var(--text-muted); font-weight: normal; background: rgba(0,0,0,0.06); padding: 1px 4px; border-radius: 3px;">Calculat</span>
                        </div>

                        <!-- Select Type -->
                        <template v-else-if="getElementType(name, col) === 'Select'">
                          <!-- Multiple select -->
                          <div 
                            v-if="getElementMetadata(name, col)?.multiple"
                            :id="'data-field-' + name + '-' + idx + '-' + col"
                            :data-path="name + '.' + idx + '.' + col"
                            style="display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 32px; padding: 4px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); flex-grow: 1; cursor: pointer; max-width: 300px; max-height: 80px; overflow-y: auto;"
                            @click="openMultiSelectModal(name, false, idx, col, getElementMetadata(name, col))"
                            title="Fes clic per modificar la selecció"
                          >
                            <span v-if="getSelectedPills(store.excelJsonData[name][idx][col], getElementMetadata(name, col)).length === 0" style="color: var(--text-muted); font-size: 0.8rem; padding: 0 4px;">
                              [Tria opcions]
                            </span>
                            <span 
                              v-for="pill in getSelectedPills(store.excelJsonData[name][idx][col], getElementMetadata(name, col))" 
                              :key="pill.value" 
                              style="background-color: var(--color-primary-light, #e0f2fe); color: var(--color-primary, #0284c7); font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; font-weight: 500; display: inline-block; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                              :title="pill.label"
                            >
                              {{ pill.label }}
                            </span>
                          </div>
                          <!-- Single select -->
                          <select 
                            v-else
                            :id="'data-field-' + name + '-' + idx + '-' + col"
                            :data-path="name + '.' + idx + '.' + col"
                            v-model="store.excelJsonData[name][idx][col]"
                            class="data-input"
                            style="flex-grow: 1; height: 32px;"
                          >
                            <option value="">[Buit / Sense valor]</option>
                            <option 
                              v-for="opt in resolveSelectOptions(getElementMetadata(name, col))" 
                              :key="opt.value" 
                              :value="opt.value"
                            >
                              {{ opt.label }}
                            </option>
                          </select>
                        </template>

                        <!-- Date Type -->
                        <input 
                          v-else-if="getElementType(name, col) === 'Date'"
                          :id="'data-field-' + name + '-' + idx + '-' + col"
                          :data-path="name + '.' + idx + '.' + col"
                          type="date"
                          v-model="store.excelJsonData[name][idx][col]"
                          class="data-input"
                          style="flex-grow: 1; height: 32px;"
                        >
                        
                        <!-- Number Type -->
                        <input 
                          v-else-if="getElementType(name, col) === 'Number'"
                          :id="'data-field-' + name + '-' + idx + '-' + col"
                          :data-path="name + '.' + idx + '.' + col"
                          type="number"
                          step="any"
                          v-model="store.excelJsonData[name][idx][col]"
                          class="data-input"
                          style="flex-grow: 1; height: 32px;"
                        >
                        
                        <!-- Percentage Type -->
                        <div v-else-if="getElementType(name, col) === 'Percentage'" style="display: flex; align-items: center; flex-grow: 1; position: relative;">
                          <input 
                            :id="'data-field-' + name + '-' + idx + '-' + col"
                            :data-path="name + '.' + idx + '.' + col"
                            type="number"
                            step="any"
                            v-model="store.excelJsonData[name][idx][col]"
                            class="data-input"
                            style="flex-grow: 1; height: 32px; padding-right: 26px;"
                            placeholder="0"
                          >
                          <span style="position: absolute; right: 8px; font-weight: bold; font-size: 0.82rem; color: var(--text-muted); pointer-events: none;">%</span>
                        </div>
                        
                        <!-- Boolean Type -->
                        <select 
                          v-else-if="getElementType(name, col) === 'Boolean'"
                          :id="'data-field-' + name + '-' + idx + '-' + col"
                          :data-path="name + '.' + idx + '.' + col"
                          v-model="store.excelJsonData[name][idx][col]"
                          class="data-input"
                          style="flex-grow: 1; height: 32px;"
                        >
                          <option value="">[Buit / Sense valor]</option>
                          <option :value="true">Cert (True)</option>
                          <option :value="false">Fals (False)</option>
                        </select>
                        
                        <!-- Text Type (default) -->
                        <textarea 
                          v-else-if="viewMode === 'compact' || (typeof row[col] === 'string' && row[col].length > 40)"
                          :id="'data-field-' + name + '-' + idx + '-' + col"
                          :data-path="name + '.' + idx + '.' + col"
                          v-model="store.excelJsonData[name][idx][col]"
                          class="data-input"
                          :rows="viewMode === 'compact' ? 3 : undefined"
                          style="flex-grow: 1; resize: vertical;"
                          :style="{ minHeight: viewMode === 'compact' ? '75px' : '50px' }"
                        ></textarea>
                        <input 
                          v-else
                          :id="'data-field-' + name + '-' + idx + '-' + col"
                          :data-path="name + '.' + idx + '.' + col"
                          type="text"
                          v-model="store.excelJsonData[name][idx][col]"
                          class="data-input"
                          style="flex-grow: 1;"
                        >
                        
                        <button 
                          v-if="getElementType(name, col) === 'Text'"
                          class="btn-icon-only"
                          style="height: 32px; width: 32px; min-width: 32px; font-size: 0.9rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: var(--bg-tertiary);"
                          title="Edició complexa en Markdown + Jinja2"
                          @click="openCellEditor(name, idx, col, false)"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                        </button>
                      </div>
                    </td>
                    <td style="text-align: center; vertical-align: middle; padding: 4px;">
                      <button 
                        class="btn-icon-only text-danger" 
                        style="height: 32px; width: 32px; min-width: 32px; font-size: 0.9rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none;"
                        title="Elimina fila"
                        @click="deleteTabularRow(name, idx)"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div style="margin-top: 6px;">
              <button 
                class="btn btn-secondary" 
                style="width: auto; padding: 3px 8px; font-size: 0.72rem; display: inline-flex; align-items: center; gap: 4px;"
                @click="addTabularRow(name, sheetData)"
                title="Afegeix una nova fila a la taula"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                <span v-if="store.config.showButtonTexts">Afegeix fila</span>
              </button>
            </div>
          </template>
          
          <!-- Key Value Form Preview -->
          <template v-else>
            <div style="display: flex; flex-direction: column; gap: 10px; padding: 6px 0; width: 100%;">
              <div 
                v-for="(rowItems, rIdx) in getKvRowBlocks(sheetData, name)" 
                :key="rIdx"
                style="display: flex; flex-wrap: wrap; gap: 10px; align-items: stretch; width: 100%;"
              >
                <div 
                  v-for="item in rowItems" 
                  :key="item.key"
                  :style="getKvFieldCardStyle(name, item)"
                >
                  <!-- Label Header -->
                  <div 
                    :style="store.config.labelPosition === 'top'
                      ? 'display: flex; justify-content: space-between; align-items: center;'
                      : 'width: 180px; min-width: 140px; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;'"
                  >
                    <div>
                      <span 
                        style="font-weight: 600; font-size: 0.82rem; color: var(--text-primary);"
                        :style="{ cursor: getFieldLabel(name, item.key) !== item.key ? 'help' : 'default' }"
                        :title="getFieldLabel(name, item.key) !== item.key ? 'Clau de camp: ' + item.key : undefined"
                      >
                        {{ getFieldLabel(name, item.key) }}
                      </span>
                    </div>
                  </div>

                  <!-- Input Controls -->
                  <div style="display: flex; gap: 4px; align-items: stretch; width: 100%; flex-grow: 1;">
                    <!-- Select Type -->
                    <template v-if="getElementType(name, item.key) === 'Select'">
                      <!-- Multiple select -->
                      <div 
                        v-if="getElementMetadata(name, item.key)?.multiple"
                        :id="'data-field-' + name + '-' + item.key"
                        :data-path="name + '.' + item.key"
                        style="display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 28px; padding: 2px 4px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); flex-grow: 1; cursor: pointer; max-width: 100%; max-height: 80px; overflow-y: auto;"
                        @click="openMultiSelectModal(name, true, item.key, null, getElementMetadata(name, item.key))"
                        title="Fes clic per modificar la selecció"
                      >
                        <span v-if="getSelectedPills(store.excelJsonData[name][item.key], getElementMetadata(name, item.key)).length === 0" style="color: var(--text-muted); font-size: 0.78rem; padding: 0 4px;">
                          [Tria opcions]
                        </span>
                        <span 
                          v-for="pill in getSelectedPills(store.excelJsonData[name][item.key], getElementMetadata(name, item.key))" 
                          :key="pill.value" 
                          style="background-color: var(--color-primary-light, #e0f2fe); color: var(--color-primary, #0284c7); font-size: 0.72rem; padding: 1px 5px; border-radius: 4px; font-weight: 500; display: inline-block; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                          :title="pill.label"
                        >
                          {{ pill.label }}
                        </span>
                      </div>
                      <!-- Single select -->
                      <select 
                        v-else
                        :id="'data-field-' + name + '-' + item.key"
                        :data-path="name + '.' + item.key"
                        v-model="store.excelJsonData[name][item.key]"
                        class="data-input"
                        style="flex-grow: 1; height: 28px; font-size: 0.8rem;"
                      >
                        <option value="">[Buit / Sense valor]</option>
                        <option 
                          v-for="opt in resolveSelectOptions(getElementMetadata(name, item.key))" 
                          :key="opt.value" 
                          :value="opt.value"
                        >
                          {{ opt.label }}
                        </option>
                      </select>
                    </template>
                    
                    <!-- Computed Type (Non-editable) -->
                    <div 
                      v-else-if="getElementType(name, item.key) === 'Computed'" 
                      :id="'data-field-' + name + '-' + item.key"
                      :data-path="name + '.' + item.key"
                      style="display: flex; align-items: center; gap: 6px; flex-grow: 1; height: 28px; padding: 2px 10px; border: 1px solid var(--border-color); border-radius: var(--radius-xs); background: var(--bg-tertiary); color: var(--text-primary); font-family: var(--font-mono); font-size: 0.8rem; font-weight: 600; cursor: not-allowed;" 
                      title="🔒 Camp calculat automàticament"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary); flex-shrink: 0;"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/></svg>
                      <span style="flex-grow: 1;">{{ store.excelJsonData[name][item.key] !== undefined ? store.excelJsonData[name][item.key] : 0 }}</span>
                      <span style="font-size: 0.65rem; color: var(--text-muted); font-weight: normal; background: rgba(0,0,0,0.06); padding: 1px 4px; border-radius: 3px;">Calculat</span>
                    </div>

                    <!-- Date Type -->
                    <input 
                      v-else-if="getElementType(name, item.key) === 'Date'"
                      :id="'data-field-' + name + '-' + item.key"
                      :data-path="name + '.' + item.key"
                      type="date"
                      v-model="store.excelJsonData[name][item.key]"
                      class="data-input"
                      style="flex-grow: 1; height: 28px; font-size: 0.8rem;"
                    >

                    <!-- Boolean Type -->
                    <select 
                      v-else-if="getElementType(name, item.key) === 'Boolean'"
                      :id="'data-field-' + name + '-' + item.key"
                      :data-path="name + '.' + item.key"
                      v-model="store.excelJsonData[name][item.key]"
                      class="data-input"
                      style="flex-grow: 1; height: 28px; font-size: 0.8rem;"
                    >
                      <option value="">[Buit / Sense valor]</option>
                      <option :value="true">Cert (True)</option>
                      <option :value="false">Fals (False)</option>
                    </select>
                    
                    <!-- Number Type -->
                    <input 
                      v-else-if="getElementType(name, item.key) === 'Number'"
                      :id="'data-field-' + name + '-' + item.key"
                      :data-path="name + '.' + item.key"
                      type="number"
                      step="any"
                      v-model="store.excelJsonData[name][item.key]"
                      class="data-input"
                      style="flex-grow: 1; height: 28px; font-size: 0.8rem;"
                    >
                    
                    <!-- Percentage Type -->
                    <div v-else-if="getElementType(name, item.key) === 'Percentage'" style="display: flex; align-items: center; flex-grow: 1; position: relative;">
                      <input 
                        :id="'data-field-' + name + '-' + item.key"
                        :data-path="name + '.' + item.key"
                        type="number"
                        step="any"
                        v-model="store.excelJsonData[name][item.key]"
                        class="data-input"
                        style="flex-grow: 1; height: 28px; font-size: 0.8rem; padding-right: 24px;"
                        placeholder="0"
                      >
                      <span style="position: absolute; right: 8px; font-weight: bold; font-size: 0.8rem; color: var(--text-muted); pointer-events: none;">%</span>
                    </div>
                    
                    <!-- Table Sub-structure Type -->
                    <div 
                      v-else-if="getElementType(name, item.key) === 'Table'"
                      :id="'data-field-' + name + '-' + item.key"
                      :data-path="name + '.' + item.key"
                      style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-grow: 1; min-height: 32px; padding: 4px 10px; border: 1.5px dashed var(--color-primary); border-radius: var(--radius-sm); background: var(--color-primary-light); color: var(--color-primary); font-size: 0.8rem; font-weight: 600;"
                    >
                      <span style="display: flex; align-items: center; gap: 6px;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h18v18H3z"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>
                        <span>Sub-taula aniuada: <code>{{ name }}.{{ item.key }}</code></span>
                      </span>
                      <button 
                        class="btn btn-secondary btn-sm" 
                        style="padding: 2px 8px; font-size: 0.72rem; height: 24px; display: inline-flex; align-items: center; gap: 4px; background: var(--bg-card); border-color: var(--color-primary); color: var(--color-primary);"
                        @click="openOrNavigateToSubTable(name, item.key)"
                        title="Navega o configura aquesta sub-taula aniuada"
                      >
                        📂 Obre Sub-taula "{{ item.key }}" ➔
                      </button>
                    </div>
                    
                    <!-- Text Type (default) -->
                    <textarea 
                      v-else-if="viewMode === 'compact' || (typeof item.val === 'string' && item.val.length > 40)"
                      :id="'data-field-' + name + '-' + item.key"
                      :data-path="name + '.' + item.key"
                      v-model="store.excelJsonData[name][item.key]"
                      class="data-input"
                      :rows="viewMode === 'compact' ? 2 : undefined"
                      style="flex-grow: 1; resize: vertical; font-size: 0.8rem;"
                      :style="{ minHeight: viewMode === 'compact' ? '55px' : '40px' }"
                    ></textarea>
                    <input 
                      v-else
                      :id="'data-field-' + name + '-' + item.key"
                      :data-path="name + '.' + item.key"
                      type="text"
                      v-model="store.excelJsonData[name][item.key]"
                      class="data-input"
                      style="flex-grow: 1; height: 28px; font-size: 0.8rem;"
                    >
                    <button 
                      v-if="getElementType(name, item.key) === 'Text'"
                      class="btn-icon-only"
                      style="height: 28px; width: 28px; min-width: 28px; font-size: 0.85rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: var(--bg-tertiary);"
                      title="Edició complexa en Markdown + Jinja2"
                      @click="openCellEditor(name, item.key, null, true)"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
            
            <!-- Integrated Hierarchical Nested Sub-Tables -->
            <template v-for="(subSchema, subKey) in getTopLevelChildSchemas(name, sheetData)" :key="subKey">
              <NestedDataNode 
                :parentObj="sheetData"
                :arrayKey="subKey"
                :schema="subSchema"
                :parentPath="name"
              />
            </template>
          </template>
        </div>
      </div>
    </div>
    
    <!-- JSON Highlighted Raw View -->
    <div v-else class="json-viewer">
      <pre style="margin: 0;" v-html="highlightedJson"></pre>
    </div>

    <!-- 5. Cell Markdown + Jinja2 Editor Modal -->
    <div class="modal-overlay" :style="{ display: isCellModalOpen ? 'flex' : 'none' }">
      <div class="modal-content" style="max-width: 1200px; width: 98%; height: 90vh; display: flex; flex-direction: column;">
        <div class="modal-header">
          <h3 style="border: none; padding-bottom: 0; margin: 0;">Editor de Cel·la (Markdown + Jinja2)</h3>
          <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem;" @click="isCellModalOpen = false">&times;</button>
        </div>
        
        <div class="modal-body" style="flex-grow: 1; padding: 0.5rem; overflow: hidden; display: flex; flex-direction: column;">
          <TemplateEditor v-model="cellTextValue" :isCellMode="true" />
        </div>
        
        <div class="modal-footer" style="margin-top: auto;">
          <button class="btn btn-secondary" style="width: auto;" @click="isCellModalOpen = false">Cancel·lar</button>
          <button class="btn btn-primary" style="width: auto;" @click="saveCellEditor">Aplicar</button>
        </div>
      </div>
    </div>

    <!-- 6. Group Configuration Modal -->
    <GroupConfigModal
      v-model="isConfigModalOpen"
      :groupName="activeConfigGroup"
      :configList="groupConfigList"
      :groupLabel="groupLabelInput"
      :selectedLayout="selectedLayout"
      @save="handleSaveGroupConfig"
      @copyGroup="copyGroupConfig"
      @pasteGroup="pasteGroupConfig"
    />

    <!-- 7. Dynamic Multi-Select Options Modal -->
    <div class="modal-overlay" v-if="isMultiSelectModalOpen" style="display: flex; z-index: 1100;">
      <div class="modal-content" style="max-width: 450px; width: 90%; max-height: 70vh; display: flex; flex-direction: column;">
        <div class="modal-header">
          <h3 style="border: none; padding-bottom: 0; margin: 0; font-size: 1.1rem;">
            Tria opcions per a: {{ activeMultiSelectCell?.colKey || activeMultiSelectCell?.rowIdxOrKey }}
          </h3>
          <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem;" @click="isMultiSelectModalOpen = false">&times;</button>
        </div>
        
        <div class="modal-body" style="flex-grow: 1; overflow-y: auto; padding: 1rem 0;">
          <div style="display: flex; flex-direction: column; gap: 8px; padding: 0 1.25rem;">
            <label 
              v-for="opt in resolveSelectOptions(activeMultiSelectCell?.meta)" 
              :key="opt.value" 
              style="display: flex; align-items: center; gap: 10px; font-size: 0.9rem; cursor: pointer; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-secondary); user-select: none; transition: background 0.15s;"
            >
              <input 
                type="checkbox" 
                :value="opt.value" 
                :checked="isOptionChecked(getCellValueForActive(), opt.value)"
                @change="toggleOptionValueForActive(opt.value, $event.target.checked)"
                style="width: 18px; height: 18px; cursor: pointer;"
              >
              <span style="color: var(--text-primary); font-weight: 500;">{{ opt.label }}</span>
            </label>
            
            <div v-if="resolveSelectOptions(activeMultiSelectCell?.meta).length === 0" style="color: var(--text-muted); text-align: center; padding: 2rem 0; font-size: 0.9rem;">
              No hi ha opcions actives. Comprova que la taula enllaçada no estigui buida o contingui només zeros.
            </div>
          </div>
        </div>
        
        <div class="modal-footer" style="margin-top: 1rem; border-top: 1px solid var(--border-color); padding-top: 1rem; display: flex; justify-content: flex-end;">
          <button class="btn btn-primary" style="width: auto;" @click="isMultiSelectModalOpen = false">Fet</button>
        </div>
      </div>
    </div>

    <!-- Dedicated Formula Editor Modal -->
    <div class="modal-overlay" v-if="isFormulaModalOpen" style="display: flex; z-index: 1100;">
      <div class="modal-content" style="max-width: 650px; width: 90%; display: flex; flex-direction: column; gap: 12px;">
        <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem;">
          <h3 style="margin: 0; font-size: 1.05rem; display: flex; align-items: center; gap: 6px;">
            <span>🧮 Editor Ampliat de Fórmula: <strong style="color: var(--color-primary);">{{ editingFormulaItem?.element }}</strong></span>
          </h3>
          <button type="button" class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="isFormulaModalOpen = false">&times;</button>
        </div>

        <div class="modal-body" style="display: flex; flex-direction: column; gap: 10px;">
          <!-- Field Insert Badges -->
          <div>
            <span style="font-size: 0.75rem; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 4px;">Camps de la fila disponibles (Clica per inserir):</span>
            <div style="display: flex; flex-wrap: wrap; gap: 6px;">
              <button 
                v-for="col in availableFormulaFields" 
                :key="col" 
                type="button" 
                class="btn btn-secondary" 
                style="padding: 3px 8px; font-size: 0.75rem; font-family: var(--font-mono); width: auto; background: var(--bg-tertiary);"
                @click="insertTokenIntoFormula(col)"
              >
                + {{ col }}
              </button>
            </div>
          </div>

          <!-- Global Model Paths Badges (Jinja2 syntax) -->
          <div v-if="globalFormulaPaths.length > 0">
            <span style="font-size: 0.75rem; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 4px;">Rutes globals del model de dades (Jinja2):</span>
            <div style="display: flex; flex-wrap: wrap; gap: 6px; max-height: 80px; overflow-y: auto;">
              <button 
                v-for="gPath in globalFormulaPaths" 
                :key="gPath" 
                type="button" 
                class="btn btn-secondary" 
                style="padding: 2px 7px; font-size: 0.73rem; font-family: var(--font-mono); width: auto; border: 1px dashed var(--color-primary); color: var(--color-primary);"
                @click="insertTokenIntoFormula(gPath)"
                :title="'Insereix la ruta global ' + gPath"
              >
                + {{ gPath }}
              </button>
            </div>
          </div>

          <!-- Quick Operators & Functions -->
          <div>
            <span style="font-size: 0.75rem; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 4px;">Operadors i Funcions:</span>
            <div style="display: flex; flex-wrap: wrap; gap: 6px;">
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' + ')">+</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' - ')">-</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' * ')">*</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' / ')">/</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' % ')">%</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' ^ ')">^</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' ( ')">(</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto;" @click="insertTokenIntoFormula(' ) ')">)</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto; font-weight: bold; color: var(--color-primary);" @click="insertTokenIntoFormula('SI(condició; cert; fals)')">SI(condició; cert; fals)</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto; font-weight: bold; color: var(--color-primary);" @click="insertTokenIntoFormula('ARRODONEIX(valor; 2)')">ARRODONEIX(valor; prec)</button>
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto; font-weight: bold; color: var(--color-primary);" @click="insertTokenIntoFormula('ABS(valor)')">ABS(valor)</button>
            </div>
          </div>

          <!-- Multi-line Textarea -->
          <div>
            <label style="font-size: 0.78rem; font-weight: 600; color: var(--text-primary); display: block; margin-bottom: 4px;">Expressió de la Fórmula:</label>
            <textarea 
              ref="formulaTextareaRef"
              v-model="formulaTextBuffer" 
              rows="5"
              class="data-input" 
              style="width: 100%; font-family: var(--font-mono); font-size: 0.9rem; padding: 8px; line-height: 1.4; resize: vertical;"
              placeholder="ex: SI(persones > 0; persones * unitats * preu; unitats * preu)"
            ></textarea>
          </div>
        </div>

        <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border-color); padding-top: 0.75rem;">
          <button type="button" class="btn btn-secondary" style="width: auto;" @click="isFormulaModalOpen = false">Cancel·la</button>
          <button type="button" class="btn btn-primary" style="width: auto;" @click="saveFormulaModal">Desa la Fórmula</button>
        </div>
      </div>
    </div>

    <!-- 9. Visual Grid Layout Editor Modal -->
    <VisualGridEditorModal 
      v-model="isVisualGridModalOpen" 
      :groupName="activeConfigGroup" 
      :configList="groupConfigList" 
    />

    <!-- Modal for Creating New Sheet / Group -->
    <div class="modal-overlay" v-if="isNewSheetModalOpen" style="display: flex; z-index: 1100;">
      <div class="modal-content" style="max-width: 540px; width: 95%;">
        <div class="modal-header">
          <h3 style="border: none; padding-bottom: 0; margin: 0; display: flex; align-items: center; gap: 8px;">
            <span style="color: var(--color-primary); font-size: 1.2rem;">📊</span>
            <span>Crear Nou Full / Grup de Dades</span>
          </h3>
          <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="isNewSheetModalOpen = false">&times;</button>
        </div>
        
        <div class="modal-body" style="display: flex; flex-direction: column; gap: 1rem; padding: 0.75rem 0;">
          <div class="form-row" style="display: flex; flex-direction: column; gap: 4px;">
            <label style="font-weight: 600; font-size: 0.85rem;">Nom del Full / Entitat (clau interna):</label>
            <input 
              type="text" 
              v-model="newSheetNameInput" 
              class="data-input" 
              placeholder="ex: contractant, pres, lots, partides"
              @keyup.enter="createNewSheet"
            >
            <span style="font-size: 0.72rem; color: var(--text-muted);">El nom es converteix automàticament a minúscules i format clau (ex: `parts`).</span>
          </div>

          <div class="form-row" style="display: flex; flex-direction: column; gap: 4px;">
            <label style="font-weight: 600; font-size: 0.85rem;">Tipus d'Estructura de Full:</label>
            <select v-model="newSheetKindInput" class="data-input">
              <option value="kv">Clau-Valor (KV - formulari d'un sol registre)</option>
              <option value="tabular">Tabular (Llista / taula de rengleres independents)</option>
              <option value="sub_table">Sub-taula Aniuada (taula fill vinculada a un altre full)</option>
            </select>
          </div>

          <div v-if="newSheetKindInput === 'sub_table'" class="form-row" style="display: flex; flex-direction: column; gap: 4px;">
            <label style="font-weight: 600; font-size: 0.85rem;">Full Pare (al qual pertany aquesta sub-taula):</label>
            <select v-model="newSheetParentInput" class="data-input">
              <option value="">[Selecciona Full Pare (ex: pres o pres.parts)]</option>
              <option v-for="p in availableParentSheets" :key="p" :value="p">{{ p }}</option>
            </select>
            <span v-if="newSheetParentInput && newSheetNameInput" style="font-size: 0.75rem; color: var(--color-primary); font-weight: 600;">
              Ruta d'accés resultant: <code>{{ newSheetParentInput }}.{{ newSheetNameInput.toLowerCase().replace(/[^a-z0-9_]/g, '_') }}</code>
            </span>
          </div>
        </div>

        <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border-color); padding-top: 0.75rem;">
          <button class="btn btn-secondary" style="width: auto;" @click="isNewSheetModalOpen = false">Cancel·la</button>
          <button class="btn btn-primary" style="width: auto;" @click="createNewSheet" :disabled="!newSheetNameInput.trim()">
            ✓ Crear Full / Grup
          </button>
        </div>
      </div>
    </div>
    <!-- Modal for Pasting Configuration Text -->
    <div class="modal-overlay" v-if="isPasteModalOpen" style="display: flex; z-index: 1150;">
      <div class="modal-content" style="max-width: 550px; width: 95%;">
        <div class="modal-header">
          <h3 style="border: none; padding-bottom: 0; margin: 0; display: flex; align-items: center; gap: 8px;">
            <span style="color: var(--color-primary); font-size: 1.2rem;">📥</span>
            <span>Enganxar Configuració {{ pasteTargetGroup ? `del grup '${pasteTargetGroup}'` : 'GLOBAL' }}</span>
          </h3>
          <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="isPasteModalOpen = false">&times;</button>
        </div>
        
        <div class="modal-body" style="display: flex; flex-direction: column; gap: 0.75rem; padding: 0.75rem 0;">
          <p style="font-size: 0.8rem; color: var(--text-muted); margin: 0;">
            Enganxa el codi JSON de la configuració de dades {{ pasteTargetGroup ? `per al grup '${pasteTargetGroup}'` : 'global de tot el projecte' }} a continuació:
          </p>
          <textarea 
            v-model="pasteBufferText"
            rows="8"
            class="data-input"
            style="font-family: var(--font-mono); font-size: 0.78rem; width: 100%; resize: vertical;"
            placeholder="Enganxa aquí el text JSON (Ctrl+V)..."
          ></textarea>
        </div>

        <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border-color); padding-top: 0.75rem;">
          <button class="btn btn-secondary" style="width: auto;" @click="isPasteModalOpen = false">Cancel·la</button>
          <button class="btn btn-primary" style="width: auto;" @click="processPasteModalSubmit" :disabled="!pasteBufferText.trim()">
            ✓ Aplica Configuració
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.data-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xs);
  font-family: inherit;
  font-size: 0.85rem;
  background: var(--bg-primary);
  color: var(--text-primary);
  box-sizing: border-box;
  resize: vertical;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.data-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-light);
  background: var(--bg-card);
}

.inspector-table td {
  vertical-align: middle;
}

:deep(.template-grid) {
  height: 100% !important;
  max-height: 100% !important;
}

:deep(.editor-container) {
  height: 100% !important;
  flex: 1 !important;
}

:deep(.variables-sidebar) {
  height: 100% !important;
}

.visual-canvas h1, .visual-canvas h2, .visual-canvas h3 {
  margin-top: 0.5rem;
  margin-bottom: 0.25rem;
  border: none;
  padding: 0;
}
.visual-canvas ul {
  padding-left: 1.25rem;
  margin: 0.5rem 0;
}

.btn-segment {
  transition: background-color 0.15s ease, color 0.15s ease;
}
.btn-segment.active {
  background-color: var(--color-primary) !important;
  color: white !important;
  font-weight: 600;
}

.accordion-item.compact-card {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-card);
  padding: 1.25rem;
  box-shadow: 0 4px 6px rgba(0,0,0,0.02);
  margin-bottom: 0;
}
.accordion-item.compact-card .accordion-content {
  padding: 0;
}
</style>
