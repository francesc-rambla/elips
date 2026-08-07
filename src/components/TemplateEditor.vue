<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import katex from 'katex';
import { latexSymbols } from './latexSymbols';

const props = defineProps({
  modelValue: { type: String, default: '' },
  isCellMode: { type: Boolean, default: false }
});

const emit = defineEmits(['update:modelValue', 'generate']);

const store = useWorkspaceStore();
const activeEditorTab = ref('visual'); // 'visual' or 'code'

const editorText = ref(props.isCellMode ? (props.modelValue || '') : (store.templateText || props.modelValue || ''));

// Watch props.modelValue if in cell mode
if (props.isCellMode) {
  watch(() => props.modelValue, (newVal) => {
    if (editorText.value !== newVal) {
      editorText.value = newVal || '';
      nextTick(() => {
        syncCodeToVisual();
      });
    }
  }, { immediate: true });

  watch(editorText, (newVal) => {
    emit('update:modelValue', newVal);
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
  });
}

// DOM refs
const canvasRef = ref(null);
const textareaRef = ref(null);
const blockExprInputRef = ref(null); // Ref to conditional input in modal

// Modals state
const isVarModalOpen = ref(false);
const isBlockModalOpen = ref(false);
const isMathModalOpen = ref(false);
const isTableModalOpen = ref(false);

const modalTitle = ref('');
const blockType = ref('if'); // 'if', 'for', 'elif'
const modalExpr = ref('');
const modalFilter = ref('');

// FOR loop separate inputs
const forItemVar = ref('item');
const forArrayVar = ref('');

// Math state
const mathExpr = ref('');
const mathType = ref('inline'); // 'inline' or 'display'
const activeMathCategory = ref(latexSymbols.categorias[0]?.id || 'basico');
let activeMathNode = null;

// Table Configuration Modal State
const tableMode = ref('dynamic'); // 'dynamic', 'transposed', 'manual'
const manualRows = ref(3);
const manualCols = ref(3);
const selectedArray = ref('');
const iteratorVar = ref('item');
const selectedColHeaderKey = ref('');
const tableColumns = ref([]); // Array of { key, header, align, selected }
let activeEditTableNode = null;

// Cursor Selection Management
let savedRange = null;
let activeEditNode = null;
let activeBlockForNewBranch = null; // Pointer to block when adding a new ELIF branch

const activeLoopContext = ref(null); // { iterator, arrayPath, columns }
const activeLoopStack = ref([]); // Stack of active loop contexts [{ iterator, arrayPath, columns }] ordered by depth (innermost first)

const linesCount = computed(() => {
  return editorText.value.split('\n').length;
});

// Check if document generation is ready to run
const isGenerateReady = computed(() => {
  return (store.excelFile || store.excelJsonData) && editorText.value.trim().length > 0 && store.enginesReady;
});

const emitGenerate = () => {
  emit('generate');
};

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

const isNonEmptySchema = (s) => {
  if (!s || typeof s !== 'object') return false;
  const hasFields = Array.isArray(s.fields) && s.fields.length > 0;
  const hasChildren = s.children && (Array.isArray(s.children) ? s.children.length > 0 : Object.keys(s.children).length > 0);
  return hasFields || hasChildren;
};

const universalFindSchema = (targetPath, dict) => {
  if (!dict || !targetPath) return { fields: [], children: {} };
  
  const cleanP = String(targetPath).replace(/\.\d+\b/g, '').replace(/^#?(dades|doc)\./, '');
  
  for (const [k, val] of Object.entries(dict)) {
    if (val && typeof val === 'object' && val.data_path === cleanP && isNonEmptySchema(val)) {
      return val;
    }
  }

  if (dict[cleanP] && isNonEmptySchema(dict[cleanP])) {
    return dict[cleanP];
  }
  
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
  
  const lastKey = parts[parts.length - 1];
  for (const [sKey, sVal] of Object.entries(dict)) {
    if ((sKey === cleanP || sKey === lastKey || sKey.endsWith(`.${lastKey}`) || sVal?.data_path === cleanP || sVal?.data_path?.endsWith(`.${lastKey}`)) && isNonEmptySchema(sVal)) {
      return sVal;
    }
  }
  
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

// Detect numeric column in Excel to set default alignment
const isNumericColumn = (arrayName, colKey) => {
  const arr = resolvePath(store.excelJsonData, arrayName);
  if (arr && Array.isArray(arr) && arr.length > 0) {
    for (const item of arr.slice(0, 5)) {
      const val = item[colKey];
      if (typeof val === 'number') return true;
      if (typeof val === 'string' && !isNaN(val) && val.trim() !== '') return true;
    }
  }
  return false;
};

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

// Formatting commands
const formatCmd = (cmd, arg = null) => {
  document.execCommand(cmd, false, arg);
  saveSelection();
  syncVisualToCode();
};

const formatBlock = (headerTag) => {
  document.execCommand('formatBlock', false, headerTag);
  saveSelection();
  syncVisualToCode();
};

// Variable Modals Trigger
const openVarModal = (node = null) => {
  saveSelection();
  activeLoopContext.value = getActiveLoopContext(node);
  if (node && node.tagName === 'SPAN') {
    activeEditNode = node;
    const raw = node.getAttribute('data-raw') || '';
    const parts = raw.split('|');
    modalExpr.value = parts[0].trim();
    modalFilter.value = parts.slice(1).join('|').trim();
    modalTitle.value = "Editar Variable";
  } else {
    activeEditNode = null;
    modalExpr.value = '';
    modalFilter.value = '';
    modalTitle.value = "Inserir Variable";
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
    modalExpr.value = '';
    modalTitle.value = "Afegir branca O SI (ELIF)";
  } else if (node && (node.tagName === 'SPAN' || node.classList?.contains('j-cond-text'))) {
    activeEditNode = node;
    const raw = node.getAttribute('data-cond') || '';
    if (type === 'for') {
      const parts = raw.split(/\s+in\s+/);
      forItemVar.value = parts[0] ? parts[0].trim() : 'item';
      forArrayVar.value = parts[1] ? parts[1].trim() : '';
      modalExpr.value = raw;
    } else {
      modalExpr.value = raw;
    }
    modalTitle.value = type === 'for' ? "Editar Bucle (FOR)" : (type === 'elif' ? "Editar branca O SI (ELIF)" : "Editar Condició (IF)");
  } else {
    activeEditNode = null;
    if (type === 'for') {
      forItemVar.value = 'item';
      forArrayVar.value = '';
      modalExpr.value = 'item in ';
    } else {
      modalExpr.value = '';
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
    mathExpr.value = node.getAttribute('data-expr') || '';
    mathType.value = node.getAttribute('data-type') || 'inline';
  } else {
    activeMathNode = null;
    mathExpr.value = '';
    mathType.value = 'inline';
  }
  isMathModalOpen.value = true;
};

const getCategoryNameInCatalan = (name) => {
  const translations = {
    'Basic': 'Bàsic',
    'Delimiters': 'Delimitadors',
    'Grouping': 'Agrupació',
    'Operators and relations': 'Operadors i relacions',
    'Sets': 'Conjunts',
    'Logic': 'Lògica',
    'Functions': 'Funcions',
    'Calculus': 'Càlcul',
    'Arrows': 'Fletxes',
    'Matrices': 'Matrius',
    'Systems': 'Sistemes',
    'Decorations': 'Decoracions',
    'Annotations': 'Anotacions',
    'Text formatting': 'Format de text',
    'Greek': 'Lletres gregues'
  };
  return translations[name] || name;
};

const renderSymbolHtml = (el) => {
  const expr = el.display || el.latex;
  try {
    return katex.renderToString(expr, { throwOnError: false, displayMode: false });
  } catch (_) {
    return expr;
  }
};

const mathCaretStart = ref(0);
const mathCaretEnd = ref(0);

const saveMathCaret = (e) => {
  const input = e.target;
  mathCaretStart.value = input.selectionStart;
  mathCaretEnd.value = input.selectionEnd;
};

const insertLatexAtCursor = (latexCode) => {
  const input = document.getElementById('mathExprInput');
  const start = mathCaretStart.value;
  const end = mathCaretEnd.value;
  const val = mathExpr.value || '';
  
  mathExpr.value = val.substring(0, start) + latexCode + val.substring(end);
  
  mathCaretStart.value = start + latexCode.length;
  mathCaretEnd.value = start + latexCode.length;
  
  nextTick(() => {
    if (input) {
      input.focus();
      let newCursorPos = start + latexCode.length;
      const braceIndex = latexCode.indexOf('{}');
      if (braceIndex !== -1) {
        newCursorPos = start + braceIndex + 1;
        mathCaretStart.value = newCursorPos;
        mathCaretEnd.value = newCursorPos;
      }
      input.setSelectionRange(newCursorPos, newCursorPos);
    }
  });
};

const currentMathPreview = computed(() => {
  let expr = mathExpr.value.trim();
  if (!expr) return '<span style="color:var(--text-muted); font-style:italic;">La previsualització de la fórmula es mostrarà aquí...</span>';
  
  // Replace Jinja2 placeholders for KaTeX rendering
  const cleanExpr = expr.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, p1) => {
    const escaped = p1.trim().replace(/_/g, '\\_');
    return `\\text{[${escaped}]}`;
  });
  
  try {
    return katex.renderToString(cleanExpr, { displayMode: mathType.value === 'display', throwOnError: false });
  } catch (err) {
    return `<span style="color:var(--color-danger);">${err.message}</span>`;
  }
});

// Apply Math Chip to canvas or textarea
const applyMath = () => {
  const expr = mathExpr.value.trim();
  const type = mathType.value;
  if (!expr) {
    if (activeMathNode) {
      activeMathNode.remove();
      syncVisualToCode();
    }
    isMathModalOpen.value = false;
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
  } else {
    if (textareaRef.value) {
      const txt = textareaRef.value;
      const start = txt.selectionStart;
      const end = txt.selectionEnd;
      const wrapExpr = type === 'display' ? `$$\n${expr}\n$$` : `$${expr}$`;
      editorText.value = editorText.value.substring(0, start) + wrapExpr + editorText.value.substring(end);
    }
  }
  isMathModalOpen.value = false;
};

// Advanced Table Modal Trigger
const openTableModal = (table = null) => {
  saveSelection();
  activeEditTableNode = table;
  
  if (table) {
    const rowLoop = table.querySelector('.j-row-loop');
    const colLoopCell = table.querySelector('[data-jinja-col-loop]');
    
    if (rowLoop) {
      tableMode.value = 'dynamic';
      const loopExpr = rowLoop.getAttribute('data-jinja-for') || '';
      const match = loopExpr.match(/^(\w+)\s+in\s+([\w\.\_]+)/);
      if (match) {
        iteratorVar.value = match[1].trim();
        selectedArray.value = match[2].trim();
        
        const headers = Array.from(table.querySelectorAll('th'));
        const cells = Array.from(rowLoop.querySelectorAll('td'));
        
        const arr = resolvePath(store.excelJsonData, selectedArray.value);
        const fields = arr && Array.isArray(arr) && arr.length > 0 ? Object.keys(arr[0]) : [];
        
        tableColumns.value = cells.map((cell, idx) => {
          const varChip = cell.querySelector('.j-var-chip');
          const rawPath = varChip ? varChip.getAttribute('data-raw') : '';
          const key = rawPath.split('.').pop() || '';
          const th = headers[idx];
          return {
            key,
            header: th ? th.innerText.trim() : key,
            align: cell.style.textAlign || 'left',
            selected: true
          };
        });
      }
    } else if (colLoopCell) {
      tableMode.value = 'transposed';
      const loopExpr = colLoopCell.getAttribute('data-jinja-col-loop') || '';
      const match = loopExpr.match(/^(\w+)\s+in\s+([\w\.\_]+)/);
      if (match) {
        iteratorVar.value = match[1].trim();
        selectedArray.value = match[2].trim();
        
        const thLoop = table.querySelector('th[data-jinja-col-loop]');
        const thChip = thLoop ? thLoop.querySelector('.j-var-chip') : null;
        if (thChip) {
          selectedColHeaderKey.value = thChip.getAttribute('data-raw').split('.').pop();
        }
        
        const rows = Array.from(table.querySelectorAll('tbody tr'));
        tableColumns.value = rows.map(r => {
          const td1 = r.querySelector('td:first-child');
          const td2 = r.querySelector('td[data-jinja-col-loop]');
          const chip = td2 ? td2.querySelector('.j-var-chip') : null;
          const key = chip ? chip.getAttribute('data-raw').split('.').pop() : '';
          return {
            key,
            header: td1 ? td1.innerText.trim() : key,
            align: td2 ? td2.style.textAlign || 'left' : 'left',
            selected: true
          };
        });
      }
    } else {
      tableMode.value = 'manual';
      manualRows.value = table.querySelectorAll('tr').length;
      manualCols.value = table.querySelector('tr') ? table.querySelector('tr').children.length : 3;
    }
  } else {
    tableMode.value = 'dynamic';
    selectedArray.value = availableArrays.value[0] || '';
    onArraySelected();
  }
  isTableModalOpen.value = true;
};

const onArraySelected = () => {
  if (!selectedArray.value) {
    tableColumns.value = [];
    return;
  }
  const arr = resolvePath(store.excelJsonData, selectedArray.value);
  if (arr && Array.isArray(arr) && arr.length > 0) {
    const fields = Object.keys(arr[0]).filter(k => k !== selectedArray.value.split('.').pop());
    tableColumns.value = fields.map(f => {
      const isNum = isNumericColumn(selectedArray.value, f);
      return {
        key: f,
        header: f.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
        align: isNum ? 'right' : 'left',
        selected: true
      };
    });
    
    iteratorVar.value = selectedArray.value.split('.').pop().toLowerCase().replace(/s$/, '') || 'item';
    selectedColHeaderKey.value = fields[0] || '';
  }
};

// Apply Table changes
const applyTableModal = () => {
  let html = '';
  const isFor = tableMode.value === 'dynamic';
  const isTrans = tableMode.value === 'transposed';
  
  if (isFor) {
    if (!selectedArray.value || !iteratorVar.value) {
      alert("Si us plau, selecciona un array de dades i un iterador vàlids.");
      return;
    }
    const loopExpr = `${iteratorVar.value.trim()} in ${selectedArray.value.trim()}`;
    const activeCols = tableColumns.value.filter(c => c.selected && c.key);
    if (activeCols.length === 0) {
      alert("Has de seleccionar almenys un camp.");
      return;
    }
    
    html += '<table><thead><tr>';
    activeCols.forEach(c => {
      html += `<th data-align="${c.align}" style="text-align: ${c.align};">${c.header}</th>`;
    });
    html += '</tr></thead><tbody>';
    
    html += `<tr class="j-row-loop" data-jinja-for="${loopExpr}">`;
    activeCols.forEach(c => {
      const chipRaw = `${iteratorVar.value.trim()}.${c.key}`;
      html += `<td style="text-align: ${c.align};"><span class="j-var-chip" contenteditable="false" data-raw="${chipRaw}">${resolveFieldLabel(chipRaw)}</span></td>`;
    });
    html += '</tr></tbody></table><p><br></p>';
  } else if (isTrans) {
    if (!selectedArray.value || !iteratorVar.value) {
      alert("Si us plau, selecciona un array de dades i un iterador vàlids.");
      return;
    }
    if (!selectedColHeaderKey.value) {
      alert("Si us plau, selecciona una capçalera de columna.");
      return;
    }
    const loopExpr = `${iteratorVar.value.trim()} in ${selectedArray.value.trim()}`;
    const activeCols = tableColumns.value.filter(c => c.selected && c.key && c.key !== selectedColHeaderKey.value);
    if (activeCols.length === 0) {
      alert("Has de seleccionar almenys una fila de dades.");
      return;
    }
    
    html += '<table><thead><tr>';
    html += '<th data-align="left">Dada</th>';
    const headChipRaw = `${iteratorVar.value.trim()}.${selectedColHeaderKey.value}`;
    html += `<th data-align="center" style="text-align: center;" data-jinja-col-loop="${loopExpr}"><span class="j-var-chip" contenteditable="false" data-raw="${headChipRaw}">${resolveFieldLabel(headChipRaw)}</span></th>`;
    html += '</tr></thead><tbody>';
    
    activeCols.forEach(c => {
      html += '<tr>';
      html += `<td>${c.header}</td>`;
      const cellChipRaw = `${iteratorVar.value.trim()}.${c.key}`;
      html += `<td style="text-align: ${c.align};" data-jinja-col-loop="${loopExpr}"><span class="j-var-chip" contenteditable="false" data-raw="${cellChipRaw}">${resolveFieldLabel(cellChipRaw)}</span></td>`;
      html += '</tr>';
    });
    html += '</tbody></table><p><br></p>';
  } else {
    html += '<table><thead><tr>';
    for (let j = 0; j < manualCols.value; j++) {
      html += '<th data-align="left">Capçalera</th>';
    }
    html += '</tr></thead><tbody>';
    for (let i = 1; i < manualRows.value; i++) {
      html += '<tr>';
      for (let j = 0; j < manualCols.value; j++) {
        html += '<td>Dada</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table><p><br></p>';
  }
  
  if (activeEditorTab.value === 'visual') {
    restoreSelection();
    if (activeEditTableNode) {
      const div = document.createElement('div');
      div.innerHTML = html;
      const newTable = div.querySelector('table');
      
      newTable.querySelectorAll('th').forEach(th => {
        th.onclick = () => toggleTableAlignment(th);
      });
      
      newTable.ondblclick = (e) => {
        e.stopPropagation();
        openTableModal(newTable);
      };
      
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
        });
      });
    }
    syncVisualToCode();
  }
  isTableModalOpen.value = false;
};

