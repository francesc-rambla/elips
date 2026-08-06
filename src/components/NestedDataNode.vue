<script setup>
import { computed } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';

const props = defineProps({
  parentObj: {
    type: Object,
    required: true
  },
  arrayKey: {
    type: String,
    required: true
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

const cleanPath = (p) => {
  if (!p) return '';
  return String(p).replace(/\.\d+\b/g, '').replace(/^#?(dades|doc)\./, '');
};

const fullPath = computed(() => {
  return props.parentPath ? `${props.parentPath}.${props.arrayKey}` : props.arrayKey;
});

const effectiveSchemaPath = computed(() => {
  if (props.schemaPath) {
    return cleanPath(props.schemaPath);
  }
  return cleanPath(fullPath.value);
});

const nodeSchema = computed(() => {
  return store.hierarchySchema?.[effectiveSchemaPath.value] || { fields: [], children: [] };
});

const childKeys = computed(() => {
  const schemaChildren = nodeSchema.value.children || [];
  const itemChildren = new Set(schemaChildren);
  
  if (Array.isArray(props.parentObj?.[props.arrayKey])) {
    props.parentObj[props.arrayKey].forEach(item => {
      if (item && typeof item === 'object') {
        Object.keys(item).forEach(k => {
          if (Array.isArray(item[k])) {
            itemChildren.add(k);
          }
        });
      }
    });
  }
  return Array.from(itemChildren);
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

const getPrimitiveFields = (item) => {
  if (!item || typeof item !== 'object') return {};
  const res = {};
  
  // First include fields from schema
  const schemaFields = nodeSchema.value.fields || [];
  schemaFields.forEach(f => {
    if (f !== '_hierarchy_schema') {
      res[f] = item[f] !== undefined ? item[f] : '';
    }
  });

  // Then add any other primitive fields present on item
  Object.keys(item).forEach(k => {
    if (k !== '_hierarchy_schema' && isPrimitive(item[k]) && !(k in res)) {
      res[k] = item[k];
    }
  });
  return res;
};

const getLeafTableHeaders = computed(() => {
  const schemaFields = nodeSchema.value.fields || [];
  if (schemaFields.length > 0) return schemaFields;
  if (items.value.length > 0 && typeof items.value[0] === 'object') {
    return Object.keys(items.value[0]).filter(k => k !== '_hierarchy_schema' && isPrimitive(items.value[0][k]));
  }
  return ['id', 'nom'];
});

const addNestedItem = () => {
  if (!Array.isArray(props.parentObj[props.arrayKey])) {
    props.parentObj[props.arrayKey] = [];
  }
  const list = props.parentObj[props.arrayKey];
  const newRow = {};
  
  // Populate primitive fields from schema or sample
  const fields = nodeSchema.value.fields || [];
  if (fields.length > 0) {
    fields.forEach(f => {
      newRow[f] = '';
    });
  } else if (list.length > 0) {
    Object.keys(list[0]).forEach(k => {
      if (isPrimitive(list[0][k])) {
        newRow[k] = '';
      }
    });
  } else {
    newRow['id'] = `item_${list.length + 1}`;
    newRow['nom'] = '';
  }

  // Initialize child sub-arrays for intermediate nodes
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

const getItemPath = (idx, fieldKey) => {
  return fieldKey !== '' ? `${fullPath.value}.${idx}.${fieldKey}` : `${fullPath.value}.${idx}`;
};

</script>

<template>
  <div class="nested-hierarchy-container" style="margin-top: 0.85rem; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 0.75rem;">
    <!-- Section Header -->
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem;">
      <h5 style="margin: 0; font-size: 0.85rem; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
        <span>📂 Sub-taula: <strong style="color: var(--color-primary);">{{ arrayKey }}</strong></span>
        <span style="font-size: 0.75rem; font-weight: normal; color: var(--text-muted);">({{ items.length }} registres)</span>
        <span v-if="isLeafLevel" style="font-size: 0.68rem; padding: 2px 6px; background: rgba(0,0,0,0.06); border-radius: 4px; font-weight: 500;">Vista Tabular</span>
        <span v-else style="font-size: 0.68rem; padding: 2px 6px; background: var(--color-primary-light, #e0f2fe); color: var(--color-primary, #0284c7); border-radius: 4px; font-weight: 500;">Vista Formularia (Clau-Valor)</span>
      </h5>
      <button 
        type="button"
        class="btn btn-secondary" 
        style="padding: 0.3rem 0.6rem; font-size: 0.75rem; display: flex; align-items: center; gap: 4px;"
        @click="addNestedItem"
      >
        ➕ Afegeix {{ arrayKey }}
      </button>
    </div>

    <!-- Empty State -->
    <div v-if="items.length === 0" style="padding: 0.75rem; font-size: 0.8rem; color: var(--text-muted); font-style: italic; background: rgba(0,0,0,0.02); border-radius: 4px; text-align: center;">
      Sense registres a <strong style="color: var(--text-primary);">{{ arrayKey }}</strong>. Feu clic a <strong>"➕ Afegeix {{ arrayKey }}"</strong> per afegir un element.
    </div>

    <!-- LEAF LEVEL: Render as Compact Tabular Table -->
    <template v-else-if="isLeafLevel">
      <div style="overflow-x: auto; max-width: 100%;">
        <table class="data-table" style="width: 100%; border-collapse: collapse; font-size: 0.8rem;">
          <thead>
            <tr style="background: var(--bg-tertiary);">
              <th v-for="h in getLeafTableHeaders" :key="h" style="padding: 6px 8px; text-align: left; border-bottom: 2px solid var(--border-color); font-weight: 600;">
                {{ h }}
              </th>
              <th style="width: 40px; text-align: center; border-bottom: 2px solid var(--border-color);"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rIdx) in items" :key="rIdx">
              <td v-for="h in getLeafTableHeaders" :key="h" style="padding: 4px 6px; border-bottom: 1px solid var(--border-color);">
                <input 
                  type="text" 
                  v-model="row[h]" 
                  class="data-input" 
                  style="width: 100%; height: 28px; font-size: 0.78rem; padding: 2px 6px;"
                  :id="'data-field-' + fullPath + '-' + rIdx + '-' + h"
                  :data-path="getItemPath(rIdx, h)"
                />
              </td>
              <td style="padding: 4px 6px; border-bottom: 1px solid var(--border-color); text-align: center;">
                <button 
                  type="button"
                  class="btn-icon-only text-danger" 
                  style="height: 24px; width: 24px; min-width: 24px; font-size: 0.75rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none;"
                  title="Elimina fila"
                  @click="deleteNestedItem(rIdx)"
                >
                  🗑️
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- INTERMEDIATE LEVEL: Render as Form Cards with Sub-Hierarchies -->
    <template v-else>
      <div style="display: flex; flex-direction: column; gap: 0.75rem;">
        <div 
          v-for="(item, idx) in items" 
          :key="idx"
          class="nested-card-item"
          style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 0.75rem; box-shadow: 0 1px 3px rgba(0,0,0,0.04);"
        >
          <!-- Card Header -->
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; padding-bottom: 0.25rem; border-bottom: 1px dashed var(--border-color);">
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

          <!-- Primitive Fields Form Grid (Key-Value style) -->
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.5rem; margin-bottom: 0.5rem;">
            <div v-for="(val, fKey) in getPrimitiveFields(item)" :key="fKey" style="display: flex; flex-direction: column; gap: 2px;">
              <label style="font-size: 0.7rem; font-weight: 600; color: var(--text-muted); margin: 0;">{{ fKey }}</label>
              <input 
                type="text" 
                v-model="item[fKey]" 
                class="data-input" 
                style="height: 30px; font-size: 0.8rem; padding: 2px 8px;"
                :id="'data-field-' + fullPath + '-' + idx + '-' + fKey"
                :data-path="getItemPath(idx, fKey)"
              />
            </div>
          </div>

          <!-- Child Hierarchies -->
          <template v-for="cKey in childKeys" :key="cKey">
            <NestedDataNode 
              :parentObj="item"
              :arrayKey="cKey"
              :schemaPath="`${effectiveSchemaPath}.${cKey}`"
              :parentPath="getItemPath(idx, '')"
            />
          </template>
        </div>
      </div>
    </template>
  </div>
</template>
