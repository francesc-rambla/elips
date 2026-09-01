<script setup>
/**
 * Presentational modal listing the special-character categories (typography,
 * quotes/marks, math symbols) TemplateEditor.vue offers for insertion. Kept
 * purely presentational on purpose: inserting the chosen character touches
 * shared editor state (cursor selection, visual/code sync) that lives in the
 * parent, so this component only reports *which* item was picked via the
 * `select` event and lets the parent do the actual insertion.
 */
defineProps({
  modelValue: { type: Boolean, default: false },
  categories: { type: Array, default: () => [] },
});

const emit = defineEmits(['update:modelValue', 'select']);

const close = () => emit('update:modelValue', false);
</script>

<template>
  <div class="modal-overlay" :style="{ display: modelValue ? 'flex' : 'none' }">
    <div class="modal-content" style="max-width: 580px; width: 95%;">
      <div class="modal-header">
        <h3 style="border: none; padding-bottom: 0; margin: 0; display: flex; align-items: center; gap: 8px;">
          <span style="color: var(--color-primary); font-size: 1.1rem; font-weight: bold;">Ω</span>
          <span>Caràcters Especials</span>
        </h3>
        <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem;" @click="close">&times;</button>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; gap: 1.2rem; max-height: 420px; overflow-y: auto;">
        <div v-for="cat in categories" :key="cat.name" style="display: flex; flex-direction: column; gap: 6px;">
          <div style="font-size: 0.75rem; font-weight: bold; color: var(--color-primary); text-transform: uppercase; border-bottom: 1px solid var(--border-color); padding-bottom: 3px;">
            {{ cat.name }}
          </div>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 6px;">
            <button
              v-for="item in cat.chars"
              :key="item.name"
              class="btn btn-secondary"
              style="display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; font-size: 0.8rem; height: auto; text-align: left;"
              @click="emit('select', item)"
              :title="`${item.name} (${item.code})`"
            >
              <span style="font-weight: bold; font-size: 1.1rem; color: var(--text-primary); font-family: var(--font-mono);">{{ item.label || item.char }}</span>
              <span style="font-size: 0.65rem; color: var(--text-muted); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 75px;">{{ item.name }}</span>
            </button>
          </div>
        </div>
      </div>
      <div class="modal-footer" style="margin-top: 1rem;">
        <button class="btn btn-secondary" style="width: auto;" @click="close">Tancar</button>
      </div>
    </div>
  </div>
</template>
