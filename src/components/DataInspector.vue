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

// Auto-initialize selectedCompactSheet and open root sheets when data loads
watch(() => store.excelJsonData, (newVal) => {
  if (newVal) {
    evaluateComputedFields(newVal);
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
  Object.keys(sheetData).forEach(k => {
    if (isPrimitive(sheetData[k])) {
      res[k] = sheetData[k];
    }
  });
  return res;
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
  return Object.values(row).every(val => val === 0 || val === 0.0 || val === '' || val === null || val === undefined || val === false);
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
    const newRow = {};
    const sample = sheetData[0] || {};
    Object.keys(sample).forEach(k => {
      if (Array.isArray(sample[k])) {
        newRow[k] = [];
      } else {
        newRow[k] = '';
      }
    });
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

const isCellModalOpen = ref(false);
const cellTextValue = ref('');
const activeCellInfo = ref({ sheet: '', keyOrIdx: '', col: null, isKv: true });

const openCellEditor = (sheet, keyOrIdx, col, isKv) => {
  const colName = isKv ? keyOrIdx : col;
  if (getElementType(sheet, colName) === 'Computed') {
    store.addLog("Aquest camp és calculat automàticament i no es pot editar manualment.", "info");
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

// Metadata Schema helpers for custom types
const getElementMetadata = (groupName, elementName) => {
  if (!store.editorMetadata) return null;
  return store.editorMetadata.find(m => m.group === groupName && m.element === elementName) || null;
};

const getElementType = (groupName, elementName) => {
  const meta = getElementMetadata(groupName, elementName);
  return meta ? meta.type : 'Text';
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

const openGroupConfig = (groupName, sheetData) => {
  activeConfigGroup.value = groupName;
  const isKv = getSheetType(sheetData) === 'kv';
  const elements = isKv ? Object.keys(sheetData) : (sheetData.length > 0 ? Object.keys(sheetData[0]) : []);
  
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
      calcTargetCol: meta.calcTargetCol || ''
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
      if (sheetData.length === 0) {
        sheetData.push({ [cleanKey]: '' });
      } else {
        sheetData.forEach(row => {
          if (!(cleanKey in row)) row[cleanKey] = '';
        });
      }
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
      calcTargetCol: ''
    });
  }
};

const saveGroupConfig = () => {
  const groupName = activeConfigGroup.value;
  
  // Clear old metadata for this group
  store.editorMetadata = store.editorMetadata.filter(m => m.group !== groupName);
  
  // Add new
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
    }
    if (item.width) {
      meta.width = item.width;
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
    }
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
        <p style="font-size:0.75rem; margin-top: 0.25rem;">Inicialitzeu els motors WASM i carregueu un Excel de licitació.</p>
      </div>
    </div>

    <!-- Spreadsheet Accordion Inspector -->
    <div v-else-if="!showJsonView" class="sheets-accordion">
      
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
            <span>{{ name }}</span>
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
                {{ name }}
              </h4>
              <button 
                class="btn btn-secondary" 
                style="width: auto; padding: 3px 8px; font-size: 0.72rem; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border-color);"
                @click="openGroupConfig(name, sheetData)"
                title="Configura tipus de dades per a aquest grup"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 1 1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
                <span v-if="store.config.showButtonTexts">Configura Tipus</span>
              </button>
          </div>
          <!-- Tabular Preview -->
          <template v-if="getSheetType(sheetData) === 'tabular'">
            <div v-if="sheetData.length === 0" style="font-size:0.8rem; color:var(--text-muted); padding: 1rem 0;">Taula buida</div>
            <div v-else style="overflow-x: auto;">
              <table class="inspector-table">
                <thead>
                  <tr>
                    <th 
                      v-for="col in Object.keys(sheetData[0]).filter(k => isPrimitive(sheetData[0][k]))" 
                      :key="col" 
                      :style="getColumnWidthStyle(name, col)"
                    >
                      <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                        <span>{{ col }}</span>
                        <span v-if="getColumnWidthPct(name, col)" style="font-size: 0.7rem; font-weight: normal; color: var(--text-muted); padding: 2px 4px; background: rgba(0,0,0,0.05); border-radius: 3px;">
                          {{ getColumnWidthPct(name, col) }}%
                        </span>
                      </div>
                    </th>
                    <th style="width: 50px;">Accions</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, idx) in sheetData.slice(0, visibleRowsCount[name])" :key="idx" :id="'data-row-' + name + '-' + idx">
                    <td v-for="col in Object.keys(sheetData[0]).filter(k => isPrimitive(sheetData[0][k]))" :key="col" style="padding: 4px;">
                      <span v-if="typeof row[col] === 'object' && row[col] !== null" style="font-size:0.75rem; color:var(--text-muted)">
                        [Complex]
                      </span>
                      <div v-else style="display: flex; gap: 4px; align-items: stretch; width: 100%;">
                        <!-- Select Type -->
                        <template v-if="getElementType(name, col) === 'Select'">
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
                        
                        <!-- Computed Type (Non-editable) -->
                        <div 
                          v-else-if="getElementType(name, col) === 'Computed'" 
                          :id="'data-field-' + name + '-' + idx + '-' + col"
                          :data-path="name + '.' + idx + '.' + col"
                          style="display: flex; align-items: center; gap: 6px; flex-grow: 1; height: 32px; padding: 2px 10px; border: 1px solid var(--border-color); border-radius: var(--radius-xs); background: var(--bg-tertiary); color: var(--text-primary); font-family: var(--font-mono); font-size: 0.82rem; font-weight: 600; cursor: not-allowed;" 
                          title="🔒 Camp calculat automàticament"
                        >
                          <span style="font-size: 0.85rem;">🧮</span>
                          <span style="flex-grow: 1;">{{ store.excelJsonData[name][idx][col] !== undefined ? store.excelJsonData[name][idx][col] : 0 }}</span>
                          <span style="font-size: 0.65rem; color: var(--text-muted); font-weight: normal; background: rgba(0,0,0,0.06); padding: 1px 4px; border-radius: 3px;">Calculat</span>
                        </div>

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
          
          <!-- Key Value Preview -->
          <template v-else>
            <table class="inspector-table">
              <thead>
                <tr>
                  <th style="width: 240px; padding: 4px 8px;">Clau (Sanititzada)</th>
                  <th style="padding: 4px 8px;">Valor</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(val, key) in getKvPrimitiveEntries(sheetData)" :key="key">
                  <td style="vertical-align: middle; padding: 3px 8px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;">
                      <div>
                        <span style="font-weight: 600; color: var(--text-primary);">{{ getFieldLabel(name, key) }}</span>
                        <code v-if="getFieldLabel(name, key) !== key" style="font-size: 0.7rem; color: var(--text-muted); margin-left: 6px;">({{ key }})</code>
                      </div>
                      <button 
                        class="btn-icon-only text-danger" 
                        style="height: 22px; width: 22px; min-width: 22px; font-size: 0.75rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none;"
                        title="Elimina clau-valor"
                        @click="deleteKvKey(name, key)"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      </button>
                    </div>
                  </td>
                  <td style="padding: 2px 4px;">
                    <div style="display: flex; gap: 4px; align-items: stretch; width: 100%;">
                      <!-- Select Type -->
                      <template v-if="getElementType(name, key) === 'Select'">
                        <!-- Multiple select -->
                        <div 
                          v-if="getElementMetadata(name, key)?.multiple"
                          :id="'data-field-' + name + '-' + key"
                          :data-path="name + '.' + key"
                          style="display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 28px; padding: 2px 4px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); flex-grow: 1; cursor: pointer; max-width: 300px; max-height: 80px; overflow-y: auto;"
                          @click="openMultiSelectModal(name, true, key, null, getElementMetadata(name, key))"
                          title="Fes clic per modificar la selecció"
                        >
                          <span v-if="getSelectedPills(store.excelJsonData[name][key], getElementMetadata(name, key)).length === 0" style="color: var(--text-muted); font-size: 0.78rem; padding: 0 4px;">
                            [Tria opcions]
                          </span>
                          <span 
                            v-for="pill in getSelectedPills(store.excelJsonData[name][key], getElementMetadata(name, key))" 
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
                          :id="'data-field-' + name + '-' + key"
                          :data-path="name + '.' + key"
                          v-model="store.excelJsonData[name][key]"
                          class="data-input"
                          style="flex-grow: 1; height: 28px; font-size: 0.8rem;"
                        >
                          <option value="">[Buit / Sense valor]</option>
                          <option 
                            v-for="opt in resolveSelectOptions(getElementMetadata(name, key))" 
                            :key="opt.value" 
                            :value="opt.value"
                          >
                            {{ opt.label }}
                          </option>
                        </select>
                      </template>
                      
                      <!-- Computed Type (Non-editable) -->
                      <div 
                        v-else-if="getElementType(name, key) === 'Computed'" 
                        :id="'data-field-' + name + '-' + key"
                        :data-path="name + '.' + key"
                        style="display: flex; align-items: center; gap: 6px; flex-grow: 1; height: 28px; padding: 2px 10px; border: 1px solid var(--border-color); border-radius: var(--radius-xs); background: var(--bg-tertiary); color: var(--text-primary); font-family: var(--font-mono); font-size: 0.8rem; font-weight: 600; cursor: not-allowed;" 
                        title="🔒 Camp calculat automàticament"
                      >
                        <span style="font-size: 0.85rem;">🧮</span>
                        <span style="flex-grow: 1;">{{ store.excelJsonData[name][key] !== undefined ? store.excelJsonData[name][key] : 0 }}</span>
                        <span style="font-size: 0.65rem; color: var(--text-muted); font-weight: normal; background: rgba(0,0,0,0.06); padding: 1px 4px; border-radius: 3px;">Calculat</span>
                      </div>

                      <!-- Date Type -->
                      <input 
                        v-else-if="getElementType(name, key) === 'Date'"
                        :id="'data-field-' + name + '-' + key"
                        :data-path="name + '.' + key"
                        type="date"
                        v-model="store.excelJsonData[name][key]"
                        class="data-input"
                        style="flex-grow: 1; height: 28px; font-size: 0.8rem;"
                      >
                      
                      <!-- Number Type -->
                      <input 
                        v-else-if="getElementType(name, key) === 'Number'"
                        :id="'data-field-' + name + '-' + key"
                        :data-path="name + '.' + key"
                        type="number"
                        step="any"
                        v-model="store.excelJsonData[name][key]"
                        class="data-input"
                        style="flex-grow: 1; height: 28px; font-size: 0.8rem;"
                      >
                      
                      <!-- Boolean Type -->
                      <select 
                        v-else-if="getElementType(name, key) === 'Boolean'"
                        :id="'data-field-' + name + '-' + key"
                        :data-path="name + '.' + key"
                        v-model="store.excelJsonData[name][key]"
                        class="data-input"
                        style="flex-grow: 1; height: 28px; font-size: 0.8rem;"
                      >
                        <option value="">[Buit / Sense valor]</option>
                        <option :value="true">Cert (True)</option>
                        <option :value="false">Fals (False)</option>
                      </select>
                      
                      <!-- Text Type (default) -->
                      <textarea 
                        v-else-if="viewMode === 'compact' || (typeof val === 'string' && val.length > 40)"
                        :id="'data-field-' + name + '-' + key"
                        :data-path="name + '.' + key"
                        v-model="store.excelJsonData[name][key]"
                        class="data-input"
                        :rows="viewMode === 'compact' ? 2 : undefined"
                        style="flex-grow: 1; resize: vertical; font-size: 0.8rem;"
                        :style="{ minHeight: viewMode === 'compact' ? '55px' : '40px' }"
                      ></textarea>
                      <input 
                        v-else
                        :id="'data-field-' + name + '-' + key"
                        :data-path="name + '.' + key"
                        type="text"
                        v-model="store.excelJsonData[name][key]"
                        class="data-input"
                        style="flex-grow: 1; height: 28px; font-size: 0.8rem;"
                      >
                      <button 
                        class="btn-icon-only"
                        style="height: 28px; width: 28px; min-width: 28px; font-size: 0.85rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: var(--bg-tertiary);"
                        title="Edició complexa en Markdown + Jinja2"
                        @click="openCellEditor(name, key, null, true)"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            
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
    <div class="modal-overlay" :style="{ display: isConfigModalOpen ? 'flex' : 'none' }">
      <div class="modal-content" style="max-width: 650px; width: 95%; max-height: 80vh; display: flex; flex-direction: column;">
        <div class="modal-header">
          <h3 style="border: none; padding-bottom: 0; margin: 0;">Configura Tipus: {{ activeConfigGroup }}</h3>
          <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem;" @click="isConfigModalOpen = false">&times;</button>
        </div>
        
        <div class="modal-body" style="flex-grow: 1; overflow-y: auto; padding: 1rem 0;">
          <table class="inspector-table" style="width: 100%;">
            <thead>
              <tr>
                <th>Element (Clau/Columna)</th>
                <th>Etiqueta al formulari (Opcional)</th>
                <th>Tipus de Dada</th>
                <th>Valors Possibles (Select)</th>
                <th v-if="getSheetType(store.excelJsonData[activeConfigGroup]) === 'tabular'" style="width: 90px;">Amplada (%)</th>
                <th v-if="getSheetType(store.excelJsonData[activeConfigGroup]) === 'tabular'" style="width: 60px; text-align: center;">Accions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in groupConfigList" :key="item.element">
                <td style="font-weight: 600; font-family: monospace; font-size: 0.8rem; vertical-align: middle; padding: 6px 8px;">
                  {{ item.element }}
                </td>
                <td style="padding: 4px;">
                  <input 
                    type="text" 
                    v-model="item.label" 
                    class="data-input" 
                    style="padding: 2px 6px; height: 28px; font-size: 0.8rem;"
                    :placeholder="item.element"
                    title="Nom personalitzat a mostrar al formulari en comptes del nom del camp"
                  >
                </td>
                <td style="padding: 4px;">
                  <select v-model="item.type" class="data-input" style="padding: 2px 6px; height: 28px; font-size: 0.8rem;">
                    <option value="Text">Text (String)</option>
                    <option value="Number">Number (Numèric)</option>
                    <option value="Date">Date (Data)</option>
                    <option value="Boolean">Boolean (Lògic)</option>
                    <option value="Select">Select (Desplegable)</option>
                    <option value="Computed">Calculat (Computed: SUM, COUNT, AVG)</option>
                  </select>
                </td>
                <td style="padding: 4px; vertical-align: top;">
                  <template v-if="item.type === 'Select'">
                    <!-- Select Source Type -->
                    <div style="margin-bottom: 6px;">
                      <select v-model="item.sourceType" class="data-input" style="padding: 2px 6px; height: 28px; font-size: 0.8rem; width: 100%;">
                        <option value="static">Llista manual (Estàtic)</option>
                        <option value="dynamic">Vector de dades (Dinàmic)</option>
                      </select>
                    </div>
                    
                    <!-- Static comma list -->
                    <div v-if="item.sourceType === 'static'">
                      <input 
                        type="text" 
                        v-model="item.optionsRaw" 
                        class="data-input" 
                        placeholder="opcio1, opcio2, opcio3"
                        style="padding: 4px 8px; height: 28px; font-size: 0.8rem;"
                      >
                    </div>
                    
                    <!-- Dynamic vector config -->
                    <div v-else style="display: flex; flex-direction: column; gap: 4px;">
                      <!-- Vector Path Selection -->
                      <select v-model="item.vectorPath" class="data-input" style="padding: 2px 6px; height: 28px; font-size: 0.8rem;" @change="onVectorPathChange(item)">
                        <option value="">-- Tria una taula --</option>
                        <option v-for="tName in getAvailableTables()" :key="tName" :value="tName">
                          {{ tName }}
                        </option>
                      </select>
                      
                      <!-- Field mapping (only if vectorPath is set and has columns) -->
                      <div v-if="item.vectorPath && getTableColumns(item.vectorPath).length > 0" style="display: flex; gap: 4px;">
                        <select v-model="item.displayField" class="data-input" style="padding: 2px 6px; height: 28px; font-size: 0.75rem; flex: 1;" title="Camp visual">
                          <option value="">-- Camp visual --</option>
                          <option v-for="col in getTableColumns(item.vectorPath)" :key="col" :value="col">{{ col }}</option>
                        </select>
                        <select v-model="item.valueField" class="data-input" style="padding: 2px 6px; height: 28px; font-size: 0.75rem; flex: 1;" title="Camp a desar">
                          <option value="">-- Camp a desar --</option>
                          <option v-for="col in getTableColumns(item.vectorPath)" :key="col" :value="col">{{ col }}</option>
                        </select>
                      </div>
                    </div>
                    
                    <!-- Multi-select checkbox -->
                    <label style="display: flex; align-items: center; gap: 6px; margin-top: 6px; cursor: pointer; font-size: 0.8rem; color: var(--text-primary);">
                      <input type="checkbox" v-model="item.multiple">
                      <span>Selecció múltiple</span>
                    </label>
                  </template>

                  <!-- Computed Configuration -->
                  <template v-else-if="item.type === 'Computed'">
                    <div style="display: flex; flex-direction: column; gap: 4px; padding: 2px 0;">
                      <div style="display: flex; gap: 4px; align-items: center;">
                        <span style="font-size: 0.72rem; font-weight: 600; width: 60px;">Funció:</span>
                        <select v-model="item.calcFn" class="data-input" style="padding: 2px 6px; height: 26px; font-size: 0.75rem; flex: 1;">
                          <option value="SUM">SUM (Suma)</option>
                          <option value="COUNT">COUNT (Recompte)</option>
                          <option value="AVG">AVG (Mitjana)</option>
                        </select>
                      </div>

                      <div style="display: flex; gap: 4px; align-items: center;">
                        <span style="font-size: 0.72rem; font-weight: 600; width: 60px;">Sub-taula:</span>
                        <select v-model="item.calcVector" class="data-input" style="padding: 2px 6px; height: 26px; font-size: 0.75rem; flex: 1;">
                          <option value="">-- Sub-taula --</option>
                          <option v-for="vec in getAvailableChildVectorsForGroup(activeConfigGroup)" :key="vec" :value="vec">
                            {{ vec }}
                          </option>
                        </select>
                      </div>

                      <div v-if="item.calcFn !== 'COUNT' && item.calcVector" style="display: flex; gap: 4px; align-items: center;">
                        <span style="font-size: 0.72rem; font-weight: 600; width: 60px;">Columna:</span>
                        <select v-model="item.calcTargetCol" class="data-input" style="padding: 2px 6px; height: 26px; font-size: 0.75rem; flex: 1;">
                          <option value="">-- Columna --</option>
                          <option v-for="col in getChildTableColumns(activeConfigGroup, item.calcVector)" :key="col" :value="col">
                            {{ col }}
                          </option>
                        </select>
                      </div>
                    </div>
                  </template>

                  <template v-else>
                    <span style="color: var(--text-muted); font-size: 0.8rem;">No aplicable</span>
                  </template>
                </td>
                
                <!-- Width (%) -->
                <td v-if="getSheetType(store.excelJsonData[activeConfigGroup]) === 'tabular'" style="padding: 4px; vertical-align: top;">
                  <div style="display: flex; align-items: center; gap: 4px;">
                    <input 
                      type="number" 
                      v-model="item.width" 
                      min="1" 
                      max="100" 
                      placeholder="Auto"
                      class="data-input" 
                      style="padding: 2px 6px; height: 28px; font-size: 0.8rem; text-align: right;"
                    >
                    <span style="font-size: 0.85rem; color: var(--text-muted);">%</span>
                  </div>
                </td>
                
                <!-- Actions -->
                <td v-if="getSheetType(store.excelJsonData[activeConfigGroup]) === 'tabular'" style="padding: 4px; text-align: center; vertical-align: middle;">
                  <button 
                    class="btn-icon-only text-danger" 
                    style="border: none; background: transparent; font-size: 1rem; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; height: 28px; width: 28px;"
                    title="Elimina columna"
                    @click="deleteTabularColumn(item.element)"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          
          <!-- Add field / key button inside config modal -->
          <div style="margin-top: 0.75rem; padding: 0 0.5rem; display: flex; justify-content: flex-start;">
            <button 
              class="btn btn-secondary" 
              style="width: auto; padding: 3px 10px; font-size: 0.75rem; display: inline-flex; align-items: center; gap: 4px;" 
              @click="addNewFieldToConfig"
              title="Afegeix una nova clau o camp a aquest grup"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span>Afegeix nova clau / camp</span>
            </button>
          </div>
        </div>
        
        <div class="modal-footer" style="margin-top: 1rem; border-top: 1px solid var(--border-color); padding-top: 1rem; display: flex; justify-content: flex-end; gap: 8px;">
          <button class="btn btn-secondary" style="width: auto;" @click="isConfigModalOpen = false">Cancel·la</button>
          <button class="btn btn-primary" style="width: auto;" @click="saveGroupConfig">Aplica</button>
        </div>
      </div>
    </div>

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
