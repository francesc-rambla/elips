<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  groupName: { type: String, default: '' },
  configList: { type: Array, default: () => [] }
});

const emit = defineEmits(['update:modelValue', 'apply']);

const visualGridRows = ref([]);
const unassignedFieldsPool = ref([]);

const handleKeydown = (e) => {
  if (!props.modelValue) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal();
  } else if (e.key === 'Enter') {
    const tag = e.target?.tagName?.toLowerCase();
    if (tag === 'textarea' && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    saveVisualGridEditor();
  }
};

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
});

const initGridFromConfig = () => {
  if (!props.configList) return;

  const rowMap = new Map();
  const unassigned = [];

  props.configList.forEach(item => {
    const rNum = (item.gridRow !== undefined && item.gridRow !== null && item.gridRow !== '')
      ? parseInt(item.gridRow, 10)
      : null;
    
    if (rNum !== null && !isNaN(rNum) && rNum > 0) {
      if (!rowMap.has(rNum)) {
        rowMap.set(rNum, []);
      }
      rowMap.get(rNum).push({ ...item });
    } else {
      unassigned.push({ ...item });
    }
  });

  rowMap.forEach((rowItems) => {
    rowItems.sort((a, b) => {
      const oA = (a.gridOrder !== undefined && a.gridOrder !== '') ? parseInt(a.gridOrder, 10) : 999;
      const oB = (b.gridOrder !== undefined && b.gridOrder !== '') ? parseInt(b.gridOrder, 10) : 999;
      return oA - oB;
    });
  });

  const sortedRowNums = Array.from(rowMap.keys()).sort((a, b) => a - b);
  const rowsList = [];

  sortedRowNums.forEach((rNum, idx) => {
    rowsList.push({
      id: idx + 1,
      items: rowMap.get(rNum)
    });
  });

  if (rowsList.length === 0 && unassigned.length > 0) {
    rowsList.push({
      id: 1,
      items: [...unassigned]
    });
    unassignedFieldsPool.value = [];
  } else {
    unassignedFieldsPool.value = unassigned;
  }

  visualGridRows.value = rowsList;
};

watch(() => props.modelValue, (newVal) => {
  if (newVal) {
    initGridFromConfig();
  }
});

const closeModal = () => {
  emit('update:modelValue', false);
};

const addVisualRow = () => {
  visualGridRows.value.push({
    id: visualGridRows.value.length + 1,
    items: []
  });
};

const moveVisualRow = (idx, direction) => {
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= visualGridRows.value.length) return;
  const temp = visualGridRows.value[idx];
  visualGridRows.value[idx] = visualGridRows.value[targetIdx];
  visualGridRows.value[targetIdx] = temp;
  visualGridRows.value.forEach((r, i) => r.id = i + 1);
};

const deleteVisualRow = (idx) => {
  const row = visualGridRows.value[idx];
  if (row && row.items.length > 0) {
    unassignedFieldsPool.value.push(...row.items);
  }
  visualGridRows.value.splice(idx, 1);
  visualGridRows.value.forEach((r, i) => r.id = i + 1);
};

const moveFieldInRow = (rowIndex, fieldIndex, direction) => {
  const row = visualGridRows.value[rowIndex];
  if (!row) return;
  const targetIndex = fieldIndex + direction;
  if (targetIndex < 0 || targetIndex >= row.items.length) return;
  const temp = row.items[fieldIndex];
  row.items[fieldIndex] = row.items[targetIndex];
  row.items[targetIndex] = temp;
};

const moveFieldToRow = (fieldItem, fromRowIdx, toRowIdx) => {
  if (!fieldItem) return;
  if (fromRowIdx !== null && fromRowIdx >= 0 && visualGridRows.value[fromRowIdx]) {
    visualGridRows.value[fromRowIdx].items = visualGridRows.value[fromRowIdx].items.filter(i => i.element !== fieldItem.element);
  } else {
    unassignedFieldsPool.value = unassignedFieldsPool.value.filter(i => i.element !== fieldItem.element);
  }

  if (toRowIdx !== null && toRowIdx >= 0 && visualGridRows.value[toRowIdx]) {
    visualGridRows.value[toRowIdx].items.push(fieldItem);
  } else {
    unassignedFieldsPool.value.push(fieldItem);
  }
};

