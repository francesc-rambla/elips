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
import { ref, watch, computed } from 'vue';
import { encodeSessionCode, decodeSessionCode } from '../composables/useCollabRealtime';

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
  // Fase 24: inici/tancament de sessió del tercer transport (sincronització
  // al núvol, Firebase). 'unconfigured' | 'signed-out' | 'signing-in' |
  // 'signed-in' | 'error'.
  cloudAuthStatus: { type: String, default: 'unconfigured' },
  cloudCurrentUserEmail: { type: String, default: '' },
  cloudAuthError: { type: String, default: null },
  // Fase 25: motor real de sincronització (document d'accés + canal de
  // dades). 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'error'.
  cloudSyncStatus: { type: String, default: 'disabled' },
  cloudProjectId: { type: String, default: null },
  cloudSyncError: { type: String, default: null },
  cloudActivityLog: { type: Array, default: () => [] },
  cloudProjectAccess: { type: Object, default: null }, // {ownerEmail, memberEmails}
  isCloudProjectOwner: { type: Boolean, default: false },
  // Fase 30/31: projectes als quals aquest correu té accés
  // ({projectId, projectName, ownerEmail}[]), per mostrar-los pel seu nom
  // real -- independent de si AQUEST projecte local ja n'és un.
  myCloudProjects: { type: Array, default: () => [] },
  // Fase 32: cert mentre s'espera la primera instantània de cada canal
  // just després d'activar/unir-se -- vegeu useCloudSync.js.
  cloudIsApplyingInitialSync: { type: Boolean, default: false },
  // Fase 35/36: projectes locals l'escombrat automàtic dels quals ha
  // trobat un xoc de nom amb un projecte al núvol ja existent --
  // ({localName, cloudProjectId, cloudProjectName}[]), pendents de
  // resoldre amb una de les quatre opcions.
  pendingCloudConflicts: { type: Array, default: () => [] },
});

