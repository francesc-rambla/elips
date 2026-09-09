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
import { useWorkspaceStore } from '../stores/workspace';
import NestedDataNode from './NestedDataNode.vue';

// Extracted from NestedDataNode.vue's own "INTERMEDIATE LEVEL" accordion
// body (the field-grid for one row's primitive fields, plus its recursive
// nested children) so the SAME markup can be reused in two contexts:
// inline, one instance per row, when a group's view mode is 'form' (today's
// behaviour, unchanged); and inside the new row-edit modal, one instance for
// whichever single row is being edited, when a group's view mode is 'table'
// (leaf sheets in form mode, or intermediate groups in table mode -- see
// NestedDataNode.vue's own view-mode dispatch). `item` is mutated directly
// via v-model, exactly as before -- no staged copy, autosave same as
// everywhere else in this app.
//
// `helpers` bundles the handful of NestedDataNode.vue-local functions this
// form needs to call back into (getFieldLabel/getElementType/
// getElementMetadata/openMultiSelectModal/getSelectedPills/
// resolveSelectOptions/getItemPath/openCellEditor/getFieldCardStyle/
// getItemRowBlocks) -- they stay defined ONCE in NestedDataNode.vue (its
// own leaf table needs several of them too) and are simply passed down by
// reference rather than duplicated here.
const props = defineProps({
  item: { type: Object, required: true },
  idx: { type: Number, required: true },
  fullPath: { type: String, required: true },
  childKeys: { type: Array, default: () => [] },
  childSchemas: { type: Object, default: () => ({}) },
  nestingDepth: { type: Number, default: 0 },
  helpers: { type: Object, required: true }
});

const store = useWorkspaceStore();
</script>