// Apply Variable Chip to canvas or textarea
const applyVariable = () => {
  const expr = modalExpr.value.trim();
  const filter = modalFilter.value.trim();
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
  const insertContent = isBlock ? `\n\n${expr.trim()}\n\n` : (expr.startsWith('{{') ? expr : `{{ ${expr} }}`);

  if (activeEditorTab.value === 'code') {
    if (textareaRef.value) {
      const txt = textareaRef.value;
      const start = txt.selectionStart || 0;
      const end = txt.selectionEnd || 0;
      editorText.value = editorText.value.substring(0, start) + insertContent + editorText.value.substring(end);
      setTimeout(() => {
        txt.focus();
        txt.selectionStart = txt.selectionEnd = start + insertContent.length;
        updateActiveLoopContext();
      }, 50);
    }
  } else {
    // Visual Mode:
    // Update Markdown source of truth at caret offset and recompile visual canvas
    saveSelection();
    let charOffset = 0;
    if (canvasRef.value) {
      charOffset = getCaretCharacterOffsetWithin(canvasRef.value);
      const currentMd = convertHtmlToMarkdown(canvasRef.value);
      editorText.value = currentMd;
    }
    
    const currentText = editorText.value || '';
    const safeOffset = Math.min(charOffset, currentText.length);
    editorText.value = currentText.substring(0, safeOffset) + insertContent + currentText.substring(safeOffset);
    
    // Compile markdown back to visual HTML DOM canvas
    syncCodeToVisual();
    
    nextTick(() => {
      updateActiveLoopContext();
    });
  }
};

// Insert variables at cursor inside the IF condition box in the modal
const insertVarIntoIfExpr = (varPath) => {
  const input = blockExprInputRef.value;
  if (input) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const current = modalExpr.value || '';
    modalExpr.value = current.substring(0, start) + varPath + current.substring(end);
    nextTick(() => {
      input.focus();
      input.selectionStart = input.selectionEnd = start + varPath.length;
    });
  } else {
    modalExpr.value = (modalExpr.value || '') + varPath;
  }
};

// Insert variables at cursor inside the LaTeX equation input box in the modal
const insertVarIntoMathExpr = (varPath) => {
  const input = document.getElementById('mathExprInput');
  const insertText = `{{ ${varPath} }}`;
  const start = mathCaretStart.value;
  const end = mathCaretEnd.value;
  const current = mathExpr.value || '';
  
  mathExpr.value = current.substring(0, start) + insertText + current.substring(end);
  
  mathCaretStart.value = start + insertText.length;
  mathCaretEnd.value = start + insertText.length;
  
  nextTick(() => {
    if (input) {
      input.focus();
      input.setSelectionRange(start + insertText.length, start + insertText.length);
    }
  });
};

const selectArrayForLoop = (arrayPath) => {
  forArrayVar.value = arrayPath;
};

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