const emit = defineEmits([
  'close', 'connect', 'disconnect', 'request-permission', 'update-display-name',
  'start-realtime-session', 'join-realtime-session', 'stop-realtime-session',
  'request-project-transfer', 'cloud-sign-in', 'cloud-sign-out',
  'activate-cloud-sync', 'join-cloud-project', 'deactivate-cloud-sync',
  'add-cloud-project-member', 'remove-cloud-project-member', 'open-cloud-project',
  'resolve-cloud-conflict',
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

const joinCodeInput = ref('');
const isPasswordRevealed = ref(false);

// Sala, contrasenya i (Fase 18) el servidor de senyalització que s'hi ha
// fet servir, tots junts en un únic "codi de sessió" que es pot copiar/
// enganxar d'un sol cop -- qui s'hi uneix no ha de configurar cap servidor
// de senyalització per separat, ja hi viatja incrustat (encodeSessionCode,
// useCollabRealtime.js).
const sessionCode = computed(() => encodeSessionCode({
  roomId: props.realtimeRoomId,
  password: props.realtimePassword,
  signaling: props.realtimeSignalingServer,
}));

const parsedJoinCode = computed(() => decodeSessionCode(joinCodeInput.value));

const submitJoinRealtimeSession = () => {
  const parsed = parsedJoinCode.value;
  if (!parsed) return;
  emit('join-realtime-session', parsed);
  joinCodeInput.value = '';
};

// Fase 24: formulari mínim d'inici de sessió al núvol -- la gestió de
// projectes/membres pròpiament dita (Fases 25-27) encara no hi és.
const cloudEmailInput = ref('');
const cloudPasswordInput = ref('');
const submitCloudSignIn = () => {
  emit('cloud-sign-in', { email: cloudEmailInput.value.trim(), password: cloudPasswordInput.value });
};

// Fase 25: gestió del projecte al núvol (activar/unir-se/gestionar accés).
const cloudJoinIdInput = ref('');
const cloudNewMemberInput = ref('');
const cloudSyncStatusLabel = {
  disabled: 'Cal iniciar sessió',
  disconnected: 'Cap projecte al núvol vinculat',
  connecting: 'Connectant...',
  connected: 'Connectat',
  error: 'Error de connexió',
};
const submitJoinCloudProject = () => {
  if (!cloudJoinIdInput.value.trim()) return;
  emit('join-cloud-project', cloudJoinIdInput.value.trim());
  cloudJoinIdInput.value = '';
};
const submitAddCloudMember = () => {
  if (!cloudNewMemberInput.value.trim()) return;
  emit('add-cloud-project-member', cloudNewMemberInput.value.trim());
  cloudNewMemberInput.value = '';
};

// Fase 33: tres pestanyes independents per als tres transports -- abans una
// sola columna apilada. El camp de nom (compartit) es manté per sobre,
// fora de les pestanyes.
const activeTab = ref('folder'); // 'folder' | 'realtime' | 'cloud'

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

        <!-- Fase 33: una pestanya per transport -- cadascuna mostra NOMÉS
             la seva pròpia secció/configuració. -->
        <div style="padding: 0 1.25rem; display: flex; gap: 4px; border-bottom: 1px solid var(--border-color);">
          <button type="button" class="office-tab-btn" :class="{ active: activeTab === 'folder' }" @click="activeTab = 'folder'">📁 Carpeta compartida</button>
          <button type="button" class="office-tab-btn" :class="{ active: activeTab === 'realtime' }" @click="activeTab = 'realtime'">📡 Sessió en viu</button>
          <button type="button" class="office-tab-btn" :class="{ active: activeTab === 'cloud' }" @click="activeTab = 'cloud'">☁️ Sincronització al núvol</button>
        </div>

        <div v-show="activeTab === 'folder'" style="display: flex; flex-direction: column; gap: 1rem;">
        <template v-if="!isCollabSupported">
          <p style="font-size: 0.85rem; color: var(--text-secondary); padding: 0 1.25rem;">
            La col·laboració via <strong>carpeta compartida</strong> (p. ex. dins el vostre OneDrive
            sincronitzat) requereix la File System Access API del navegador, disponible
            només a <strong>Chrome</strong> i <strong>Edge</strong>. La <strong>sessió en viu
            (WebRTC)</strong> de la pestanya corresponent funciona igualment en aquest navegador.
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
        </div>

        <!-- Sessió en viu (WebRTC) -- funciona a qualsevol navegador, no
             gated per isCollabSupported (això és específic de la carpeta,
             que necessita la File System Access API). Pot coexistir amb
             la carpeta compartida sense coordinar-s'hi. -->
        <div v-show="activeTab === 'realtime'" style="padding: 0 1.25rem; display: flex; flex-direction: column; gap: 8px; padding-top: 1rem;">
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
                v-model="joinCodeInput"
                class="data-input"
                placeholder="Codi de sessió (sala.contrasenya)"
                style="font-size: 0.82rem; height: 30px; padding: 2px 8px; font-family: monospace;"
                @keyup.enter="submitJoinRealtimeSession"
              >
              <button
                class="btn btn-secondary"
                style="width: auto; padding: 5px 12px; font-size: 0.78rem; align-self: flex-start;"
                :disabled="!parsedJoinCode"
                @click="submitJoinRealtimeSession"
              >
                Uneix-te
              </button>
            </div>
          </template>

          <template v-if="realtimeStatus === 'connected'">
            <div style="display: flex; flex-direction: column; gap: 6px;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="font-size: 0.78rem; color: var(--text-secondary); flex-shrink: 0;">Codi de sessió:</span>
                <code style="font-size: 0.78rem; background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; flex: 1; overflow-x: auto; white-space: nowrap;">{{ isPasswordRevealed ? sessionCode : `${realtimeRoomId}.••••••••••••` }}</code>
                <button type="button" class="btn-icon-only" style="border: none; background: none; cursor: pointer;" :title="isPasswordRevealed ? 'Amaga' : 'Mostra'" @click="isPasswordRevealed = !isPasswordRevealed">{{ isPasswordRevealed ? '🙈' : '👁️' }}</button>
                <button type="button" class="btn-icon-only" style="border: none; background: none; cursor: pointer;" title="Copia el codi de sessió" @click="copyToClipboard(sessionCode)">📋</button>
              </div>
              <p style="font-size: 0.72rem; color: var(--text-muted); margin: 0;">
                Comparteix aquest codi (p. ex. per xat) amb qui es vulgui unir -- ja inclou el servidor de senyalització, no cal que en configuri cap.
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

        <!-- Sincronització al núvol (Firebase) -- Fase 24 (autenticació) +
             Fase 25 (document d'accés per projecte + canal de dades real).
             Vegeu el pla per a les Fases 26-33 (resta de canals, identitat
             real del projecte, selector, indicador de progrés). -->
        <div v-show="activeTab === 'cloud'" style="padding: 0 1.25rem; display: flex; flex-direction: column; gap: 8px; padding-top: 1rem;">
          <span style="font-size: 0.85rem; font-weight: 700; color: var(--text-primary);">☁️ Sincronització al núvol</span>

          <!-- Fase 36: conflictes de nom pendents de l'escombrat automàtic
               (Fase 35) -- es mostren per sobre de la resta, abans de
               qualsevol altra cosa, mentre n'hi hagi cap. -->
          <div v-if="pendingCloudConflicts.length" style="display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--color-warning, #d97706); border-radius: 6px; padding: 10px; background: var(--bg-tertiary);">
            <span style="font-size: 0.85rem; font-weight: 700; color: var(--color-warning, #d97706);">⚠️ Conflictes de nom pendents de resoldre</span>
            <div v-for="conflict in pendingCloudConflicts" :key="conflict.localName" style="display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border-color); padding-top: 8px;">
              <span style="font-size: 0.8rem; color: var(--text-secondary);">
                El projecte local <strong>{{ conflict.localName }}</strong> coincideix de nom amb un projecte ja existent al núvol (de <strong>{{ conflict.cloudProjectName }}</strong>).
              </span>
              <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                <button class="btn btn-secondary" style="width: auto; padding: 4px 8px; font-size: 0.72rem;" @click="emit('resolve-cloud-conflict', { localName: conflict.localName, option: 'create-new' })">Crea'n un de nou al núvol</button>
                <button class="btn btn-secondary" style="width: auto; padding: 4px 8px; font-size: 0.72rem;" @click="emit('resolve-cloud-conflict', { localName: conflict.localName, option: 'overwrite-cloud' })">Sobreescriu el núvol amb el local</button>
                <button class="btn btn-secondary" style="width: auto; padding: 4px 8px; font-size: 0.72rem;" @click="emit('resolve-cloud-conflict', { localName: conflict.localName, option: 'overwrite-local' })">Sobreescriu el local amb el núvol</button>
                <button class="btn btn-secondary" style="width: auto; padding: 4px 8px; font-size: 0.72rem;" @click="emit('resolve-cloud-conflict', { localName: conflict.localName, option: 'merge' })">Intenta fusionar-los</button>
              </div>
            </div>
          </div>

          <template v-if="cloudAuthStatus === 'unconfigured'">
            <p style="font-size: 0.78rem; color: var(--text-muted); margin: 0;">
              Encara no configurada per a aquest desplegament -- cal omplir
              <code>src/utils/firebaseConfig.js</code> amb les dades d'un projecte Firebase propi.
            </p>
          </template>
          <template v-else>
            <p style="font-size: 0.78rem; color: var(--text-muted); margin: 0;">
              Còpia de seguretat automàtica de tots els teus projectes locals: en
              iniciar sessió, cada projecte que encara no en tingui es desa al núvol
              sol, sense haver de clicar res -- i et queda disponible des de
              qualsevol altre navegador on tornis a iniciar sessió.
            </p>

            <div v-if="cloudAuthStatus === 'signed-in'" style="display: flex; flex-direction: column; gap: 10px;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 0.82rem; color: var(--text-secondary);">
                  Connectat com a <strong>{{ cloudCurrentUserEmail }}</strong>
                </span>
                <button type="button" class="btn-icon-only" style="border: none; background: none; cursor: pointer; font-size: 0.74rem; color: var(--text-muted);" @click="emit('cloud-sign-out')">Tanca la sessió</button>
              </div>

              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 0.85rem; color: var(--text-secondary);">Projecte al núvol:</span>
                <span style="font-size: 0.85rem; font-weight: 700;" :style="{ color: cloudSyncStatus === 'connected' ? 'var(--color-success, #16a34a)' : (cloudSyncStatus === 'error' ? 'var(--color-danger, #dc2626)' : 'var(--text-primary)') }">
                  {{ cloudSyncStatusLabel[cloudSyncStatus] || cloudSyncStatus }}
                </span>
              </div>
              <div v-if="cloudSyncStatus === 'error' && cloudSyncError" style="font-size: 0.78rem; color: var(--color-danger, #dc2626);">
                {{ cloudSyncError }}
              </div>
              <!-- Fase 32: una activació/unió que trigui uns segons (o més,
                   en connexions lentes) mai ha de semblar que ha fallat en
                   silenci -- cloudSyncStatus encara és 'connecting' mentre
                   dura. -->
              <div v-if="cloudIsApplyingInitialSync" style="font-size: 0.78rem; color: var(--text-secondary); display: flex; align-items: center; gap: 6px;">
                ⏳ Sincronitzant el contingut inicial... pot trigar uns segons.
              </div>

              <template v-if="cloudSyncStatus === 'connected'">
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span style="font-size: 0.78rem; color: var(--text-secondary); flex-shrink: 0;">Identificador:</span>
                  <code style="font-size: 0.72rem; background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; flex: 1; overflow-x: auto; white-space: nowrap;">{{ cloudProjectId }}</code>
                  <button type="button" class="btn-icon-only" style="border: none; background: none; cursor: pointer;" title="Copia l'identificador" @click="copyToClipboard(cloudProjectId)">📋</button>
                </div>
                <p style="font-size: 0.72rem; color: var(--text-muted); margin: 0;">
                  Comparteix-lo amb qui vulguis que hi tingui accés -- només hi podran entrar un cop l'afegeixis a sota.
                </p>

                <div style="display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border-color); padding-top: 8px;">
                  <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);">Gestiona l'accés</span>
                  <p style="font-size: 0.72rem; color: var(--text-muted); margin: 0;">
                    Opcional -- només cal si vols que algú altre, a més de tu, pugui
                    veure i editar aquest projecte concret des del seu propi compte.
                  </p>
                  <template v-if="isCloudProjectOwner">
                    <div v-for="email in (cloudProjectAccess?.memberEmails || [])" :key="email" style="display: flex; justify-content: space-between; align-items: center; font-size: 0.82rem;">
                      <span>{{ email }}<span v-if="email === cloudProjectAccess?.ownerEmail" style="font-size: 0.7rem; color: var(--text-muted);"> (propietari)</span></span>
                      <button v-if="email !== cloudProjectAccess?.ownerEmail" type="button" class="btn-icon-only" style="border: none; background: none; cursor: pointer;" title="Treu l'accés" @click="emit('remove-cloud-project-member', email)">✕</button>
                    </div>
                    <div style="display: flex; gap: 6px; margin-top: 4px;">
                      <input type="email" v-model="cloudNewMemberInput" class="data-input" placeholder="Afegeix un correu..." style="font-size: 0.8rem; height: 28px; padding: 2px 8px;" @keyup.enter="submitAddCloudMember">
                      <button class="btn btn-secondary" style="width: auto; padding: 4px 10px; font-size: 0.76rem;" @click="submitAddCloudMember">Afegeix</button>
                    </div>
                  </template>
                  <p v-else style="font-size: 0.78rem; color: var(--text-muted); margin: 0;">
                    Ets membre d'aquest projecte, gestionat per <strong>{{ cloudProjectAccess?.ownerEmail }}</strong>.
                  </p>
                </div>

                <button class="btn btn-secondary text-danger" style="width: auto; padding: 6px 14px; font-size: 0.8rem; align-self: flex-start;" @click="emit('deactivate-cloud-sync')">
                  Desvincula aquest projecte
                </button>

                <div v-if="cloudActivityLog.length" style="display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--border-color); padding-top: 8px; max-height: 120px; overflow-y: auto;">
                  <div v-for="(entry, idx) in cloudActivityLog" :key="idx" style="font-size: 0.72rem; color: var(--text-muted);">
                    <span style="font-family: monospace;">{{ entry.time }}</span> — {{ entry.text }}
                  </div>
                </div>
              </template>

              <template v-else>
                <button class="btn btn-primary" style="width: auto; padding: 6px 14px; font-size: 0.8rem; align-self: flex-start;" @click="emit('activate-cloud-sync')">
                  ☁️ Activa la sincronització per a aquest projecte
                </button>
                <p style="font-size: 0.72rem; color: var(--text-muted); margin: 0;">
                  Normalment no cal -- els teus projectes es sincronitzen automàticament
                  en iniciar sessió. Fes servir aquest botó només per reintentar-ho si
                  no s'ha fet sol, o si acabes de crear aquest projecte.
                </p>

                <!-- Fase 31: llistat pel nom real -- per sobre del camp
                     d'enganxar un identificador, que queda com a reserva
                     (p. ex. si encara no ets a la llista perquè t'acaben
                     d'afegir i no has tornat a obrir aquest panell). -->
                <div v-if="myCloudProjects.length" style="display: flex; flex-direction: column; gap: 6px; margin-top: 8px; border-top: 1px solid var(--border-color); padding-top: 8px;">
                  <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);">Projectes als quals tens accés</span>
                  <div v-for="proj in myCloudProjects" :key="proj.projectId" style="display: flex; justify-content: space-between; align-items: center; font-size: 0.82rem; gap: 8px;">
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                      {{ proj.projectName }}
                      <span style="font-size: 0.7rem; color: var(--text-muted);">({{ proj.ownerEmail === cloudCurrentUserEmail ? 'el teu' : proj.ownerEmail }})</span>
                    </span>
                    <button
                      class="btn btn-secondary"
                      style="width: auto; padding: 3px 10px; font-size: 0.74rem; flex-shrink: 0;"
                      @click="emit('open-cloud-project', proj.projectId, proj.projectName)"
                    >
                      Obre
                    </button>
                  </div>
                </div>

                <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 4px;">
                  <label style="font-size: 0.78rem; font-weight: 600; color: var(--text-secondary);">O uneix-te amb un identificador</label>
                  <input
                    type="text"
                    v-model="cloudJoinIdInput"
                    class="data-input"
                    placeholder="Identificador del projecte..."
                    style="font-size: 0.82rem; height: 30px; padding: 2px 8px; font-family: monospace;"
                    @keyup.enter="submitJoinCloudProject"
                  >
                  <button
                    class="btn btn-secondary"
                    style="width: auto; padding: 5px 12px; font-size: 0.78rem; align-self: flex-start;"
                    :disabled="!cloudJoinIdInput.trim()"
                    @click="submitJoinCloudProject"
                  >
                    Uneix-te
                  </button>
                </div>
              </template>
            </div>
            <form v-else style="display: flex; flex-direction: column; gap: 6px;" @submit.prevent="submitCloudSignIn">
              <input
                type="email"
                v-model="cloudEmailInput"
                class="data-input"
                placeholder="Correu electrònic"
                style="font-size: 0.82rem; height: 30px; padding: 2px 8px;"
                required
              >
              <input
                type="password"
                v-model="cloudPasswordInput"
                class="data-input"
                placeholder="Contrasenya"
                style="font-size: 0.82rem; height: 30px; padding: 2px 8px;"
                required
              >
              <button
                type="submit"
                class="btn btn-primary"
                style="width: auto; padding: 6px 14px; font-size: 0.8rem; align-self: flex-start;"
                :disabled="cloudAuthStatus === 'signing-in'"
              >
                {{ cloudAuthStatus === 'signing-in' ? 'Connectant...' : 'Inicia sessió' }}
              </button>
              <div v-if="cloudAuthStatus === 'error' && cloudAuthError" style="font-size: 0.78rem; color: var(--color-danger, #dc2626);">
                {{ cloudAuthError }}
              </div>
            </form>
          </template>
        </div>
      </div>

      <div class="modal-footer" style="display: flex; justify-content: flex-end; padding-top: 0.75rem; border-top: 1px solid var(--border-color);">
        <button class="btn btn-secondary" @click="emit('close')">Tanca</button>
      </div>
    </div>
  </div>
</template>
