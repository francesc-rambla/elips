<script setup>
import { computed } from 'vue';

const props = defineProps({
  parentObj: {
    type: Object,
    required: true
  },
  arrayKey: {
    type: String,
    required: true
  },
  parentPath: {
    type: String,
    default: ''
  }
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

const getPrimitiveFields = (item) => {
  if (!item || typeof item !== 'object') return {};
  const res = {};
  Object.keys(item).forEach(k => {
    if (isPrimitive(item[k])) {
      res[k] = item[k];
    }
  });
  return res;
};

const getNestedArrayKeys = (item) => {
  if (!item || typeof item !== 'object') return [];
  return Object.keys(item).filter(k => Array.isArray(item[k]));
};

const addNestedItem = () => {
  if (!Array.isArray(props.parentObj[props.arrayKey])) {
    props.parentObj[props.arrayKey] = [];
  }
  const list = props.parentObj[props.arrayKey];
  const newRow = {};
  
  if (list.length > 0) {
    const sample = list[0];
    Object.keys(sample).forEach(k => {
      if (Array.isArray(sample[k])) {
        newRow[k] = [];
      } else {
        newRow[k] = '';
      }
    });
  } else {
    newRow['id'] = `item_${list.length + 1}`;
    newRow['nom'] = '';
  }
  list.push(newRow);
};

const deleteNestedItem = (idx) => {
  if (confirm(`Segur que vols eliminar aquest element (${props.arrayKey} #${idx + 1})?`)) {
    props.parentObj[props.arrayKey].splice(idx, 1);
  }
};

const getItemPath = (idx, fieldKey) => {
  const base = props.parentPath ? `${props.parentPath}.${props.arrayKey}` : props.arrayKey;
  return fieldKey !== '' ? `${base}.${idx}.${fieldKey}` : `${base}.${idx}`;
};
</script>

<template>
  <div class="nested-hierarchy-container" style="margin-top: 0.85rem; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 0.75rem;">
    <!-- Section Header -->
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem;">
      <h5 style="margin: 0; font-size: 0.85rem; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
        <span>📂 Sub-taula: <strong style="color: var(--color-primary);">{{ arrayKey }}</strong></span>
        <span style="font-size: 0.75rem; font-weight: normal; color: var(--text-muted);">({{ items.length }} registres)</span>
      </h5>
      <button 
        type="button"
        class="btn btn-secondary" 
        style="width: auto; padding: 3px 10px; font-size: 0.75rem; border-radius: 4px; display: flex; align-items: center; gap: 4px; border: 1px solid var(--border-color);"
        @click="addNestedItem"
      >
        ➕ Afegeix {{ arrayKey }}
      </button>
    </div>

    <!-- Empty List State -->
    <div v-if="items.length === 0" style="font-size: 0.75rem; color: var(--text-muted); font-style: italic; text-align: center; padding: 0.75rem 0;">
      Sense elements a {{ arrayKey }}. Utilitzeu "➕ Afegeix {{ arrayKey }}" per crear el primer element.
    </div>

    <!-- Items List -->
    <div v-else style="display: flex; flex-direction: column; gap: 0.75rem;">
      <div 
        v-for="(item, idx) in items" 
        :key="idx" 
        class="nested-card-item"
        style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 0.75rem; box-shadow: 0 1px 3px rgba(0,0,0,0.02);"
        :id="'data-row-' + (parentPath ? parentPath + '-' + arrayKey : arrayKey) + '-' + idx"
      >
        <!-- Item Header -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; border-bottom: 1px dashed var(--border-color); padding-bottom: 0.35rem;">
          <span style="font-size: 0.75rem; font-weight: 700; color: var(--color-primary);">
            #{{ idx + 1 }} {{ arrayKey }}
          </span>
          <button 
            type="button"
            class="btn-icon-only text-danger" 
            style="height: 22px; width: 22px; min-width: 22px; font-size: 0.75rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none;"
            title="Elimina element"
            @click="deleteNestedItem(idx)"
          >
            🗑️
          </button>
        </div>

        <!-- Primitive Fields Form Grid -->
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.5rem; margin-bottom: 0.5rem;">
          <div v-for="(val, fKey) in getPrimitiveFields(item)" :key="fKey" style="display: flex; flex-direction: column; gap: 2px;">
            <label style="font-size: 0.7rem; font-weight: 600; color: var(--text-muted); margin: 0;">{{ fKey }}</label>
            <input 
              type="text" 
              v-model="item[fKey]" 
              class="data-input" 
              style="height: 30px; font-size: 0.8rem; padding: 2px 8px;"
              :id="'data-field-' + (parentPath ? parentPath + '-' + arrayKey : arrayKey) + '-' + idx + '-' + fKey"
              :data-path="getItemPath(idx, fKey)"
            />
          </div>
        </div>

        <!-- Recursive Child Hierarchies (e.g. activitats inside partida, costos inside activitat) -->
        <template v-for="subArrayKey in getNestedArrayKeys(item)" :key="subArrayKey">
          <NestedDataNode 
            :parentObj="item"
            :arrayKey="subArrayKey"
            :parentPath="getItemPath(idx, '')"
          />
        </template>
      </div>
    </div>
  </div>
</template>
