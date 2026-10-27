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
import { reactive, ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { KNOWN_SIGNALING_SERVERS } from '../utils/collabSignalingServers';

const props = defineProps({
  isOpen: Boolean
});

const emit = defineEmits(['close']);
const store = useWorkspaceStore();

// Local copy for cancellation. collabSignalingServers és un array -- cal
// clonar-lo explícitament (no n'hi ha prou amb el spread superficial
// `{...store.config}`, que copiaria la MATEIXA referència) perquè afegir/
// treure servidors mentre el modal és obert no muti store.config abans de
// prémer "Desa la configuració".
const localConfig = reactive({
  ...store.config,
  collabSignalingServers: JSON.parse(JSON.stringify(store.config.collabSignalingServers || [])),
});

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
    localConfig.collabSignalingServers = JSON.parse(JSON.stringify(store.config.collabSignalingServers || []));
  }
});

const saveSettings = () => {
  Object.assign(store.config, localConfig);
  localStorage.setItem('showButtonTexts', store.config.showButtonTexts ? 'true' : 'false');
  localStorage.setItem('labelPosition', store.config.labelPosition || 'top');
  localStorage.setItem('autoSaveDebounceSeconds', String(store.config.autoSaveDebounceSeconds || 5));
  localStorage.setItem('collabPollIntervalSeconds', String(store.config.collabPollIntervalSeconds || 5));
  localStorage.setItem('collabCaptureDebounceSeconds', String(store.config.collabCaptureDebounceSeconds || 5));
  localStorage.setItem('collabSignalingServers', JSON.stringify(store.config.collabSignalingServers || []));
  localStorage.setItem('collabPreferredSignalingServer', store.config.collabPreferredSignalingServer || '');
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
  localConfig.collabPollIntervalSeconds = 5;
  localConfig.collabCaptureDebounceSeconds = 5;
  localConfig.collabSignalingServers = JSON.parse(JSON.stringify(KNOWN_SIGNALING_SERVERS));
  localConfig.collabPreferredSignalingServer = '';
};

const newSignalingUrl = ref('');
const newSignalingLabel = ref('');
const isValidNewSignalingUrl = computed(() => /^wss?:\/\/.+/.test(newSignalingUrl.value.trim()));

// Afegeix un servidor de senyalització nou a la llista local (no es desa a
// localStorage fins a "Desa la configuració", mateix criteri que la resta
// de camps d'aquest modal).
const addSignalingServer = () => {
  const url = newSignalingUrl.value.trim();
  if (!/^wss?:\/\/.+/.test(url)) return;
  if (localConfig.collabSignalingServers.some((s) => s.url === url)) {
    alert('Ja hi ha un servidor amb aquesta URL a la llista.');
    return;
  }
  localConfig.collabSignalingServers.push({ url, label: newSignalingLabel.value.trim() || url });
  newSignalingUrl.value = '';
  newSignalingLabel.value = '';
};

