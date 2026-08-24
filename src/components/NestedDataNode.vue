<script setup>
import { computed, ref } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';

import { useWasmEngines } from '../composables/useWasmEngines';
import VisualGridEditorModal from './VisualGridEditorModal.vue';

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

// Metadata & Custom Data Type Config Helpers
const getElementMetadata = (elementName) => {
  if (!store.editorMetadata) return null;
  return store.editorMetadata.find(m => m.group === props.arrayKey && m.element === elementName) || null;
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
  return meta ? meta.type : 'Text';
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

const saveGroupConfig = () => {
  store.editorMetadata = store.editorMetadata.filter(m => m.group !== props.arrayKey);
  
  // Save group layout & label header
  const groupMeta = {
    group: props.arrayKey,
    element: '_group_label',
    isGroupHeader: true,
    groupLayout: selectedLayout.value
  };
  if (groupLabelInput.value && groupLabelInput.value.trim()) {
    groupMeta.label = groupLabelInput.value.trim();
  }
  store.editorMetadata.push(groupMeta);
  
  // Save field config items
  groupConfigList.value.forEach(item => {
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
    store.editorMetadata.push(meta);
  });
  
  if (store.excelJsonData) {
    store.excelJsonData.editor_metadata = store.editorMetadata;
    evaluateComputedFields(store.excelJsonData);
  }
  
  isConfigModalOpen.value = false;
  store.addLog(`Configuració de tipus de dades per al grup '${props.arrayKey}' desada i valors calculats avaluats.`, 'success');
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
                  <!-- Select Type -->
                  <template v-if="getElementType(h) === 'Select'">
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

                  <!-- Computed Type (Non-editable) -->
                  <div 
                    v-else-if="getElementType(h) === 'Computed'" 
                    :id="'data-field-' + fullPath + '-' + rIdx + '-' + h"
                    :data-path="getItemPath(rIdx, h)"
                    style="display: flex; align-items: center; gap: 6px; flex-grow: 1; height: 28px; padding: 2px 8px; border: 1px solid var(--border-color); border-radius: var(--radius-xs); background: var(--bg-tertiary); color: var(--text-primary); font-family: var(--font-mono); font-size: 0.78rem; font-weight: 600; cursor: not-allowed;" 
                    title="🔒 Camp calculat automàticament"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary); flex-shrink: 0;"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/></svg>
                    <span style="flex-grow: 1;">{{ row[h] !== undefined ? row[h] : 0 }}</span>
                    <span style="font-size: 0.65rem; color: var(--text-muted); font-weight: normal; background: rgba(0,0,0,0.06); padding: 1px 4px; border-radius: 3px;">Calculat</span>
                  </div>

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
    <div class="modal-overlay" v-if="isConfigModalOpen" style="display: flex; z-index: 1050;">
      <div class="modal-content" style="max-width: 800px; width: 90%; max-height: 85vh; display: flex; flex-direction: column;">
        <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 0.75rem;">
          <h3 style="border: none; padding-bottom: 0; margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 6px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 1 1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            <span>Configuració del grup: <strong style="color: var(--color-primary);" :title="getGroupLabel(arrayKey) !== arrayKey ? 'Clau de grup: ' + arrayKey : undefined">{{ getGroupLabel(arrayKey) }}</strong></span>
          </h3>
          <button type="button" class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="isConfigModalOpen = false">&times;</button>
        </div>
        
        <div class="modal-body" style="flex-grow: 1; overflow-y: auto; padding: 1rem 0;">
          <!-- Top Control Header: Label Input + Action Buttons (Nova Clau, Editor Visual Grid) -->
          <div style="background: var(--bg-card); padding: 10px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); margin-bottom: 1rem; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
            <!-- Left: Group Label Input -->
            <div style="display: flex; align-items: center; gap: 8px; flex: 1 1 260px; min-width: 240px;">
              <span style="font-size: 0.85rem; font-weight: 600; color: var(--text-primary); white-space: nowrap;">Etiqueta formulari:</span>
              <input 
                type="text" 
                v-model="groupLabelInput" 
                class="data-input" 
                placeholder="ex: Pressupost, Partides, Activitats..." 
                style="height: 30px; font-size: 0.85rem; flex-grow: 1;"
              />
            </div>

            <!-- Right: Action Buttons at the exact same row level -->
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <button 
                type="button"
                class="btn btn-secondary" 
                style="width: auto; padding: 4px 10px; font-size: 0.75rem; height: 30px; display: inline-flex; align-items: center; gap: 5px;" 
                @click="addNewFieldToConfig"
                title="Afegeix una nova clau o camp a aquest grup"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                <span>Afegeix camp</span>
              </button>

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

          <!-- Layout selector option (Vertical KV vs Horizontal Grid) -->
          <div style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-secondary); padding: 10px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); margin-bottom: 1rem; flex-wrap: wrap; gap: 8px;">
            <span style="font-size: 0.85rem; font-weight: 600; color: var(--text-primary);">Disposició visual dels camps de formulari:</span>
            <div style="display: flex; gap: 16px;">
              <label style="display: flex; align-items: center; gap: 6px; font-size: 0.8rem; font-weight: 600; cursor: pointer; color: var(--text-primary);">
                <input type="radio" value="vertical" v-model="selectedLayout" style="cursor: pointer;" />
                <span>Vertical (Taula Clau-Valor 2-Columnes - Per defecte)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 6px; font-size: 0.8rem; font-weight: 600; cursor: pointer; color: var(--text-primary);">
                <input type="radio" value="horizontal" v-model="selectedLayout" style="cursor: pointer;" />
                <span>Horitzontal (Graella / Grid)</span>
              </label>
            </div>
          </div>

          <table class="inspector-table" style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background: var(--bg-tertiary);">
                <th style="padding: 8px; text-align: left;">Element / Camp</th>
                <th style="padding: 8px; text-align: left;">Etiqueta al formulari (Opcional)</th>
                <th style="padding: 8px; text-align: left; width: 130px;">Tipus de Dada</th>
                <th style="width: 65px; text-align: center;" title="Fila a la quadrícula del formulari (ex: 1, 2...)">Fila Grid</th>
                <th style="width: 65px; text-align: center;" title="Ordre de prioritat a la fila (ex: 1, 2...)">Ordre</th>
                <th style="width: 55px; text-align: center;" title="Si està marcat, el camp ocuparà tot l'espai horitzontal disponible a la fila">Omple</th>
                <th style="padding: 8px; text-align: left;">Font d'Opcions (Select / Fórmules)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in groupConfigList" :key="item.element">
                <td style="padding: 6px 8px; vertical-align: top;">
                  <code style="font-weight: bold; font-size: 0.85rem;">{{ item.element }}</code>
                </td>
                <td style="padding: 4px 6px; vertical-align: top;">
                  <input 
                    type="text" 
                    v-model="item.label" 
                    class="data-input" 
                    style="padding: 2px 6px; height: 28px; font-size: 0.8rem;"
                    :placeholder="item.element"
                    title="Nom personalitzat a mostrar al formulari en comptes del nom del camp"
                  >
                </td>
                <td style="padding: 6px 8px; vertical-align: top;">
                  <select v-model="item.type" class="data-input" style="padding: 2px 6px; height: 28px; font-size: 0.8rem;">
                    <option value="Text">Text</option>
                    <option value="Select">Select (Llista)</option>
                    <option value="Date">Data</option>
                    <option value="Number">Nombre</option>
                    <option value="Boolean">Booleà</option>
                    <option value="Computed">Calculat (Computed: SUM, COUNT, AVG)</option>
                  </select>
                </td>
                <!-- Grid Row assignment -->
                <td style="padding: 4px; width: 65px; vertical-align: top;">
                  <input 
                    type="number" 
                    v-model="item.gridRow" 
                    min="1" 
                    placeholder="Auto"
                    class="data-input" 
                    style="padding: 2px 4px; height: 28px; font-size: 0.8rem; text-align: center;"
                    title="Número de fila a la quadrícula del formulari (ex: 1, 2, 3...). Buit = automàtic"
                  >
                </td>
                
                <!-- Grid Order assignment -->
                <td style="padding: 4px; width: 65px; vertical-align: top;">
                  <input 
                    type="number" 
                    v-model="item.gridOrder" 
                    min="1" 
                    placeholder="Auto"
                    class="data-input" 
                    style="padding: 2px 4px; height: 28px; font-size: 0.8rem; text-align: center;"
                    title="Ordre de prioritat dins de la fila a la quadrícula (ex: 1, 2, 3...). Buit = automàtic"
                  >
                </td>

                <!-- Grid Fill option ("Omple") -->
                <td style="padding: 4px; width: 55px; text-align: center; vertical-align: middle;">
                  <input 
                    type="checkbox" 
                    v-model="item.gridFill" 
                    style="width: 18px; height: 18px; cursor: pointer;"
                    title="Si està marcat, el camp ocuparà tot l'espai horitzontal disponible a la fila"
                  >
                </td>
                <td style="padding: 6px 8px; vertical-align: top;">
                  <template v-if="item.type === 'Select'">
                    <div style="display: flex; gap: 12px; margin-bottom: 6px;">
                      <label style="display: flex; align-items: center; gap: 4px; font-size: 0.8rem; cursor: pointer;">
                        <input type="radio" value="static" v-model="item.sourceType"> Estàtica (Manual)
                      </label>
                      <label style="display: flex; align-items: center; gap: 4px; font-size: 0.8rem; cursor: pointer;">
                        <input type="radio" value="dynamic" v-model="item.sourceType"> Dinàmica (Taula)
                      </label>
                    </div>
                    
                    <div v-if="item.sourceType === 'static'">
                      <input 
                        type="text" 
                        v-model="item.optionsRaw" 
                        class="data-input" 
                        placeholder="opcio1, opcio2, opcio3"
                        style="padding: 4px 8px; height: 28px; font-size: 0.8rem;"
                      >
                    </div>
                    
                    <div v-else style="display: flex; flex-direction: column; gap: 4px;">
                      <select v-model="item.vectorPath" class="data-input" style="padding: 2px 6px; height: 28px; font-size: 0.8rem;" @change="onVectorPathChange(item)">
                        <option value="">-- Tria una taula --</option>
                        <option v-for="tName in getAvailableTables()" :key="tName" :value="tName">
                          {{ tName }}
                        </option>
                      </select>
                      
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
                    
                    <label style="display: flex; align-items: center; gap: 6px; margin-top: 6px; cursor: pointer; font-size: 0.8rem; color: var(--text-primary);">
                      <input type="checkbox" v-model="item.multiple">
                      <span>Selecció múltiple</span>
                    </label>
                  </template>

                  <!-- Computed Configuration for Nested Level -->
                  <template v-else-if="item.type === 'Computed'">
                    <div style="display: flex; flex-direction: column; gap: 4px; padding: 2px 0;">
                      <div style="display: flex; gap: 4px; align-items: center;">
                        <span style="font-size: 0.72rem; font-weight: 600; width: 60px;">Funció:</span>
                        <select v-model="item.calcFn" class="data-input" style="padding: 2px 6px; height: 26px; font-size: 0.75rem; flex: 1;">
                          <option value="SUM">SUM (Suma sub-taula)</option>
                          <option value="COUNT">COUNT (Recompte sub-taula)</option>
                          <option value="AVG">AVG (Mitjana sub-taula)</option>
                          <option value="CUSTOM">CUSTOM (Fórmula personalitzada)</option>
                        </select>
                      </div>

                      <template v-if="item.calcFn === 'CUSTOM'">
                        <div style="display: flex; flex-direction: column; gap: 3px; margin-top: 2px;">
                          <div style="display: flex; gap: 4px; align-items: center;">
                            <span style="font-size: 0.72rem; font-weight: 600; width: 60px;">Fórmula:</span>
                            <input 
                              type="text" 
                              v-model="item.calcFormula" 
                              class="data-input" 
                              placeholder="ex: preu * unitats o SI(unitats > 10; preu * 0.9; preu)"
                              style="padding: 2px 6px; height: 26px; font-size: 0.75rem; flex: 1; font-family: var(--font-mono);"
                              title="Ex: preu * unitats o SI(unitats > 10; preu * 0.9; preu * unitats)"
                            />
                            <button 
                              type="button" 
                              class="btn btn-secondary" 
                              style="padding: 2px 8px; height: 26px; font-size: 0.72rem; width: auto; display: inline-flex; align-items: center; gap: 3px; white-space: nowrap;"
                              @click="openFormulaModal(item, groupConfigList.map(x => x.element))"
                              title="Obre l'editor ampliat de fórmules"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                              <span>Amplia</span>
                            </button>
                          </div>
                          <span style="font-size: 0.68rem; color: var(--text-muted);">
                            Operadors: +, -, *, /, %, ^ | Condició: SI(condició; cert; fals)
                          </span>
                        </div>
                      </template>

                      <template v-else>
                        <div style="display: flex; gap: 4px; align-items: center;">
                          <span style="font-size: 0.72rem; font-weight: 600; width: 60px;">Sub-taula:</span>
                          <select v-model="item.calcVector" class="data-input" style="padding: 2px 6px; height: 26px; font-size: 0.75rem; flex: 1;">
                            <option value="">-- Sub-taula --</option>
                            <option v-for="vec in getAvailableChildVectorsForGroup()" :key="vec" :value="vec">
                              {{ vec }}
                            </option>
                          </select>
                        </div>

                        <div v-if="item.calcFn !== 'COUNT' && item.calcVector" style="display: flex; gap: 4px; align-items: center;">
                          <span style="font-size: 0.72rem; font-weight: 600; width: 60px;">Columna:</span>
                          <select v-model="item.calcTargetCol" class="data-input" style="padding: 2px 6px; height: 26px; font-size: 0.75rem; flex: 1;">
                            <option value="">-- Columna --</option>
                            <option v-for="col in getChildTableColumns(item.calcVector)" :key="col" :value="col">
                              {{ col }}
                            </option>
                          </select>
                        </div>
                      </template>
                    </div>
                  </template>

                  <template v-else>
                    <span style="color: var(--text-muted); font-size: 0.8rem;">No aplicable</span>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>

          <!-- Add field / key button inside config modal -->
          <div style="margin-top: 0.75rem; padding: 0 0.5rem; display: flex; justify-content: flex-start;">
            <button 
              type="button"
              class="btn btn-secondary" 
              style="width: auto; padding: 3px 10px; font-size: 0.75rem; display: inline-flex; align-items: center; gap: 4px;" 
              @click="addNewFieldToConfig"
              title="Afegeix una nova clau o camp a aquest grup"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span>Afegeix nou camp / clau</span>
            </button>
          </div>
        </div>
        
        <div class="modal-footer" style="margin-top: 1rem; border-top: 1px solid var(--border-color); padding-top: 1rem; display: flex; justify-content: flex-end; gap: 8px;">
          <button type="button" class="btn btn-secondary" style="width: auto;" @click="isConfigModalOpen = false">Cancel·la</button>
          <button type="button" class="btn btn-primary" style="width: auto;" @click="saveGroupConfig">Aplica</button>
        </div>
      </div>
    </div>

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
              <button type="button" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; width: auto; font-weight: bold; color: var(--color-primary);" @click="insertTokenIntoFormula('SI(condició; expressió_cert; expressió_fals)')">SI(condició; cert; fals)</button>
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
  </div>
</template>
