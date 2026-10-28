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
// Fase 11 adds a second, independent transport: a WebRTC+Yjs "live session"
// (useCollabRealtime.js) that works in ANY browser (not gated by
// isCollabSupported, which is specifically about the File System Access
// API the folder transport needs) -- the two can be connected at the same
// time on the same project, see .claude/plans/unified-nibbling-adleman.md.
const props = defineProps({
  isOpen: { type: Boolean, default: false },
  isCollabSupported: { type: Boolean, default: false },
  folderStatus: { type: String, default: 'disconnected' }, // 'unsupported' | 'disconnected' | 'needs-permission' | 'connected' | 'error'
  folderName: { type: String, default: '' },
  displayName: { type: String, default: '' },
  connectedPeers: { type: Array, default: () => [] },
  activityLog: { type: Array, default: () => [] },
  realtimeStatus: { type: String, default: 'disconnected' }, // 'disconnected' | 'connecting' | 'connected' | 'error'
  realtimeError: { type: String, default: null },
  realtimeRoomId: { type: String, default: '' },
  realtimePassword: { type: String, default: '' },
  realtimeDocName: { type: String, default: '' },
  realtimeSignalingServer: { type: String, default: '' },
  realtimePeers: { type: Array, default: () => [] },
  // Fase 14: sol·licitud/transferència del ZIP quan s'és dins
  // `realtimeStatus === 'awaiting-project'` (el nom del projecte de la
  // sessió) o `'receiving-project'` (`{receivedChunks, totalChunks}`,
  // `null` si encara no n'hi ha cap en curs).
  realtimePendingProjectName: { type: String, default: '' },
  realtimeTransferProgress: { type: Object, default: null },
});

const emit = defineEmits([
  'close', 'connect', 'disconnect', 'request-permission', 'update-display-name',
  'start-realtime-session', 'join-realtime-session', 'stop-realtime-session',
  'request-project-transfer',
]);

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

const realtimeStatusLabel = {
  disconnected: 'Sense connectar',
  connecting: 'Connectant...',
  connected: 'Connectat',
  error: 'Error de connexió',
  'awaiting-project': 'Projecte no disponible',
  'receiving-project': 'Rebent el projecte...',
};

const joinRoomIdInput = ref('');
const joinPasswordInput = ref('');
const isPasswordRevealed = ref(false);

const submitJoinRealtimeSession = () => {
  if (!joinRoomIdInput.value.trim() || !joinPasswordInput.value.trim()) return;
  emit('join-realtime-session', { roomId: joinRoomIdInput.value.trim(), password: joinPasswordInput.value.trim() });
  joinRoomIdInput.value = '';
  joinPasswordInput.value = '';
};