<template>
  <!-- FORM GRID ROW BLOCKS FOR NESTED ITEM PRIMITIVE FIELDS -->
  <div style="display: flex; flex-direction: column; gap: 0.5rem; width: 100%; margin-bottom: 0.75rem;">
    <div
      v-for="(rowBlock, rIdx) in helpers.getItemRowBlocks(item)"
      :key="'item-row-' + rIdx"
      class="form-grid-row"
      style="display: flex; flex-wrap: wrap; align-items: stretch; gap: 0.75rem; width: 100%;"
    >
      <div
        v-for="entry in rowBlock"
        :key="entry.key"
        :style="helpers.getFieldCardStyle(entry.key)"
      >
        <!-- Label Header -->
        <div
          :style="store.config.labelPosition === 'top'
            ? 'display: flex; align-items: center; gap: 6px;'
            : 'width: 220px; min-width: 180px; display: flex; align-items: center; gap: 6px;'"
        >
          <span
            style="font-weight: 600; font-size: 0.8rem; color: var(--text-primary);"
            :style="{ cursor: helpers.getFieldLabel(entry.key) !== entry.key ? 'help' : 'default' }"
            :title="helpers.getFieldLabel(entry.key) !== entry.key ? 'Clau de camp: ' + entry.key : undefined"
          >
            {{ helpers.getFieldLabel(entry.key) }}
          </span>
        </div>

        <!-- Input Controls -->
        <div style="display: flex; gap: 4px; align-items: center; width: 100%; flex-grow: 1;">
          <!-- Calculated Field (Non-editable) -- the isCalculated flag wins
               over whatever the field's own nominal type is (a calculated
               field can be typed Number/Percentage/Text/... and should
               still show this locked style, not its type's normal input),
               matching the leaf table's own dispatch order. -->
          <div
            v-if="helpers.isCalculatedField(entry.key)"
            :id="'data-field-' + fullPath + '-' + idx + '-' + entry.key"
            :data-path="helpers.getItemPath(idx, entry.key)"
            style="display: flex; align-items: center; gap: 6px; flex-grow: 1; height: 32px; padding: 2px 10px; border: 1px solid var(--border-color); border-radius: var(--radius-xs); background: var(--bg-tertiary); color: var(--text-primary); font-family: var(--font-mono); font-size: 0.85rem; font-weight: 600; cursor: not-allowed;"
            title="🔒 Camp calculat automàticament"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary); flex-shrink: 0;"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/></svg>
            <span style="flex-grow: 1;">{{ helpers.getElementType(entry.key) === 'Percentage' ? (helpers.formatPercentageDisplay(item[entry.key]) + ' %') : (item[entry.key] !== undefined ? item[entry.key] : 0) }}</span>
            <span style="font-size: 0.7rem; color: var(--text-muted); font-weight: normal; background: rgba(0,0,0,0.06); padding: 1px 5px; border-radius: 4px;">Calculat</span>
          </div>

          <!-- Select Type -->
          <template v-else-if="helpers.getElementType(entry.key) === 'Select'">
            <!-- Multiple select -->
            <div
              v-if="helpers.getElementMetadata(entry.key)?.multiple"
              :id="'data-field-' + fullPath + '-' + idx + '-' + entry.key"
              :data-path="helpers.getItemPath(idx, entry.key)"
              style="display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 32px; padding: 4px 8px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); flex-grow: 1; cursor: pointer; max-width: 100%; max-height: 80px; overflow-y: auto;"
              @click="helpers.openMultiSelectModal(item, entry.key, helpers.getElementMetadata(entry.key))"
              title="Fes clic per modificar la selecció"
            >
              <span v-if="helpers.getSelectedPills(item[entry.key], helpers.getElementMetadata(entry.key)).length === 0" style="color: var(--text-muted); font-size: 0.8rem;">
                [Tria opcions]
              </span>
              <span
                v-for="pill in helpers.getSelectedPills(item[entry.key], helpers.getElementMetadata(entry.key))"
                :key="pill.value"
                style="background-color: var(--color-primary-light, #e0f2fe); color: var(--color-primary, #0284c7); font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; font-weight: 500; display: inline-block; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                :title="pill.label"
              >
                {{ pill.label }}
              </span>
            </div>
            <!-- Single select -->
            <select
              v-else
              :id="'data-field-' + fullPath + '-' + idx + '-' + entry.key"
              :data-path="helpers.getItemPath(idx, entry.key)"
              v-model="item[entry.key]"
              class="data-input"
              style="flex-grow: 1; height: 32px;"
            >
              <option value="">[Buit / Sense valor]</option>
              <option
                v-for="opt in helpers.resolveSelectOptions(helpers.getElementMetadata(entry.key))"
                :key="opt.value"
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
            </select>
          </template>

          <!-- Date Type -->
          <input
            v-else-if="helpers.getElementType(entry.key) === 'Date'"
            :id="'data-field-' + fullPath + '-' + idx + '-' + entry.key"
            :data-path="helpers.getItemPath(idx, entry.key)"
            type="date"
            v-model="item[entry.key]"
            class="data-input"
            style="flex-grow: 1; height: 32px;"
          >

          <!-- Number Type -->
          <input
            v-else-if="helpers.getElementType(entry.key) === 'Number'"
            :id="'data-field-' + fullPath + '-' + idx + '-' + entry.key"
            :data-path="helpers.getItemPath(idx, entry.key)"
            type="number"
            step="any"
            v-model="item[entry.key]"
            class="data-input"
            style="flex-grow: 1; height: 32px;"
          >

          <!-- Boolean Type -->
          <select
            v-else-if="helpers.getElementType(entry.key) === 'Boolean'"
            :id="'data-field-' + fullPath + '-' + idx + '-' + entry.key"
            :data-path="helpers.getItemPath(idx, entry.key)"
            v-model="item[entry.key]"
            class="data-input"
            style="flex-grow: 1; height: 32px;"
          >
            <option value="">[Buit / Sense valor]</option>
            <option :value="true">Cert (True)</option>
            <option :value="false">Fals (False)</option>
          </select>

          <!-- Text Type (default) -->
          <input
            v-else
            :id="'data-field-' + fullPath + '-' + idx + '-' + entry.key"
            :data-path="helpers.getItemPath(idx, entry.key)"
            type="text"
            v-model="item[entry.key]"
            class="data-input"
            style="flex-grow: 1; height: 32px;"
          >

          <button
            v-if="helpers.getElementType(entry.key) === 'Text'"
            type="button"
            class="btn-icon-only"
            style="height: 32px; width: 32px; min-width: 32px; font-size: 0.9rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: var(--bg-tertiary);"
            title="Edició complexa en Markdown + Jinja2"
            @click="helpers.openCellEditor(item, entry.key)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Child Hierarchies -->
  <!-- parentPath must be the SCHEMA-level path (fullPath, e.g. "pres.parts"), not
       getItemPath(idx, '') (e.g. "pres.parts.0") — the row's own data object is
       already passed correctly via :parentObj="item", but the *group* identifier
       used for editor_metadata/schema lookups must stay shared across every row of
       this table, not be forked per row index. -->
  <template v-for="cKey in childKeys" :key="cKey">
    <NestedDataNode
      :parentObj="item"
      :arrayKey="cKey"
      :schema="childSchemas[cKey] || { fields: [], children: {} }"
      :parentPath="fullPath"
      :nestingDepth="nestingDepth + 1"
    />
  </template>
</template>
