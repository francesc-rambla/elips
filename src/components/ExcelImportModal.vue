<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';

const props = defineProps({
  isOpen: Boolean
});

const emit = defineEmits(['close', 'confirm']);
const store = useWorkspaceStore();

const selectedSheetKey = ref('');
const activeFilter = ref('all'); // 'all', 'kept', 'discarded'

// Local override map for rows: { sheetKey: { rowIdx: boolean } }
const userOverrides = ref({});

const inspectionData = computed(() => store.excelImportInspection || {});
const sheetKeys = computed(() => Object.keys(inspectionData.value));

const currentSheetInfo = computed(() => {
  if (!selectedSheetKey.value || !inspectionData.value) return null;
  return inspectionData.value[selectedSheetKey.value] || null;
});

// Auto-select first sheet when modal opens
watch(() => props.isOpen, (newVal) => {
  if (newVal && sheetKeys.value.length > 0) {
    if (!selectedSheetKey.value || !(selectedSheetKey.value in inspectionData.value)) {
      selectedSheetKey.value = sheetKeys.value[0];
    }
  }
}, { immediate: true });

watch(inspectionData, (newData) => {
  if (newData && Object.keys(newData).length > 0) {
    if (!selectedSheetKey.value || !(selectedSheetKey.value in newData)) {
      selectedSheetKey.value = Object.keys(newData)[0];
    }
  }
});

const isRowIncluded = (sheetKey, rIdx, defaultStatus) => {
  if (userOverrides.value[sheetKey] && userOverrides.value[sheetKey][rIdx] !== undefined) {
    return userOverrides.value[sheetKey][rIdx];
  }
  return defaultStatus === 'kept';
};

const toggleRowInclusion = (sheetKey, rIdx, defaultStatus) => {
  if (!userOverrides.value[sheetKey]) {
    userOverrides.value[sheetKey] = {};
  }
  const current = isRowIncluded(sheetKey, rIdx, defaultStatus);
  userOverrides.value[sheetKey][rIdx] = !current;
};

const filteredRows = computed(() => {
  if (!currentSheetInfo.value || !Array.isArray(currentSheetInfo.value.rows)) return [];
  const rows = currentSheetInfo.value.rows;
  if (activeFilter.value === 'kept') {
    return rows.filter(r => isRowIncluded(selectedSheetKey.value, r.index, r.status));
  } else if (activeFilter.value === 'discarded') {
    return rows.filter(r => !isRowIncluded(selectedSheetKey.value, r.index, r.status));
  }
  return rows;
});

const tableColumns = computed(() => {
  if (!currentSheetInfo.value) return [];
  if (Array.isArray(currentSheetInfo.value.headers) && currentSheetInfo.value.headers.length > 0) {
    return currentSheetInfo.value.headers;
  }
  const rows = currentSheetInfo.value.rows || [];
  const colSet = new Set();
  rows.forEach(r => {
    if (r.data && typeof r.data === 'object') {
      Object.keys(r.data).forEach(k => {
        if (!k.startsWith('_')) colSet.add(k);
      });
    }
  });
  return Array.from(colSet);
});

const handleKeydown = (e) => {
  if (!props.isOpen) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
};

onMounted(() => window.addEventListener('keydown', handleKeydown));
onUnmounted(() => window.removeEventListener('keydown', handleKeydown));

const applyImport = () => {
  if (!store.excelJsonData) store.excelJsonData = {};
  
  // Re-build excelJsonData based on inspectionData and userOverrides
  sheetKeys.value.forEach(rawName => {
    const sInfo = inspectionData.value[rawName];
    const cleanName = sInfo.clean_name || rawName.replace(/^OUT_/, '');
    
    if (sInfo.kind === 'tabular') {
      const finalRows = [];
      (sInfo.rows || []).forEach(r => {
        if (isRowIncluded(rawName, r.index, r.status)) {
          finalRows.append ? finalRows.append(r.data) : finalRows.push(r.data);
        }
      });
      store.excelJsonData[cleanName] = finalRows;
      if (rawName !== cleanName) {
        store.excelJsonData[rawName] = finalRows;
      }
    } else if (sInfo.kind === 'kv') {
      const kvObj = {};
      (sInfo.rows || []).forEach(r => {
        if (isRowIncluded(rawName, r.index, r.status) && r.data && r.data.key) {
          kvObj[r.data.key] = r.data.value;
        }
      });
      store.excelJsonData[cleanName] = kvObj;
      if (rawName !== cleanName) {
        store.excelJsonData[rawName] = kvObj;
      }
    }
  });

  store.addLog("Importació de l'Excel confirmada amb èxit des del modal d'inspecció.", "success");
  emit('confirm');
  emit('close');
};
</script>