const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // Clipboard API pot no estar disponible (p. ex. context no segur) --
    // no és crític, la persona sempre pot seleccionar el text a mà.
  }
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
        <!-- El nom és compartit per totes dues vies (carpeta i sessió en
             viu) -- no gated per isCollabSupported, que és específic de la
             carpeta. -->
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

        <template v-if="!isCollabSupported">
          <p style="font-size: 0.85rem; color: var(--text-secondary); padding: 0 1.25rem;">
            La col·laboració via <strong>carpeta compartida</strong> (p. ex. dins el vostre OneDrive
            sincronitzat) requereix la File System Access API del navegador, disponible
            només a <strong>Chrome</strong> i <strong>Edge</strong>. La <strong>sessió en viu
            (WebRTC)</strong> de més avall funciona igualment en aquest navegador.
          </p>
        </template>
        <template v-else>
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

        <!-- Sessió en viu (WebRTC) -- funciona a qualsevol navegador, no
             gated per isCollabSupported (això és específic de la carpeta,
             que necessita la File System Access API). Pot coexistir amb
             la carpeta compartida sense coordinar-s'hi. -->
        <div style="padding: 0 1.25rem; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border-color); padding-top: 1rem;">
          <span style="font-size: 0.85rem; font-weight: 700; color: var(--text-primary);">📡 Sessió en viu (WebRTC)</span>
          <p style="font-size: 0.78rem; color: var(--text-muted); margin: 0;">
            Edició en temps real amb qualsevol navegador, sense carpeta compartida.
            La plantilla es fusiona caràcter a caràcter mentre la sessió estigui oberta;
            en tancar-se, deixa d'actualitzar-se fins que algú la torni a obrir.
          </p>

          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 0.85rem; color: var(--text-secondary);">Estat:</span>
            <span style="font-size: 0.85rem; font-weight: 700;" :style="{ color: realtimeStatus === 'connected' ? 'var(--color-success, #16a34a)' : (realtimeStatus === 'error' ? 'var(--color-danger, #dc2626)' : 'var(--text-primary)') }">
              {{ realtimeStatusLabel[realtimeStatus] || realtimeStatus }}
            </span>
          </div>
          <div v-if="realtimeStatus === 'error' && realtimeError" style="font-size: 0.78rem; color: var(--color-danger, #dc2626);">
            {{ realtimeError }}
          </div>

          <template v-if="realtimeStatus === 'awaiting-project'">
            <p style="font-size: 0.82rem; color: var(--text-secondary); margin: 0;">
              Aquesta sessió és del projecte <strong>"{{ realtimePendingProjectName }}"</strong>,
              que no tens al teu entorn local.
            </p>
            <button
              class="btn btn-primary"
              style="width: auto; padding: 6px 14px; font-size: 0.8rem; align-self: flex-start;"
              @click="emit('request-project-transfer')"
            >
              📥 Sol·licita el projecte ara
            </button>
            <p style="font-size: 0.72rem; color: var(--text-muted); margin: 0;">
              Qualsevol altra persona ja connectada a aquesta sessió amb el projecte correcte
              te l'enviarà sencer (xifrat igual que la resta de la sessió). Pot trigar uns
              segons segons la mida del projecte i la connexió de qui te l'envia.
            </p>
          </template>

          <template v-if="realtimeStatus === 'receiving-project'">
            <p style="font-size: 0.82rem; color: var(--text-secondary); margin: 0;">
              Rebent el projecte "{{ realtimePendingProjectName }}"...
            </p>
            <div v-if="realtimeTransferProgress && realtimeTransferProgress.totalChunks > 0" style="font-size: 0.78rem; color: var(--text-muted);">
              {{ realtimeTransferProgress.receivedChunks }} / {{ realtimeTransferProgress.totalChunks }} trossos
            </div>
          </template>

          <template v-if="realtimeStatus === 'disconnected' || realtimeStatus === 'error'">
            <button
              class="btn btn-primary"
              style="width: auto; padding: 6px 14px; font-size: 0.8rem; align-self: flex-start;"
              @click="emit('start-realtime-session')"
            >
              🆕 Inicia una sessió nova
            </button>

            <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 4px;">
              <label style="font-size: 0.78rem; font-weight: 600; color: var(--text-secondary);">O uneix-te a una sessió existent</label>
              <p style="font-size: 0.72rem; color: var(--text-muted); margin: 0;">
                Només et pots unir a una sessió del mateix projecte que tens obert ara mateix
                (se t'avisarà i no es connectarà si no coincideix). Un cop dins, cada participant
                pot anar per un document diferent (memòria, plec...) del mateix projecte --
                la sincronització et segueix si en canvies.
              </p>
              <input
                type="text"
                v-model="joinRoomIdInput"
                class="data-input"
                placeholder="Identificador de sala"
                style="font-size: 0.82rem; height: 30px; padding: 2px 8px; font-family: monospace;"
              >
              <input
                type="text"
                v-model="joinPasswordInput"
                class="data-input"
                placeholder="Contrasenya"
                style="font-size: 0.82rem; height: 30px; padding: 2px 8px; font-family: monospace;"
                @keyup.enter="submitJoinRealtimeSession"
              >
              <button
                class="btn btn-secondary"
                style="width: auto; padding: 5px 12px; font-size: 0.78rem; align-self: flex-start;"
                :disabled="!joinRoomIdInput.trim() || !joinPasswordInput.trim()"
                @click="submitJoinRealtimeSession"
              >
                Uneix-te
              </button>
            </div>
          </template>

          <template v-if="realtimeStatus === 'connected'">
            <div style="display: flex; flex-direction: column; gap: 6px;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="font-size: 0.78rem; color: var(--text-secondary); flex-shrink: 0;">Sala:</span>
                <code style="font-size: 0.78rem; background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; flex: 1; overflow-x: auto; white-space: nowrap;">{{ realtimeRoomId }}</code>
                <button type="button" class="btn-icon-only" style="border: none; background: none; cursor: pointer;" title="Copia l'identificador de sala" @click="copyToClipboard(realtimeRoomId)">📋</button>
              </div>
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="font-size: 0.78rem; color: var(--text-secondary); flex-shrink: 0;">Contrasenya:</span>
                <code style="font-size: 0.78rem; background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; flex: 1; overflow-x: auto; white-space: nowrap;">{{ isPasswordRevealed ? realtimePassword : '••••••••••••' }}</code>
                <button type="button" class="btn-icon-only" style="border: none; background: none; cursor: pointer;" :title="isPasswordRevealed ? 'Amaga' : 'Mostra'" @click="isPasswordRevealed = !isPasswordRevealed">{{ isPasswordRevealed ? '🙈' : '👁️' }}</button>
                <button type="button" class="btn-icon-only" style="border: none; background: none; cursor: pointer;" title="Copia la contrasenya" @click="copyToClipboard(realtimePassword)">📋</button>
              </div>
              <p style="font-size: 0.72rem; color: var(--text-muted); margin: 0;">
                Comparteix aquests dos valors (p. ex. per xat) amb qui es vulgui unir -- no hi ha cap altra manera de distribuir-los.
              </p>
              <div style="font-size: 0.78rem; color: var(--text-secondary);">
                Document sincronitzat ara: <strong>{{ realtimeDocName }}</strong>
              </div>
              <div style="font-size: 0.72rem; color: var(--text-muted); font-family: monospace; overflow-x: auto; white-space: nowrap;">
                Servidor de senyalització: {{ realtimeSignalingServer || '—' }}
              </div>
            </div>

            <button
              class="btn btn-secondary text-danger"
              style="width: auto; padding: 6px 14px; font-size: 0.8rem; align-self: flex-start;"
              @click="emit('stop-realtime-session')"
            >
              Desconnecta
            </button>

            <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 4px;">
              <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);">Participants a la sessió en viu</span>
              <div v-if="realtimePeers.length === 0" style="font-size: 0.8rem; color: var(--text-muted);">
                Esperant que algú més s'hi uneixi...
              </div>
              <div v-for="peer in realtimePeers" :key="peer.userId" style="display: flex; justify-content: space-between; align-items: center; font-size: 0.82rem;">
                <span>
                  <span style="color: var(--color-success, #16a34a);">●</span>
                  {{ peer.displayName }}
                  <span v-if="peer.isSelf" style="font-size: 0.72rem; color: var(--text-muted);">(tu)</span>
                </span>
                <span v-if="peer.docName" style="font-size: 0.72rem; color: var(--text-muted);">{{ peer.docName }}</span>
              </div>
            </div>
          </template>
        </div>
      </div>

      <div class="modal-footer" style="display: flex; justify-content: flex-end; padding-top: 0.75rem; border-top: 1px solid var(--border-color);">
        <button class="btn btn-secondary" @click="emit('close')">Tanca</button>
      </div>
    </div>
  </div>
</template>