const saveVisualGridEditor = () => {
  visualGridRows.value.forEach((row, rIdx) => {
    const rowNumStr = String(rIdx + 1);
    row.items.forEach((item, fIdx) => {
      const orderNumStr = String(fIdx + 1);
      const target = props.configList.find(g => g.element === item.element);
      if (target) {
        target.gridRow = rowNumStr;
        target.gridOrder = orderNumStr;
        target.width = item.width || '';
        target.gridFill = !!item.gridFill;
      }
    });
  });

  unassignedFieldsPool.value.forEach(item => {
    const target = props.configList.find(g => g.element === item.element);
    if (target) {
      target.gridRow = '';
      target.gridOrder = '';
    }
  });

  emit('apply', props.configList);
  closeModal();
};
</script>

<template>
  <div class="modal-overlay" v-if="modelValue" style="display: flex; z-index: 1200;">
    <div class="modal-content" style="max-width: 860px; width: 95%; max-height: 85vh; display: flex; flex-direction: column;">
      <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem;">
        <h3 style="margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          <span>Editor Visual de Grid: <strong style="color: var(--color-primary);">{{ groupName }}</strong></span>
        </h3>
        <button type="button" class="btn-icon-only" style="border:none; background:none; font-size:1.5rem; cursor: pointer;" @click="closeModal">&times;</button>
      </div>

      <div class="modal-body" style="flex-grow: 1; overflow-y: auto; padding: 0.75rem 0; display: flex; flex-direction: column; gap: 1rem;">
        
        <!-- Pool of Unassigned / Available Fields -->
        <div v-if="unassignedFieldsPool.length > 0" style="background: var(--bg-tertiary); padding: 0.75rem; border-radius: var(--radius-sm); border: 1px dashed var(--border-color);">
          <span style="font-size: 0.78rem; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 6px;">
            Camps sense assignar a cap fila (fes clic per afegir a una fila):
          </span>
          <div style="display: flex; flex-wrap: wrap; gap: 6px;">
            <div 
              v-for="item in unassignedFieldsPool" 
              :key="item.element"
              style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.78rem;"
            >
              <span style="font-weight: 600; color: var(--text-primary);">{{ item.label || item.element }}</span>
              <span style="font-size: 0.7rem; color: var(--text-muted);">({{ item.element }})</span>
              <button 
                type="button" 
                class="btn btn-secondary" 
                style="padding: 1px 5px; font-size: 0.68rem; width: auto;"
                @click="moveFieldToRow(item, null, 0)"
                title="Assigna a la Fila 1"
              >
                + Fila 1
              </button>
            </div>
          </div>
        </div>

        <!-- Vertical List of Row Containers -->
        <div style="display: flex; flex-direction: column; gap: 0.75rem;">
          <div 
            v-for="(row, rIdx) in visualGridRows" 
            :key="row.id"
            style="border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-card); padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem;"
          >
            <!-- Row Header / Controls -->
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 0.35rem;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-weight: 700; font-size: 0.85rem; color: var(--color-primary); display: inline-flex; align-items: center; gap: 4px;">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                  Fila {{ rIdx + 1 }}
                </span>
                <span style="font-size: 0.72rem; color: var(--text-muted);">({{ row.items.length }} camps)</span>
              </div>

              <div style="display: flex; align-items: center; gap: 4px;">
                <!-- Row Up / Down buttons -->
                <button 
                  type="button" 
                  class="btn btn-secondary" 
                  style="padding: 2px 6px; font-size: 0.72rem; width: auto; display: inline-flex; align-items: center; gap: 3px;" 
                  :disabled="rIdx === 0"
                  @click="moveVisualRow(rIdx, -1)"
                  title="Mou tota la fila amunt"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                  <span>Amunt</span>
                </button>
                <button 
                  type="button" 
                  class="btn btn-secondary" 
                  style="padding: 2px 6px; font-size: 0.72rem; width: auto; display: inline-flex; align-items: center; gap: 3px;" 
                  :disabled="rIdx === visualGridRows.length - 1"
                  @click="moveVisualRow(rIdx, 1)"
                  title="Mou tota la fila avall"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
                  <span>Avall</span>
                </button>

                <!-- Add field to row select -->
                <select 
                  v-if="unassignedFieldsPool.length > 0"
                  style="font-size: 0.72rem; padding: 2px 4px; height: 24px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-primary);"
                  @change="moveFieldToRow(unassignedFieldsPool.find(x => x.element === $event.target.value), null, rIdx); $event.target.value = '';"
                >
                  <option value="">+ Afegeix camp a Fila {{ rIdx + 1 }}...</option>
                  <option v-for="uItem in unassignedFieldsPool" :key="uItem.element" :value="uItem.element">
                    {{ uItem.label || uItem.element }}
                  </option>
                </select>

                <button 
                  type="button" 
                  class="btn-icon-only text-danger" 
                  style="border: none; background: transparent; font-size: 0.9rem; cursor: pointer; width: 24px; height: 24px;"
                  @click="deleteVisualRow(rIdx)"
                  title="Elimina aquesta fila"
                >
                  &times;
                </button>
              </div>
            </div>

            <!-- Row Horizontal Fields List -->
            <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: stretch; min-height: 48px; padding: 4px; background: var(--bg-tertiary); border-radius: 4px;">
              <div v-if="row.items.length === 0" style="color: var(--text-muted); font-size: 0.75rem; display: flex; align-items: center; justify-content: center; width: 100%; height: 44px; font-style: italic;">
                Fila buida. Tria un camp del selector a sobre per afegir-lo aquí.
              </div>

              <div 
                v-for="(fItem, fIdx) in row.items" 
                :key="fItem.element"
                style="display: flex; flex-direction: column; gap: 4px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 6px 8px; flex: 1 1 200px; min-width: 180px; box-sizing: border-box;"
              >
                <!-- Field Header & Reorder controls -->
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span style="font-weight: 600; font-size: 0.8rem; color: var(--text-primary); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    {{ fItem.label || fItem.element }}
                  </span>

                  <div style="display: flex; gap: 2px;">
                    <!-- Left / Right buttons -->
                    <button 
                      type="button" 
                      class="btn btn-secondary" 
                      style="padding: 1px 4px; font-size: 0.68rem; width: auto;" 
                      :disabled="fIdx === 0"
                      @click="moveFieldInRow(rIdx, fIdx, -1)"
                      title="Mou a l'esquerra"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
                    </button>
                    <button 
                      type="button" 
                      class="btn btn-secondary" 
                      style="padding: 1px 4px; font-size: 0.68rem; width: auto;" 
                      :disabled="fIdx === row.items.length - 1"
                      @click="moveFieldInRow(rIdx, fIdx, 1)"
                      title="Mou a la dreta"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                    </button>
                    <button 
                      type="button" 
                      style="border: none; background: transparent; font-size: 0.85rem; cursor: pointer; color: var(--color-danger);" 
                      @click="moveFieldToRow(fItem, rIdx, null)"
                      title="Treu d'aquesta fila"
                    >
                      &times;
                    </button>
                  </div>
                </div>

                <!-- Width & Fill Controls -->
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 2px;">
                  <div style="display: flex; align-items: center; gap: 4px;">
                    <span style="font-size: 0.7rem; color: var(--text-muted);">Amplada:</span>
                    <select 
                      v-model="fItem.width" 
                      style="font-size: 0.7rem; padding: 1px 3px; height: 22px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--bg-primary);"
                    >
                      <option value="">Auto</option>
                      <option value="25%">25%</option>
                      <option value="33%">33%</option>
                      <option value="50%">50%</option>
                      <option value="66%">66%</option>
                      <option value="75%">75%</option>
                      <option value="100%">100%</option>
                    </select>
                  </div>

                  <label style="font-size: 0.7rem; color: var(--text-muted); display: flex; align-items: center; gap: 3px; cursor: pointer;" title="Omple tot l'espai restant de la fila">
                    <input type="checkbox" v-model="fItem.gridFill" style="width: 13px; height: 13px;">
                    <span>Omple</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Add New Row Button -->
        <div style="display: flex; justify-content: center; margin-top: 0.5rem;">
          <button 
            type="button" 
            class="btn btn-secondary" 
            style="width: auto; padding: 4px 12px; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 5px;"
            @click="addVisualRow"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            <span>Afegir Nova Fila (Fila {{ visualGridRows.length + 1 }})</span>
          </button>
        </div>

      </div>

      <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border-color); padding-top: 0.75rem;">
        <button type="button" class="btn btn-secondary" style="width: auto;" @click="closeModal">Cancel·la</button>
        <button type="button" class="btn btn-primary" style="width: auto; display: inline-flex; align-items: center; gap: 5px;" @click="saveVisualGridEditor">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          <span>Aplica Distribució</span>
        </button>
      </div>
    </div>
  </div>
</template>
