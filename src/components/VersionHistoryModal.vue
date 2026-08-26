<script setup>
import { ref, computed, onMounted } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';

const props = defineProps({
  isOpen: { type: Boolean, default: false },
  historyData: { type: Array, default: () => [] }
});

const emit = defineEmits(['close', 'restore', 'createSnapshot']);

const store = useWorkspaceStore();
const selectedEntryId = ref(null);
const activeFilter = ref('all'); // 'all', 'hourly', 'manual'
const customNoteInput = ref('');

// Flatten snapshots and their diffs into a unified chronological timeline
const timelineEntries = computed(() => {
  const list = [];
  (props.historyData || []).forEach(snap => {
    // Add baseline snapshot
    list.push({
      id: snap.id,
      parentId: snap.id,
      timestamp: snap.timestamp,
      displayTime: snap.displayTime,
      type: snap.type || 'hourly',
      isSnapshot: true,
      note: snap.note || 'Còpia d horària automàtica',
      snapshotState: {
        templateText: snap.templateText,
        excelJsonData: snap.excelJsonData,
        editorMetadata: snap.editorMetadata
      },
      hasText: !!snap.templateText,
      hasData: !!(snap.excelJsonData && Object.keys(snap.excelJsonData).length > 0),
      hasSchema: !!(snap.editorMetadata && snap.editorMetadata.length > 0)
    });

    // Add diffs belonging to this snapshot
    if (snap.diffs && Array.isArray(snap.diffs)) {
      snap.diffs.forEach(diff => {
        list.push({
          id: diff.id,
          parentId: snap.id,
          timestamp: diff.timestamp,
          displayTime: diff.displayTime,
          type: 'diff',
          isSnapshot: false,
          note: diff.note || 'Diferencial de canvis',
          textDiff: diff.textDiff,
          dataDiff: diff.dataDiff,
          metaDiff: diff.metaDiff,
          snapshotState: diff.snapshotState,
          hasText: !!(diff.snapshotState && diff.snapshotState.templateText),
          hasData: !!(diff.snapshotState && diff.snapshotState.excelJsonData),
          hasSchema: !!(diff.snapshotState && diff.snapshotState.editorMetadata)
        });
      });
    }
  });

  // Sort descending by timestamp (newest first)
  return list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
});

const filteredEntries = computed(() => {
  if (activeFilter.value === 'hourly') {
    return timelineEntries.value.filter(e => e.type === 'hourly');
  }
  if (activeFilter.value === 'manual') {
    return timelineEntries.value.filter(e => e.type === 'manual' || e.type === 'init');
  }
  return timelineEntries.value;
});

const selectedEntry = computed(() => {
  if (!selectedEntryId.value && filteredEntries.value.length > 0) {
    return filteredEntries.value[0];
  }
  return timelineEntries.value.find(e => e.id === selectedEntryId.value) || filteredEntries.value[0] || null;
});

const handleCreateManualSnapshot = () => {
  const note = customNoteInput.value.trim() || 'Punt de control manual';
  emit('createSnapshot', note);
  customNoteInput.value = '';
};

const triggerRestore = (entry, mode) => {
  if (!entry) return;
  const modeLabels = {
    all: 'Totes les dades (Plantilla, Model i Esquema)',
    template: 'la Plantilla',
    data: 'les Dades del Model',
    schema: 'l Esquema de Metadades'
  };
  
  if (confirm(`Estàs segur que vols restaurar ${modeLabels[mode]} de la versió del ${entry.displayTime}?`)) {
    emit('restore', { entry, mode });
    emit('close');
  }
};
</script>

