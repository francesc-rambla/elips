<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import VisualGridEditorModal from './VisualGridEditorModal.vue';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  groupName: { type: String, default: '' },
  configList: { type: Array, default: () => [] },
  groupLabel: { type: String, default: '' },
  selectedLayout: { type: String, default: 'vertical' }
});

const emit = defineEmits(['update:modelValue', 'save', 'copyGroup', 'pasteGroup']);

const store = useWorkspaceStore();

const localGroupLabel = ref('');
const localSelectedLayout = ref('vertical');
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
    localConfigList.value = (props.configList || []).map(item => {
      let fn = item.calcFn || 'SUM';
      if (fn === 'CUSTOM') fn = 'FORMULA';
      if (fn === 'AVG') fn = 'AVERAGE';
      return {
        ...item,
        calcFn: fn,
        calcFormula: item.calcFormula || ''
      };
    });
  }
});

const closeModal = () => {
  emit('update:modelValue', false);
};

const handleSave = () => {
  const cleanedList = localConfigList.value.map(item => {
    const copy = { ...item };
    if (copy.type === 'Computed') {
      if (copy.calcFn === 'FORMULA') {
        copy.calcFn = 'CUSTOM';
      } else if (copy.calcFn === 'AVERAGE') {
        copy.calcFn = 'AVG';
      }
    }
    return copy;
  });

  emit('save', {
    groupLabel: localGroupLabel.value,
    selectedLayout: localSelectedLayout.value,
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

const openFormulaEditor = (item) => {
  editingFormulaItem.value = item;
  formulaTextBuffer.value = item.calcFormula || '';
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
</script>

<template>
  <div>
    <!-- Main Unified Group Configuration Modal -->
    <div class="modal-overlay" v-if="modelValue" style="display: flex; z-index: 1080;">
      <div class="modal-content" style="max-width: 880px; width: 95%; max-height: 85vh; display: flex; flex-direction: column;">
        
        <!-- Modal Header -->
        <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem;">
          <h3 style="margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            <span>Configuració del grup / formulari: <strong style="color: var(--color-primary);">{{ groupName }}</strong></span>
          </h3>
          <button type="button" class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="closeModal">&times;</button>
        </div>

        <!-- Modal Body -->
        <div class="modal-body" style="flex-grow: 1; overflow-y: auto; padding: 0.75rem 0;">
          
          <!-- Top Control Header: Label Input + Action Buttons (Nova Clau, Editor Visual Grid) -->
          <div style="background: var(--bg-card); padding: 10px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
            <!-- Left: Group Label Input -->
            <div style="display: flex; align-items: center; gap: 8px; flex: 1 1 260px; min-width: 240px;">
              <span style="font-size: 0.85rem; font-weight: 600; color: var(--text-primary); white-space: nowrap;">Etiqueta formulari:</span>
              <input 
                type="text" 
                v-model="localGroupLabel" 
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
          <div style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-secondary); padding: 8px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); margin-bottom: 0.75rem; flex-wrap: wrap; gap: 8px;">
            <span style="font-size: 0.82rem; font-weight: 600; color: var(--text-primary);">Disposició visual dels camps de formulari:</span>
            <div style="display: flex; gap: 16px;">
              <label style="display: flex; align-items: center; gap: 6px; font-size: 0.78rem; font-weight: 600; cursor: pointer; color: var(--text-primary);">
                <input type="radio" value="vertical" v-model="localSelectedLayout" style="cursor: pointer;" />
                <span>Vertical (Taula Clau-Valor 2-Columnes - Per defecte)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 6px; font-size: 0.78rem; font-weight: 600; cursor: pointer; color: var(--text-primary);">
                <input type="radio" value="horizontal" v-model="localSelectedLayout" style="cursor: pointer;" />
                <span>Horitzontal (Graella / Grid)</span>
              </label>
            </div>
          </div>

          <!-- Configuration Fields Table -->
          <table class="inspector-table" style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background: var(--bg-tertiary);">
                <th style="padding: 8px; text-align: left; width: 140px;">Element / Camp</th>
                <th style="padding: 8px; text-align: left;">Etiqueta formulari</th>
                <th style="padding: 8px; text-align: left; width: 125px;">Tipus Dada</th>
                <th style="padding: 8px; text-align: left;">Configuració / Propietats</th>
                <th style="padding: 8px; text-align: center; width: 160px;">Posició Grid</th>
                <th style="padding: 8px; text-align: center; width: 40px;"></th>
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
                    style="width: 100%; font-size: 0.8rem; height: 28px;"
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

                <!-- Dynamic Type Configuration Properties -->
                <td style="padding: 6px 8px; vertical-align: top;">
                  <!-- Select Config -->
                  <template v-if="item.type === 'Select'">
                    <div style="display: flex; flex-direction: column; gap: 4px;">
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

                  <!-- Computed Config -->
                  <template v-else-if="item.type === 'Computed'">
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                      <div style="display: flex; gap: 4px; align-items: center;">
                        <select v-model="item.calcFn" class="data-input" style="width: 100%; height: 26px; font-size: 0.75rem;">
                          <option value="SUM">SUMA (Sub-taula)</option>
                          <option value="AVERAGE">MITJANA (Sub-taula)</option>
                          <option value="COUNT">RECOMPTE (Sub-taula)</option>
                          <option value="MIN">MÍNIM (Sub-taula)</option>
                          <option value="MAX">MÀXIM (Sub-taula)</option>
                          <option value="FORMULA">FÓRMULA PERSONALITZADA</option>
                        </select>
                      </div>

                      <!-- If FORMULA or CUSTOM: show formula text input AND ampliada button! -->
                      <template v-if="item.calcFn === 'FORMULA' || item.calcFn === 'CUSTOM'">
                        <div style="display: flex; gap: 4px; align-items: center; margin-top: 2px;">
                          <input 
                            type="text" 
                            v-model="item.calcFormula" 
                            class="data-input" 
                            placeholder="ex: preu * unitats o SI(unitats > 10; preu * 0.9; preu)"
                            style="flex: 1; font-size: 0.75rem; height: 26px; font-family: var(--font-mono);"
                            title="Fórmula personalitzada d'operació"
                          />
                          <button 
                            type="button" 
                            class="btn btn-secondary" 
                            style="height: 26px; font-size: 0.72rem; padding: 2px 6px; width: auto; display: inline-flex; align-items: center; gap: 3px; white-space: nowrap;"
                            @click="openFormulaEditor(item)"
                            title="Obre l'editor ampliat de fórmules"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                            <span>Amplia</span>
                          </button>
                        </div>
                        <span style="font-size: 0.68rem; color: var(--text-muted);">
                          Operadors: +, -, *, /, %, ^ | Condició: SI(condició; cert; fals)
                        </span>
                      </template>

                      <template v-else>
                        <select v-model="item.calcVector" class="data-input" style="width: 100%; font-size: 0.75rem; height: 26px;">
                          <option value="">-- Sub-taula --</option>
                          <option v-for="tbl in getAvailableTables()" :key="tbl" :value="tbl">{{ tbl }}</option>
                        </select>

                        <select v-if="item.calcFn !== 'COUNT' && item.calcVector" v-model="item.calcTargetCol" class="data-input" style="width: 100%; font-size: 0.75rem; height: 26px;">
                          <option value="">-- Columna --</option>
                          <option v-for="col in getChildTableColumns(item.calcVector)" :key="col" :value="col">{{ col }}</option>
                        </select>
                      </template>
                    </div>
                  </template>

                  <!-- Table Config -->
                  <template v-else-if="item.type === 'Table'">
                    <select v-model="item.vectorPath" class="data-input" style="width: 100%; font-size: 0.75rem; height: 26px;">
                      <option value="">-- Tria Taula / Matriu --</option>
                      <option v-for="tbl in getAvailableTables()" :key="tbl" :value="tbl">{{ tbl }}</option>
                    </select>
                  </template>

                  <template v-else>
                    <span style="color: var(--text-muted); font-size: 0.78rem;">Standard</span>
                  </template>
                </td>

                <!-- Grid Position Options -->
                <td style="padding: 6px 4px; vertical-align: top;">
                  <div style="display: flex; flex-direction: column; gap: 3px;">
                    <div style="display: flex; gap: 4px; align-items: center;">
                      <span style="font-size: 0.7rem; color: var(--text-muted); width: 32px;">Fila:</span>
                      <input type="number" min="1" v-model="item.gridRow" class="data-input" style="height: 22px; font-size: 0.7rem; width: 45px; padding: 1px 3px;" placeholder="Auto" />
                      <span style="font-size: 0.7rem; color: var(--text-muted); width: 35px;">Ordre:</span>
                      <input type="number" min="1" v-model="item.gridOrder" class="data-input" style="height: 22px; font-size: 0.7rem; width: 45px; padding: 1px 3px;" placeholder="Auto" />
                    </div>
                    <div style="display: flex; gap: 4px; align-items: center;">
                      <span style="font-size: 0.7rem; color: var(--text-muted); width: 32px;">Amp:</span>
                      <select v-model="item.width" class="data-input" style="height: 22px; font-size: 0.7rem; flex: 1; padding: 1px 3px;">
                        <option value="">Auto</option>
                        <option value="25%">25%</option>
                        <option value="33%">33%</option>
                        <option value="50%">50%</option>
                        <option value="66%">66%</option>
                        <option value="75%">75%</option>
                        <option value="100%">100%</option>
                      </select>
                      <label style="font-size: 0.68rem; color: var(--text-muted); display: flex; align-items: center; gap: 2px; cursor: pointer;">
                        <input type="checkbox" v-model="item.gridFill" style="width: 12px; height: 12px;" /> Omple
                      </label>
                    </div>
                  </div>
                </td>

                <!-- Delete Action -->
                <td style="padding: 6px 4px; vertical-align: top; text-align: center;">
                  <button 
                    type="button" 
                    class="btn-icon-only text-danger" 
                    style="border: none; background: transparent; font-size: 1.1rem; cursor: pointer;"
                    @click="removeFieldFromConfig(idx)"
                    title="Eliminar camp"
                  >
                    &times;
                  </button>
                </td>
              </tr>
            </tbody>
          </table>

        </div>
        
        <!-- Modal Footer -->
        <div class="modal-footer" style="margin-top: 0.75rem; border-top: 1px solid var(--border-color); padding-top: 0.75rem; display: flex; justify-content: space-between; align-items: center; gap: 8px;">
          <div style="display: flex; gap: 6px;">
            <button 
              type="button"
              class="btn btn-secondary" 
              style="width: auto; padding: 3px 8px; font-size: 0.72rem; display: inline-flex; align-items: center; gap: 4px;"
              @click="emit('copyGroup', groupName)"
              title="Copia la configuració d'aquest grup al portaretalls"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>Copia Grup</span>
            </button>
            <button 
              type="button"
              class="btn btn-secondary" 
              style="width: auto; padding: 3px 8px; font-size: 0.72rem; display: inline-flex; align-items: center; gap: 4px;"
              @click="emit('pasteGroup', groupName)"
              title="Enganxa la configuració del portaretalls sobre aquest grup"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
              <span>Enganxa Grup</span>
            </button>
          </div>

          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn btn-secondary" style="width: auto;" @click="closeModal">Cancel·la</button>
            <button type="button" class="btn btn-primary" style="width: auto;" @click="handleSave">Aplica</button>
          </div>
        </div>

      </div>
    </div>

    <!-- Integrated Reusable Visual Grid Layout Editor Modal -->
    <VisualGridEditorModal 
      v-model="isVisualGridModalOpen" 
      :groupName="groupName" 
      :configList="localConfigList" 
    />

    <!-- Integrated Formula Editor Modal -->
    <div class="modal-overlay" v-if="isFormulaModalOpen" style="display: flex; z-index: 1200;">
      <div class="modal-content" style="max-width: 650px; width: 90%; display: flex; flex-direction: column; gap: 12px;">
        <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem;">
          <h3 style="margin: 0; font-size: 1.05rem; display: flex; align-items: center; gap: 6px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
            <span>Editor de Fórmula: <strong style="color: var(--color-primary);">{{ editingFormulaItem?.element }}</strong></span>
          </h3>
          <button type="button" class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="isFormulaModalOpen = false">&times;</button>
        </div>

        <div class="modal-body" style="display: flex; flex-direction: column; gap: 10px;">
          <!-- Field Insert Badges -->
          <div v-if="availableFormulaFields.length > 0">
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

          <!-- Global Model Paths Badges -->
          <div v-if="globalFormulaPaths.length > 0">
            <span style="font-size: 0.75rem; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 4px;">Rutes globals del model de dades:</span>
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
          <textarea 
            ref="formulaTextareaRef"
            v-model="formulaTextBuffer" 
            class="data-input" 
            rows="5" 
            style="width: 100%; font-family: var(--font-mono); font-size: 0.85rem; padding: 8px; resize: vertical;"
            placeholder="ex: preu * unitats o SI(unitats > 10; preu * 0.9; preu)"
          ></textarea>
        </div>

        <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border-color); padding-top: 0.5rem;">
          <button type="button" class="btn btn-secondary" style="width: auto;" @click="isFormulaModalOpen = false">Cancel·la</button>
          <button type="button" class="btn btn-primary" style="width: auto;" @click="saveFormulaModal">Desa Fórmula</button>
        </div>
      </div>
    </div>
  </div>
</template>