const removeSignalingServer = (idx) => {
  const server = localConfig.collabSignalingServers[idx];
  if (!confirm(`Segur que vols eliminar el servidor '${server.label || server.url}' de la llista?`)) return;
  if (localConfig.collabPreferredSignalingServer === server.url) {
    localConfig.collabPreferredSignalingServer = '';
  }
  localConfig.collabSignalingServers.splice(idx, 1);
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
          🔗 Col·laboració (carpeta compartida)
        </div>

        <div class="form-row" style="margin-bottom: 0.85rem;">
          <label for="cfgCollabPollSec" style="font-weight: 600;">Interval de sondeig de canvis d'altres persones (segons)</label>
          <input
            type="number"
            id="cfgCollabPollSec"
            v-model.number="localConfig.collabPollIntervalSeconds"
            min="1"
            max="60"
            style="width: 100%; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border-color); font-size: 0.85rem;"
          >
          <span style="font-size: 0.72rem; color: var(--text-muted); display: block; margin-top: 2px;">
            Cada quants segons es rellegeix la carpeta de col·laboració per incorporar canvis d'altres persones (Defecte: 5s). Només té efecte amb una carpeta connectada.
          </span>
        </div>

        <div class="form-row" style="margin-bottom: 1.25rem;">
          <label for="cfgCollabCaptureSec" style="font-weight: 600;">Temps d'espera per desar els propis canvis a la carpeta (segons)</label>
          <input
            type="number"
            id="cfgCollabCaptureSec"
            v-model.number="localConfig.collabCaptureDebounceSeconds"
            min="1"
            max="60"
            style="width: 100%; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border-color); font-size: 0.85rem;"
          >
          <span style="font-size: 0.72rem; color: var(--text-muted); display: block; margin-top: 2px;">
            Temps en segons després del darrer canvi per desar-lo al propi fitxer de deltes de la carpeta de col·laboració (Defecte: 5s).
          </span>
        </div>

        <div style="font-size: 0.85rem; font-weight: bold; color: var(--color-primary); margin-bottom: 0.5rem; text-transform: uppercase; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">
          📡 Sessió en viu (WebRTC) — servidors de senyalització
        </div>

        <div style="margin-bottom: 0.5rem;">
          <span style="font-size: 0.72rem; color: var(--text-muted); display: block;">
            Servidors gratuïts de tercers, sense garantia de disponibilitat. El marcat com a
            preferit es prova primer; si falla, se't preguntarà si vols provar la resta. Sense
            cap preferit, es proven tots seguits, en ordre.
          </span>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 0.5rem;">
          <div
            v-for="(server, idx) in localConfig.collabSignalingServers"
            :key="server.url"
            style="display: flex; align-items: center; gap: 8px; font-size: 0.82rem;"
          >
            <input
              type="radio"
              name="cfgPreferredSignaling"
              :id="`cfgSignalingPreferred${idx}`"
              :checked="localConfig.collabPreferredSignalingServer === server.url"
              @change="localConfig.collabPreferredSignalingServer = server.url"
              title="Fes-lo servir com a preferit"
            >
            <label :for="`cfgSignalingPreferred${idx}`" style="flex: 1; overflow: hidden; cursor: pointer; margin: 0; text-transform: none;">
              <div style="font-weight: 600;">{{ server.label || server.url }}</div>
              <div style="font-size: 0.72rem; color: var(--text-muted); font-family: monospace; overflow-x: auto; white-space: nowrap;">{{ server.url }}</div>
            </label>
            <button
              type="button"
              class="btn-icon-only"
              style="color: var(--color-danger); border: none; background: transparent; cursor: pointer; padding: 4px;"
              title="Elimina aquest servidor de la llista"
              @click="removeSignalingServer(idx)"
            >&times;</button>
          </div>
          <div v-if="localConfig.collabSignalingServers.length === 0" style="font-size: 0.78rem; color: var(--text-muted);">
            Cap servidor configurat.
          </div>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 0.8rem; margin: 2px 0 0; cursor: pointer; text-transform: none;">
            <input
              type="radio"
              name="cfgPreferredSignaling"
              :checked="!localConfig.collabPreferredSignalingServer"
              @change="localConfig.collabPreferredSignalingServer = ''"
            >
            Cap preferit (prova'ls tots seguits, en ordre)
          </label>
        </div>

        <div style="display: flex; gap: 6px; margin-bottom: 1.25rem;">
          <input
            type="text"
            v-model="newSignalingUrl"
            placeholder="wss://el-teu-servidor..."
            style="flex: 1; min-width: 0; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border-color); font-size: 0.82rem;"
          >
          <input
            type="text"
            v-model="newSignalingLabel"
            placeholder="Nom (opcional)"
            style="width: 140px; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border-color); font-size: 0.82rem;"
          >
          <button
            type="button"
            class="btn btn-secondary"
            style="width: auto; padding: 6px 12px; font-size: 0.8rem; flex-shrink: 0;"
            :disabled="!isValidNewSignalingUrl"
            @click="addSignalingServer"
          >
            Afegeix
          </button>
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