// Apply Jinja Logical Card (IF, FOR or ELIF)
const applyBlock = () => {
  let expr = '';
  if (blockType.value === 'for') {
    expr = `${forItemVar.value.trim()} in ${forArrayVar.value.trim()}`;
  } else {
    expr = modalExpr.value.trim();
  }
  
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

// 1. Convert visual HTML to clean Markdown + Jinja
const convertHtmlToMarkdown = (element) => {
  const clone = element.cloneNode(true);
  
  // Replace variable chips in the element
  clone.querySelectorAll('.j-var-chip').forEach(c => {
    let raw = (c.getAttribute('data-raw') || '').trim();
    if (raw.endsWith('.')) raw = raw.slice(0, -1);
    const parts = raw.split('|');
    const expr = parts[0].trim();
    const filter = parts.slice(1).join('|').trim();
    const str = expr ? (filter ? `{{ ${expr} | ${filter} }}` : `{{ ${expr} }}`) : '[Variable sense nom]';
    c.parentNode.replaceChild(document.createTextNode(str), c);
  });
  
  // Replace math chips in the element
  clone.querySelectorAll('.latex-chip').forEach(c => {
    const expr = c.getAttribute('data-expr') || '';
    const type = c.getAttribute('data-type') || 'inline';
    const marker = type === 'display' ? `$$${expr}$$` : `$${expr}$`;
    c.parentNode.replaceChild(document.createTextNode(marker), c);
  });
  
  let html = clone.innerHTML;
  html = html.replace(/<h1>(.*?)<\/h1>/gi, '\n# $1\n\n')
             .replace(/<h2>(.*?)<\/h2>/gi, '\n## $1\n\n')
             .replace(/<h3>(.*?)<\/h3>/gi, '\n### $1\n\n')
             .replace(/<h4>(.*?)<\/h4>/gi, '\n#### $1\n\n')
             .replace(/<h5>(.*?)<\/h5>/gi, '\n##### $1\n\n')
             .replace(/<h6>(.*?)<\/h6>/gi, '\n###### $1\n\n')
             .replace(/<b>(.*?)<\/b>|<strong>(.*?)<\/strong>/gi, '**$1$2**')
             .replace(/<i>(.*?)<\/i>|<em>(.*?)<\/em>/gi, '*$1$2*')
             .replace(/<ul>/gi, '\n').replace(/<\/ul>/gi, '\n')
             .replace(/<li>(.*?)<\/li>/gi, '- $1\n')
             .replace(/<ol>([\s\S]*?)<\/ol>/gi, (m, cnt) => {
               let i = 1;
               return '\n' + cnt.replace(/<li>(.*?)<\/li>/gi, (m2, t) => `${i++}. ${t}\n`) + '\n';
             })
             .replace(/<div><br><\/div>/gi, '\n')
             .replace(/<div>(.*?)<\/div>/gi, '\n$1')
             .replace(/<br\s*[\/]?>/gi, '\n');
             
  const txt = document.createElement("textarea");
  txt.innerHTML = html.replace(/<[^>]*>?/gm, ''); 
  return txt.value;
};

// 1. Convert visual HTML to clean Markdown + Jinja (using Text Placeholders to bypass DOM serialisation linebreak bugs)
const parseHtmlToMarkdown = (sourceElement) => {
  const clone = sourceElement.cloneNode(true);
  
  // Remove helper trailing editable lines used for caret placement
  clone.querySelectorAll('.trailing-editable-line').forEach(el => el.remove());
  
  // Extract leading Pandoc YAML metadata chip if present
  let pandocYamlHeader = '';
  const metadataChip = clone.querySelector('.pandoc-metadata-chip');
  if (metadataChip) {
    const rawYaml = decodeURIComponent(metadataChip.getAttribute('data-raw') || '');
    if (rawYaml.trim()) {
      pandocYamlHeader = `---\n${rawYaml.trim()}\n---\n\n`;
    }
    metadataChip.remove();
  }
  
  // Replace tables with full Row and Column loops support and placeholders FIRST
  const tablePlaceholders = [];
  clone.querySelectorAll('table').forEach((table, idx) => {
    const rowLoop = table.querySelector('.j-row-loop');
    const colLoopCell = table.querySelector('[data-jinja-col-loop]');
    
    let mdTable = "";
    if (rowLoop) {
      // Dynamic Table
      const loopExpr = rowLoop.getAttribute('data-jinja-for') || '';
      mdTable += `\n<!-- DYNAMIC_TABLE_START:${loopExpr} -->\n`;
      
      const rows = Array.from(table.querySelectorAll('tr'));
      rows.forEach((row, rIdx) => {
        const cells = Array.from(row.querySelectorAll('th, td'));
        
        // Convert chips inside cells to their Jinja representation BEFORE reading innerText
        const cellTexts = cells.map(cell => {
          let text = cell.innerText.trim();
          const chip = cell.querySelector('.j-var-chip');
          if (chip) {
            const raw = chip.getAttribute('data-raw') || '';
            text = `{{ ${raw} }}`;
          }
          return text;
        });
        
        let rowStr = "| " + cellTexts.join(" | ") + " |\n";
        
        if (row.classList.contains('j-row-loop')) {
          mdTable += `{% for ${loopExpr} %}\n${rowStr}{% endfor %}\n`;
        } else {
          mdTable += rowStr;
        }
        
        if (rIdx === 0 || row.querySelector('th')) {
          mdTable += "| " + cells.map(th => {
            const align = th.getAttribute('data-align') || 'left';
            return align === 'center' ? ':---:' : (align === 'right' ? '---:' : '---');
          }).join(" | ") + " |\n";
        }
      });
      mdTable += "<!-- DYNAMIC_TABLE_END -->\n";
    } else if (colLoopCell) {
      // Transposed Table
      const loopExpr = colLoopCell.getAttribute('data-jinja-col-loop') || '';
      let colHeaderKey = '';
      let rowKeys = [];
      const thLoop = table.querySelector('th[data-jinja-col-loop]');
      const thChip = thLoop ? thLoop.querySelector('.j-var-chip') : null;
      if (thChip) {
        let raw = (thChip.getAttribute('data-raw') || '').trim();
        if (raw.endsWith('.')) raw = raw.slice(0, -1);
        colHeaderKey = raw.split('.').pop();
      }
      
      table.querySelectorAll('tbody tr').forEach(r => {
        const tdLoop = r.querySelector('td[data-jinja-col-loop]');
        if (tdLoop) {
          const chip = tdLoop.querySelector('.j-var-chip');
          if (chip) {
            let raw = (chip.getAttribute('data-raw') || '').trim();
            if (raw.endsWith('.')) raw = raw.slice(0, -1);
            rowKeys.push(raw.split('.').pop());
          }
        }
      });
      
      mdTable += `\n<!-- TRANSPOSED_TABLE_START:${loopExpr};colHeader=${colHeaderKey};rows=${rowKeys.join(',')} -->\n`;
      
      const rows = Array.from(table.querySelectorAll('tr'));
      rows.forEach((row, rIdx) => {
        const cells = Array.from(row.querySelectorAll('th, td'));
        let rowStr = "| ";
        cells.forEach(cell => {
          const colLoop = cell.getAttribute('data-jinja-col-loop');
          
          let cellText = cell.innerText.trim();
          const chip = cell.querySelector('.j-var-chip');
          if (chip) {
            let raw = (chip.getAttribute('data-raw') || '').trim();
            if (raw.endsWith('.')) raw = raw.slice(0, -1);
            cellText = `{{ ${raw} }}`;
          }
          
          if (colLoop) {
            rowStr += `{% for ${colLoop} %}${cellText} | {% endfor %}`;
          } else {
            rowStr += `${cellText} | `;
          }
        });
        rowStr += "\n\n";
        mdTable += rowStr;
        
        if (rIdx === 0 || row.querySelector('th')) {
          let divStr = "| ";
          cells.forEach(cell => {
            const colLoop = cell.getAttribute('data-jinja-col-loop');
            const align = cell.getAttribute('data-align') || 'left';
            const alignStr = align === 'center' ? ':---:' : (align === 'right' ? '---:' : '---');
            if (colLoop) {
              divStr += `{% for ${colLoop} %}${alignStr} | {% endfor %}`;
            } else {
              divStr += `${alignStr} | `;
            }
          });
          divStr += "\n\n";
          mdTable += divStr;
        }
      });
      mdTable += "<!-- TRANSPOSED_TABLE_END -->\n";
    } else {
      // Manual Table
      mdTable += "\n";
      const rows = Array.from(table.querySelectorAll('tr'));
      rows.forEach((row, rIdx) => {
        const cells = Array.from(row.querySelectorAll('th, td'));
        mdTable += "| " + cells.map(c => c.innerText.trim()).join(" | ") + " |\n";
        if (rIdx === 0 || row.querySelector('th')) {
          mdTable += "| " + cells.map(th => {
            const align = th.getAttribute('data-align') || 'left';
            return align === 'center' ? ':---:' : (align === 'right' ? '---:' : '---');
          }).join(" | ") + " |\n";
        }
      });
      mdTable += "\n";
    }
    
    tablePlaceholders[idx] = mdTable;
    const placeholderText = document.createTextNode(`\n\n__TABLE_PLACEHOLDER_${idx}__\n\n`);
    table.parentNode.replaceChild(placeholderText, table);
  });

  // Replace logical cards in reverse order (innermost first)
  const blockPlaceholders = [];
  const blocks = Array.from(clone.querySelectorAll('.jinja-block'));
  for (let idx = blocks.length - 1; idx >= 0; idx--) {
    const block = blocks[idx];
    let code = "";
    
    const isInline = block.classList.contains('inline') || block.getAttribute('data-layout') === 'inline';
    
    if (isInline) {
      const type = block.getAttribute('data-type') || block.querySelector('.j-head')?.getAttribute('data-type') || 'if';
      const cond = block.getAttribute('data-cond') || (block.querySelector('.j-cond-text')?.getAttribute('data-cond') || '');
      const contentEl = block.querySelector('.j-content');
      let contentMd = contentEl ? convertHtmlToMarkdown(contentEl) : '';
      
      code = `{% ${type} ${cond} %}${contentMd.trim()}{% end${type === 'for' ? 'for' : 'endif'} %}`;
    } else {
      const type = block.getAttribute('data-type') || block.querySelector('.j-head')?.getAttribute('data-type') || 'if';
      const cond = block.getAttribute('data-cond') || (block.querySelector('.j-cond-text')?.getAttribute('data-cond') || '');
      
      code += `{% ${type} ${cond} %}\n`;
      
      Array.from(block.childNodes).forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.classList.contains('j-content')) {
            const innerMd = convertHtmlToMarkdown(node).trim();
            if (innerMd) {
              code += innerMd + '\n';
            }
          } else if (node.classList.contains('j-branch')) {
            const bType = node.getAttribute('data-type');
            if (bType === 'else') {
              code += `{% else %}\n`;
            } else {
              const bCond = node.querySelector('.j-cond-text')?.getAttribute('data-cond') || '';
              code += `{% ${bType} ${bCond} %}\n`;
            }
          }
        }
      });
      
      code += type === 'for' ? `{% endfor %}` : `{% endif %}`;
    }
    
    blockPlaceholders[idx] = code;
    const placeholderText = document.createTextNode(isInline ? `__BLOCK_PLACEHOLDER_${idx}__` : `\n__BLOCK_PLACEHOLDER_${idx}__\n`);
    block.parentNode.replaceChild(placeholderText, block);
  }
  
  // Now convert the remaining document (which now only has text, placeholders and standard tags)
  let markdown = convertHtmlToMarkdown(clone);
  
  // Restore Placeholders in forward order (parent outermost first, introducing child placeholders, then innermost)
  for (let idx = 0; idx < blockPlaceholders.length; idx++) {
    const code = blockPlaceholders[idx];
    if (code === undefined) continue;
    markdown = markdown.replace(new RegExp(`__BLOCK_PLACEHOLDER_${idx}__`, 'g'), () => code);
  }
  tablePlaceholders.forEach((mdTable, idx) => {
    markdown = markdown.replace(new RegExp(`__TABLE_PLACEHOLDER_${idx}__`, 'g'), () => mdTable);
  });
  
  const cleanBody = markdown.replace(/\n{3,}/g, '\n\n').trim();
  return pandocYamlHeader ? pandocYamlHeader + cleanBody : cleanBody;
};

// Helper: Convert inner cell templates to chips
const convertJinjaToChips = (text) => {
  return text.replace(/\{\{\s*(.*?)\s*\}\}/g, (m, v) => {
    const vars = v.split('|');
    const expr = vars[0].trim();
    const filter = vars.length > 1 ? vars.slice(1).join('|').trim() : '';
    const displayLabel = resolveFieldLabel(v);
    return `<span class="j-var-chip" contenteditable="false" data-raw="${expr}${filter ? '|' + filter : ''}">${displayLabel}</span>`;
  });
};

const findBestKeyMatch = (arrayPath, label) => {
  if (!store.excelJsonData || !arrayPath || !label) return '';
  const arr = resolvePath(store.excelJsonData, arrayPath);
  if (!arr || !Array.isArray(arr) || arr.length === 0) return '';
  
  const keys = Object.keys(arr[0]);
  const normLabel = label.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  for (const k of keys) {
    if (k.toLowerCase().replace(/[^a-z0-9]/g, '') === normLabel) {
      return k;
    }
  }
  for (const k of keys) {
    if (k.toLowerCase().includes(normLabel) || normLabel.includes(k.toLowerCase())) {
      return k;
    }
  }
  return keys[0] || '';
};

const findColHeaderKeyMatch = (arrayPath, values) => {
  if (!store.excelJsonData || !arrayPath || !values || values.length === 0) return '';
  const arr = resolvePath(store.excelJsonData, arrayPath);
  if (!arr || !Array.isArray(arr) || arr.length === 0) return '';
  
  const keys = Object.keys(arr[0]);
  for (const k of keys) {
    const sampleVals = arr.map(item => String(item[k]).trim().toLowerCase());
    const matchCount = values.filter(v => sampleVals.includes(v.trim().toLowerCase())).length;
    if (matchCount > 0) {
      return k;
    }
  }
  return keys[0] || '';
};

