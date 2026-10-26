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
import { ref, watch } from 'vue';

// Connect/disconnect a collaboration folder for the CURRENT project, its
// permission lifecycle, the display name shown to other participants, and
// (Fase 5) the live participant list + activity log fed by useCollabSync.js.
const props = defineProps({
  isOpen: { type: Boolean, default: false },
  isCollabSupported: { type: Boolean, default: false },
  folderStatus: { type: String, default: 'disconnected' }, // 'unsupported' | 'disconnected' | 'needs-permission' | 'connected' | 'error'
  folderName: { type: String, default: '' },
  displayName: { type: String, default: '' },
  connectedPeers: { type: Array, default: () => [] },
  activityLog: { type: Array, default: () => [] },
});

const emit = defineEmits(['close', 'connect', 'disconnect', 'request-permission', 'update-display-name']);

const nameInput = ref(props.displayName);
watch(() => props.displayName, (v) => { nameInput.value = v; });

const saveDisplayName = () => {
  if (nameInput.value.trim() !== props.displayName) {
    emit('update-display-name', nameInput.value.trim());
  }
};

const statusLabel = {
  unsupported: 'No disponible en aquest navegador',
  disconnected: 'Sense connectar',
  'needs-permission': 'Cal tornar a concedir permís',
  connected: 'Connectat',
  error: 'Error de connexió',
};
</script>

<template>
  <div class="modal-overlay" :style="{ display: isOpen ? 'flex' : 'none' }" @click.self="emit('close')">
    <div class="modal-content" style="max-width: 460px; width: 90%;">
      <div class="modal-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary);"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <h3 style="margin: 0; font-size: 1.1rem; font-weight: 700; color: var(--text-primary);">Col·laboració</h3>
        </div>
        <button type="button" class="btn-close" @click="emit('close')" title="Tanca">×</button>
      </div>

      <div class="modal-body" style="display: flex; flex-direction: column; gap: 1rem; padding: 1rem 0;">
        <template v-if="!isCollabSupported">
          <p style="font-size: 0.85rem; color: var(--text-secondary); padding: 0 1.25rem;">
            La col·laboració en viu requereix una carpeta compartida (p. ex. dins el vostre OneDrive
            sincronitzat) accessible mitjançant la File System Access API del navegador, disponible
            només a <strong>Chrome</strong> i <strong>Edge</strong>.
          </p>
        </template>
        <template v-else>
          <div style="padding: 0 1.25rem; display: flex; flex-direction: column; gap: 4px;">
            <label style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);">El vostre nom (visible per als altres participants)</label>
            <div style="display: flex; gap: 6px;">
              <input
                type="text"
                v-model="nameInput"
                class="data-input"
                placeholder="El vostre nom..."
                style="font-size: 0.85rem; height: 32px; padding: 2px 8px;"
                @keyup.enter="saveDisplayName"
                @blur="saveDisplayName"
              >
            </div>
          </div>

          <div style="padding: 0 1.25rem; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border-color); padding-top: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 0.85rem; color: var(--text-secondary);">Estat:</span>
              <span style="font-size: 0.85rem; font-weight: 700;" :style="{ color: folderStatus === 'connected' ? 'var(--color-success, #16a34a)' : (folderStatus === 'error' ? 'var(--color-danger, #dc2626)' : 'var(--text-primary)') }">
                {{ statusLabel[folderStatus] || folderStatus }}
              </span>
            </div>
            <div v-if="folderStatus === 'connected'" style="font-size: 0.8rem; color: var(--text-muted); font-family: monospace;">
              📁 {{ folderName }}
            </div>

            <div style="display: flex; gap: 8px; margin-top: 4px;">
              <button
                v-if="folderStatus === 'disconnected' || folderStatus === 'error'"
                class="btn btn-primary"
                style="width: auto; padding: 6px 14px; font-size: 0.8rem;"
                @click="emit('connect')"
              >
                📁 Connecta una carpeta
              </button>
              <button
                v-if="folderStatus === 'needs-permission'"
                class="btn btn-primary"
                style="width: auto; padding: 6px 14px; font-size: 0.8rem;"
                @click="emit('request-permission')"
              >
                🔓 Reconnecta la carpeta
              </button>
              <button
                v-if="folderStatus === 'connected'"
                class="btn btn-secondary text-danger"
                style="width: auto; padding: 6px 14px; font-size: 0.8rem;"
                @click="emit('disconnect')"
              >
                Desconnecta
              </button>
            </div>
          </div>

          <div v-if="folderStatus === 'connected'" style="padding: 0 1.25rem; display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border-color); padding-top: 1rem;">
            <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);">Participants connectats</span>
            <div v-if="connectedPeers.length === 0" style="font-size: 0.8rem; color: var(--text-muted);">
              Cap altra persona connectada encara.
            </div>
            <div v-for="peer in connectedPeers" :key="peer.userId" style="display: flex; justify-content: space-between; align-items: center; font-size: 0.82rem;">
              <span>
                <span :style="{ color: peer.isStale ? 'var(--text-muted)' : 'var(--color-success, #16a34a)' }">●</span>
                {{ peer.displayName }}
              </span>
              <span v-if="!peer.isSelf" style="font-size: 0.72rem; color: var(--text-muted);">
                {{ peer.isStale ? 'possiblement desconnectat' : 'actiu' }}
              </span>
            </div>
          </div>

          <div v-if="folderStatus === 'connected' && activityLog.length" style="padding: 0 1.25rem; display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border-color); padding-top: 1rem;">
            <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);">Activitat recent</span>
            <div style="max-height: 160px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;">
              <div
                v-for="(entry, idx) in activityLog"
                :key="idx"
                style="font-size: 0.75rem; display: flex; gap: 6px;"
                :style="{ color: entry.type === 'error' ? 'var(--color-danger, #dc2626)' : (entry.type === 'warning' ? '#b45309' : 'var(--text-secondary)') }"
              >
                <span style="font-family: monospace; color: var(--text-muted); flex-shrink: 0;">{{ entry.time }}</span>
                <span>{{ entry.text }}</span>
              </div>
            </div>
          </div>
        </template>
      </div>

      <div class="modal-footer" style="display: flex; justify-content: flex-end; padding-top: 0.75rem; border-top: 1px solid var(--border-color);">
        <button class="btn btn-secondary" @click="emit('close')">Tanca</button>
      </div>
    </div>
  </div>
</template>
