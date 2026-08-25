<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';

import { useWasmEngines } from '../composables/useWasmEngines';
import VisualGridEditorModal from './VisualGridEditorModal.vue';
import GroupConfigModal from './GroupConfigModal.vue';

const props = defineProps({
  parentObj: {
    type: Object,
    required: true
  },
  arrayKey: {
    type: String,
    required: true
  },
  schema: {
    type: Object,
    default: () => ({ fields: [], children: {} })
  },
  schemaPath: {
    type: String,
    default: ''
  },
  parentPath: {
    type: String,
    default: ''
  }
});

const store = useWorkspaceStore();
const { evaluateComputedFields } = useWasmEngines();

const getAvailableChildVectorsForGroup = () => {
  const result = new Set();
  
  // 1. From childKeys computed property
  if (Array.isArray(childKeys.value)) {
    childKeys.value.forEach(k => result.add(k));
  }

  // 2. From actual items data
  if (items.value && Array.isArray(items.value)) {
    items.value.forEach(item => {
      if (item && typeof item === 'object') {
        Object.keys(item).forEach(k => {
          if (Array.isArray(item[k])) {
            result.add(k);
          }
        });
      }
    });
  }

  // 3. From nodeSchema definition
  if (nodeSchema.value && nodeSchema.value.children) {
    const ch = nodeSchema.value.children;
    if (Array.isArray(ch)) {
      ch.forEach(k => result.add(k));
    } else if (typeof ch === 'object') {
      Object.keys(ch).forEach(k => result.add(k));
    }
  }

  // 4. Fallback search inside excelJsonData
  if (result.size === 0 && store.excelJsonData) {
    const searchSub = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        obj.forEach(elem => {
          if (elem && typeof elem === 'object') {
            Object.keys(elem).forEach(k => {
              if (Array.isArray(elem[k])) result.add(k);
            });
          }
        });
      }
    };
    searchSub(store.excelJsonData[props.arrayKey]);
  }

  return Array.from(result);
};

const getChildTableColumns = (vectorName) => {
  if (!vectorName) return [];
  const cols = new Set();

  // 1. Inspect actual rows in items.value
  if (items.value && Array.isArray(items.value)) {
    items.value.forEach(item => {
      if (item && Array.isArray(item[vectorName]) && item[vectorName].length > 0 && typeof item[vectorName][0] === 'object') {
        Object.keys(item[vectorName][0]).forEach(k => {
          if (k !== '_hierarchy_schema' && isPrimitive(item[vectorName][0][k])) {
            cols.add(k);
          }
        });
      }
    });
  }

  // 2. Inspect childSchemas
  if (childSchemas.value && childSchemas.value[vectorName]) {
    const s = childSchemas.value[vectorName];
    if (Array.isArray(s.fields)) {
      s.fields.forEach(f => cols.add(f));
    }
  }

  // 3. Fallback search store.excelJsonData globally
  if (cols.size === 0 && store.excelJsonData) {
    const searchGlobal = (container) => {
      if (!container || typeof container !== 'object') return;
      if (Array.isArray(container)) {
        container.forEach(item => {
          if (item && typeof item === 'object') {
            if (Array.isArray(item[vectorName]) && item[vectorName].length > 0 && typeof item[vectorName][0] === 'object') {
              Object.keys(item[vectorName][0]).forEach(k => {
                if (k !== '_hierarchy_schema' && isPrimitive(item[vectorName][0][k])) cols.add(k);
              });
            }
            Object.values(item).forEach(v => searchGlobal(v));
          }
        });
      } else {
        Object.values(container).forEach(v => searchGlobal(v));
      }
    };
    searchGlobal(store.excelJsonData);
  }

  return Array.from(cols);
};

