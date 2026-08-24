<script setup>
import { ref, computed, watch } from 'vue';
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

// Formula Modal State
const isFormulaModalOpen = ref(false);
const editingFormulaItem = ref(null);
const formulaTextBuffer = ref('');

watch(() => props.modelValue, (newVal) => {
  if (newVal) {
    localGroupLabel.value = props.groupLabel || '';
    localSelectedLayout.value = props.selectedLayout || 'vertical';
    localConfigList.value = JSON.parse(JSON.stringify(props.configList || []));
  }
});

const closeModal = () => {
  emit('update:modelValue', false);
};

const handleSave = () => {
  emit('save', {
    groupLabel: localGroupLabel.value,
    selectedLayout: localSelectedLayout.value,
    configList: localConfigList.value
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
  if (!store.excelJsonData) return [];
  return Object.keys(store.excelJsonData).filter(k => Array.isArray(store.excelJsonData[k]));
};

const getChildTableColumns = (vectorName) => {
  if (!vectorName || !store.excelJsonData || !Array.isArray(store.excelJsonData[vectorName])) return [];
  const list = store.excelJsonData[vectorName];
  if (list.length === 0) return [];
  const sample = list.find(item => item && typeof item === 'object') || list[0];
  if (!sample || typeof sample !== 'object') return ['valor'];
  return Object.keys(sample).filter(k => !k.startsWith('_'));
};

const openFormulaEditor = (item) => {
  editingFormulaItem.value = item;
  formulaTextBuffer.value = item.calcFormula || '';
  isFormulaModalOpen.value = true;
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
                        <select v-model="item.calcFn" class="data-input" style="width: 90px; height: 26px; font-size: 0.75rem;">
                          <option value="SUM">SUMA</option>
                          <option value="AVERAGE">MITJANA</option>
                          <option value="COUNT">RECOMPTE</option>
                          <option value="MIN">MÍNIM</option>
                          <option value="MAX">MÀXIM</option>
                          <option value="FORMULA">FÓRMULA</option>
                        </select>

                        <button 
                          v-if="item.calcFn === 'FORMULA'" 
                          type="button" 
                          class="btn btn-secondary" 
                          style="height: 26px; font-size: 0.72rem; padding: 2px 8px; width: auto;"
                          @click="openFormulaEditor(item)"
                        >
                          ✏️ Edita Fórmula
                        </button>
                      </div>

                      <template v-if="item.calcFn !== 'FORMULA'">
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
      <div class="modal-content" style="max-width: 600px; width: 90%;">
        <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem;">
          <h3 style="margin: 0; font-size: 1rem;">Editor de Fórmula Personalitzada</h3>
          <button type="button" class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="isFormulaModalOpen = false">&times;</button>
        </div>
        <div class="modal-body" style="padding: 1rem 0;">
          <textarea 
            v-model="formulaTextBuffer" 
            class="data-input" 
            rows="6" 
            style="width: 100%; font-family: monospace; font-size: 0.85rem;"
            placeholder="ex: sum(item.import for item in parts if item.actiu)"
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
