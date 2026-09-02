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
 * Jinja2 {% if %}/{% for %}/{% elif %} condition/loop editor, plus its own
 * embedded data browser (reusing the same availableVariables/availableArrays
 * the main Var modal/sidebar computes, passed down as props rather than
 * recomputed here). On apply it reports the final expression string ({{ item
 * in array }} already combined for the for-case) and lets the parent build
 * and insert the actual .jinja-block/.j-branch DOM — that logic also wires
 * ELIF/ELSE buttons back to openBlockModal and shares insertBranchAtCursorOrFooter
 * with the canvas's own "+ ELSE" button, so it stays canvas-level parent state.
 */
import { ref, watch, nextTick } from 'vue';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  blockType: { type: String, default: 'if' }, // 'if' | 'for' | 'elif'
  title: { type: String, default: '' },
  initialExpr: { type: String, default: '' },
  initialForItemVar: { type: String, default: 'item' },
  initialForArrayVar: { type: String, default: '' },
  availableVariables: { type: Array, default: () => [] },
  availableArrays: { type: Array, default: () => [] },
});

const emit = defineEmits(['update:modelValue', 'apply']);

const blockExpr = ref('');
const blockForItemVar = ref('item');
const blockForArrayVar = ref('');
const blockExprInputRef = ref(null);

watch(() => props.modelValue, (open) => {
  if (!open) return;
  blockExpr.value = props.initialExpr || '';
  blockForItemVar.value = props.initialForItemVar || 'item';
  blockForArrayVar.value = props.initialForArrayVar || '';
});

const close = () => emit('update:modelValue', false);

const insertVarIntoExpr = (varPath) => {
  const input = blockExprInputRef.value;
  if (input) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const current = blockExpr.value || '';
    blockExpr.value = current.substring(0, start) + varPath + current.substring(end);
    nextTick(() => {
      input.focus();
      input.selectionStart = input.selectionEnd = start + varPath.length;
    });
  } else {
    blockExpr.value = (blockExpr.value || '') + varPath;
  }
};

const selectArrayForLoop = (arrayPath) => {
  blockForArrayVar.value = arrayPath;
};

const apply = () => {
  const expr = props.blockType === 'for'
    ? `${blockForItemVar.value.trim()} in ${blockForArrayVar.value.trim()}`
    : blockExpr.value.trim();
  if (!expr) return;
  emit('apply', expr);
  emit('update:modelValue', false);
};

defineExpose({ apply });
</script>

<template>
  <div class="modal-overlay" :style="{ display: modelValue ? 'flex' : 'none' }">
    <div class="modal-content" style="max-width: 750px; width: 95%;">
      <div class="modal-header">
        <h3 style="border: none; padding-bottom: 0; margin: 0;">{{ title }}</h3>
        <button class="btn-icon-only" style="border:none; background:none; font-size:1.5rem;" @click="close">&times;</button>
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
              v-model="blockExpr"
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
              <input type="text" v-model="blockForItemVar" placeholder="item" style="font-family: monospace;">
            </div>
            <div class="form-row">
              <label>Array / Llista d'Excel a recórrer</label>
              <input type="text" v-model="blockForArrayVar" placeholder="lots" style="font-family: monospace;">
            </div>

            <div style="background-color: var(--bg-tertiary); padding: 0.75rem; border-radius: 4px; border: 1px solid var(--border-color);">
              <span style="font-size: 0.75rem; font-weight: bold; color: var(--text-secondary); text-transform: uppercase;">Vista prèvia del tag Jinja2</span>
              <pre style="margin-top: 0.25rem; font-family: var(--font-mono); font-size: 0.8rem; color: var(--color-primary);">{% for {{ blockForItemVar }} in {{ blockForArrayVar || '...' }} %}</pre>
            </div>
          </div>
        </div>

        <!-- Right Panel: Data Browser -->
        <div style="border-left: 1px solid var(--border-color); padding-left: 1.25rem;">
          <div style="font-size: 0.8rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 0.5rem; letter-spacing: 0.05em;">
            Navegador de Dades
          </div>

          <div v-if="availableVariables.length === 0 && availableArrays.length === 0" style="font-size:0.75rem; color:var(--text-muted); font-style:italic">
            Carrega un Excel per activar el navegador.
          </div>

          <!-- Variable List for IF/ELIF -->
          <div v-else-if="blockType !== 'for'" style="max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 0.4rem; padding-right: 2px;">
            <div
              v-for="v in availableVariables"
              :key="v.path"
              class="variable-item present"
              :style="v.isContext ? 'margin: 0; font-size: 0.75rem; padding: 4px 6px; background-color: var(--color-success-light); border-left: 3px solid var(--color-success); justify-content: space-between;' : (v.category === 'array' || v.category === 'arrayExpr' ? 'margin: 0; font-size: 0.75rem; padding: 4px 6px; background-color: var(--color-primary-light); justify-content: space-between;' : 'margin: 0; font-size: 0.75rem; padding: 4px 6px; justify-content: space-between;')"
              @click="insertVarIntoExpr(v.path)"
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
        <button class="btn btn-secondary" style="width: auto;" @click="close">Cancel·lar</button>
        <button class="btn btn-primary" style="width: auto;" @click="apply">Aplicar</button>
      </div>
    </div>
  </div>
</template>