const cleanPath = (p) => {
  if (!p) return '';
  return String(p).replace(/\.\d+\b/g, '').replace(/^#?(dades|doc)\./, '');
};

const fullPath = computed(() => {
  return props.parentPath ? `${props.parentPath}.${props.arrayKey}` : props.arrayKey;
});

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

  // 2. Direct Flat Key Lookup
  if (dict[cleanP] && isNonEmptySchema(dict[cleanP])) {
    return dict[cleanP];
  }
  
  // 3. Direct Tree Path Traversal
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
  
  // 4. Search by key suffix or data_path
  const lastKey = parts[parts.length - 1];
  for (const [sKey, sVal] of Object.entries(dict)) {
    if ((sKey === cleanP || sKey === lastKey || sKey.endsWith(`.${lastKey}`) || sVal?.data_path === cleanP || sVal?.data_path?.endsWith(`.${lastKey}`)) && isNonEmptySchema(sVal)) {
      return sVal;
    }
  }
  
  // 5. Deep DFS
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

const formatPercentageDisplay = (val) => {
  if (val === undefined || val === null || val === '') return '';
  let strVal = String(val).replace('%', '').replace(',', '.').trim();
  const num = parseFloat(strVal);
  if (isNaN(num)) return val;
  // Always convert internal proportion (e.g. 0.21 -> 21, 1 -> 100, 100 -> 10000)
  return Math.round(num * 100 * 10000) / 10000;
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
  // Always divide user input scale by 100 for internal proportion storage (21 -> 0.21, 100 -> 1)
  targetObj[key] = num / 100.0;
};

const nodeSchema = computed(() => {
  const schemaDict = store.hierarchySchema || {};
  if (isNonEmptySchema(props.schema)) {
    return props.schema;
  }
  const effPath = cleanPath(props.schemaPath || fullPath.value);
  return universalFindSchema(effPath || props.arrayKey, schemaDict);
});

const childSchemas = computed(() => {
  const children = nodeSchema.value.children;
  const res = {};
  const schemaDict = store.hierarchySchema || {};
  const currentPath = cleanPath(props.schemaPath || fullPath.value);
  
  if (Array.isArray(children)) {
    children.forEach(cKey => {
      if (typeof cKey === 'string') {
        const fullKey = currentPath ? `${currentPath}.${cKey}` : cKey;
        res[cKey] = universalFindSchema(fullKey, schemaDict);
      }
    });
  } else if (children && typeof children === 'object') {
    Object.entries(children).forEach(([cKey, cVal]) => {
      if (isNonEmptySchema(cVal)) {
        res[cKey] = cVal;
      } else {
        const fullKey = currentPath ? `${currentPath}.${cKey}` : cKey;
        res[cKey] = universalFindSchema(fullKey, schemaDict);
      }
    });
  }
  return res;
});

const childKeys = computed(() => {
  const keys = new Set(Object.keys(childSchemas.value));
  if (Array.isArray(props.parentObj?.[props.arrayKey])) {
    props.parentObj[props.arrayKey].forEach(item => {
      if (item && typeof item === 'object') {
        Object.keys(item).forEach(k => {
          if (Array.isArray(item[k])) {
            keys.add(k);
          }
        });
      }
    });
  }
  return Array.from(keys);
});

const isLeafLevel = computed(() => {
  return childKeys.value.length === 0;
});

const items = computed(() => {
  if (!props.parentObj || !props.arrayKey) return [];
  if (!Array.isArray(props.parentObj[props.arrayKey])) {
    props.parentObj[props.arrayKey] = [];
  }
  return props.parentObj[props.arrayKey];
});

const isPrimitive = (val) => {
  return !Array.isArray(val) && (typeof val !== 'object' || val === null);
};

const effectiveFields = computed(() => {
  const schemaFields = nodeSchema.value.fields || [];
  if (schemaFields.length > 0) {
    return schemaFields;
  }
  if (items.value.length > 0 && typeof items.value[0] === 'object' && items.value[0] !== null) {
    return Object.keys(items.value[0]).filter(k => k !== '_hierarchy_schema' && isPrimitive(items.value[0][k]));
  }
  return [];
});

const getPrimitiveFields = (item) => {
  if (!item || typeof item !== 'object') return {};
  const res = {};
  
  effectiveFields.value.forEach(f => {
    if (f !== '_hierarchy_schema') {
      res[f] = item[f] !== undefined ? item[f] : '';
    }
  });

  Object.keys(item).forEach(k => {
    if (k !== '_hierarchy_schema' && isPrimitive(item[k]) && !(k in res)) {
      res[k] = item[k];
    }
  });

  const keys = Object.keys(res);
  keys.sort((a, b) => {
    const metaA = getElementMetadata(a);
    const metaB = getElementMetadata(b);
    
    const rA = (metaA?.gridRow !== undefined && metaA?.gridRow !== '') ? parseInt(metaA.gridRow, 10) : 9999;
    const rB = (metaB?.gridRow !== undefined && metaB?.gridRow !== '') ? parseInt(metaB.gridRow, 10) : 9999;
    if (rA !== rB) return rA - rB;
    
    const oA = (metaA?.gridOrder !== undefined && metaA?.gridOrder !== '') ? parseInt(metaA.gridOrder, 10) : 9999;
    const oB = (metaB?.gridOrder !== undefined && metaB?.gridOrder !== '') ? parseInt(metaB.gridOrder, 10) : 9999;
    if (oA !== oB) return oA - oB;
    
    return 0;
  });

  const sortedRes = {};
  keys.forEach(k => {
    sortedRes[k] = res[k];
  });
  return sortedRes;
};

const getFieldCardStyle = (fKey) => {
  const meta = getElementMetadata(fKey);
  const isTop = store.config.labelPosition === 'top';
  
  let baseStyle = isTop 
    ? 'display: flex; flex-direction: column; gap: 4px; background: var(--bg-card); padding: 8px 10px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); box-sizing: border-box;' 
    : 'display: flex; align-items: center; gap: 10px; padding: 4px 6px; border-bottom: 1px solid var(--border-color); box-sizing: border-box;';
  
  if (meta?.width) {
    baseStyle += ` flex: 0 0 calc(${meta.width} - 0.75rem); max-width: ${meta.width}; width: ${meta.width};`;
  } else if (meta?.gridFill) {
    baseStyle += ' flex: 1 1 260px; min-width: 200px;';
  } else {
    baseStyle += ' flex: 0 1 240px; min-width: 180px;';
  }
  return baseStyle;
};

const getItemRowBlocks = (item) => {
  const primObj = getPrimitiveFields(item);
  const keys = Object.keys(primObj);
  
  const rowMap = new Map();
  const unassigned = [];

  keys.forEach(key => {
    const meta = getElementMetadata(key);
    const rNum = (meta?.gridRow !== undefined && meta?.gridRow !== null && meta?.gridRow !== '')
      ? parseInt(meta.gridRow, 10)
      : null;

    if (rNum !== null && !isNaN(rNum) && rNum > 0) {
      if (!rowMap.has(rNum)) {
        rowMap.set(rNum, []);
      }
      rowMap.get(rNum).push({ key, meta });
    } else {
      unassigned.push({ key, meta });
    }
  });

  rowMap.forEach((items) => {
    items.sort((a, b) => {
      const oA = (a.meta?.gridOrder !== undefined && a.meta?.gridOrder !== '') ? parseInt(a.meta.gridOrder, 10) : 999;
      const oB = (b.meta?.gridOrder !== undefined && b.meta?.gridOrder !== '') ? parseInt(b.meta.gridOrder, 10) : 999;
      return oA - oB;
    });
  });

  const sortedRowNums = Array.from(rowMap.keys()).sort((a, b) => a - b);
  const resultRows = [];

  sortedRowNums.forEach(rNum => {
    resultRows.push(rowMap.get(rNum));
  });

  if (unassigned.length > 0) {
    resultRows.push(unassigned);
  }

  return resultRows;
};

const getLeafTableHeaders = computed(() => {
  return effectiveFields.value.length > 0 ? effectiveFields.value : ['valor'];
});

// Group Layout Config (vertical / horizontal)
const selectedLayout = ref('vertical');

const groupLayout = computed(() => {
  if (!store.editorMetadata) return 'vertical';
  const meta = store.editorMetadata.find(m => m.group === props.arrayKey && m.groupLayout);
  return meta ? meta.groupLayout : 'vertical';
});

const groupLabelInput = ref('');

const getGroupLabel = (groupName) => {
  if (!groupName) return '';
  if (store.editorMetadata) {
    const meta = store.editorMetadata.find(m => 
      (m.group === groupName || m.group === groupName.split('.').pop() || m.group === fullPath.value) && 
      (m.element === '_group_label' || m.element === '_group' || m.isGroupHeader) && 
      m.label && m.label.trim()
    );
    if (meta) {
      return meta.label.trim();
    }
  }
  return groupName;
};

// Metadata Schema helpers for custom types
const getElementMetadata = (elementName) => {
  if (!store.editorMetadata) return null;
  const gName = props.arrayKey;
  const shortName = gName ? gName.split('.').pop() : '';
  const cleanGroup = gName ? gName.replace(/^OUT_/, '') : '';
  const cleanShort = shortName ? shortName.replace(/^OUT_/, '') : '';
  return store.editorMetadata.find(m => 
    m && m.element === elementName && (
      m.group === gName || 
      m.group === shortName || 
      m.group === cleanGroup || 
      m.group === cleanShort ||
      m.group === `OUT_${cleanGroup}`
    )
  ) || null;
};

const isCalculatedField = (elementName) => {
  const meta = getElementMetadata(elementName);
  if (!meta) return false;
  if (meta.isCalculated === true || meta.sourceType === 'computed' || meta.type === 'Computed') {
    return true;
  }
  if (meta.calcFormula && String(meta.calcFormula).trim() !== '') {
    return true;
  }
  if (meta.calcFn && meta.calcFn !== 'NONE' && meta.calcFn !== '') {
    return Boolean(meta.calcVector || meta.calcFormula);
  }
  return false;
};

const getFieldLabel = (elementName) => {
  const meta = getElementMetadata(elementName);
  if (meta && meta.label && meta.label.trim()) {
    return meta.label.trim();
  }
  return elementName;
};

const getElementType = (elementName) => {
  const meta = getElementMetadata(elementName);
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

const resolveSelectOptions = (meta) => {
  if (!meta || meta.type !== 'Select') return [];
  if (meta.sourceType === 'dynamic' && meta.vectorPath) {
    const list = store.excelJsonData?.[meta.vectorPath];
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
    const opts = Array.isArray(meta.options) ? meta.options : [];
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

const toggleOptionValue = (item, fieldKey, optionValue, isChecked) => {
  let currentVal = item[fieldKey];
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
  
  item[fieldKey] = Array.isArray(currentVal) ? currentList : currentList.join(', ');
};

const isMultiSelectModalOpen = ref(false);
const activeMultiSelectCell = ref(null);

const openMultiSelectModal = (item, fieldKey, meta) => {
  activeMultiSelectCell.value = { item, fieldKey, meta };
  isMultiSelectModalOpen.value = true;
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

const isCellModalOpen = ref(false);
const activeCellInfo = ref(null);
const cellTextValue = ref('');

const openCellEditor = (item, fieldKey) => {
  if (getElementType(fieldKey) !== 'Text') {
    return;
  }
  activeCellInfo.value = { item, fieldKey };
  cellTextValue.value = String(item[fieldKey] || '');
  isCellModalOpen.value = true;
};

const saveCellEditor = () => {
  if (activeCellInfo.value) {
    const { item, fieldKey } = activeCellInfo.value;
    item[fieldKey] = cellTextValue.value;
  }
  isCellModalOpen.value = false;
  store.addLog("Camp actualitzat correctament.", "success");
};

const handleNestedKeydown = (e) => {
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
  window.addEventListener('keydown', handleNestedKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleNestedKeydown);
});

// Group Config Modal for arrayKey
const isConfigModalOpen = ref(false);
const isVisualGridModalOpen = ref(false);
const groupConfigList = ref([]);

const getAvailableTables = () => {
  return Object.keys(store.excelJsonData || {}).filter(name => {
    if (name === 'editor_metadata' || name === '_hierarchy_schema') return false;
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

const onVectorPathChange = (configItem) => {
  const cols = getTableColumns(configItem.vectorPath);
  if (cols.length > 0) {
    configItem.displayField = cols[0];
    configItem.valueField = cols[0];
  } else {
    configItem.displayField = '';
    configItem.valueField = '';
  }
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

// Autocomplete state for formula modal
const autocompleteQuery = ref('');
const autocompleteIndex = ref(0);
const showAutocomplete = ref(false);

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

const openFormulaModal = (item, fields) => {
  editingFormulaItem.value = item;
  formulaTextBuffer.value = item.calcFormula || '';
  availableFormulaFields.value = (fields || []).filter(f => f !== item.element);
  globalFormulaPaths.value = getGlobalFormulaPaths();
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

const openGroupConfig = () => {
  selectedLayout.value = groupLayout.value;
  const currentLabel = getGroupLabel(props.arrayKey);
  groupLabelInput.value = currentLabel !== props.arrayKey ? currentLabel : '';

  const elements = effectiveFields.value;
  groupConfigList.value = elements.map(el => {
    const meta = getElementMetadata(el) || { type: 'Text' };
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

const addNewFieldToConfig = () => {
  const key = prompt("Introdueix el nom del nou camp/clau (es sanititzarà automàticament):");
  if (!key) return;
  const cleanKey = key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  
  if (Array.isArray(props.items)) {
    if (props.items.length === 0) {
      props.items.push({ [cleanKey]: '' });
    } else {
      props.items.forEach(item => {
        if (typeof item === 'object' && !(cleanKey in item)) {
          item[cleanKey] = '';
        }
      });
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

const handleSaveGroupConfig = (data) => {
  store.editorMetadata = store.editorMetadata.filter(m => m.group !== props.arrayKey);
  
  // Save group layout & label header
  const groupMeta = {
    group: props.arrayKey,
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
      group: props.arrayKey,
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
    }
    meta.isCalculated = !!item.isCalculated;
    if (item.isCalculated || item.type === 'Computed' || (item.calcFormula && item.calcFormula.trim() !== '') || (item.calcFn && item.calcFn !== 'NONE')) {
      meta.isCalculated = true;
      meta.sourceType = 'computed';
      meta.calcFn = item.calcFn || 'CUSTOM';
      meta.calcVector = item.calcVector || '';
      meta.calcTargetCol = item.calcTargetCol || '';
      meta.calcFormula = item.calcFormula || '';
    } else {
      meta.isCalculated = false;
      if (item.type !== 'Select') {
        meta.sourceType = 'static';
      }
      meta.calcFn = 'NONE';
      meta.calcVector = '';
      meta.calcTargetCol = '';
      meta.calcFormula = '';
    }
    if (item.type === 'Table') {
      meta.vectorPath = item.vectorPath;
    }

    if (item.width) meta.width = item.width;
    if (item.gridRow) meta.gridRow = item.gridRow;
    if (item.gridOrder) meta.gridOrder = item.gridOrder;
    if (item.gridFill) meta.gridFill = item.gridFill;

    store.editorMetadata.push(meta);
  });

  isConfigModalOpen.value = false;
  store.addLog(`Configuració desada per al grup '${props.arrayKey}'.`, 'success');
  
  if (store.excelJsonData) {
    store.excelJsonData.editor_metadata = store.editorMetadata;
    evaluateComputedFields(store.excelJsonData);
  }
};

const addNestedItem = () => {
  if (!Array.isArray(props.parentObj[props.arrayKey])) {
    props.parentObj[props.arrayKey] = [];
  }
  const list = props.parentObj[props.arrayKey];
  const newRow = {};
  
  const fields = effectiveFields.value;
  if (fields.length > 0) {
    fields.forEach(f => {
      newRow[f] = '';
    });
  } else {
    newRow['valor'] = '';
  }

  childKeys.value.forEach(cKey => {
    newRow[cKey] = [];
  });

  list.push(newRow);
};

const deleteNestedItem = (idx) => {
  if (confirm(`Segur que vols eliminar aquest element (${props.arrayKey} #${idx + 1})?`)) {
    props.parentObj[props.arrayKey].splice(idx, 1);
  }
};

const duplicateNestedItem = (idx) => {
  if (!Array.isArray(props.parentObj[props.arrayKey])) return;
  const original = props.parentObj[props.arrayKey][idx];
  if (!original) return;
  
  const clone = JSON.parse(JSON.stringify(original));
  
  const pKey = effectiveFields.value[0] || Object.keys(clone).find(k => k.startsWith('id_') || k.endsWith('_id') || k === 'id');
  if (pKey && typeof clone[pKey] === 'string' && clone[pKey].trim() !== '') {
    clone[pKey] = `${clone[pKey]}_copia`;
  }
  
  props.parentObj[props.arrayKey].splice(idx + 1, 0, clone);
};

const isMoveModalOpen = ref(false);
const itemToMoveIndex = ref(null);
const availableMoveTargets = ref([]);
const selectedTargetParent = ref(null);

const getItemLabel = (item, fallback) => {
  if (!item || typeof item !== 'object') return fallback;
  const idKey = Object.keys(item).find(k => k.startsWith('id_') || k === 'id');
  const labelKey = Object.keys(item).find(k => isPrimitive(item[k]) && k !== 'id' && !k.startsWith('id_') && typeof item[k] === 'string' && item[k].trim() !== '')
    || Object.keys(item).find(k => isPrimitive(item[k]) && typeof item[k] === 'string' && item[k].trim() !== '');
  
  const idVal = idKey ? String(item[idKey]) : '';
  const labelVal = labelKey ? String(item[labelKey]) : '';
  
  if (idVal && labelVal && idVal !== labelVal) {
    return `${idVal} - ${labelVal}`;
  }
  return labelVal || idVal || fallback;
};

const openMoveModal = (idx) => {
  itemToMoveIndex.value = idx;
  selectedTargetParent.value = null;
  const targets = [];
  
  const walkForTargets = (obj, pathPrefix = '', parentLabel = 'Arrel') => {
    if (!obj || typeof obj !== 'object') return;
    
    if (Array.isArray(obj)) {
      obj.forEach((elem, elemIdx) => {
        if (elem && typeof elem === 'object') {
          const elemP = `${pathPrefix}[${elemIdx}]`;
          const elemLbl = getItemLabel(elem, `${parentLabel} #${elemIdx + 1}`);
          
          if (Array.isArray(elem[props.arrayKey]) && elem !== props.parentObj) {
            targets.push({
              container: elem,
              path: elemP,
              label: `${elemLbl}`
            });
          }
          
          Object.entries(elem).forEach(([k, v]) => {
            if (k !== '_hierarchy_schema' && Array.isArray(v)) {
              walkForTargets(v, `${elemP}.${k}`, elemLbl);
            }
          });
        }
      });
    } else {
      Object.entries(obj).forEach(([k, v]) => {
        if (k === 'editor_metadata' || k === '_hierarchy_schema') return;
        const curP = pathPrefix ? `${pathPrefix}.${k}` : k;
        if (Array.isArray(v)) {
          walkForTargets(v, curP, k);
        } else if (typeof v === 'object' && v !== null) {
          if (Array.isArray(v[props.arrayKey]) && v !== props.parentObj) {
            targets.push({
              container: v,
              path: curP,
              label: `${k} (${curP})`
            });
          }
          walkForTargets(v, curP, k);
        }
      });
    }
  };

  walkForTargets(store.excelJsonData, '');
  availableMoveTargets.value = targets;
  if (targets.length > 0) {
    selectedTargetParent.value = targets[0].container;
  }
  isMoveModalOpen.value = true;
};

const executeMoveItem = () => {
  if (itemToMoveIndex.value === null || !selectedTargetParent.value) return;
  const idx = itemToMoveIndex.value;
  const list = props.parentObj[props.arrayKey];
  if (!Array.isArray(list) || idx < 0 || idx >= list.length) return;
  
  const [movedItem] = list.splice(idx, 1);
  
  if (!Array.isArray(selectedTargetParent.value[props.arrayKey])) {
    selectedTargetParent.value[props.arrayKey] = [];
  }
  
  selectedTargetParent.value[props.arrayKey].push(movedItem);
  
  isMoveModalOpen.value = false;
  itemToMoveIndex.value = null;
};

const getItemPath = (idx, fieldKey) => {
  return fieldKey !== '' ? `${fullPath.value}.${idx}.${fieldKey}` : `${fullPath.value}.${idx}`;
};
</script>

<template>
  <div class="nested-hierarchy-container" style="margin-top: 0.85rem; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 0.75rem;">
    <!-- Section Header -->
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem; flex-wrap: wrap; gap: 8px;">
      <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
        <h5 style="margin: 0; font-size: 0.85rem; font-weight: 700; color: var(--text-primary); display: inline-flex; align-items: center; gap: 6px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span>Sub-taula: <strong style="color: var(--color-primary);">{{ arrayKey }}</strong></span>
          <span style="font-size: 0.75rem; font-weight: normal; color: var(--text-muted);">({{ items.length }} registres)</span>
        </h5>
      </div>

      <div style="display: flex; align-items: center; gap: 6px;">
        <button 
          type="button"
          class="btn btn-secondary" 
          style="width: auto; padding: 2px 8px; font-size: 0.7rem; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border-color);"
          @click.stop="openGroupConfig"
          title="Configura tipus de dades i disposició per a aquest grup"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 1 1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          <span v-if="store.config.showButtonTexts">Configura</span>
        </button>
        <button 
          type="button"
          class="btn btn-secondary" 
          style="padding: 2px 8px; font-size: 0.72rem; display: inline-flex; align-items: center; gap: 4px;"
          @click="addNestedItem"
          :title="'Afegeix ' + arrayKey"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <span v-if="store.config.showButtonTexts">Afegeix {{ arrayKey }}</span>
        </button>
      </div>
    </div>

    <!-- Empty State -->
    <div v-if="items.length === 0" style="padding: 0.75rem; font-size: 0.8rem; color: var(--text-muted); font-style: italic; background: rgba(0,0,0,0.02); border-radius: 4px; text-align: center;">
      Sense registres a <strong style="color: var(--text-primary);">{{ arrayKey }}</strong>. Feu clic a <strong>"➕ Afegeix {{ arrayKey }}"</strong> per afegir un element.
    </div>

    <!-- LEAF LEVEL: Render as Compact Tabular Table with Rich Controls -->
    <template v-else-if="isLeafLevel">
      <div style="overflow-x: auto; max-width: 100%;">
        <table class="data-table" style="width: 100%; border-collapse: collapse; font-size: 0.8rem;">
          <thead>
            <tr style="background: var(--bg-tertiary);">
              <th v-for="h in getLeafTableHeaders" :key="h" style="padding: 6px 8px; text-align: left; border-bottom: 2px solid var(--border-color); font-weight: 600;">
                {{ h }}
              </th>
              <th style="width: 90px; text-align: center; border-bottom: 2px solid var(--border-color);">Accions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rIdx) in items" :key="rIdx">
              <td v-for="h in getLeafTableHeaders" :key="h" style="padding: 4px 6px; border-bottom: 1px solid var(--border-color);">
                <div style="display: flex; gap: 4px; align-items: stretch; width: 100%;">
                  <!-- Calculated Field (Non-editable, Read-only with lock badge and type-specific formatting) -->
                  <div 
                    v-if="isCalculatedField(h)" 
                    :id="'data-field-' + fullPath + '-' + rIdx + '-' + h"
                    :data-path="getItemPath(rIdx, h)"
                    style="display: flex; align-items: center; gap: 6px; flex-grow: 1; height: 28px; padding: 2px 8px; border: 1px solid var(--border-color); border-radius: var(--radius-xs); background: var(--bg-tertiary); color: var(--text-primary); font-family: var(--font-mono); font-size: 0.78rem; font-weight: 600; cursor: not-allowed;" 
                    title="🔒 Camp calculat automàticament"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-muted); opacity: 0.85; flex-shrink: 0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    <span style="flex-grow: 1;">
                      {{ getElementType(h) === 'Percentage' ? (formatPercentageDisplay(row[h]) + ' %') : (row[h] !== undefined ? row[h] : 0) }}
                    </span>
                    <span style="font-size: 0.65rem; color: var(--text-muted); font-weight: normal; background: rgba(0,0,0,0.06); padding: 1px 4px; border-radius: 3px;">Calculat</span>
                  </div>

                  <!-- Select Type -->
                  <template v-else-if="getElementType(h) === 'Select'">
                    <div 
                      v-if="getElementMetadata(h)?.multiple"
                      :id="'data-field-' + fullPath + '-' + rIdx + '-' + h"
                      :data-path="getItemPath(rIdx, h)"
                      style="display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 28px; padding: 2px 4px; border: 1px solid var(--border-color); border-radius: var(--radius-xs); background: var(--bg-primary); flex-grow: 1; cursor: pointer; max-width: 250px; max-height: 70px; overflow-y: auto;"
                      @click="openMultiSelectModal(row, h, getElementMetadata(h))"
                      title="Fes clic per modificar la selecció"
                    >
                      <span v-if="getSelectedPills(row[h], getElementMetadata(h)).length === 0" style="color: var(--text-muted); font-size: 0.75rem; padding: 0 2px;">
                        [Tria opcions]
                      </span>
                      <span 
                        v-for="pill in getSelectedPills(row[h], getElementMetadata(h))" 
                        :key="pill.value" 
                        style="background-color: var(--color-primary-light, #e0f2fe); color: var(--color-primary, #0284c7); font-size: 0.72rem; padding: 1px 5px; border-radius: 4px; font-weight: 500;"
                        :title="pill.label"
                      >
                        {{ pill.label }}
                      </span>
                    </div>
                    <select 
                      v-else
                      :id="'data-field-' + fullPath + '-' + rIdx + '-' + h"
                      :data-path="getItemPath(rIdx, h)"
                      v-model="row[h]"
                      class="data-input"
                      style="flex-grow: 1; height: 28px; font-size: 0.78rem;"
                    >
                      <option value="">[Buit / Sense valor]</option>
                      <option 
                        v-for="opt in resolveSelectOptions(getElementMetadata(h))" 
                        :key="opt.value" 
                        :value="opt.value"
                      >
                        {{ opt.label }}
                      </option>
                    </select>
                  </template>

                  <!-- Date Type -->
                  <input 
                    v-else-if="getElementType(h) === 'Date'"
                    :id="'data-field-' + fullPath + '-' + rIdx + '-' + h"
                    :data-path="getItemPath(rIdx, h)"
                    type="date"
                    v-model="row[h]"
                    class="data-input"
                    style="flex-grow: 1; height: 28px; font-size: 0.78rem;"
                  >

                  <!-- Number Type -->
                  <input 
                    v-else-if="getElementType(h) === 'Number'"
                    :id="'data-field-' + fullPath + '-' + rIdx + '-' + h"
                    :data-path="getItemPath(rIdx, h)"
                    type="number"
                    step="any"
                    v-model="row[h]"
                    class="data-input"
                    style="flex-grow: 1; height: 28px; font-size: 0.78rem;"
                  >

                  <!-- Percentage Type -->
                  <div v-else-if="getElementType(h) === 'Percentage'" style="display: flex; align-items: center; flex-grow: 1; position: relative;">
                    <input 
                      :id="'data-field-' + fullPath + '-' + rIdx + '-' + h"
                      :data-path="getItemPath(rIdx, h)"
                      type="text"
                      inputmode="decimal"
                      :value="formatPercentageDisplay(row[h])"
                      @input="updatePercentageValue(row, h, $event.target.value)"
                      class="data-input"
                      style="flex-grow: 1; height: 28px; font-size: 0.78rem; padding-right: 24px;"
                      placeholder="0"
                    >
                    <span style="position: absolute; right: 8px; font-weight: bold; font-size: 0.78rem; color: var(--text-muted); pointer-events: none;">%</span>
                  </div>

                  <!-- Boolean Type -->
                  <select 
                    v-else-if="getElementType(h) === 'Boolean'"
                    :id="'data-field-' + fullPath + '-' + rIdx + '-' + h"
                    :data-path="getItemPath(rIdx, h)"
                    v-model="row[h]"
                    class="data-input"
                    style="flex-grow: 1; height: 28px; font-size: 0.78rem;"
                  >
                    <option value="">[Buit / Sense valor]</option>
                    <option :value="true">Cert (True)</option>
                    <option :value="false">Fals (False)</option>
                  </select>

                  <!-- Text Type (default) -->
                  <input 
                    v-else
                    :id="'data-field-' + fullPath + '-' + rIdx + '-' + h"
                    :data-path="getItemPath(rIdx, h)"
                    type="text"
                    v-model="row[h]"
                    class="data-input"
                    style="flex-grow: 1; height: 28px; font-size: 0.78rem; padding: 2px 6px;"
                  />

                  <button 
                    v-if="getElementType(h) === 'Text'"
                    type="button"
                    class="btn-icon-only"
                    style="height: 28px; width: 28px; min-width: 28px; font-size: 0.8rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: var(--bg-tertiary);"
                    title="Edició complexa en Markdown + Jinja2"
                    @click="openCellEditor(row, h)"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                  </button>
                </div>
              </td>
              <td style="padding: 4px 6px; border-bottom: 1px solid var(--border-color); text-align: center;">
                <div style="display: flex; align-items: center; justify-content: center; gap: 4px;">
                  <button 
                    type="button"
                    class="btn-icon-only" 
                    style="height: 24px; width: 24px; min-width: 24px; font-size: 0.75rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none;"
                    title="Duplica fila"
                    @click="duplicateNestedItem(rIdx)"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  </button>
                  <button 
                    type="button"
                    class="btn-icon-only" 
                    style="height: 24px; width: 24px; min-width: 24px; font-size: 0.75rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none;"
                    title="Trasllada fila a un altre pare"
                    @click="openMoveModal(rIdx)"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 11 21 7 17 3"/><line x1="21" y1="7" x2="9" y2="7"/><polyline points="7 21 3 17 7 13"/><line x1="3" y1="17" x2="15" y2="17"/></svg>
                  </button>
                  <button 
                    type="button"
                    class="btn-icon-only text-danger" 
                    style="height: 24px; width: 24px; min-width: 24px; font-size: 0.75rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none;"
                    title="Elimina fila"
                    @click="deleteNestedItem(rIdx)"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- INTERMEDIATE LEVEL: Render as Form Cards with Configurable Vertical KV or Horizontal Layout -->
    <template v-else>
      <div style="display: flex; flex-direction: column; gap: 0.35rem;">
        <div 
          v-for="(item, idx) in items" 
          :key="idx"
          class="nested-card-item"
          style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 0.4rem 0.6rem; box-shadow: 0 1px 3px rgba(0,0,0,0.03);"
        >
          <!-- Card Header -->
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem; padding-bottom: 0.2rem; border-bottom: 1px dashed var(--border-color);">
            <span style="font-size: 0.75rem; font-weight: 700; color: var(--color-primary);">
              #{{ idx + 1 }} 
              <span 
                :style="{ cursor: getGroupLabel(arrayKey) !== arrayKey ? 'help' : 'default' }"
                :title="getGroupLabel(arrayKey) !== arrayKey ? 'Clau de grup: ' + arrayKey : undefined"
              >
                {{ getGroupLabel(arrayKey) }}
              </span>: 
              <strong>{{ getItemLabel(item, `Element #${idx + 1}`) }}</strong>
            </span>
            <div style="display: flex; align-items: center; gap: 4px;">
              <button 
                type="button"
                class="btn btn-secondary" 
                style="padding: 2px 6px; font-size: 0.72rem; display: inline-flex; align-items: center; gap: 3px;"
                title="Duplica aquest element i totes les mebres aniuades"
                @click="duplicateNestedItem(idx)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span v-if="store.config.showButtonTexts">Duplica</span>
              </button>
              <button 
                type="button"
                class="btn btn-secondary" 
                style="padding: 2px 6px; font-size: 0.72rem; display: inline-flex; align-items: center; gap: 3px;"
                title="Trasllada aquest element a un altre pare"
                @click="openMoveModal(idx)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 11 21 7 17 3"/><line x1="21" y1="7" x2="9" y2="7"/><polyline points="7 21 3 17 7 13"/><line x1="3" y1="17" x2="15" y2="17"/></svg>
                <span v-if="store.config.showButtonTexts">Trasllada</span>
              </button>
              <button 
                type="button"
                class="btn-icon-only text-danger" 
                style="height: 22px; width: 22px; min-width: 22px; font-size: 0.75rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none;"
                title="Elimina element"
                @click="deleteNestedItem(idx)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>
          </div>

          <!-- FORM GRID ROW BLOCKS FOR NESTED ITEM PRIMITIVE FIELDS -->
          <div style="display: flex; flex-direction: column; gap: 0.5rem; width: 100%; margin-bottom: 0.75rem;">
            <div 
              v-for="(rowBlock, rIdx) in getItemRowBlocks(item)" 
              :key="'item-row-' + rIdx"
              class="form-grid-row"
              style="display: flex; flex-wrap: wrap; align-items: stretch; gap: 0.75rem; width: 100%;"
            >
              <div 
                v-for="entry in rowBlock" 
                :key="entry.key"
                :style="getFieldCardStyle(entry.key)"
              >
                <!-- Label Header -->
                <div 
                  :style="store.config.labelPosition === 'top'
                    ? 'display: flex; align-items: center; gap: 6px;'
                    : 'width: 220px; min-width: 180px; display: flex; align-items: center; gap: 6px;'"
                >
                  <span 
                    style="font-weight: 600; font-size: 0.8rem; color: var(--text-primary);"
                    :style="{ cursor: getFieldLabel(entry.key) !== entry.key ? 'help' : 'default' }"
                    :title="getFieldLabel(entry.key) !== entry.key ? 'Clau de camp: ' + entry.key : undefined"
                  >
                    {{ getFieldLabel(entry.key) }}
                  </span>
                </div>

                <!-- Input Controls -->
                <div style="display: flex; gap: 4px; align-items: center; width: 100%; flex-grow: 1;">
                  <!-- Select Type -->
                  <template v-if="getElementType(entry.key) === 'Select'">
                    <!-- Multiple select -->
                    <div 
                      v-if="getElementMetadata(entry.key)?.multiple"
                      :id="'data-field-' + fullPath + '-' + idx + '-' + entry.key"
                      :data-path="getItemPath(idx, entry.key)"
                      style="display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 32px; padding: 4px 8px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); flex-grow: 1; cursor: pointer; max-width: 100%; max-height: 80px; overflow-y: auto;"
                      @click="openMultiSelectModal(item, entry.key, getElementMetadata(entry.key))"
                      title="Fes clic per modificar la selecció"
                    >
                      <span v-if="getSelectedPills(item[entry.key], getElementMetadata(entry.key)).length === 0" style="color: var(--text-muted); font-size: 0.8rem;">
                        [Tria opcions]
                      </span>
                      <span 
                        v-for="pill in getSelectedPills(item[entry.key], getElementMetadata(entry.key))" 
                        :key="pill.value" 
                        style="background-color: var(--color-primary-light, #e0f2fe); color: var(--color-primary, #0284c7); font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; font-weight: 500; display: inline-block; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                        :title="pill.label"
                      >
                        {{ pill.label }}
                      </span>
                    </div>
                    <!-- Single select -->
                    <select 
                      v-else
                      :id="'data-field-' + fullPath + '-' + idx + '-' + entry.key"
                      :data-path="getItemPath(idx, entry.key)"
                      v-model="item[entry.key]"
                      class="data-input"
                      style="flex-grow: 1; height: 32px;"
                    >
                      <option value="">[Buit / Sense valor]</option>
                      <option 
                        v-for="opt in resolveSelectOptions(getElementMetadata(entry.key))" 
                        :key="opt.value" 
                        :value="opt.value"
                      >
                        {{ opt.label }}
                      </option>
                    </select>
                  </template>
                  
                  <!-- Computed Type (Non-editable) -->
                  <div 
                    v-else-if="getElementType(entry.key) === 'Computed'" 
                    :id="'data-field-' + fullPath + '-' + idx + '-' + entry.key"
                    :data-path="getItemPath(idx, entry.key)"
                    style="display: flex; align-items: center; gap: 6px; flex-grow: 1; height: 32px; padding: 2px 10px; border: 1px solid var(--border-color); border-radius: var(--radius-xs); background: var(--bg-tertiary); color: var(--text-primary); font-family: var(--font-mono); font-size: 0.85rem; font-weight: 600; cursor: not-allowed;" 
                    title="🔒 Camp calculat automàticament"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary); flex-shrink: 0;"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/></svg>
                    <span style="flex-grow: 1;">{{ item[entry.key] !== undefined ? item[entry.key] : 0 }}</span>
                    <span style="font-size: 0.7rem; color: var(--text-muted); font-weight: normal; background: rgba(0,0,0,0.06); padding: 1px 5px; border-radius: 4px;">Calculat</span>
                  </div>

                  <!-- Date Type -->
                  <input 
                    v-else-if="getElementType(entry.key) === 'Date'"
                    :id="'data-field-' + fullPath + '-' + idx + '-' + entry.key"
                    :data-path="getItemPath(idx, entry.key)"
                    type="date"
                    v-model="item[entry.key]"
                    class="data-input"
                    style="flex-grow: 1; height: 32px;"
                  >
                  
                  <!-- Number Type -->
                  <input 
                    v-else-if="getElementType(entry.key) === 'Number'"
                    :id="'data-field-' + fullPath + '-' + idx + '-' + entry.key"
                    :data-path="getItemPath(idx, entry.key)"
                    type="number"
                    step="any"
                    v-model="item[entry.key]"
                    class="data-input"
                    style="flex-grow: 1; height: 32px;"
                  >
                  
                  <!-- Boolean Type -->
                  <select 
                    v-else-if="getElementType(entry.key) === 'Boolean'"
                    :id="'data-field-' + fullPath + '-' + idx + '-' + entry.key"
                    :data-path="getItemPath(idx, entry.key)"
                    v-model="item[entry.key]"
                    class="data-input"
                    style="flex-grow: 1; height: 32px;"
                  >
                    <option value="">[Buit / Sense valor]</option>
                    <option :value="true">Cert (True)</option>
                    <option :value="false">Fals (False)</option>
                  </select>
                  
                  <!-- Text Type (default) -->
                  <input 
                    v-else
                    :id="'data-field-' + fullPath + '-' + idx + '-' + entry.key"
                    :data-path="getItemPath(idx, entry.key)"
                    type="text"
                    v-model="item[entry.key]"
                    class="data-input"
                    style="flex-grow: 1; height: 32px;"
                  >
                  
                  <button 
                    v-if="getElementType(entry.key) === 'Text'"
                    type="button"
                    class="btn-icon-only"
                    style="height: 32px; width: 32px; min-width: 32px; font-size: 0.9rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: var(--bg-tertiary);"
                    title="Edició complexa en Markdown + Jinja2"
                    @click="openCellEditor(item, entry.key)"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Child Hierarchies -->
          <template v-for="cKey in childKeys" :key="cKey">
            <NestedDataNode 
              :parentObj="item"
              :arrayKey="cKey"
              :schema="childSchemas[cKey] || { fields: [], children: {} }"
              :parentPath="getItemPath(idx, '')"
            />
          </template>
        </div>
      </div>
    </template>

    <!-- Group Config Modal -->
    <GroupConfigModal
      v-model="isConfigModalOpen"
      :groupName="arrayKey"
      :configList="groupConfigList"
      :groupLabel="groupLabelInput"
      :selectedLayout="selectedLayout"
      @save="handleSaveGroupConfig"
    />

    <!-- Visual Grid Layout Editor Modal -->
    <VisualGridEditorModal 
      v-model="isVisualGridModalOpen" 
      :groupName="arrayKey" 
      :configList="groupConfigList" 
    />

    <!-- Cell Text / Markdown + Jinja2 Editor Modal -->
    <div class="modal-overlay" v-if="isCellModalOpen" style="display: flex; z-index: 1100;">
      <div class="modal-content" style="max-width: 650px; width: 90%;">
        <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 0.75rem;">
          <h3 style="border: none; padding-bottom: 0; margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 6px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
            <span>Edició complexa del camp: {{ activeCellInfo?.fieldKey }}</span>
          </h3>
          <button type="button" class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="isCellModalOpen = false">&times;</button>
        </div>
        
        <div class="modal-body" style="padding: 1rem 0;">
          <textarea 
            v-model="cellTextValue" 
            class="data-input" 
            rows="10" 
            style="width: 100%; font-family: monospace; font-size: 0.85rem; padding: 8px; resize: vertical;"
            placeholder="Introdueix text o codi Jinja2..."
          ></textarea>
        </div>
        
        <div class="modal-footer" style="margin-top: 1rem; border-top: 1px solid var(--border-color); padding-top: 1rem; display: flex; justify-content: flex-end; gap: 8px;">
          <button type="button" class="btn btn-secondary" style="width: auto;" @click="isCellModalOpen = false">Cancel·la</button>
          <button type="button" class="btn btn-primary" style="width: auto;" @click="saveCellEditor">Desa Canvis</button>
        </div>
      </div>
    </div>

    <!-- Dynamic Multi-Select Options Modal -->
    <div class="modal-overlay" v-if="isMultiSelectModalOpen" style="display: flex; z-index: 1100;">
      <div class="modal-content" style="max-width: 450px; width: 90%; max-height: 70vh; display: flex; flex-direction: column;">
        <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 0.75rem;">
          <h3 style="border: none; padding-bottom: 0; margin: 0; font-size: 1.05rem;">
            Tria opcions per a: {{ activeMultiSelectCell?.fieldKey }}
          </h3>
          <button type="button" class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="isMultiSelectModalOpen = false">&times;</button>
        </div>
        
        <div class="modal-body" style="flex-grow: 1; overflow-y: auto; padding: 1rem 0;">
          <div style="display: flex; flex-direction: column; gap: 8px; padding: 0 0.5rem;">
            <label 
              v-for="opt in resolveSelectOptions(activeMultiSelectCell?.meta)" 
              :key="opt.value" 
              style="display: flex; align-items: center; gap: 10px; font-size: 0.88rem; cursor: pointer; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-secondary); user-select: none;"
            >
              <input 
                type="checkbox" 
                :value="opt.value" 
                :checked="isOptionChecked(activeMultiSelectCell?.item[activeMultiSelectCell?.fieldKey], opt.value)"
                @change="toggleOptionValue(activeMultiSelectCell?.item, activeMultiSelectCell?.fieldKey, opt.value, $event.target.checked)"
                style="width: 18px; height: 18px; cursor: pointer;"
              >
              <span style="color: var(--text-primary); font-weight: 500;">{{ opt.label }}</span>
            </label>
            
            <div v-if="resolveSelectOptions(activeMultiSelectCell?.meta).length === 0" style="color: var(--text-muted); text-align: center; padding: 2rem 0; font-size: 0.85rem;">
              No hi ha opcions actives. Comprova que la font d'opcions estigui configurada.
            </div>
          </div>
        </div>
        
        <div class="modal-footer" style="margin-top: 1rem; border-top: 1px solid var(--border-color); padding-top: 1rem; display: flex; justify-content: flex-end;">
          <button type="button" class="btn btn-primary" style="width: auto;" @click="isMultiSelectModalOpen = false">Fet</button>
        </div>
      </div>
    </div>

    <!-- Modal for Moving Item to Another Parent -->
    <div class="modal-overlay" :style="{ display: isMoveModalOpen ? 'flex' : 'none' }">
      <div class="modal-content" style="max-width: 450px;">
        <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem; margin-bottom: 0.75rem;">
          <h4 style="margin: 0; border: none; font-size: 0.95rem; font-weight: 700;">↔️ Traslladar element {{ arrayKey }}</h4>
          <button type="button" class="btn-icon-only" style="border:none; background:none; font-size:1.3rem; cursor: pointer;" @click="isMoveModalOpen = false">&times;</button>
        </div>
        <div class="modal-body" style="padding: 0.5rem 0;">
          <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0; margin-bottom: 0.75rem;">
            Tria el node pare de destí on vols traslladar aquest element de <strong>{{ arrayKey }}</strong>:
          </p>

          <div v-if="availableMoveTargets.length === 0" style="font-size: 0.8rem; color: var(--text-muted); font-style: italic; padding: 0.75rem; background: rgba(0,0,0,0.03); border-radius: 4px; text-align: center;">
            No s'ha trobat cap altre pare disponible a l'arbre per rebre aquest element de {{ arrayKey }}.
          </div>

          <div v-else style="display: flex; flex-direction: column; gap: 0.5rem;">
            <label style="font-size: 0.75rem; font-weight: 600; color: var(--text-secondary);">Destí:</label>
            <select v-model="selectedTargetParent" class="data-input" style="width: 100%; height: 36px; font-size: 0.82rem;">
              <option v-for="(tgt, tIdx) in availableMoveTargets" :key="tIdx" :value="tgt.container">
                {{ tgt.label }}
              </option>
            </select>
          </div>
        </div>
        <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 1rem; border-top: 1px solid var(--border-color); padding-top: 0.75rem;">
          <button type="button" class="btn btn-secondary" style="font-size: 0.8rem; padding: 0.4rem 0.8rem;" @click="isMoveModalOpen = false">
            Cancel·la
          </button>
          <button type="button" class="btn btn-primary" style="font-size: 0.8rem; padding: 0.4rem 0.8rem;" :disabled="!selectedTargetParent" @click="executeMoveItem">
            ↔️ Trasllada Aquí
          </button>
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

              <!-- Floating Autocomplete Dropdown Panel -->
              <div 
                v-if="showAutocomplete && autocompleteCandidates.length > 0"
                style="position: absolute; left: 10px; bottom: -10px; transform: translateY(100%); z-index: 1300; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 6px; box-shadow: var(--shadow-md); max-height: 220px; overflow-y: auto; min-width: 280px; padding: 4px;"
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
