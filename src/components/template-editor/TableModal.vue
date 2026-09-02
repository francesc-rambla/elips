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
/**
 * Table insertion/configuration modal (dynamic row-loop, transposed
 * column-loop, or a plain manual grid). Owns its own form state (mode,
 * selected array/iterator, per-column config) and computes the resulting
 * <table> HTML on apply — but never touches the canvas DOM itself: replacing
 * an existing table node vs. inserting a new one at the saved selection (and
 * re-wiring its th click / dblclick handlers) is canvas-level state the
 * parent owns, same split as the other extracted modals.
 *
 * `initialConfig` is computed by the parent from either an existing table's
 * DOM (editing) or sensible defaults (new table) — this component just
 * copies it into local state when opened, and recomputes column defaults
 * itself (onArraySelected) when initialConfig arrives with no columns yet
 * (the "new dynamic table, nothing chosen" case).
 */
import { ref, watch } from 'vue';
import { useWorkspaceStore } from '../../stores/workspace';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  isEditing: { type: Boolean, default: false },
  initialConfig: { type: Object, default: () => ({}) },
  availableArrays: { type: Array, default: () => [] },
  resolvePath: { type: Function, required: true },
  resolveFieldLabel: { type: Function, required: true },
});

const emit = defineEmits(['update:modelValue', 'apply']);

const store = useWorkspaceStore();

const tableMode = ref('dynamic'); // 'dynamic', 'transposed', 'manual'
const manualRows = ref(3);
const manualCols = ref(3);
const selectedArray = ref('');
const iteratorVar = ref('item');
const selectedColHeaderKey = ref('');
const tableColumns = ref([]); // Array of { key, header, align, selected, filter }

const isNumericColumn = (arrayName, colKey) => {
  const arr = props.resolvePath(store.excelJsonData, arrayName);
  if (arr && Array.isArray(arr) && arr.length > 0) {
    for (const item of arr.slice(0, 5)) {
      const val = item[colKey];
      if (typeof val === 'number') return true;
      if (typeof val === 'string' && !isNaN(val) && val.trim() !== '') return true;
    }
  }
  return false;
};

const onArraySelected = () => {
  if (!selectedArray.value) {
    tableColumns.value = [];
    return;
  }
  const arr = props.resolvePath(store.excelJsonData, selectedArray.value);
  if (arr && Array.isArray(arr) && arr.length > 0) {
    const fields = Object.keys(arr[0]).filter((k) => k !== selectedArray.value.split('.').pop());
    tableColumns.value = fields.map((f) => {
      const isNum = isNumericColumn(selectedArray.value, f);
      let defaultFilter = '';
      const fLower = f.toLowerCase();
      if (fLower.includes('preu') || fLower.includes('import') || fLower.includes('cost') || fLower.includes('sou') || fLower.includes('pressupost') || fLower.includes('iva') || fLower.includes('base') || fLower.includes('total') || fLower.includes('valor')) {
        defaultFilter = 'coin';
      } else if (isNum) {
        defaultFilter = 'number';
      }
      return {
        key: f,
        header: f.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
        align: (defaultFilter || isNum) ? 'right' : 'left',
        selected: true,
        filter: defaultFilter,
      };
    });

    iteratorVar.value = selectedArray.value.split('.').pop().toLowerCase().replace(/s$/, '') || 'item';
    selectedColHeaderKey.value = fields[0] || '';
  }
};

watch(() => props.modelValue, (open) => {
  if (!open) return;
  const cfg = props.initialConfig || {};
  tableMode.value = cfg.mode || 'dynamic';
  iteratorVar.value = cfg.iteratorVar || 'item';
  selectedArray.value = cfg.selectedArray || '';
  selectedColHeaderKey.value = cfg.selectedColHeaderKey || '';
  tableColumns.value = cfg.columns || [];
  manualRows.value = cfg.manualRows || 3;
  manualCols.value = cfg.manualCols || 3;

  if (!cfg.columns?.length && selectedArray.value) {
    onArraySelected();
  }
});

const close = () => emit('update:modelValue', false);

