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
import { reactive, watch, onMounted, onUnmounted } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';

const props = defineProps({
  isOpen: Boolean
});

const emit = defineEmits(['close']);
const store = useWorkspaceStore();

// Local copy for cancellation
const localConfig = reactive({ ...store.config });

const handleKeydown = (e) => {
  if (!props.isOpen) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  } else if (e.key === 'Enter') {
    const tag = e.target?.tagName?.toLowerCase();
    if (tag === 'textarea' && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    saveSettings();
  }
};

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
});

// Sync config local copies when opening modal
watch(() => props.isOpen, (newVal) => {
  if (newVal) {
    Object.assign(localConfig, store.config);
  }
});

const saveSettings = () => {
  Object.assign(store.config, localConfig);
  localStorage.setItem('showButtonTexts', store.config.showButtonTexts ? 'true' : 'false');
  localStorage.setItem('labelPosition', store.config.labelPosition || 'top');
  localStorage.setItem('autoSaveDebounceSeconds', String(store.config.autoSaveDebounceSeconds || 5));
  store.addLog("Configuració de motors, rendiment i interfície desada reactivament.", "success");
  emit('close');
};

const resetSettings = () => {
  localConfig.pyIndex = 'https://cdn.jsdelivr.net/pyodide/v0.29.4/full/';
  localConfig.pandocUrl = './vendor/pandoc/pandoc.js';
  localConfig.pandocWasmUrl = './pandoc.wasm';
  localConfig.dateFormat = 'iso';
  localConfig.strictMode = false;
  localConfig.useDefaultRef = true;
  localConfig.mainThreadPandoc = true;
  localConfig.showButtonTexts = true;
  localConfig.labelPosition = 'top';
  localConfig.autoSaveDebounceSeconds = 5;
};
</script>

<template>
  <div class="modal-overlay" :style="{ display: isOpen ? 'flex' : 'none' }">
    <div class="modal-content">
      <div class="modal-header">
        <h3 style="border: none; padding-bottom: 0; margin: 0;">Configuració Avançada</h3>
        <button 
          class="btn-icon-only" 
          style="border:none; background:none; font-size:1.5rem; line-height:1"
          @click="emit('close')"
        >
          &times;
        </button>
      </div>
      
      <div class="modal-body">
        <!-- Interface Preferences -->
        <div style="font-size: 0.85rem; font-weight: bold; color: var(--color-primary); margin-bottom: 0.5rem; text-transform: uppercase; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">
          🖥️ Interfície i Rendiment
        </div>

        <div class="form-row" style="margin-bottom: 0.85rem;">
          <label for="cfgDebounceSec" style="font-weight: 600;">Temps d'espera per al desat i recàlcul automàtic (segons)</label>
          <input 
            type="number" 
            id="cfgDebounceSec" 
            v-model.number="localConfig.autoSaveDebounceSeconds" 
            min="1" 
            max="60"
            style="width: 100%; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border-color); font-size: 0.85rem;"
          >
          <span style="font-size: 0.72rem; color: var(--text-muted); display: block; margin-top: 2px;">
            Temps en segons després del darrer canvi o en sortir de la cel·la (blur) per executar el desat, recàlcul i històric (Defecte: 5s).
          </span>
        </div>

        <div class="form-row" style="margin-bottom: 0.85rem;">
          <label for="cfgLabelPosition" style="font-weight: 600;">Posició de les etiquetes als formularis de dades</label>
          <select id="cfgLabelPosition" v-model="localConfig.labelPosition" style="width: 100%; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border-color); font-size: 0.85rem;">
            <option value="top">A dalt (Superiors - per defecte)</option>
            <option value="left">A l'esquerra</option>
          </select>
        </div>

        <div class="checkbox-row" style="margin-bottom: 1.25rem;">
          <input type="checkbox" id="cfgShowButtonTexts" v-model="localConfig.showButtonTexts">
          <label for="cfgShowButtonTexts" style="display:inline; margin:0; text-transform:none; font-weight: 600;">
            Mostra els textos als botons de les eines (si es desactiva, es mostraran només les icones amb consells al passar el cursor)
          </label>
        </div>

        <div style="font-size: 0.85rem; font-weight: bold; color: var(--color-primary); margin-bottom: 0.5rem; text-transform: uppercase; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">
          ⚙️ Motors de Compilació
        </div>

        <div class="form-row">
          <label for="cfgPyIndex">Pyodide CDN URL</label>
          <input type="text" id="cfgPyIndex" v-model="localConfig.pyIndex">
        </div>
        
        <div class="form-row">
          <label for="cfgPandocUrl">Pandoc Mòdul JS (Local o CDN)</label>
          <input type="text" id="cfgPandocUrl" v-model="localConfig.pandocUrl">
        </div>
        
        <div class="form-row">
          <label for="cfgPandocWasm">Pandoc WASM URL (Local o CDN)</label>
          <input type="text" id="cfgPandocWasm" v-model="localConfig.pandocWasmUrl">
        </div>
        
        <div class="form-row">
          <label for="cfgDateFormat">Format de Dates al JSON</label>
          <select id="cfgDateFormat" v-model="localConfig.dateFormat">
            <option value="iso">ISO (AAAA-MM-DD)</option>
            <option value="excel">Excel (DD/MM/AAAA)</option>
          </select>
        </div>
        
        <div class="checkbox-row">
          <input type="checkbox" id="cfgStrictMode" v-model="localConfig.strictMode">
          <label for="cfgStrictMode" style="display:inline; margin:0; text-transform:none;">
            Activa el mode estricte en la jerarquia de l'Excel
          </label>
        </div>
        
        <div class="checkbox-row">
          <input type="checkbox" id="cfgMainThreadPandoc" v-model="localConfig.mainThreadPandoc">
          <label for="cfgMainThreadPandoc" style="display:inline; margin:0; text-transform:none;">
            Inicialitza Pandoc al fil principal de Javascript
          </label>
        </div>
      </div>
      
      <div class="modal-footer">
        <button class="btn btn-secondary" style="width: auto;" @click="resetSettings">Restableix</button>
        <button class="btn btn-primary" style="width: auto;" @click="saveSettings">Desa la configuració</button>
      </div>
    </div>
  </div>
</template>