<template>
  <div class="modal-overlay" :style="{ display: isOpen ? 'flex' : 'none' }">
    <div class="modal-content" style="max-width: 1100px; width: 95%; max-height: 90vh; display: flex; flex-direction: column;">
      
      <!-- Header -->
      <div class="modal-header" style="padding: 1rem 1.25rem; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; background: var(--bg-secondary);">
        <div>
          <h3 style="margin: 0; font-size: 1.1rem; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
            <span>🔍 Inspecció i Confirmació d'Importació Excel</span>
          </h3>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.8rem; color: var(--text-muted);">
            Revisa la diagnosi de cada full de l'Excel. Pots filtrar i forçar la inclusió o exclusió de qualsevol fila abans d'incorporar les dades al teu projecte.
          </p>
        </div>
        <button 
          class="btn-icon-only" 
          style="border: none; background: none; font-size: 1.6rem; cursor: pointer; color: var(--text-muted);"
          @click="emit('close')"
        >
          &times;
        </button>
      </div>

      <!-- Controls & Selector -->
      <div style="padding: 0.85rem 1.25rem; background: var(--bg-primary); border-bottom: 1px solid var(--border-color); display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;">
        
        <!-- Sheet Dropdown -->
        <div style="display: flex; align-items: center; gap: 8px; flex-grow: 1; max-width: 500px;">
          <label style="font-weight: 600; font-size: 0.85rem; white-space: nowrap;">📄 Selecciona Full:</label>
          <select 
            v-model="selectedSheetKey" 
            style="flex-grow: 1; padding: 6px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); font-size: 0.88rem; font-weight: 600; background: var(--bg-card); color: var(--text-primary);"
          >
            <option v-for="(sInfo, key) in inspectionData" :key="key" :value="key">
              {{ key }} — {{ sInfo.kept_count }} vàlides / {{ sInfo.discarded_count }} buides (Total: {{ sInfo.total_rows }})
            </option>
          </select>
        </div>

        <!-- Filter buttons -->
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-muted); margin-right: 4px;">Filtra files:</span>
          <button 
            class="btn btn-secondary" 
            style="padding: 4px 10px; font-size: 0.78rem; border-radius: 4px;"
            :style="{ background: activeFilter === 'all' ? 'var(--color-primary)' : '', color: activeFilter === 'all' ? '#fff' : '' }"
            @click="activeFilter = 'all'"
          >
            Totes ({{ currentSheetInfo?.total_rows || 0 }})
          </button>
          <button 
            class="btn btn-secondary" 
            style="padding: 4px 10px; font-size: 0.78rem; border-radius: 4px;"
            :style="{ background: activeFilter === 'kept' ? '#10b981' : '', color: activeFilter === 'kept' ? '#fff' : '' }"
            @click="activeFilter = 'kept'"
          >
            🟢 Només Vàlides ({{ currentSheetInfo?.kept_count || 0 }})
          </button>
          <button 
            class="btn btn-secondary" 
            style="padding: 4px 10px; font-size: 0.78rem; border-radius: 4px;"
            :style="{ background: activeFilter === 'discarded' ? '#ef4444' : '', color: activeFilter === 'discarded' ? '#fff' : '' }"
            @click="activeFilter = 'discarded'"
          >
            🔴 Només Buides ({{ currentSheetInfo?.discarded_count || 0 }})
          </button>
        </div>
      </div>

      <!-- Sheet Stats Summary Banner -->
      <div v-if="currentSheetInfo" style="padding: 0.6rem 1.25rem; background: var(--bg-tertiary); font-size: 0.82rem; border-bottom: 1px solid var(--border-color); display: flex; gap: 20px; align-items: center;">
        <div><strong>Tipus:</strong> <span class="accordion-badge" :class="currentSheetInfo.kind">{{ currentSheetInfo.kind }}</span></div>
        <div><strong>Total Llegides:</strong> {{ currentSheetInfo.total_rows }}</div>
        <div style="color: #059669;"><strong>🟢 Carregaran (Dades reals):</strong> {{ currentSheetInfo.kept_count }}</div>
        <div style="color: #dc2626;"><strong>🔴 Descartaran (Fórmules a 0):</strong> {{ currentSheetInfo.discarded_count }}</div>
      </div>

      <!-- Main Body Table -->
      <div class="modal-body" style="padding: 1rem; overflow-y: auto; flex-grow: 1;">
        
        <div v-if="!currentSheetInfo" style="text-align: center; padding: 2rem; color: var(--text-muted);">
          No s'ha seleccionat cap full.
        </div>

        <!-- Tabular Grid View -->
        <div v-else-if="currentSheetInfo.kind === 'tabular'" style="overflow-x: auto;">
          <table class="inspector-table" style="width: 100%; border-collapse: collapse; font-size: 0.8rem;">
            <thead>
              <tr style="background: var(--bg-secondary); border-bottom: 2px solid var(--border-color);">
                <th style="padding: 6px 10px; text-align: center; width: 60px;"># Fila</th>
                <th style="padding: 6px 10px; text-align: center; width: 130px;">Estat Importació</th>
                <th style="padding: 6px 10px; text-align: center; width: 70px;">Incloure?</th>
                <th v-for="col in tableColumns" :key="col" style="padding: 6px 10px; text-align: left; font-weight: 600;">
                  {{ col }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr 
                v-for="r in filteredRows" 
                :key="r.index"
                :style="{
                  background: isRowIncluded(selectedSheetKey, r.index, r.status) ? 'rgba(16, 185, 129, 0.08)' : 'rgba(239, 68, 68, 0.08)',
                  borderBottom: '1px solid var(--border-color)'
                }"
              >
                <!-- Row Index -->
                <td style="padding: 6px 10px; text-align: center; font-weight: 600; color: var(--text-muted);">
                  {{ r.index }}
                </td>

                <!-- Status Badge -->
                <td style="padding: 6px 10px; text-align: center;">
                  <span 
                    v-if="isRowIncluded(selectedSheetKey, r.index, r.status)"
                    style="background: #d1fae5; color: #065f46; padding: 2px 8px; border-radius: 12px; font-size: 0.72rem; font-weight: 700; display: inline-block;"
                  >
                    🟢 S'IMPORTARÀ
                  </span>
                  <span 
                    v-else
                    style="background: #fee2e2; color: #991b1b; padding: 2px 8px; border-radius: 12px; font-size: 0.72rem; font-weight: 700; display: inline-block;"
                  >
                    🔴 BUIDA / DESCARTADA
                  </span>
                </td>

                <!-- Checkbox Toggle -->
                <td style="padding: 6px 10px; text-align: center;">
                  <input 
                    type="checkbox" 
                    :checked="isRowIncluded(selectedSheetKey, r.index, r.status)"
                    @change="toggleRowInclusion(selectedSheetKey, r.index, r.status)"
                    style="cursor: pointer; width: 16px; height: 16px;"
                  >
                </td>

                <!-- Cells -->
                <td 
                  v-for="col in tableColumns" 
                  :key="col" 
                  style="padding: 6px 10px; white-space: nowrap; max-width: 250px; overflow: hidden; text-overflow: ellipsis;"
                  :style="{
                    color: isRowIncluded(selectedSheetKey, r.index, r.status) ? 'var(--text-primary)' : 'var(--text-muted)',
                    textDecoration: isRowIncluded(selectedSheetKey, r.index, r.status) ? 'none' : 'line-through'
                  }"
                >
                  {{ r.data && r.data[col] !== undefined ? r.data[col] : '' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Key/Value Grid View -->
        <div v-else-if="currentSheetInfo.kind === 'kv'" style="overflow-x: auto;">
          <table class="inspector-table" style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
            <thead>
              <tr style="background: var(--bg-secondary); border-bottom: 2px solid var(--border-color);">
                <th style="padding: 6px 10px; text-align: left; width: 220px;">Clau (Parameter)</th>
                <th style="padding: 6px 10px; text-align: center; width: 130px;">Estat</th>
                <th style="padding: 6px 10px; text-align: center; width: 70px;">Incloure?</th>
                <th style="padding: 6px 10px; text-align: left;">Valor a l'Excel</th>
              </tr>
            </thead>
            <tbody>
              <tr 
                v-for="r in filteredRows" 
                :key="r.index"
                :style="{
                  background: isRowIncluded(selectedSheetKey, r.index, r.status) ? 'rgba(16, 185, 129, 0.08)' : 'rgba(239, 68, 68, 0.08)',
                  borderBottom: '1px solid var(--border-color)'
                }"
              >
                <td style="padding: 6px 10px; font-weight: 600;">{{ r.index }}</td>
                <td style="padding: 6px 10px; text-align: center;">
                  <span 
                    v-if="isRowIncluded(selectedSheetKey, r.index, r.status)"
                    style="background: #d1fae5; color: #065f46; padding: 2px 8px; border-radius: 12px; font-size: 0.72rem; font-weight: 700;"
                  >
                    🟢 S'IMPORTARÀ
                  </span>
                  <span 
                    v-else
                    style="background: #fee2e2; color: #991b1b; padding: 2px 8px; border-radius: 12px; font-size: 0.72rem; font-weight: 700;"
                  >
                    🔴 BUIDA / DESCARTADA
                  </span>
                </td>
                <td style="padding: 6px 10px; text-align: center;">
                  <input 
                    type="checkbox" 
                    :checked="isRowIncluded(selectedSheetKey, r.index, r.status)"
                    @change="toggleRowInclusion(selectedSheetKey, r.index, r.status)"
                    style="cursor: pointer;"
                  >
                </td>
                <td style="padding: 6px 10px;">{{ r.data?.value }}</td>
              </tr>
            </tbody>
          </table>
        </div>

      </div>

      <!-- Footer Action Buttons -->
      <div class="modal-footer" style="padding: 0.85rem 1.25rem; border-top: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; background: var(--bg-secondary);">
        <button class="btn btn-secondary" @click="emit('close')">
          Tancar
        </button>
        <button class="btn btn-primary" style="padding: 8px 18px; font-weight: 600;" @click="applyImport">
          ✅ Confirmar i Carregar Dades Seleccionades
        </button>
      </div>

    </div>
  </div>
</template>