const apply = () => {
  let html = '';
  const isFor = tableMode.value === 'dynamic';
  const isTrans = tableMode.value === 'transposed';

  if (isFor) {
    if (!selectedArray.value || !iteratorVar.value) {
      alert('Si us plau, selecciona un array de dades i un iterador vàlids.');
      return;
    }
    const loopExpr = `${iteratorVar.value.trim()} in ${selectedArray.value.trim()}`;
    const activeCols = tableColumns.value.filter((c) => c.selected && c.key);
    if (activeCols.length === 0) {
      alert('Has de seleccionar almenys un camp.');
      return;
    }

    html += '<table><thead><tr>';
    activeCols.forEach((c) => {
      html += `<th data-align="${c.align}" style="text-align: ${c.align};">${c.header}</th>`;
    });
    html += '</tr></thead><tbody>';

    html += `<tr class="j-row-loop" data-jinja-for="${loopExpr}">`;
    activeCols.forEach((c) => {
      const filterPart = c.filter ? ` | ${c.filter.trim().replace(/^\|\s*/, '')}` : '';
      const chipRaw = `${iteratorVar.value.trim()}.${c.key}${filterPart}`;
      html += `<td style="text-align: ${c.align};"><span class="j-var-chip" contenteditable="false" data-raw="${chipRaw}">${props.resolveFieldLabel(chipRaw)}</span></td>`;
    });
    html += '</tr></tbody></table><p><br></p>';
  } else if (isTrans) {
    if (!selectedArray.value || !iteratorVar.value) {
      alert('Si us plau, selecciona un array de dades i un iterador vàlids.');
      return;
    }
    const colHeaderKey = selectedColHeaderKey.value.trim();
    const loopExpr = `${iteratorVar.value.trim()} in ${selectedArray.value.trim()}${colHeaderKey ? ` if ${iteratorVar.value.trim()}.${colHeaderKey}` : ''}`;
    const activeCols = tableColumns.value.filter((c) => c.selected && c.key && c.key !== colHeaderKey);
    if (activeCols.length === 0) {
      alert('Has de seleccionar almenys una fila de dades.');
      return;
    }

    html += '<table><thead><tr>';
    html += '<th data-align="left">Dada</th>';
    const headChipRaw = `${iteratorVar.value.trim()}.${colHeaderKey}`;
    html += `<th data-align="center" style="text-align: center;" data-jinja-col-loop="${loopExpr}"><span class="j-var-chip" contenteditable="false" data-raw="${headChipRaw}">${props.resolveFieldLabel(headChipRaw)}</span></th>`;
    html += '</tr></thead><tbody>';

    activeCols.forEach((c) => {
      html += '<tr>';
      html += `<td>${c.header}</td>`;
      const filterPart = c.filter ? ` | ${c.filter.trim().replace(/^\|\s*/, '')}` : '';
      const cellChipRaw = `${iteratorVar.value.trim()}.${c.key}${filterPart}`;
      html += `<td style="text-align: ${c.align};" data-jinja-col-loop="${loopExpr}"><span class="j-var-chip" contenteditable="false" data-raw="${cellChipRaw}">${props.resolveFieldLabel(cellChipRaw)}</span></td>`;
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

  emit('apply', html);
  emit('update:modelValue', false);
};

defineExpose({ apply });
</script>

<template>
  <div class="modal-overlay" :style="{ display: modelValue ? 'flex' : 'none' }">
    <div class="modal-content" style="max-width: 720px; width: 95%;">
      <div class="modal-header">
        <h3 style="border: none; padding-bottom: 0; margin: 0;">{{ isEditing ? 'Configurar / Modificar Taula' : 'Inserir Nova Taula' }}</h3>
        <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem;" @click="close">&times;</button>
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
            🔄 Transposada (Columnes iterables)
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
              {{ tableMode === 'dynamic' ? 'Selecciona les columnes, alineació i filtres' : 'Selecciona les files dades, alineació i filtres' }}
            </span>

            <div style="display: flex; flex-direction: column; gap: 0.5rem; max-height: 220px; overflow-y: auto; padding-right: 4px;">
              <!-- Header grid layout -->
              <div style="display: grid; grid-template-columns: 30px 125px 150px 95px 125px; gap: 8px; font-size: 0.7rem; font-weight:bold; text-transform:uppercase; color: var(--text-muted); border-bottom: 1px solid var(--border-color); padding-bottom: 4px; margin-bottom: 4px;">
                <span>Usa</span>
                <span>Clau</span>
                <span>Títol</span>
                <span>Alineació</span>
                <span>Filtre Jinja2</span>
              </div>

              <div
                v-for="c in tableColumns"
                :key="c.key"
                v-show="tableMode === 'dynamic' || c.key !== selectedColHeaderKey"
                style="display: grid; grid-template-columns: 30px 125px 150px 95px 125px; gap: 8px; align-items: center;"
              >
                <input type="checkbox" v-model="c.selected">
                <span style="font-family: monospace; font-size: 0.8rem; font-weight: 600; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;" :title="c.key">{{ c.key }}</span>
                <input type="text" v-model="c.header" placeholder="Capçalera" style="padding: 4px; font-size: 0.75rem;">
                <select v-model="c.align" style="padding: 4px; font-size: 0.75rem;">
                  <option value="left">Esquerra</option>
                  <option value="center">Centre</option>
                  <option value="right">Dreta</option>
                </select>
                <select v-model="c.filter" style="padding: 4px; font-size: 0.75rem;">
                  <option value="">Sense filtre</option>
                  <option value="coin">Moneda (€ | coin)</option>
                  <option value="number">Número (| number)</option>
                  <option value="round(2)">Arrodonit (| round(2))</option>
                  <option value="percent">Percentatge (| percent)</option>
                  <option value="upper">Majúscules (| upper)</option>
                  <option value="lower">Minúscules (| lower)</option>
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
        <button class="btn btn-secondary" style="width: auto;" @click="close">Cancel·lar</button>
        <button class="btn btn-primary" style="width: auto;" @click="apply">Aplicar</button>
      </div>
    </div>
  </div>
</template>