// Parse framed tables (transposed/dynamic) using metadata tags
const parseCommentTablesToHtml = (md) => {
  let processed = md;
  
  // 1. Parse Transposed Tables
  processed = processed.replace(/<!--\s*TRANSPOSED_TABLE_START:(.*?)\s*-->([\s\S]*?)<!--\s*TRANSPOSED_TABLE_END\s*-->/g, (match, meta, tableContent) => {
    const parts = meta.split(';');
    const loopExpr = parts[0].trim();
    let colHeader = '';
    let rowsStr = '';
    parts.slice(1).forEach(p => {
      const [k, v] = p.split('=');
      if (k === 'colHeader') colHeader = v;
      if (k === 'rows') rowsStr = v;
    });
    const rowKeys = rowsStr ? rowsStr.split(',') : [];
    
    const lines = tableContent.trim().split('\n').filter(l => l.trim().startsWith('|'));
    if (lines.length < 2) return match;
    
    const splitLine = (line) => {
      const clean = line.trim().replace(/^\|/, '').replace(/\|$/, '');
      return clean.split('|').map(c => c.trim());
    };
    
    const headers = splitLine(lines[0]);
    const headerValues = headers.slice(1);
    
    const loopVar = loopExpr.split(' ')[0];
    const arrayPath = loopExpr.split(' in ')[1] || '';
    
    // Auto-healing fallback for column header key
    if (!colHeader) {
      colHeader = findColHeaderKeyMatch(arrayPath, headerValues);
    }
    
    const aligns = [];
    if (lines[1]) {
      splitLine(lines[1]).forEach(div => {
        if (div.startsWith(':') && div.endsWith(':')) aligns.push('center');
        else if (div.endsWith(':')) aligns.push('right');
        else aligns.push('left');
      });
    }
    
    let html = '<table><thead><tr>';
    html += '<th data-align="left">Dada</th>';
    const headChipRaw = `${loopVar}.${colHeader}`;
    html += `<th data-align="center" style="text-align: center;" data-jinja-col-loop="${loopExpr}"><span class="j-var-chip" contenteditable="false" data-raw="${headChipRaw}">${resolveFieldLabel(headChipRaw)}</span></th>`;
    html += '</tr></thead><tbody>';
    
    const bodyLines = lines.slice(2);
    const parsedRowKeys = [...rowKeys];
    bodyLines.forEach((bl, idx) => {
      const cells = splitLine(bl);
      const rowLabel = cells[0] || 'Dada';
      if (!parsedRowKeys[idx]) {
        parsedRowKeys[idx] = findBestKeyMatch(arrayPath, rowLabel);
      }
      
      const key = parsedRowKeys[idx] || '';
      const cellChipRaw = `${loopVar}.${key}`;
      const align = aligns[1] || 'left';
      
      html += '<tr>';
      html += `<td>${rowLabel}</td>`;
      html += `<td style="text-align: ${align};" data-jinja-col-loop="${loopExpr}"><span class="j-var-chip" contenteditable="false" data-raw="${cellChipRaw}">${resolveFieldLabel(cellChipRaw)}</span></td>`;
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  });
  
  // 2. Parse Dynamic Tables
  processed = processed.replace(/<!--\s*DYNAMIC_TABLE_START:(.*?)\s*-->([\s\S]*?)<!--\s*DYNAMIC_TABLE_END\s*-->/g, (match, loopExpr, tableContent) => {
    const lines = tableContent.trim().split('\n').filter(l => l.trim().startsWith('|') || l.trim().startsWith('{%'));
    
    const headerLine = lines.find(l => l.startsWith('|') && !l.includes('---'));
    const dividerLine = lines.find(l => l.startsWith('|') && l.includes('---'));
    const bodyLine = lines.find(l => l.startsWith('|') && l.includes('{{'));
    
    if (!headerLine) return match;
    
    const splitLine = (line) => {
      const clean = line.trim().replace(/^\|/, '').replace(/\|$/, '');
      return clean.split('|').map(c => c.trim());
    };
    
    const headers = splitLine(headerLine);
    const aligns = [];
    if (dividerLine) {
      splitLine(dividerLine).forEach(div => {
        if (div.startsWith(':') && div.endsWith(':')) aligns.push('center');
        else if (div.endsWith(':')) aligns.push('right');
        else aligns.push('left');
      });
    }
    
    let html = '<table><thead><tr>';
    headers.forEach((h, idx) => {
      const align = aligns[idx] || 'left';
      html += `<th data-align="${align}" style="text-align: ${align};">${h}</th>`;
    });
    html += '</tr></thead><tbody>';
    
    html += `<tr class="j-row-loop" data-jinja-for="${loopExpr.trim()}">`;
    if (bodyLine) {
      splitLine(bodyLine).forEach((cell, idx) => {
        const align = aligns[idx] || 'left';
        const chipHtml = convertJinjaToChips(cell);
        html += `<td style="text-align: ${align};">${chipHtml}</td>`;
      });
    }
    html += '</tr></tbody></table>';
    return html;
  });

  return processed;
};

// Parser: Restore remaining standard Markdown tables to Visual HTML tables
const parseMarkdownTablesToHtml = (md) => {
  const lines = md.split('\n');
  let result = [];
  let inTable = false;
  let tableRows = [];
  
  for (let line of lines) {
    const isRow = line.trim().startsWith('|') && line.trim().endsWith('|');
    if (isRow) {
      inTable = true;
      tableRows.push(line.trim());
    } else {
      if (inTable) {
        result.push(renderTableRowsToHtml(tableRows));
        inTable = false;
        tableRows = [];
      }
      result.push(line);
    }
  }
  if (inTable) {
    result.push(renderTableRowsToHtml(tableRows));
  }
  return result.join('\n');
};

const renderTableRowsToHtml = (rows) => {
  if (rows.length < 2) return rows.join('\n');
  
  const isDivider = (r) => r.replace(/[\s\|:\-]/g, '') === '';
  
  let headerRow = rows[0];
  let dividerRow = rows[1];
  let bodyRows = rows.slice(2);
  
  if (!isDivider(dividerRow)) {
    bodyRows = rows.slice(1);
    dividerRow = '';
  }
  
  const splitLine = (line) => {
    let safe = line.replace(/\{%.*?%\}/g, (m) => m.replace(/\|/g, '__PIPE__'));
    safe = safe.trim().replace(/^\|/, '').replace(/\|$/, '');
    return safe.split('|').map(cell => cell.replace(/__PIPE__/g, '|').trim());
  };
  
  const headers = splitLine(headerRow);
  const alignments = [];
  if (dividerRow) {
    const divs = splitLine(dividerRow);
    divs.forEach(div => {
      let cleanDiv = div;
      const loopMatch = div.match(/\{%\s*for\s+.*?\s*%\}(.*?)\{%\s*endfor\s*%\}/);
      if (loopMatch) {
        cleanDiv = loopMatch[1].trim();
      }
      
      if (cleanDiv.startsWith(':') && cleanDiv.endsWith(':')) {
        alignments.push('center');
      } else if (cleanDiv.endsWith(':')) {
        alignments.push('right');
      } else {
        alignments.push('left');
      }
    });
  }
  
  let html = '<table><thead><tr>';
  headers.forEach((h, idx) => {
    const align = alignments[idx] || 'left';
    const loopMatch = h.match(/\{%\s*for\s+(.*?)\s*%\}(.*?)\|\s*\{%\s*endfor\s*%\}/) || h.match(/\{%\s*for\s+(.*?)\s*%\}(.*?)\{%\s*endfor\s*%\}/);
    
    if (loopMatch) {
      const cond = loopMatch[1].trim();
      const innerVal = loopMatch[2].trim();
      const chipHtml = convertJinjaToChips(innerVal);
      html += `<th data-align="${align}" style="text-align: ${align};" data-jinja-col-loop="${cond}">${chipHtml}</th>`;
    } else {
      const chipHtml = convertJinjaToChips(h);
      html += `<th data-align="${align}" style="text-align: ${align};">${chipHtml}</th>`;
    }
  });
  html += '</tr></thead><tbody>';
  
  bodyRows.forEach(r => {
    const rowLoopMatch = r.match(/^\{%\s*for\s+(.*?)\s*%\}(.*)\{%\s*endfor\s*%\}$/);
    let loopCond = '';
    let rowContent = r;
    if (rowLoopMatch) {
      loopCond = rowLoopMatch[1].trim();
      rowContent = rowLoopMatch[2].trim();
    }
    
    const cells = splitLine(rowContent);
    html += loopCond ? `<tr class="j-row-loop" data-jinja-for="${loopCond}">` : '<tr>';
    
    cells.forEach((cell, idx) => {
      const align = alignments[idx] || 'left';
      const colLoopMatch = cell.match(/\{%\s*for\s+(.*?)\s*%\}(.*?)\|\s*\{%\s*endfor\s*%\}/) || cell.match(/\{%\s*for\s+(.*?)\s*%\}(.*?)\{%\s*endfor\s*%\}/);
      
      if (colLoopMatch) {
        const cond = colLoopMatch[1].trim();
        const innerVal = colLoopMatch[2].trim();
        const chipHtml = convertJinjaToChips(innerVal);
        html += `<td style="text-align: ${align};" data-jinja-col-loop="${cond}">${chipHtml}</td>`;
      } else {
        const chipHtml = convertJinjaToChips(cell);
        html += `<td style="text-align: ${align};">${chipHtml}</td>`;
      }
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  return html;
};

// 2. Compile raw Markdown + Jinja back to HTML visual tree
const compileMarkdownToHtml = (markdownText) => {
  let processed = markdownText || '';
  
  // 0. Extract leading Pandoc YAML metadata block if present
  let yamlHeaderHtml = '';
  const yamlMatch = processed.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (yamlMatch) {
    const rawYaml = yamlMatch[1];
    processed = processed.slice(yamlMatch[0].length);
    yamlHeaderHtml = `<div class="pandoc-metadata-chip" contenteditable="false" data-raw="${encodeURIComponent(rawYaml)}" style="background-color: var(--bg-tertiary); border: 1px dashed var(--color-primary); border-radius: 6px; padding: 8px 12px; margin-bottom: 1rem; user-select: none;">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
        <div style="font-size: 0.8rem; font-weight: bold; color: var(--color-primary); display: flex; align-items: center; gap: 6px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
          <span>Metadades Pandoc (YAML Header)</span>
        </div>
        <button class="j-btn-mini btn-edit-metadata" style="background-color: var(--color-primary); color: white; border: none; padding: 3px 10px; cursor: pointer; border-radius: 4px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          <span>Edita Metadades</span>
        </button>
      </div>
    </div>`;
  }
  
  // 1. Extract math formulas and replace with placeholders to avoid double-parsing variables inside them
  const mathPlaceholders = [];
  
  // Extract double dollar formulas (display math)
  processed = processed.replace(/\$\$(.*?)\$\$/gs, (m, expr) => {
    const idx = mathPlaceholders.length;
    mathPlaceholders.push({ expr: expr.trim(), type: 'display' });
    return `__MATH_PLACEHOLDER_${idx}__`;
  });
  
  // Extract single dollar formulas (inline math)
  processed = processed.replace(/\$(.*?)\$/g, (m, expr) => {
    const idx = mathPlaceholders.length;
    mathPlaceholders.push({ expr: expr.trim(), type: 'inline' });
    return `__MATH_PLACEHOLDER_${idx}__`;
  });
  
  // Run table parsers on the clean text (with math hidden)
  processed = parseCommentTablesToHtml(processed);
  processed = parseMarkdownTablesToHtml(processed);
  
  // 2. Parse Jinja control tags
  const tokens = processed.split(/(\{%.*?%\})/g);
  let htmlResult = '';
  let stack = [];
  
  for (let idx = 0; idx < tokens.length; idx++) {
    const chunk = tokens[idx];
    const matchTag = chunk.match(/\{%\s*(.*?)\s*%\}/);
    if (matchTag) {
      const expr = matchTag[1].trim();
      if (expr.startsWith('for ')) {
        const cond = expr.substring(4).trim();
        
        // Detect layout mode: block if tag is on its own line
        const prevChunk = idx > 0 ? tokens[idx - 1] : '';
        const nextChunk = idx < tokens.length - 1 ? tokens[idx + 1] : '';
        const isBlock = (idx === 0 || /\n\s*$/.test(prevChunk)) && (idx === tokens.length - 1 || /^\s*\n/.test(nextChunk));
        
        if (isBlock) {
          htmlResult += `<div class="jinja-block" contenteditable="false" data-layout="block" data-type="for" data-cond="${cond}"><div class="j-head" data-type="for"><div style="display:flex;align-items:center;gap:4px;"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg> <span style="font-weight:700;color:var(--color-primary);">PER CADA:</span> <span class="j-cond-text" data-cond="${cond}">${cond}</span></div><div class="j-actions"><button class="j-btn-mini btn-layout" style="background-color:var(--color-primary);color:white;border:none;display:inline-flex;align-items:center;gap:3px;" title="Canvia a mode integrat al text (Inline)"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> <span>Inline</span></button><button class="j-btn-mini btn-trash" style="background-color:var(--color-danger);color:white;border:none;display:inline-flex;align-items:center;justify-content:center;" title="Elimina el bucle"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div></div><div class="j-content" contenteditable="true">`;
          stack.push('for');
        } else {
          htmlResult += `<span class="jinja-block inline" contenteditable="false" data-layout="inline" data-type="for" data-cond="${cond}"><span class="j-inline-tag" contenteditable="false" title="Fes clic per passar a BLOC">{% for ${cond} %}</span><span class="j-content" contenteditable="true">`;
          stack.push('for-inline');
        }
      } else if (expr.startsWith('if ')) {
        const cond = expr.substring(3).trim();
        
        // Detect layout mode: block if tag is on its own line
        const prevChunk = idx > 0 ? tokens[idx - 1] : '';
        const nextChunk = idx < tokens.length - 1 ? tokens[idx + 1] : '';
        const isBlock = (idx === 0 || /\n\s*$/.test(prevChunk)) && (idx === tokens.length - 1 || /^\s*\n/.test(nextChunk));
        
        if (isBlock) {
          htmlResult += `<div class="jinja-block" contenteditable="false" data-layout="block" data-type="if" data-cond="${cond}"><div class="j-head" data-type="if"><div style="display:flex;align-items:center;gap:4px;"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg> <span style="font-weight:700;color:#b45309;">SI:</span> <span class="j-cond-text" data-cond="${cond}">${cond}</span></div><div class="j-actions"><button class="j-btn-mini btn-layout" style="background-color:var(--color-primary);color:white;border:none;display:inline-flex;align-items:center;gap:3px;" title="Canvia a mode integrat al text (Inline)"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> <span>Inline</span></button><button class="j-btn-mini btn-elif" title="Afegeix branca O SI (ELIF)">+ ELIF</button><button class="j-btn-mini btn-else" title="Afegeix branca EN CAS CONTRARI (ELSE)">+ ELSE</button><button class="j-btn-mini btn-trash" style="background-color:var(--color-danger);color:white;border:none;display:inline-flex;align-items:center;justify-content:center;" title="Elimina el condicional"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div></div><div class="j-content" contenteditable="true">`;
          stack.push('if');
        } else {
          htmlResult += `<span class="jinja-block inline" contenteditable="false" data-layout="inline" data-type="if" data-cond="${cond}"><span class="j-inline-tag" contenteditable="false" title="Fes clic per passar a BLOC">{% if ${cond} %}</span><span class="j-content" contenteditable="true">`;
          stack.push('if-inline');
        }
      } else if (expr.startsWith('elif ')) {
        const cond = expr.substring(5).trim();
        const parentType = stack[stack.length - 1];
        if (parentType === 'if-inline') {
          htmlResult += `</span><span class="j-inline-tag" contenteditable="false">{% elif ${cond} %}</span><span class="j-content" contenteditable="true">`;
        } else {
          htmlResult += `</div><div class="j-branch" data-type="elif"><div style="display:flex;align-items:center;gap:4px;"><span style="font-weight:700;color:#b45309;">O SI:</span> <span class="j-cond-text" data-cond="${cond}">${cond}</span></div><button class="j-btn-mini btn-branch-trash" style="background-color:var(--color-danger);color:white;border:none;display:inline-flex;align-items:center;justify-content:center;" title="Elimina la branca"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div><div class="j-content" contenteditable="true">`;
        }
      } else if (expr === 'else') {
        const parentType = stack[stack.length - 1];
        if (parentType === 'if-inline') {
          htmlResult += `</span><span class="j-inline-tag" contenteditable="false">{% else %}</span><span class="j-content" contenteditable="true">`;
        } else {
          htmlResult += `</div><div class="j-branch" data-type="else"><div style="display:flex;align-items:center;gap:4px;"><span style="font-weight:700;color:#b45309;">EN CAS CONTRARI</span></div><button class="j-btn-mini btn-branch-trash" style="background-color:var(--color-danger);color:white;border:none;display:inline-flex;align-items:center;justify-content:center;" title="Elimina la branca"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div><div class="j-content" contenteditable="true">`;
        }
      } else if (expr === 'endif' || expr === 'endfor') {
        const parentType = stack.pop();
        if (parentType === 'for-inline' || parentType === 'if-inline') {
          const type = parentType === 'for-inline' ? 'for' : 'if';
          htmlResult += `</span><span class="j-inline-tag" contenteditable="false" title="Fes clic per passar a BLOC">{% end${type} %}</span></span>`;
        } else {
          const label = parentType === 'for' ? 'FINAL BUCLE' : 'FINAL CONDICIONAL';
          htmlResult += `</div><div class="j-footer"><span>${label}</span></div></div>`;
        }
      }
    } else {
      let blockText = chunk.replace(/\{\{\s*(.*?)\s*\}\}/g, (m, v) => {
        const vars = v.split('|');
        const expr = vars[0].trim();
        const filter = vars.length > 1 ? vars.slice(1).join('|').trim() : '';
        const displayLabel = resolveFieldLabel(v);
        return `<span class="j-var-chip" contenteditable="false" data-raw="${expr}${filter ? '|' + filter : ''}">${displayLabel}</span>`;
      });
      
      blockText = blockText.replace(/^###### (.*)$/gm, '<h6>$1</h6>')
                           .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
                           .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
                           .replace(/^### (.*)$/gm, '<h3>$1</h3>')
                           .replace(/^## (.*)$/gm, '<h2>$1</h2>')
                           .replace(/^# (.*)$/gm, '<h1>$1</h1>');
                           
      blockText = blockText.replace(/^- (.*)$/gm, '<ul><li>$1</li></ul>')
                           .replace(/<\/ul>\s*<ul>/g, '')
                           .replace(/\n/g, '<br>');
      htmlResult += blockText;
    }
  }
  
  // 3. Restore and compile math placeholders
  mathPlaceholders.forEach((ph, idx) => {
    let render = '';
    const expr = ph.expr;
    const type = ph.type;
    try {
      const cleanExpr = expr.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, p1) => {
        const escaped = p1.trim().replace(/_/g, '\\_');
        return `\\text{[${escaped}]}`;
      });
      render = katex.renderToString(cleanExpr, { displayMode: type === 'display', throwOnError: false });
    } catch (_) {
      render = expr;
    }
    
    const replacement = type === 'display'
      ? `<div class="latex-chip display-math" contenteditable="false" data-type="display" data-expr="${expr}">${render}</div>\n`
      : `<span class="latex-chip inline-math" contenteditable="false" data-type="inline" data-expr="${expr}">${render}</span>`;
      
    htmlResult = htmlResult.replace(`__MATH_PLACEHOLDER_${idx}__`, replacement);
  });
  
  return yamlHeaderHtml + htmlResult;
};

// Sync loops
const syncVisualToCode = () => {
  if (canvasRef.value && activeEditorTab.value === 'visual') {
    editorText.value = parseHtmlToMarkdown(canvasRef.value);
  }
};

const syncCodeToVisual = () => {
  if (canvasRef.value) {
    canvasRef.value.innerHTML = compileMarkdownToHtml(editorText.value);
    
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
    });

    canvasRef.value.querySelectorAll('.jinja-block').forEach(block => {
      const isInline = block.classList.contains('inline') || block.getAttribute('data-layout') === 'inline';
      const type = block.getAttribute('data-type') || 'if';
      
      if (isInline) {
        block.querySelectorAll('.j-inline-tag').forEach(tag => {
          tag.onclick = (e) => {
            e.stopPropagation();
            block.setAttribute('data-layout', 'block');
            block.classList.remove('inline');
            syncVisualToCode();
            syncCodeToVisual();
          };
        });
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
  }
};

// Handle Tab Switches
const switchTab = (tab) => {
  if (tab === activeEditorTab.value) return;
  
  if (tab === 'code') {
    syncVisualToCode();
  } else {
    syncCodeToVisual();
    nextTick(() => {
      updateActiveLoopContext();
    });
  }
  activeEditorTab.value = tab;
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

// Clean paste formatting inside contenteditable preserving custom chips
const sanitizePasteHtml = (node) => {
  const fragment = document.createDocumentFragment();
  
  const walk = (curr, parentFrag) => {
    if (curr.nodeType === Node.TEXT_NODE) {
      parentFrag.appendChild(document.createTextNode(curr.textContent));
      return;
    }
    
    if (curr.nodeType === Node.ELEMENT_NODE) {
      const tag = curr.tagName.toLowerCase();
      
      // 1. Variable Chip
      if (tag === 'span' && curr.classList.contains('j-var-chip')) {
        const chip = document.createElement('span');
        chip.className = 'j-var-chip';
        chip.setAttribute('contenteditable', 'false');
        chip.setAttribute('data-raw', curr.getAttribute('data-raw') || '');
        chip.innerText = curr.innerText;
        chip.ondblclick = (e) => { e.stopPropagation(); openVarModal(chip); };
        parentFrag.appendChild(chip);
        return;
      }
      
      // 2. LaTeX Chip
      if ((tag === 'span' || tag === 'div') && curr.classList.contains('latex-chip')) {
        const chip = document.createElement(tag);
        chip.className = curr.className;
        chip.setAttribute('contenteditable', 'false');
        chip.setAttribute('data-expr', curr.getAttribute('data-expr') || '');
        chip.setAttribute('data-type', curr.getAttribute('data-type') || 'inline');
        chip.innerHTML = curr.innerHTML;
        chip.ondblclick = (e) => { e.stopPropagation(); openMathModal(chip); };
        parentFrag.appendChild(chip);
        return;
      }
      
      // 3. Jinja block wrapper or conditional text
      if (tag === 'div' && curr.classList.contains('jinja-block')) {
        const block = document.createElement('div');
        block.className = 'jinja-block';
        block.setAttribute('data-type', curr.getAttribute('data-type') || '');
        parentFrag.appendChild(block);
        for (let child of curr.childNodes) {
          walk(child, block);
        }
        return;
      }
      if (tag === 'span' && curr.classList.contains('j-cond-text')) {
        const cond = document.createElement('span');
        cond.className = 'j-cond-text';
        cond.setAttribute('data-cond', curr.getAttribute('data-cond') || '');
        cond.innerText = curr.innerText;
        cond.onclick = (e) => {
          e.stopPropagation();
          openBlockModal(curr.parentNode?.getAttribute('data-type') || 'if', cond);
        };
        parentFrag.appendChild(cond);
        return;
      }
      
      // 4. Safe structural HTML tags
      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span'].includes(tag)) {
        const el = document.createElement(tag);
        
        if (curr.className) {
          const cleanClasses = [];
          curr.classList.forEach(cls => {
            if (['j-head', 'j-branch', 'j-content', 'j-footer', 'j-row-loop', 'btn-branch-trash', 'j-btn-mini'].includes(cls)) {
              cleanClasses.push(cls);
            }
          });
          if (cleanClasses.length > 0) {
            el.className = cleanClasses.join(' ');
          }
        }
        
        if (curr.hasAttribute('data-jinja-for')) {
          el.setAttribute('data-jinja-for', curr.getAttribute('data-jinja-for'));
        }
        if (curr.hasAttribute('data-jinja-col-loop')) {
          el.setAttribute('data-jinja-col-loop', curr.getAttribute('data-jinja-col-loop'));
        }
        if (curr.style.textAlign) {
          el.style.textAlign = curr.style.textAlign;
        }
        
        if (curr.classList.contains('btn-branch-trash')) {
          el.onclick = () => {
            el.nextElementSibling?.remove();
            el.remove();
            syncVisualToCode();
          };
        }
        
        parentFrag.appendChild(el);
        for (let child of curr.childNodes) {
          walk(child, el);
        }
        return;
      }
      
      // 5. Walk generic formatting children
      for (let child of curr.childNodes) {
        walk(child, parentFrag);
      }
    }
  };
  
  for (let child of node.childNodes) {
    walk(child, fragment);
  }
  
  return fragment;
};

const onCanvasPaste = (e) => {
  e.preventDefault();
  
  const html = e.clipboardData.getData('text/html');
  if (html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const cleanFragment = sanitizePasteHtml(doc.body);
    
    restoreSelection();
    const sel = window.getSelection();
    if (sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(cleanFragment);
      
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      saveSelection();
    }
    syncVisualToCode();
  } else {
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
    syncVisualToCode();
  }
};

// --- Pandoc YAML Metadata Modal State & Logic ---
const isMetadataModalOpen = ref(false);
const metadataForm = ref({
  title: '',
  subtitle: '',
  author: '',
  date: '',
  lang: 'ca',
  toc: false,
  tocTitle: 'Índex de continguts',
  abstract: '',
  keywords: '',
  customYamlText: ''
});

const parseYamlHeader = (mdText) => {
  const match = (mdText || '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { header: null, body: mdText || '' };
  
  const yamlContent = match[1];
  const body = (mdText || '').slice(match[0].length);
  
  const fields = {
    title: '',
    subtitle: '',
    author: '',
    date: '',
    lang: 'ca',
    toc: false,
    tocTitle: 'Índex de continguts',
    abstract: '',
    keywords: '',
    customYaml: []
  };
  
  const lines = yamlContent.split(/\r?\n/);
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    
    const kvMatch = line.match(/^([a-zA-Z0-9_\-]+)\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      let val = kvMatch[2].trim();
      val = val.replace(/^["'](.*)["']$/, '$1');
      
      if (key === 'title') fields.title = val;
      else if (key === 'subtitle') fields.subtitle = val;
      else if (key === 'author') fields.author = val;
      else if (key === 'date') fields.date = val;
      else if (key === 'lang') fields.lang = val;
      else if (key === 'toc') fields.toc = (val === 'true' || val === '1' || val === 'yes');
      else if (key === 'toc-title') fields.tocTitle = val;
      else if (key === 'abstract') fields.abstract = val;
      else if (key === 'keywords') fields.keywords = val;
      else fields.customYaml.push(line);
    } else {
      fields.customYaml.push(line);
    }
  });
  
  return { header: fields, body };
};

const openMetadataModal = () => {
  saveSelection();
  const parsed = parseYamlHeader(store.templateText || '');
  if (parsed.header) {
    metadataForm.value = {
      title: parsed.header.title,
      subtitle: parsed.header.subtitle,
      author: parsed.header.author,
      date: parsed.header.date,
      lang: parsed.header.lang || 'ca',
      toc: parsed.header.toc,
      tocTitle: parsed.header.tocTitle || 'Índex de continguts',
      abstract: parsed.header.abstract,
      keywords: parsed.header.keywords,
      customYamlText: parsed.header.customYaml.join('\n')
    };
  } else {
    metadataForm.value = {
      title: '',
      subtitle: '',
      author: '',
      date: new Date().toLocaleDateString('ca-ES'),
      lang: 'ca',
      toc: false,
      tocTitle: 'Índex de continguts',
      abstract: '',
      keywords: '',
      customYamlText: ''
    };
  }
  isMetadataModalOpen.value = true;
};

const applyMetadataModal = () => {
  const customLines = (metadataForm.value.customYamlText || '')
    .split(/\r?\n/)
    .filter(l => l.trim().length > 0);
    
  const lines = ['---'];
  if (metadataForm.value.title) lines.push(`title: "${metadataForm.value.title.replace(/"/g, '\\"')}"`);
  if (metadataForm.value.subtitle) lines.push(`subtitle: "${metadataForm.value.subtitle.replace(/"/g, '\\"')}"`);
  if (metadataForm.value.author) lines.push(`author: "${metadataForm.value.author.replace(/"/g, '\\"')}"`);
  if (metadataForm.value.date) lines.push(`date: "${metadataForm.value.date.replace(/"/g, '\\"')}"`);
  if (metadataForm.value.lang) lines.push(`lang: "${metadataForm.value.lang}"`);
  if (metadataForm.value.toc) {
    lines.push(`toc: true`);
    if (metadataForm.value.tocTitle) lines.push(`toc-title: "${metadataForm.value.tocTitle.replace(/"/g, '\\"')}"`);
  }
  if (metadataForm.value.abstract) lines.push(`abstract: "${metadataForm.value.abstract.replace(/"/g, '\\"')}"`);
  if (metadataForm.value.keywords) lines.push(`keywords: "${metadataForm.value.keywords.replace(/"/g, '\\"')}"`);
  
  if (customLines.length > 0) {
    customLines.forEach(l => lines.push(l));
  }
  
  lines.push('---');
  const yamlHeaderStr = lines.join('\n');
  
  const parsed = parseYamlHeader(store.templateText || '');
  const newText = yamlHeaderStr + '\n\n' + parsed.body.trimStart();
  
  store.templateText = newText;
  editorText.value = newText;
  syncCodeToVisual();
  
  isMetadataModalOpen.value = false;
  store.addLog("Bloc de metadades Pandoc actualitzat a la plantilla.", "success");
};

// Initialize canvas on mount
const handleGlobalKeyDown = (e) => {
  const isAnyModalOpen = isVarModalOpen.value || isBlockModalOpen.value || isMathModalOpen.value || isTableModalOpen.value || isMetadataModalOpen.value;
  if (!isAnyModalOpen) return;
  
  if (e.key === 'Escape') {
    e.preventDefault();
    isVarModalOpen.value = false;
    isBlockModalOpen.value = false;
    isMathModalOpen.value = false;
    isTableModalOpen.value = false;
    isMetadataModalOpen.value = false;
  } else if (e.key === 'Enter') {
    if (isVarModalOpen.value) {
      e.preventDefault();
      applyVariable();
    } else if (isBlockModalOpen.value) {
      e.preventDefault();
      applyBlock();
    } else if (isMathModalOpen.value) {
      e.preventDefault();
      applyMath();
    } else if (isTableModalOpen.value) {
      e.preventDefault();
      applyTableModal();
    } else if (isMetadataModalOpen.value && e.ctrlKey) {
      e.preventDefault();
      applyMetadataModal();
    }
  }
};

// Helper to get character offset inside contenteditable
const getCaretCharacterOffsetWithin = (element) => {
  let caretOffset = 0;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    if (element.contains(range.commonAncestorContainer)) {
      const preCaretRange = range.cloneRange();
      preCaretRange.selectNodeContents(element);
      preCaretRange.setEnd(range.endContainer, range.endOffset);
      caretOffset = preCaretRange.toString().length;
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

const saveCaretState = () => {
  const pName = store.currentProjectName || localStorage.getItem('currentProjectName') || 'Default';
  const dName = store.activeDocName || localStorage.getItem(`${pName}:activeDocName`) || 'Document Principal';
  
  if (activeEditorTab.value === 'code' && textareaRef.value) {
    const pos = textareaRef.value.selectionStart || 0;
    localStorage.setItem(`${pName}:doc:${dName}:caretCode`, pos);
  } else if (activeEditorTab.value === 'visual' && canvasRef.value) {
    const pos = getCaretCharacterOffsetWithin(canvasRef.value);
    if (pos > 0) {
      localStorage.setItem(`${pName}:doc:${dName}:caretVisual`, pos);
    }
  }
  localStorage.setItem(`${pName}:doc:${dName}:activeEditorTab`, activeEditorTab.value);
};

const restoreCaretState = () => {
  const pName = store.currentProjectName || localStorage.getItem('currentProjectName') || 'Default';
  const dName = store.activeDocName || localStorage.getItem(`${pName}:activeDocName`) || 'Document Principal';
  
  const savedTab = localStorage.getItem(`${pName}:doc:${dName}:activeEditorTab`);
  if (savedTab && (savedTab === 'visual' || savedTab === 'code')) {
    activeEditorTab.value = savedTab;
  }

  nextTick(() => {
    if (activeEditorTab.value === 'code' && textareaRef.value) {
      const savedCodePos = parseInt(localStorage.getItem(`${pName}:doc:${dName}:caretCode`) || '0', 10);
      if (savedCodePos > 0) {
        textareaRef.value.focus();
        textareaRef.value.setSelectionRange(savedCodePos, savedCodePos);
      }
    } else if (activeEditorTab.value === 'visual' && canvasRef.value) {
      const savedVisualPos = parseInt(localStorage.getItem(`${pName}:doc:${dName}:caretVisual`) || '0', 10);
      if (savedVisualPos > 0) {
        setCaretCharacterOffsetWithin(canvasRef.value, savedVisualPos);
      }
    }
  });
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
    emitGenerate: () => emitGenerate(),
    getActiveTab: () => activeEditorTab.value,
  };
  syncCodeToVisual();
  window.addEventListener('keydown', handleGlobalKeyDown);
  document.addEventListener('selectionchange', () => {
    saveSelection();
    saveCaretState();
    updateActiveLoopContext();
  });
  restoreCaretState();
  updateActiveLoopContext();
});

onUnmounted(() => {
  delete window.__openPandocMetadataModal;
  window.removeEventListener('keydown', handleGlobalKeyDown);
  document.removeEventListener('selectionchange', saveSelection);
});
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 0.5rem; height: 100%; max-height: 100%; min-height: 0; flex: 1;">
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
          @blur="saveSelection"
          @click="onCanvasClick"
          @mouseup="onCanvasMouseUp"
          @focus="onCanvasFocus"
        ></div>

        <!-- Code Raw Editor Textarea -->
        <textarea 
          v-show="activeEditorTab === 'code'"
          ref="textareaRef"
          class="editor-textarea" 
          v-model="editorText" 
          placeholder="Escriu o edita la teva plantilla Jinja2 en Markdown aquí..."
          @click="updateActiveLoopContext"
          @keyup="updateActiveLoopContext"
          @keydown="updateActiveLoopContext"
          @select="updateActiveLoopContext"
          @focus="updateActiveLoopContext"
          @input="updateActiveLoopContext"
        ></textarea>
      </div>

      <!-- Variable Clipboard Helper (Sidebar) -->
      <div class="variables-sidebar">
      <div class="variables-title">Esquema de Dades</div>
      
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
      <div class="modal-content" style="max-width: 400px;">
        <div class="modal-header">
          <h3 style="border: none; padding-bottom: 0; margin: 0;">{{ modalTitle }}</h3>
          <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem;" @click="isVarModalOpen = false">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label>Ruta de la Variable</label>
            <input type="text" v-model="modalExpr" placeholder="meta.expedient" style="font-family: monospace;">
          </div>
          <div class="form-row">
            <label>Filtre Jinja2 (Opcional)</label>
            <input type="text" v-model="modalFilter" placeholder="upper, lower, length, default('N/A')">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" style="width: auto;" @click="isVarModalOpen = false">Cancel·lar</button>
          <button class="btn btn-primary" style="width: auto;" @click="applyVariable">Aplicar</button>
        </div>
      </div>
    </div>

    <!-- 2. Logic Block Configuration Modal -->
    <div class="modal-overlay" :style="{ display: isBlockModalOpen ? 'flex' : 'none' }">
      <div class="modal-content" style="max-width: 750px; width: 95%;">
        <div class="modal-header">
          <h3 style="border: none; padding-bottom: 0; margin: 0;">{{ modalTitle }}</h3>
          <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem;" @click="isBlockModalOpen = false">&times;</button>
        </div>
        
        <div class="modal-body" style="display: grid; grid-template-columns: 1fr 280px; gap: 1.5rem; align-items: start;">
          <!-- Left Panel: Input controls -->
          <div style="display: flex; flex-direction: column; gap: 1rem;">
            <!-- IF / ELIF expression -->
            <div v-if="blockType !== 'for'" class="form-row">
              <label for="blockExprInput">Expressió de la Condició (Jinja2)</label>
              <input 
                type="text" 
                ref="blockExprInputRef"
                id="blockExprInput" 
                v-model="modalExpr" 
                placeholder="economia.pressupost_total > 50000" 
                style="font-family: monospace;"
              >
              <span style="font-size:0.7rem; color:var(--text-muted); margin-top:0.25rem;">
                Escriviu la condició lògica. Podeu fer clic a les variables del navegador lateral per anar-les inserint on estigui el cursor.
              </span>
            </div>
            
            <!-- FOR parameters -->
            <div v-else style="display: flex; flex-direction: column; gap: 1rem;">
              <div class="form-row">
                <label>Nom de la variable d'element (Iterador)</label>
                <input type="text" v-model="forItemVar" placeholder="item" style="font-family: monospace;">
              </div>
              <div class="form-row">
                <label>Array / Llista d'Excel a recórrer</label>
                <input type="text" v-model="forArrayVar" placeholder="lots" style="font-family: monospace;">
              </div>
              
              <div style="background-color: var(--bg-tertiary); padding: 0.75rem; border-radius: 4px; border: 1px solid var(--border-color);">
                <span style="font-size: 0.75rem; font-weight: bold; color: var(--text-secondary); text-transform: uppercase;">Vista prèvia del tag Jinja2</span>
                <pre style="margin-top: 0.25rem; font-family: var(--font-mono); font-size: 0.8rem; color: var(--color-primary);">{% for {{ forItemVar }} in {{ forArrayVar || '...' }} %}</pre>
              </div>
            </div>
          </div>
          
          <!-- Right Panel: Data Browser -->
          <div style="border-left: 1px solid var(--border-color); padding-left: 1.25rem;">
            <div style="font-size: 0.8rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 0.5rem; letter-spacing: 0.05em;">
              Navegador de Dades
            </div>
            
            <div v-if="!store.excelJsonData" style="font-size:0.75rem; color:var(--text-muted); font-style:italic">
              Carrega un Excel per activar el navegador.
            </div>
            
            <!-- Variable List for IF/ELIF -->
            <div v-else-if="blockType !== 'for'" style="max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 0.4rem; padding-right: 2px;">
              <div 
                v-for="v in availableVariables" 
                :key="v.path" 
                class="variable-item present" 
                :style="v.isContext ? 'margin: 0; font-size: 0.75rem; padding: 4px 6px; background-color: var(--color-success-light); border-left: 3px solid var(--color-success); justify-content: space-between;' : (v.category === 'array' || v.category === 'arrayExpr' ? 'margin: 0; font-size: 0.75rem; padding: 4px 6px; background-color: var(--color-primary-light); justify-content: space-between;' : 'margin: 0; font-size: 0.75rem; padding: 4px 6px; justify-content: space-between;')"
                @click="insertVarIntoIfExpr(v.path)"
                title="Clica per afegir a l'expressió"
              >
                <span style="font-weight: 600;">{{ v.path }}</span>
                <span style="font-size: 0.6rem; font-weight: 600;" :style="{ color: v.isContext ? 'var(--color-success-dark)' : (v.category === 'array' || v.category === 'arrayExpr' ? 'var(--color-primary-dark)' : 'var(--text-muted)') }">
                  {{ v.isContext ? 'bucle' : (v.category === 'array' ? 'llista' : (v.category === 'arrayExpr' ? 'recompte' : (v.category === 'arrayItem' ? 'element' : 'clau'))) }}
                </span>
              </div>
            </div>
            
            <!-- Array List for FOR -->
            <div v-else style="max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 0.4rem; padding-right: 2px;">
              <div 
                v-for="arr in availableArrays" 
                :key="arr" 
                class="variable-item present" 
                style="margin: 0; font-size: 0.75rem; padding: 4px 6px; background-color: var(--color-primary-light); justify-content: space-between;"
                @click="selectArrayForLoop(arr)"
                title="Clica per seleccionar com a array a recórrer"
              >
                <span style="font-weight: 600;">{{ arr }}</span>
                <span class="variable-badge present" style="background-color: var(--color-primary); color: white;">Array</span>
              </div>
              <div v-if="availableArrays.length === 0" style="font-size: 0.75rem; color: var(--text-muted); font-style: italic;">
                No s'ha detectat cap llista (array) al full de dades.
              </div>
            </div>
          </div>
        </div>
        
        <div class="modal-footer">
          <button class="btn btn-secondary" style="width: auto;" @click="isBlockModalOpen = false">Cancel·lar</button>
          <button class="btn btn-primary" style="width: auto;" @click="applyBlock">Aplicar</button>
        </div>
      </div>
    </div>

    <!-- 3. Math Equation Configuration Modal -->
    <div class="modal-overlay" :style="{ display: isMathModalOpen ? 'flex' : 'none' }">
      <div class="modal-content" style="max-width: 1200px; width: 98%;">
        <div class="modal-header">
          <h3 style="border: none; padding-bottom: 0; margin: 0;">Editor d'Equacions LaTeX</h3>
          <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem;" @click="isMathModalOpen = false">&times;</button>
        </div>
        
        <div class="modal-body" style="display: grid; grid-template-columns: 200px 1fr 280px; gap: 1.5rem; height: 500px; max-height: 70vh;">
          <!-- Left side: Categories list -->
          <div style="border-right: 1px solid var(--border-color); padding-right: 1rem; display: flex; flex-direction: column; gap: 0.5rem; overflow-y: auto;">
            <button 
              v-for="cat in latexSymbols.categorias" 
              :key="cat.id"
              class="btn"
              :class="activeMathCategory === cat.id ? 'btn-primary' : 'btn-secondary'"
              style="width: 100%; text-align: left; padding: 8px 12px; font-size: 0.85rem;"
              @click="activeMathCategory = cat.id"
            >
              {{ getCategoryNameInCatalan(cat.nombre) }}
            </button>
          </div>
          
          <!-- Middle side: Symbols Grid and Input/Preview -->
          <div style="display: flex; flex-direction: column; gap: 1.25rem; overflow-y: auto; padding-right: 0.5rem;">
            <!-- Symbols Grid -->
            <div style="background-color: var(--bg-tertiary); padding: 1rem; border-radius: 6px; border: 1px solid var(--border-color); flex-grow: 1; overflow-y: auto;">
              <div 
                v-for="cat in latexSymbols.categorias" 
                :key="cat.id" 
                v-show="activeMathCategory === cat.id"
                style="display: grid; grid-template-columns: repeat(auto-fill, minmax(70px, 1fr)); gap: 8px;"
              >
                <button 
                  v-for="(el, idx) in cat.elementos" 
                  :key="idx"
                  class="btn btn-secondary"
                  style="height: 50px; padding: 4px; display: flex; align-items: center; justify-content: center; overflow: hidden; background: white;"
                  :title="el.title"
                  @click="insertLatexAtCursor(el.latex)"
                >
                  <span v-html="renderSymbolHtml(el)" style="font-size: 1.15rem; color: #1e293b;"></span>
                </button>
              </div>
            </div>
            
            <!-- Real-time Preview Box -->
            <div style="border: 1px solid var(--border-color); border-radius: 6px; padding: 1rem; background-color: var(--bg-card); display: flex; align-items: center; justify-content: center; min-height: 80px; box-shadow: inset 0 1px 3px rgba(0,0,0,0.05);">
              <div v-html="currentMathPreview" style="font-size: 1.25rem;"></div>
            </div>
            
            <!-- Input control -->
            <div style="display: grid; grid-template-columns: 1fr 240px; gap: 1rem; align-items: end;">
              <div class="form-row" style="margin: 0;">
                <label for="mathExprInput">Expressió LaTeX</label>
                <input 
                  type="text" 
                  id="mathExprInput" 
                  v-model="mathExpr" 
                  placeholder="e = mc^2" 
                  style="font-family: monospace; font-size: 1.05rem; padding: 8px;"
                  @blur="saveMathCaret"
                  @keyup="saveMathCaret"
                  @click="saveMathCaret"
                  @focus="saveMathCaret"
                >
              </div>
              
              <div class="form-row" style="margin: 0;">
                <label for="mathTypeSelect">Tipus de Fórmula</label>
                <select 
                  id="mathTypeSelect" 
                  v-model="mathType" 
                  style="padding: 6px; border: 1px solid var(--border-color); border-radius: 4px; height: 42px; font-size: 0.9rem;"
                >
                  <option value="inline">En línia ($ ... $)</option>
                  <option value="display">Independent / Bloc ($$ ... $$)</option>
                </select>
              </div>
            </div>
          </div>

          <!-- Right side: Data Browser (Grouped, contextual tree matching main sidebar) -->
          <div style="border-left: 1px solid var(--border-color); padding-left: 1.25rem; display: flex; flex-direction: column; gap: 0.5rem; overflow-y: auto;">
            <div style="font-size: 0.8rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 0.5rem; letter-spacing: 0.05em;">
              Navegador de Dades
            </div>
            
            <!-- Contextual loop variables banner in equation modal -->
            <div v-if="activeLoopContext" style="background-color: var(--color-primary-light); padding: 0.5rem; border-radius: var(--radius-sm); border: 1px solid var(--border-focus); margin-bottom: 0.5rem; display: flex; flex-direction: column; gap: 0.35rem;">
              <div style="font-size: 0.65rem; font-weight: bold; color: var(--color-primary); text-transform: uppercase;">
                📌 Dins del bucle actiu:
              </div>
              <code style="font-family: var(--font-mono); font-size: 0.7rem; font-weight: bold; color: var(--text-primary);">
                for {{ activeLoopContext.iterator }} in {{ activeLoopContext.arrayPath }}
              </code>
              <div style="display:flex; flex-direction:column; gap:0.3rem; margin-top:0.15rem;">
                <div 
                  v-for="col in activeLoopContext.columns" 
                  :key="col"
                  class="variable-item present"
                  style="background-color: var(--bg-card); margin: 0; font-size: 0.75rem; padding: 4px 6px; justify-content: space-between;"
                  @click="insertVarIntoMathExpr(`${activeLoopContext.iterator}.${col}`)"
                  title="Insereix variable contextual del bucle"
                >
                  <span style="font-weight: 600;">{{ activeLoopContext.iterator }}.{{ col }}</span>
                  <span class="variable-badge present" style="background-color: var(--color-primary); color: white;">bucle</span>
                </div>
              </div>
            </div>

            <div v-if="!store.excelJsonData" style="font-size:0.75rem; color:var(--text-muted); font-style:italic">
              Carrega un Excel per activar el navegador.
            </div>
            <div v-else style="display:flex; flex-direction:column; gap:0.6rem;">
              <div v-for="(item, rootKey) in store.excelJsonData" :key="rootKey" style="margin-bottom:0.25rem;">
                <div style="font-size: 0.75rem; font-weight: 700; color: var(--text-secondary); margin-bottom: 0.25rem; border-bottom: 1px solid var(--border-color); padding-bottom: 2px;">
                  {{ rootKey }}
                </div>
                
                <template v-if="Array.isArray(item)">
                  <template v-if="item.length > 0">
                    <div 
                      v-for="subKey in Object.keys(item[0])" 
                      v-show="subKey !== rootKey"
                      :key="subKey" 
                      class="variable-item present"
                      style="margin: 0; font-size: 0.75rem; padding: 4px 6px; justify-content: space-between;"
                      @click="insertVarIntoMathExpr(`${rootKey}.${subKey}`)"
                      title="Clica per inserir variable"
                    >
                      <span>{{ subKey }}</span>
                      <span class="variable-badge present">Columna</span>
                    </div>
                  </template>
                </template>
                
                <template v-else>
                  <div 
                    v-for="(val, k) in item" 
                    :key="k" 
                    class="variable-item present"
                    style="margin: 0; font-size: 0.75rem; padding: 4px 6px; justify-content: space-between;"
                    @click="insertVarIntoMathExpr(`${rootKey}.${k}`)"
                    title="Clica per inserir variable"
                  >
                    <span>{{ k }}</span>
                    <span class="variable-badge present">Clau</span>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>
        
        <div class="modal-footer">
          <button class="btn btn-secondary" style="width: auto;" @click="isMathModalOpen = false">Cancel·lar</button>
          <button class="btn btn-primary" style="width: auto;" @click="applyMath">Aplicar</button>
        </div>
      </div>
    </div>

    <!-- 4. Table Configuration Modal -->
    <div class="modal-overlay" :style="{ display: isTableModalOpen ? 'flex' : 'none' }">
      <div class="modal-content" style="max-width: 650px; width: 95%;">
        <div class="modal-header">
          <h3 style="border: none; padding-bottom: 0; margin: 0;">{{ activeEditTableNode ? 'Configurar / Modificar Taula' : 'Inserir Nova Taula' }}</h3>
          <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem;" @click="isTableModalOpen = false">&times;</button>
        </div>
        
        <div class="modal-body" style="display: flex; flex-direction: column; gap: 1rem;">
          <!-- Mode Selector (Tabs style) -->
          <div style="display: flex; gap: 8px; border-bottom: 1px solid var(--border-color); padding-bottom: 6px;">
            <button 
              class="btn-secondary" 
              style="width: auto; padding: 0.35rem 0.7rem; font-size: 0.75rem; border: 1px solid var(--border-color);"
              :class="{ 'btn-primary': tableMode === 'dynamic' }"
              @click="tableMode = 'dynamic'"
            >
              📊 Dinàmica (Fila iterable)
            </button>
            <button 
              class="btn-secondary" 
              style="width: auto; padding: 0.35rem 0.7rem; font-size: 0.75rem; border: 1px solid var(--border-color);"
              :class="{ 'btn-primary': tableMode === 'transposed' }"
              @click="tableMode = 'transposed'"
            >
              🔄 Transposada (Columna iterable)
            </button>
            <button 
              class="btn-secondary" 
              style="width: auto; padding: 0.35rem 0.7rem; font-size: 0.75rem; border: 1px solid var(--border-color);"
              :class="{ 'btn-primary': tableMode === 'manual' }"
              @click="tableMode = 'manual'"
            >
              ✏️ Manual (Files i Columnes)
            </button>
          </div>
          
          <!-- Mode 1: Dynamic & Mode 2: Transposed controls -->
          <div v-if="tableMode === 'dynamic' || tableMode === 'transposed'" style="display: flex; flex-direction: column; gap: 0.75rem;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
              <div class="form-row">
                <label>Llista/Array d'Excel per a la taula</label>
                <select v-model="selectedArray" @change="onArraySelected" style="padding: 6px; border: 1px solid var(--border-color); border-radius:4px;">
                  <option value="">Selecciona una taula...</option>
                  <option v-for="arr in availableArrays" :key="arr" :value="arr">{{ arr }}</option>
                </select>
              </div>
              <div class="form-row">
                <label>Nom de la variable iteradora</label>
                <input type="text" v-model="iteratorVar" placeholder="item" style="font-family: monospace;">
              </div>
            </div>
            
            <!-- Specific Transposed Header Selection -->
            <div v-if="tableMode === 'transposed'" class="form-row">
              <label>Camp de la capçalera de columna (es repetirà per columna)</label>
              <select v-model="selectedColHeaderKey" style="padding: 6px; border: 1px solid var(--border-color); border-radius:4px;">
                <option v-for="c in tableColumns" :key="c.key" :value="c.key">{{ c.key }}</option>
              </select>
            </div>
            
            <!-- Column Fields List -->
            <div v-if="selectedArray" style="border: 1px solid var(--border-color); border-radius: 4px; padding: 0.75rem; background-color: var(--bg-tertiary);">
              <span style="font-size: 0.8rem; font-weight: bold; color: var(--text-secondary); display: block; margin-bottom: 0.5rem;">
                {{ tableMode === 'dynamic' ? 'Selecciona les columnes i alineació' : 'Selecciona les files dades' }}
              </span>
              
              <div style="display: flex; flex-direction: column; gap: 0.5rem; max-height: 200px; overflow-y: auto; padding-right: 4px;">
                <!-- Header grid layout -->
                <div style="display: grid; grid-template-columns: 30px 140px 180px 120px; gap: 8px; font-size: 0.7rem; font-weight:bold; text-transform:uppercase; color: var(--text-muted); border-bottom: 1px solid var(--border-color); padding-bottom: 4px; margin-bottom: 4px;">
                  <span>Usa</span>
                  <span>Clau Original</span>
                  <span>Títol Capçalera</span>
                  <span>Alineació</span>
                </div>
                
                <div 
                  v-for="c in tableColumns" 
                  :key="c.key"
                  v-show="tableMode === 'dynamic' || c.key !== selectedColHeaderKey"
                  style="display: grid; grid-template-columns: 30px 140px 180px 120px; gap: 8px; align-items: center;"
                >
                  <input type="checkbox" v-model="c.selected">
                  <span style="font-family: monospace; font-size: 0.8rem; font-weight: 600; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">{{ c.key }}</span>
                  <input type="text" v-model="c.header" placeholder="Capçalera" style="padding: 4px; font-size: 0.75rem;">
                  <select v-model="c.align" style="padding: 4px; font-size: 0.75rem;">
                    <option value="left">Esquerra (abc)</option>
                    <option value="center">Centre (1-1)</option>
                    <option value="right">Dreta (123)</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
          
          <!-- Mode 3: Manual controls -->
          <div v-else style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
            <div class="form-row">
              <label>Número de files (incloent capçalera)</label>
              <input type="number" v-model="manualRows" min="1" max="100">
            </div>
            <div class="form-row">
              <label>Número de columnes</label>
              <input type="number" v-model="manualCols" min="1" max="50">
            </div>
          </div>
        </div>
        
        <div class="modal-footer">
          <button class="btn btn-secondary" style="width: auto;" @click="isTableModalOpen = false">Cancel·lar</button>
          <button class="btn btn-primary" style="width: auto;" @click="applyTableModal">Aplicar</button>
        </div>
      </div>
    </div>

    <!-- Pandoc Metadata Modal -->
    <div class="modal-overlay" v-if="isMetadataModalOpen" style="display: flex; z-index: 1060;">
      <div class="modal-content" style="max-width: 650px; width: 90%; max-height: 85vh; display: flex; flex-direction: column;">
        <div class="modal-header">
          <h3 style="border: none; padding-bottom: 0; margin: 0; display: flex; align-items: center; gap: 0.5rem;">
            🏷️ Configurar Metadades Pandoc (YAML)
          </h3>
          <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="isMetadataModalOpen = false">&times;</button>
        </div>
        
        <div class="modal-body" style="flex-grow: 1; overflow-y: auto; padding: 1rem 0; display: flex; flex-direction: column; gap: 1rem;">
          <p style="margin: 0; font-size: 0.85rem; color: var(--text-secondary); line-height: 1.4;">
            Pandoc utilitza aquestes metadades YAML al principi del document per generar automàticament la portada, l'autor, la data, l'índex i l'estructura del document Word final.
          </p>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
            <div class="form-row" style="grid-column: span 2;">
              <label style="font-weight: 600; font-size: 0.8rem;">Títol Principal del Document (title)</label>
              <input type="text" v-model="metadataForm.title" placeholder="ex: Memòria Justificativa de la Licitació">
            </div>

            <div class="form-row">
              <label style="font-weight: 600; font-size: 0.8rem;">Subtítol (subtitle)</label>
              <input type="text" v-model="metadataForm.subtitle" placeholder="ex: Contracte de Serveis Informàtics">
            </div>

            <div class="form-row">
              <label style="font-weight: 600; font-size: 0.8rem;">Autor / Organisme (author)</label>
              <input type="text" v-model="metadataForm.author" placeholder="ex: Òrgan de Contractació">
            </div>

            <div class="form-row">
              <label style="font-weight: 600; font-size: 0.8rem;">Data del Document (date)</label>
              <input type="text" v-model="metadataForm.date" placeholder="ex: 31 de juliol de 2026">
            </div>

            <div class="form-row">
              <label style="font-weight: 600; font-size: 0.8rem;">Idioma Principal (lang)</label>
              <select v-model="metadataForm.lang">
                <option value="ca">Català (ca)</option>
                <option value="es">Castellà (es)</option>
                <option value="en">Anglès (en)</option>
                <option value="fr">Francès (fr)</option>
                <option value="de">Alemany (de)</option>
              </select>
            </div>
          </div>

          <!-- Table of Contents configuration -->
          <div style="border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 0.75rem; background: var(--bg-tertiary); display: flex; flex-direction: column; gap: 0.5rem;">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <input type="checkbox" id="chkToc" v-model="metadataForm.toc">
              <label for="chkToc" style="display: inline; margin: 0; font-weight: 600; font-size: 0.85rem; cursor: pointer;">
                📑 Genera automàticament l'Índex de Continguts (toc: true)
              </label>
            </div>
            
            <div v-if="metadataForm.toc" class="form-row" style="margin-top: 0.4rem;">
              <label style="font-weight: 600; font-size: 0.8rem;">Títol de l'Índex (toc-title)</label>
              <input type="text" v-model="metadataForm.tocTitle" placeholder="ex: Índex de continguts">
            </div>
          </div>

          <div class="form-row">
            <label style="font-weight: 600; font-size: 0.8rem;">Resum del Document / Introducció (abstract)</label>
            <textarea v-model="metadataForm.abstract" rows="2" placeholder="Resum executiu del tràmit o objecte de la contractació..."></textarea>
          </div>

          <div class="form-row">
            <label style="font-weight: 600; font-size: 0.8rem;">Paraules Clau (keywords)</label>
            <input type="text" v-model="metadataForm.keywords" placeholder="ex: contractació, licitació, plec de clàusules">
          </div>

          <!-- Advanced Custom YAML -->
          <div style="border-top: 1px dashed var(--border-color); padding-top: 0.5rem;">
            <label style="font-weight: 600; font-size: 0.8rem; color: var(--text-secondary); display: block; margin-bottom: 0.25rem;">
              ⚙️ Línies YAML Addicionals Personalitzades (opcional)
            </label>
            <textarea v-model="metadataForm.customYamlText" rows="3" style="font-family: var(--font-mono); font-size: 0.75rem;" placeholder="geometry: margin=2.5cm&#10;fontsize: 11pt"></textarea>
          </div>
        </div>

        <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 0.5rem; padding-top: 0.75rem; border-top: 1px solid var(--border-color); margin-top: 0.5rem;">
          <button class="btn btn-secondary" style="width: auto;" @click="isMetadataModalOpen = false">Cancel·lar</button>
          <button class="btn btn-primary" style="width: auto;" @click="applyMetadataModal">Aplicar Metadades a la Plantilla</button>
        </div>
      </div>
    </div>

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
  margin: 0.8rem 0 0.5rem 0;
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

th[data-jinja-col-loop]::before, td[data-jinja-col-loop]::before {
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
