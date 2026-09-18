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
// Editable Text-type field: shows its value as processed Markdown by
// default, and swaps to a raw-source textarea while it's being edited
// (click or focus in, blur back out). Used in place of a plain
// input/textarea everywhere a "Text" field is rendered (DataInspector.vue,
// NestedDataNode.vue's leaf table, NestedItemForm.vue), so the toggle
// behaves identically in all three.
import { ref, computed, nextTick } from 'vue';
import { marked } from 'marked';

const props = defineProps({
  modelValue: { type: [String, Number], default: '' }
});
const emit = defineEmits(['update:modelValue', 'blur']);

const isEditing = ref(false);
const textareaRef = ref(null);

const rawText = computed(() => props.modelValue != null ? String(props.modelValue) : '');

const renderedHtml = computed(() => rawText.value.trim() ? marked.parse(rawText.value) : '');

const enterEdit = () => {
  isEditing.value = true;
  nextTick(() => textareaRef.value?.focus());
};

const exitEdit = (event) => {
  isEditing.value = false;
  emit('blur', event);
};
</script>

<template>
  <textarea
    v-if="isEditing"
    ref="textareaRef"
    :value="rawText"
    @input="$emit('update:modelValue', $event.target.value)"
    @blur="exitEdit"
    class="markdown-field-source"
    rows="1"
  ></textarea>
  <div
    v-else
    class="markdown-field-preview"
    tabindex="0"
    title="Fes clic per editar el text font"
    @click="enterEdit"
    @focus="enterEdit"
  >
    <div v-if="renderedHtml" class="markdown-field-rendered" v-html="renderedHtml"></div>
    <span v-else class="markdown-field-placeholder">Clica per editar…</span>
  </div>
</template>

<style scoped>
.markdown-field-preview,
.markdown-field-source {
  width: 100%;
  box-sizing: border-box;
}

.markdown-field-preview {
  cursor: text;
  overflow: auto;
  white-space: normal;
}

.markdown-field-placeholder {
  color: var(--text-muted);
  font-style: italic;
}

.markdown-field-rendered :deep(p) {
  margin: 0;
}

.markdown-field-rendered :deep(p + p) {
  margin-top: 0.4em;
}

.markdown-field-rendered :deep(ul),
.markdown-field-rendered :deep(ol) {
  margin: 0.2em 0 0.2em 1.1em;
  padding: 0;
}

.markdown-field-rendered :deep(code) {
  font-family: var(--font-mono), monospace;
  font-size: 0.92em;
}

.markdown-field-source {
  resize: vertical;
  font-family: var(--font-mono), monospace;
}
</style>