<template>
  <div v-if="isOpen" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal-card version-history-modal">
      
      <!-- Header -->
      <div class="modal-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary);"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <h3 style="margin: 0; font-size: 1.1rem; font-weight: 700; color: var(--text-primary);">Històric de Versions i Punts de Control</h3>
        </div>
        <button type="button" class="btn-close" @click="emit('close')" title="Tanca">×</button>
      </div>

      <!-- Body Grid: Left Timeline list + Right Version details & preview -->
      <div class="modal-body history-grid">
        
        <!-- Left Panel: Timeline -->
        <div class="history-sidebar">
          
          <!-- Manual Snapshot Creator Bar -->
          <div style="display: flex; gap: 6px; margin-bottom: 10px;">
            <input 
              type="text" 
              v-model="customNoteInput" 
              placeholder="Descripció de la versió actual..." 
              class="data-input"
              style="font-size: 0.78rem; height: 28px; padding: 2px 8px;"
              @keyup.enter="handleCreateManualSnapshot"
            >
            <button 
              type="button" 
              class="btn btn-primary" 
              style="font-size: 0.75rem; padding: 2px 10px; flex-shrink: 0; height: 28px; white-space: nowrap;"
              @click="handleCreateManualSnapshot"
              title="Crea una nova versió manual immediata"
            >
              + Desar Versió
            </button>
          </div>

          <!-- Filter Tabs -->
          <div style="display: flex; gap: 4px; margin-bottom: 10px; border-bottom: 1px solid var(--border-color); padding-bottom: 6px;">
            <button 
              type="button" 
              class="btn btn-secondary" 
              :class="{ active: activeFilter === 'all' }"
              style="padding: 2px 8px; font-size: 0.72rem; flex: 1;"
              @click="activeFilter = 'all'"
            >Tots ({{ timelineEntries.length }})</button>
            <button 
              type="button" 
              class="btn btn-secondary" 
              :class="{ active: activeFilter === 'hourly' }"
              style="padding: 2px 8px; font-size: 0.72rem; flex: 1;"
              @click="activeFilter = 'hourly'"
            >🕒 Horaris</button>
            <button 
              type="button" 
              class="btn btn-secondary" 
              :class="{ active: activeFilter === 'manual' }"
              style="padding: 2px 8px; font-size: 0.72rem; flex: 1;"
              @click="activeFilter = 'manual'"
            >📌 Manuals</button>
          </div>

          <!-- Timeline Entries List -->
          <div v-if="filteredEntries.length === 0" style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 2rem 0;">
            No hi ha cap versió desada encara.
          </div>
          <div v-else class="timeline-list">
            <div 
              v-for="e in filteredEntries" 
              :key="e.id" 
              class="timeline-item"
              :class="{ selected: selectedEntry && selectedEntry.id === e.id, snapshot: e.isSnapshot }"
              @click="selectedEntryId = e.id"
            >
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
                <span class="entry-type-badge" :class="e.type">
                  <span v-if="e.type === 'hourly'">🕒 Horari</span>
                  <span v-else-if="e.type === 'manual'">📌 Manual</span>
                  <span v-else-if="e.type === 'init'">🚀 Inicial</span>
                  <span v-else>✍️ Diff</span>
                </span>
                <span style="font-size: 0.68rem; color: var(--text-muted); font-family: var(--font-mono);">{{ e.displayTime }}</span>
              </div>
              <div style="font-size: 0.78rem; font-weight: 600; color: var(--text-primary); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                {{ e.note }}
              </div>
            </div>
          </div>

        </div>

        <!-- Right Panel: Selected Entry Preview & Restore Controls -->
        <div v-if="selectedEntry" class="history-detail">
          
          <!-- Detail Header & Restoration Bar -->
          <div class="detail-header">
            <div>
              <h4 style="margin: 0 0 4px 0; font-size: 0.95rem; font-weight: 700; color: var(--text-primary);">
                {{ selectedEntry.note }}
              </h4>
              <div style="font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono);">
                Data i hora: {{ selectedEntry.displayTime }} (ID: {{ selectedEntry.id }})
              </div>
            </div>

            <!-- Restore Action Buttons -->
            <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;">
              <button 
                type="button" 
                class="btn btn-primary" 
                style="font-size: 0.78rem; padding: 4px 10px; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;"
                @click="triggerRestore(selectedEntry, 'all')"
                title="Restaura la Plantilla, el Model i l'Esquema alhora"
              >
                🔄 Restaurar Tot
              </button>
              <button 
                type="button" 
                class="btn btn-secondary" 
                style="font-size: 0.78rem; padding: 4px 8px; display: inline-flex; align-items: center; gap: 4px;"
                @click="triggerRestore(selectedEntry, 'template')"
                title="Restaura només el text de la plantilla Jinja2"
              >
                📄 Plantilla
              </button>
              <button 
                type="button" 
                class="btn btn-secondary" 
                style="font-size: 0.78rem; padding: 4px 8px; display: inline-flex; align-items: center; gap: 4px;"
                @click="triggerRestore(selectedEntry, 'data')"
                title="Restaura només el JSON de dades de l'Excel"
              >
                📊 Dades
              </button>
              <button 
                type="button" 
                class="btn btn-secondary" 
                style="font-size: 0.78rem; padding: 4px 8px; display: inline-flex; align-items: center; gap: 4px;"
                @click="triggerRestore(selectedEntry, 'schema')"
                title="Restaura només les metadades de l'esquema"
              >
                ⚙️ Esquema
              </button>
            </div>
          </div>

          <!-- Preview & Differential Content Tabs -->
          <div class="detail-content" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; margin-top: 10px;">
            
            <!-- Text Diff or Full Preview -->
            <div style="border: 1px solid var(--border-color); border-radius: 6px; padding: 8px; background: var(--bg-primary);">
              <div style="font-size: 0.75rem; font-weight: 700; color: var(--color-primary); margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;">
                <span>📄 Estat / Canvis a la Plantilla</span>
                <span v-if="selectedEntry.textDiff" style="color: #d97706; font-size: 0.7rem;">(Diferencial de canvis)</span>
              </div>

              <!-- Line Diff Display -->
              <div v-if="selectedEntry.textDiff && selectedEntry.textDiff.length > 0" style="font-family: var(--font-mono); font-size: 0.72rem; max-height: 180px; overflow-y: auto; background: var(--bg-card); padding: 6px; border-radius: 4px; border: 1px solid var(--border-color);">
                <div v-for="(change, idx) in selectedEntry.textDiff" :key="idx" :style="{ color: change.type === 'add' ? '#16a34a' : change.type === 'del' ? '#dc2626' : '#d97706' }">
                  <span v-if="change.type === 'add'">+ Línia {{ change.line }}: {{ change.content }}</span>
                  <span v-else-if="change.type === 'del'">- Línia {{ change.line }}: {{ change.content }}</span>
                  <span v-else>~ Línia {{ change.line }}: {{ change.oldContent }} ➔ {{ change.newContent }}</span>
                </div>
              </div>

              <!-- Full Text Preview -->
              <textarea 
                v-else 
                readonly 
                :value="selectedEntry.snapshotState?.templateText || 'Sense contingut de plantilla'"
                class="data-input" 
                rows="6" 
                style="font-family: var(--font-mono); font-size: 0.75rem; width: 100%; resize: vertical;"
              ></textarea>
            </div>

            <!-- Model Data Preview -->
            <div style="border: 1px solid var(--border-color); border-radius: 6px; padding: 8px; background: var(--bg-primary);">
              <div style="font-size: 0.75rem; font-weight: 700; color: var(--color-primary); margin-bottom: 6px;">
                📊 Model de Dades Excel
              </div>
              <textarea 
                readonly 
                :value="JSON.stringify(selectedEntry.snapshotState?.excelJsonData || {}, null, 2)"
                class="data-input" 
                rows="5" 
                style="font-family: var(--font-mono); font-size: 0.72rem; width: 100%; resize: vertical;"
              ></textarea>
            </div>

            <!-- Metadata Schema Preview -->
            <div style="border: 1px solid var(--border-color); border-radius: 6px; padding: 8px; background: var(--bg-primary);">
              <div style="font-size: 0.75rem; font-weight: 700; color: var(--color-primary); margin-bottom: 6px;">
                ⚙️ Esquema de Metadades ({{ (selectedEntry.snapshotState?.editorMetadata || []).length }} camps)
              </div>
              <textarea 
                readonly 
                :value="JSON.stringify(selectedEntry.snapshotState?.editorMetadata || [], null, 2)"
                class="data-input" 
                rows="4" 
                style="font-family: var(--font-mono); font-size: 0.72rem; width: 100%; resize: vertical;"
              ></textarea>
            </div>

          </div>

        </div>

      </div>

      <!-- Footer -->
      <div class="modal-footer" style="padding-top: 0.75rem; border-top: 1px solid var(--border-color); display: flex; justify-content: flex-end;">
        <button type="button" class="btn btn-secondary" style="width: auto;" @click="emit('close')">Tanca</button>
      </div>

    </div>
  </div>
</template>

<style scoped>
.version-history-modal {
  width: 90vw;
  max-width: 950px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}

.history-grid {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 12px;
  flex: 1;
  min-height: 480px;
  max-height: calc(85vh - 110px);
  overflow: hidden;
}

.history-sidebar {
  border-right: 1px solid var(--border-color);
  padding-right: 10px;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.timeline-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.timeline-item {
  padding: 8px 10px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  cursor: pointer;
  transition: all 0.15s ease;
}

.timeline-item:hover {
  border-color: var(--color-primary);
  background: var(--bg-tertiary);
}

.timeline-item.selected {
  border-color: var(--color-primary);
  background: var(--color-primary-light);
  box-shadow: 0 0 0 2px var(--color-primary);
}

.entry-type-badge {
  font-size: 0.65rem;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 3px;
  text-transform: uppercase;
}

.entry-type-badge.hourly {
  background: #e0f2fe;
  color: #0369a1;
}

.entry-type-badge.manual {
  background: #fef3c7;
  color: #92400e;
}

.entry-type-badge.init {
  background: #dcfce7;
  color: #15803d;
}

.entry-type-badge.diff {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.history-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.detail-header {
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 8px;
}
</style>
