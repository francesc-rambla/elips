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
import { useWasmEngines } from '../composables/useWasmEngines';
import { isPrimitive, isNonEmptySchema, universalFindSchema } from '../composables/useSchemaResolver';
import { builtinFunctions, useFormulaAutocomplete } from '../composables/useFormulaAutocomplete';
import { findElementMetadata, isFieldCalculated, fieldLabel, groupLabel, isInternalMetadataKey, saveGroupConfig as saveGroupConfigShared } from '../composables/useGroupMetadata';
import NestedDataNode from './NestedDataNode.vue';
import katex from 'katex';
import { latexSymbols } from './latexSymbols';

import { runGlobalAutoAdjust } from '../main';

const store = useWorkspaceStore();
const { saveExcelData, evaluateComputedFields, analyzeMirrorPattern, applyMirrorColumn } = useWasmEngines();
const showJsonView = ref(false);
const openSheets = ref({});
const savingExcel = ref(false);

const isExcelLoaded = computed(() => !!store.excelJsonData);

const viewMode = ref('compact'); // 'complete' or 'compact' (default: compact)
const selectedCompactSheet = ref('');

let isEvaluating = false;
let evalDebounceTimer = null;

// Reprograma un timer per recalcular fórmules i desar mentre l'usuari escriu, evitant recàlculs a cada tecla
const onCellInput = () => {
  if (evalDebounceTimer) clearTimeout(evalDebounceTimer);
  const delayMs = Math.max(1, (store.config?.autoSaveDebounceSeconds || 5)) * 1000;
  evalDebounceTimer = setTimeout(() => {
    runCellEvaluationAndSave();
  }, delayMs);
};

// En perdre el focus d'una cel·la, cancel·la el debounce pendent i força l'avaluació/desat immediats
const onCellBlur = () => {
  if (evalDebounceTimer) {
    clearTimeout(evalDebounceTimer);
    evalDebounceTimer = null;
  }
  runCellEvaluationAndSave();
  if (window.__flushGlobalSave) {
    window.__flushGlobalSave();
  }
};

// Recalcula els camps calculats i desa l'Excel; punt únic cridat pels handlers d'edició de cel·la
const runCellEvaluationAndSave = () => {
  if (!store.excelJsonData) return;
  try {
    evaluateComputedFields(store.excelJsonData, store.editorMetadata);
    saveExcelData();
  } catch (err) {
    console.error("Error durant el recàlcul o desat:", err);
  }
};

const getSheetType = (sheetData) => {
  return Array.isArray(sheetData) ? 'tabular' : 'kv';
};

// Determina si un nom de full és un full arrel visible a l'acordió (exclou metadades internes i sub-taules amb ruta amb punt)
const isRootSheet = (name) => {
  if (name === 'editor_metadata' || name === '_hierarchy_schema') return false;
  return !name.includes('.');
};

// Trigger instant textarea height adjustments when sheets or data change
watch([selectedCompactSheet, viewMode, () => store.excelJsonData], () => {
  nextTick(() => {
    runGlobalAutoAdjust();
    setTimeout(runGlobalAutoAdjust, 100);
  });
}, { deep: true, immediate: true });

// Real-time immediate formula evaluation deep watcher + auto-initialize selectedCompactSheet
watch(() => store.excelJsonData, (newVal) => {
  if (newVal && !isEvaluating) {
    isEvaluating = true;
    try {
      evaluateComputedFields(newVal, store.editorMetadata);
    } catch (e) {
      console.warn("Error durant el recàlcul de fórmules:", e);
    } finally {
      nextTick(() => {
        isEvaluating = false;
      });
    }
    const keys = Object.keys(newVal).filter(k => k !== 'editor_metadata' && k !== '_hierarchy_schema' && isRootSheet(k));
    if (keys.length > 0) {
      if (!selectedCompactSheet.value || !keys.includes(selectedCompactSheet.value)) {
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

// Retorna només els parells clau/valor primitius d'un full KV, descartant sub-objectes/taules aniuades
const getKvPrimitiveEntries = (sheetData) => {
  if (!sheetData || typeof sheetData !== 'object' || Array.isArray(sheetData)) return {};
  const res = {};
  Object.keys(sheetData).filter(k => !isInternalMetadataKey(k) && isPrimitive(sheetData[k])).forEach(k => {
    res[k] = sheetData[k];
  });
  return res;
};

// Agrupa i ordena els camps primitius d'un full KV en files segons la configuració manual (gridRow/gridOrder) per construir el layout de l'acordió
const getKvRowBlocks = (sheetData, groupName = '') => {
  if (!sheetData || typeof sheetData !== 'object' || Array.isArray(sheetData)) return [];
  const keys = Object.keys(sheetData).filter(k => !isInternalMetadataKey(k) && isPrimitive(sheetData[k]));
  
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

// Calcula l'estil inline de la targeta d'un camp KV (amplada, layout) segons la configuració del grup i la posició de l'etiqueta
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

// Converteix un valor intern (fracció) a la representació visual en tant per cent amb coma decimal
const formatPercentageDisplay = (val) => {
  if (val === undefined || val === null || val === '') return '';
  let strVal = String(val).replace('%', '').replace(',', '.').trim();
  const num = parseFloat(strVal);
  if (isNaN(num)) return val;
  const scaled = Math.round(num * 100 * 1000000) / 1000000;
  return String(scaled).replace('.', ',');
};

// Interpreta l'entrada de l'usuari en un camp de percentatge i la converteix a la fracció interna que es desa
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
  targetObj[key] = Math.round((num / 100.0) * 1000000) / 1000000;
};

const getGroupCleanName = (name) => {
  if (!name) return '';
  return name.includes('.') ? name.split('.').pop() : name;
};

// Determina les columnes visibles d'una taula combinant metadades de l'editor, l'esquema jeràrquic, la informació dels fulls i les dades reals existents
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

// Localitza els esquemes de les sub-taules/grups fills directes d'un full, combinant l'esquema jeràrquic declarat amb claus no primitives presents a les dades
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

// Navega i fa scroll fins al camp indicat per store.targetDataPath, obrint el full corresponent i ressaltant-lo visualment
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

// Afegeix una nova clau sanititzada a un full KV, evitant duplicats, i desa el canvi
const addKvKey = (sheetName) => {
  const key = prompt("Introdueix el nom de la nova clau (es sanititzarà automàticament):");
  if (!key) return;
  const cleanKey = key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!store.excelJsonData[sheetName]) {
    store.excelJsonData[sheetName] = {};
  }
  if (cleanKey in store.excelJsonData[sheetName]) {
    alert("Aquesta clau ja existeix.");
    return;
  }
  store.excelJsonData[sheetName][cleanKey] = '';
  store.excelJsonData = JSON.parse(JSON.stringify(store.excelJsonData));
  saveExcelData();
  store.addLog(`Clau '${cleanKey}' afegida al full '${sheetName}'.`, 'info');
};

// Elimina una clau d'un full KV després de confirmació de l'usuari i desa el canvi
const deleteKvKey = (sheetName, key) => {
  if (confirm(`Segur que vols eliminar la clau '${key}'?`)) {
    delete store.excelJsonData[sheetName][key];
    store.excelJsonData = JSON.parse(JSON.stringify(store.excelJsonData));
    saveExcelData();
    store.addLog(`Clau '${key}' eliminada del full '${sheetName}'.`, 'info');
  }
};

// Indica si una fila tabular és efectivament buida (tots els valors primitius a zero/buit), per decidir si es pot amagar/reutilitzar
const isRowAllZerosOrEmpty = (row) => {
  if (!row || typeof row !== 'object') return false;
  const primitiveValues = Object.entries(row)
    .filter(([k, v]) => !k.startsWith('_') && !Array.isArray(v) && (typeof v !== 'object' || v === null))
    .map(([k, v]) => v);
  if (primitiveValues.length === 0) return true;
  return primitiveValues.every(val => val === 0 || val === 0.0 || val === '' || val === null || val === undefined || val === false || val === '0' || val === '0.0');
};

const visibleRowsCount = ref({});

// Calcula quantes files de cada taula cal mostrar inicialment, amagant les files finals buides generades per l'Excel importat
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

// Afegeix una fila a una taula: reutilitza una fila buida ja existent si n'hi ha, o en crea una de nova amb totes les columnes conegudes
const addTabularRow = (sheetName, sheetData) => {
  const currentVisible = visibleRowsCount.value[sheetName] || 0;
  if (currentVisible < sheetData.length) {
    visibleRowsCount.value[sheetName] = currentVisible + 1;
    store.excelJsonData = JSON.parse(JSON.stringify(store.excelJsonData));
    saveExcelData();
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
    store.excelJsonData = JSON.parse(JSON.stringify(store.excelJsonData));
    saveExcelData();
    store.addLog(`S'ha afegit una nova fila al final del full '${sheetName}'.`, 'info');
  }
};

// Elimina una fila d'una taula després de confirmació i ajusta el comptador de files visibles
const deleteTabularRow = (sheetName, idx) => {
  if (confirm(`Segur que vols eliminar la fila número ${idx + 1}?`)) {
    store.excelJsonData[sheetName].splice(idx, 1);
    if (visibleRowsCount.value[sheetName] > 0) {
      visibleRowsCount.value[sheetName]--;
    }
    store.excelJsonData = JSON.parse(JSON.stringify(store.excelJsonData));
    saveExcelData();
    store.addLog(`Fila eliminada del full '${sheetName}'.`, 'info');
  }
};

// Genera i descarrega el fitxer Excel actualitzat amb les dades editades
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

// Obre l'editor visual de cel·la (Markdown+Jinja2) per a un camp de tipus Text, carregant-hi el valor actual
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

// Desa el text editat al modal de cel·la de tornada a la dada corresponent (KV o tabular) i tanca el modal
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

// Gestiona dreceres de teclat (Escape/Enter) per a tots els modals propis d'aquest component, segons quin estigui obert
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

// Metadata Schema helpers for custom types (shared implementation in useGroupMetadata.js)
const getElementMetadata = (groupName, elementName) => findElementMetadata(store, groupName, elementName);
// Embolcall sobre isFieldCalculated de useGroupMetadata.js
const isCalculatedField = (groupName, elementName) => isFieldCalculated(store, groupName, elementName);

// Determina el tipus efectiu d'un camp (Text, Number, Select, Percentage...) a partir de la metadada configurada o, si no n'hi ha, per detecció automàtica pel nom del camp
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

// Resol la llista d'opcions d'un camp Select, ja siguin estàtiques (definides a la metadada) o dinàmiques (extretes d'un altre vector de dades)
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

// Comprova si una opció concreta està seleccionada en un valor de cel·la que pot ser array o cadena separada per comes
const isOptionChecked = (cellValue, optionValue) => {
  if (cellValue === undefined || cellValue === null || cellValue === '') return false;
  if (Array.isArray(cellValue)) {
    return cellValue.includes(optionValue);
  }
  const parts = String(cellValue).split(',').map(x => x.trim());
  return parts.includes(String(optionValue));
};

// Afegeix o treu una opció del valor d'una cel·la multi-selecció, mantenint el mateix format (array o cadena) que ja tenia
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

// Converteix el valor cru d'una cel·la multi-selecció en la llista d'etiquetes (pills) a mostrar, resolent els labels contra les opcions disponibles
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

// Llista els noms de fulls tabulars amb dades, per oferir-los com a possible font d'un Select dinàmic
const getAvailableTables = () => {
  return Object.keys(store.excelJsonData || {}).filter(name => {
    if (name === 'editor_metadata') return false;
    const data = store.excelJsonData[name];
    return Array.isArray(data) && data.length > 0 && typeof data[0] === 'object';
  });
};

// Retorna els noms de columna d'un full tabular, usats per configurar el camp mostrat/valor d'un Select dinàmic
const getTableColumns = (sheetName) => {
  if (!sheetName || !store.excelJsonData || !store.excelJsonData[sheetName]) return [];
  const data = store.excelJsonData[sheetName];
  if (Array.isArray(data) && data.length > 0) {
    return Object.keys(data[0]);
  }
  return [];
};

// En canviar el vector font d'un Select dinàmic, reinicialitza els camps de visualització i valor a la primera columna disponible
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

// Afegeix una nova columna a la taula activa (dades i configuració), sanititzant el nom i evitant duplicats
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

// Elimina una columna de la taula activa, tant de les dades de totes les files com de la seva configuració
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

// Embolcall sobre groupLabel de useGroupMetadata.js
const getGroupLabel = (groupName) => groupLabel(store, groupName);
// Embolcall sobre fieldLabel de useGroupMetadata.js
const getFieldLabel = (groupName, elementName) => fieldLabel(store, groupName, elementName);

// Cerca, dins les dades d'un grup (i si cal a tot l'arbre), quins vectors (arrays) fills hi ha disponibles per configurar-los com a font d'un Select dinàmic
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

// Cerca a les dades reals les columnes primitives disponibles d'un vector concret, per poder-les oferir com a camp de visualització/valor d'un Select dinàmic
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

const {
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
} = useFormulaAutocomplete({
  formulaTextBuffer,
  formulaTextareaRef,
  availableFormulaFields,
  globalFormulaPaths,
  isFormulaModalOpen,
  editingFormulaItem,
  store,
});

// Obre el modal de configuració d'un grup, construint la llista editable de metadades (tipus, opcions, format...) de cada element existent
const openGroupConfig = (groupName, sheetData) => {
  activeConfigGroup.value = groupName;
  const currentGroupLabel = getGroupLabel(groupName);
  groupLabelInput.value = currentGroupLabel !== groupName ? currentGroupLabel : '';

  const isKv = getSheetType(sheetData) === 'kv';
  const elements = isKv ? Object.keys(sheetData).filter(k => !isInternalMetadataKey(k)) : getTabularColumns(groupName, sheetData);
  
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
      calcFn: meta.calcFn || 'NONE',
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

// Afegeix un nou camp/clau al grup en configuració, tant a les dades com a la llista de configuració que s'edita al modal
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

// Recupera la fórmula de títol d'ítem configurada per a un grup, cercant-la a la metadada de capçalera del grup corresponent
const getItemTitleFormula = (groupName) => {
  const metaList = (store.editorMetadata && store.editorMetadata.length > 0) 
    ? store.editorMetadata 
    : (store.excelJsonData?.editor_metadata || store.excelJsonData?.editorMetadata || []);
  if (!metaList || !Array.isArray(metaList) || !groupName) return '';
  const shortName = groupName.split('.').pop();
  const meta = metaList.find(m => {
    const mGroup = m.group ? m.group.split('.').pop() : '';
    const groupMatches = m.group === groupName || m.group === shortName || mGroup === shortName;
    const isHeader = m.element === '_group_label' || m.element === '_group' || m.isGroupHeader || !m.element || m.element === '';
    return groupMatches && isHeader && m.itemTitleFormula;
  });
  return meta ? meta.itemTitleFormula : '';
};

// Desplaça una fila d'una taula una posició amunt i força l'avaluació/desat
const moveTabularRowUp = (name, idx) => {
  if (idx <= 0 || !store.excelJsonData?.[name]) return;
  const list = store.excelJsonData[name];
  if (!Array.isArray(list)) return;
  const item = list.splice(idx, 1)[0];
  list.splice(idx - 1, 0, item);
  onCellBlur();
};

// Desplaça una fila d'una taula una posició avall i força l'avaluació/desat
const moveTabularRowDown = (name, idx) => {
  if (!store.excelJsonData?.[name]) return;
  const list = store.excelJsonData[name];
  if (!Array.isArray(list) || idx >= list.length - 1) return;
  const item = list.splice(idx, 1)[0];
  list.splice(idx + 1, 0, item);
  onCellBlur();
};

// Embolcall sobre saveGroupConfigShared de useGroupMetadata.js amb el grup actualment en edició
const handleSaveGroupConfig = async (data) => {
  await saveGroupConfigShared(store, {
    groupPath: activeConfigGroup.value,
    data,
    ensureFieldKeys: true,
    saveExcelData,
    evaluateComputedFields,
    analyzeMirrorPattern,
    applyMirrorColumn,
  });
  isConfigModalOpen.value = false;
};

// Garanteix que una sub-taula aniuada tingui entrada a sheetInfo i que la clau corresponent existeixi (com a array buit) a les dades del pare
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

// Crea un nou full o grup de dades (arrel o sub-taula aniuada) amb la seva entrada a sheetInfo i metadada de capçalera de grup
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
  
  store.excelJsonData = JSON.parse(JSON.stringify(store.excelJsonData));
  saveExcelData();
  
  isNewSheetModalOpen.value = false;
  selectedCompactSheet.value = fullPath;
  store.addLog(`Full/Grup de dades '${fullPath}' (${newSheetKindInput.value}) creat correctament.`, 'success');
};

// Assegura l'existència d'una sub-taula i hi navega, obrint-la juntament amb el seu grup pare
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

// Copia al portaretalls, en format JSON, la configuració de metadades d'un grup concret
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

// Llegeix la configuració d'un grup des del portaretalls i l'aplica; si l'accés al portaretalls falla, obre un modal per enganxar-la manualment
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

// Interpreta un JSON de configuració de grup i el substitueix a la metadada de l'editor per al grup indicat
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

// Copia al portaretalls, en format JSON, tota la configuració de metadades del projecte
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

// Llegeix la configuració global des del portaretalls i l'aplica; si l'accés al portaretalls falla, obre un modal per enganxar-la manualment
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

// Interpreta un JSON de configuració global i substitueix tota la metadada de l'editor del projecte
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

// Processa el text enganxat manualment al modal, aplicant-lo com a configuració de grup o global segons el destí
const processPasteModalSubmit = () => {
  if (!pasteBufferText.value.trim()) return;
  if (pasteTargetGroup.value) {
    applyGroupConfigJson(pasteBufferText.value, pasteTargetGroup.value);
  } else {
    applyGlobalConfigJson(pasteBufferText.value);
  }
};

// Gestiona Escape/Ctrl+Enter dins el modal d'edició de cel·la (tancar o desar)
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
    ...store.dataActions,
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
// Carrega un conjunt de dades i esquema d'exemple (mock) per a proves/demo del component sense necessitat d'importar un Excel
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
    ...store.dataActions,
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
                          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-muted); opacity: 0.85; flex-shrink: 0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
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
                            @change="onCellBlur"
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
                          @input="onCellInput"
                          @blur="onCellBlur"
                          @change="onCellBlur"
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
                          @input="onCellInput"
                          @blur="onCellBlur"
                          @change="onCellBlur"
                          class="data-input"
                          style="flex-grow: 1; height: 32px;"
                        >
                        
                        <!-- Percentage Type -->
                        <div v-else-if="getElementType(name, col) === 'Percentage'" style="display: flex; align-items: center; flex-grow: 1; position: relative;">
                          <input 
                            :id="'data-field-' + name + '-' + idx + '-' + col"
                            :data-path="name + '.' + idx + '.' + col"
                            type="text"
                            inputmode="decimal"
                            :value="formatPercentageDisplay(store.excelJsonData[name][idx][col])"
                            @input="updatePercentageValue(store.excelJsonData[name][idx], col, $event.target.value); onCellInput();"
                            @blur="onCellBlur"
                            @change="onCellBlur"
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
                          @change="onCellBlur"
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
                          @input="onCellInput"
                          @blur="onCellBlur"
                          class="data-input"
                          rows="1"
                          style="flex-grow: 1; resize: vertical; min-height: 28px;"
                        ></textarea>
                        <input 
                          v-else
                          :id="'data-field-' + name + '-' + idx + '-' + col"
                          :data-path="name + '.' + idx + '.' + col"
                          type="text"
                          v-model="store.excelJsonData[name][idx][col]"
                          @input="onCellInput"
                          @blur="onCellBlur"
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
                      <div style="display: flex; align-items: center; justify-content: center; gap: 3px;">
                        <button 
                          type="button"
                          class="btn-icon-only" 
                          :disabled="idx === 0"
                          style="height: 24px; width: 24px; min-width: 24px; font-size: 0.75rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: 1px solid var(--border-color); border-radius: 3px;"
                          :style="{ opacity: idx === 0 ? 0.35 : 1, cursor: idx === 0 ? 'not-allowed' : 'pointer' }"
                          title="Desplaça fila amunt"
                          @click="moveTabularRowUp(name, idx)"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
                        </button>
                        <button 
                          type="button"
                          class="btn-icon-only" 
                          :disabled="idx === sheetData.length - 1"
                          style="height: 24px; width: 24px; min-width: 24px; font-size: 0.75rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: 1px solid var(--border-color); border-radius: 3px;"
                          :style="{ opacity: idx === sheetData.length - 1 ? 0.35 : 1, cursor: idx === sheetData.length - 1 ? 'not-allowed' : 'pointer' }"
                          title="Desplaça fila avall"
                          @click="moveTabularRowDown(name, idx)"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                        </button>
                        <button 
                          type="button"
                          class="btn-icon-only text-danger" 
                          style="height: 24px; width: 24px; min-width: 24px; font-size: 0.8rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none;"
                          title="Elimina fila"
                          @click="deleteTabularRow(name, idx)"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                      </div>
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
                    <!-- Calculated Field (Non-editable, Read-only with lock badge and type-specific formatting) -->
                    <div 
                      v-if="isCalculatedField(name, item.key)" 
                      :id="'data-field-' + name + '-' + item.key"
                      :data-path="name + '.' + item.key"
                      style="display: flex; align-items: center; gap: 6px; flex-grow: 1; height: 28px; padding: 2px 10px; border: 1px solid var(--border-color); border-radius: var(--radius-xs); background: var(--bg-tertiary); color: var(--text-primary); font-family: var(--font-mono); font-size: 0.8rem; font-weight: 600; cursor: not-allowed;" 
                      title="🔒 Camp calculat automàticament"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-muted); opacity: 0.85; flex-shrink: 0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                      <span style="flex-grow: 1;">
                        {{ getElementType(name, item.key) === 'Percentage' ? (formatPercentageDisplay(store.excelJsonData[name][item.key]) + ' %') : (store.excelJsonData[name][item.key] !== undefined ? store.excelJsonData[name][item.key] : 0) }}
                      </span>
                      <span style="font-size: 0.65rem; color: var(--text-muted); font-weight: normal; background: rgba(0,0,0,0.06); padding: 1px 4px; border-radius: 3px;">Calculat</span>
                    </div>

                    <!-- Select Type -->
                    <template v-else-if="getElementType(name, item.key) === 'Select'">
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
                      @change="onCellBlur"
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
                      @input="onCellInput"
                      @blur="onCellBlur"
                      @change="onCellBlur"
                      class="data-input"
                      style="flex-grow: 1; height: 28px; font-size: 0.8rem;"
                    >
                    
                    <!-- Percentage Type -->
                    <div v-else-if="getElementType(name, item.key) === 'Percentage'" style="display: flex; align-items: center; flex-grow: 1; position: relative;">
                      <input 
                        :id="'data-field-' + name + '-' + item.key"
                        :data-path="name + '.' + item.key"
                        type="text"
                        inputmode="decimal"
                        :value="formatPercentageDisplay(store.excelJsonData[name][item.key])"
                        @input="updatePercentageValue(store.excelJsonData[name], item.key, $event.target.value); onCellInput();"
                        @blur="onCellBlur"
                        @change="onCellBlur"
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
                      @input="onCellInput"
                      @blur="onCellBlur"
                      class="data-input"
                      rows="1"
                      style="flex-grow: 1; resize: vertical; font-size: 0.8rem; min-height: 28px;"
                    ></textarea>
                    <input 
                      v-else
                      :id="'data-field-' + name + '-' + item.key"
                      :data-path="name + '.' + item.key"
                      type="text"
                      v-model="store.excelJsonData[name][item.key]"
                      @input="onCellInput"
                      @blur="onCellBlur"
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
            
            <div style="margin-top: 10px; margin-bottom: 6px; display: flex; gap: 8px;">
              <button 
                class="btn btn-secondary" 
                style="padding: 4px 10px; font-size: 0.76rem; display: inline-flex; align-items: center; gap: 5px;"
                @click="addKvKey(name)"
                title="Afegeix una nova clau a aquest full clau/valor"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                + Afegeix Nova Clau
              </button>
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
      :itemTitleFormula="getItemTitleFormula(activeConfigGroup)"
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

    <!-- 9. Visual Grid Layout Editor Modal -->
    <VisualGridEditorModal 
      v-model="isVisualGridModalOpen" 
      :groupName="activeConfigGroup" 
      :configList="groupConfigList" 
    />

    <!-- Modal for Creating New Sheet / Group -->
    <div id="newSheetModalOverlay" class="modal-overlay new-sheet-modal" v-if="isNewSheetModalOpen" style="display: flex; z-index: 1100;">
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
              id="newSheetNameInput"
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
            <select id="newSheetKindSelect" v-model="newSheetKindInput" class="data-input">
              <option value="kv">Clau-Valor (KV - formulari d'un sol registre)</option>
              <option value="tabular">Tabular (Llista / taula de rengleres independents)</option>
              <option value="sub_table">Sub-taula Aniuada (taula fill vinculada a un altre full)</option>
            </select>
          </div>

          <div v-if="newSheetKindInput === 'sub_table'" class="form-row" style="display: flex; flex-direction: column; gap: 4px;">
            <label style="font-weight: 600; font-size: 0.85rem;">Full Pare (al qual pertany aquesta sub-taula):</label>
            <select id="newSheetParentSelect" v-model="newSheetParentInput" class="data-input">
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
          <button id="newSheetConfirmBtn" class="btn btn-primary" style="width: auto;" @click="createNewSheet" :disabled="!newSheetNameInput.trim()">
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
  background-color: var(--bg-primary);
  color: var(--text-primary);
  box-sizing: border-box;
  resize: vertical;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

input[type="number"].data-input {
  font-family: var(--font-mono), monospace;
  background-color: var(--bg-primary);
  color: var(--text-primary);
}

select.data-input, select {
  padding: 3px 8px;
  box-sizing: border-box;
  background-color: var(--bg-primary);
  color: var(--text-primary);
}

.data-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-light);
  background-color: var(--bg-card);
  color: var(--text-primary);
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
