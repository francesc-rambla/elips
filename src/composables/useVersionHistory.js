import { ref, computed, watch } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';

// Fast & lightweight line-based text diff helper
export const computeTextDiff = (oldText = '', newText = '') => {
  if (oldText === newText) return null;
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const changes = [];
  let i = 0, j = 0;
  
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else if (j < newLines.length && (i >= oldLines.length || !oldLines.slice(i).includes(newLines[j]))) {
      changes.push({ type: 'add', line: j + 1, content: newLines[j] });
      j++;
    } else if (i < oldLines.length && (j >= newLines.length || !newLines.slice(j).includes(oldLines[i]))) {
      changes.push({ type: 'del', line: i + 1, content: oldLines[i] });
      i++;
    } else {
      changes.push({ type: 'mod', line: j + 1, oldContent: oldLines[i], newContent: newLines[j] });
      i++;
      j++;
    }
  }
  return changes.length > 0 ? changes : null;
};

// Structured JSON diff helper for objects & metadata arrays
export const computeJsonDiff = (oldObj, newObj) => {
  const oldStr = JSON.stringify(oldObj || null);
  const newStr = JSON.stringify(newObj || null);
  if (oldStr === newStr) return null;

  const diffs = [];
  if (!oldObj && newObj) {
    diffs.push({ op: 'replace', path: '/', value: newObj });
    return diffs;
  }
  if (oldObj && !newObj) {
    diffs.push({ op: 'remove', path: '/' });
    return diffs;
  }

  const oldKeys = Object.keys(oldObj || {});
  const newKeys = Object.keys(newObj || {});
  
  const allKeys = new Set([...oldKeys, ...newKeys]);
  for (const k of allKeys) {
    const valOld = oldObj[k];
    const valNew = newObj[k];
    if (JSON.stringify(valOld) !== JSON.stringify(valNew)) {
      if (valOld === undefined) {
        diffs.push({ op: 'add', path: `/${k}`, value: valNew });
      } else if (valNew === undefined) {
        diffs.push({ op: 'remove', path: `/${k}` });
      } else {
        diffs.push({ op: 'replace', path: `/${k}`, oldValue: valOld, newValue: valNew });
      }
    }
  }
  return diffs.length > 0 ? diffs : null;
};

// Reconstruct text from base snapshot + diff array
export const applyTextDiffs = (baseText, diffsList) => {
  let current = baseText || '';
  if (!diffsList || !Array.isArray(diffsList)) return current;
  for (const diff of diffsList) {
    if (diff && diff.templateText) {
      current = diff.templateText; // If full snapshot stored in diff fallback
    }
  }
  return current;
};

export function useVersionHistory() {
  const store = useWorkspaceStore();
  const historyData = ref([]);
  const isHistoryModalOpen = ref(false);
  const isAutoRecording = ref(true);

  const getProjectName = () => {
    return localStorage.getItem('currentProjectName') || 'Default';
  };

  const getStorageKey = () => {
    return `${getProjectName()}:version_history_v1`;
  };

  // Load history from localStorage
  const loadHistory = () => {
    try {
      const key = getStorageKey();
      const raw = localStorage.getItem(key);
      if (raw) {
        historyData.value = JSON.parse(raw);
      } else {
        historyData.value = [];
      }
    } catch (err) {
      console.warn("Error carregant històric de versions:", err);
      historyData.value = [];
    }
  };

  // Save history to localStorage
  const saveHistoryToStorage = () => {
    try {
      const key = getStorageKey();
      // Cap history at 50 snapshots to maintain fast performance & stay within storage bounds
      if (historyData.value.length > 50) {
        historyData.value = historyData.value.slice(-50);
      }
      localStorage.setItem(key, JSON.stringify(historyData.value));
    } catch (err) {
      console.warn("Error desant històric de versions:", err);
    }
  };

  // Get latest snapshot or diff entry
  const getLatestState = () => {
    if (historyData.value.length === 0) return null;
    const lastSnap = historyData.value[historyData.value.length - 1];
    if (lastSnap.diffs && lastSnap.diffs.length > 0) {
      const lastDiff = lastSnap.diffs[lastSnap.diffs.length - 1];
      return {
        templateText: lastDiff.snapshotState?.templateText ?? lastSnap.templateText,
        excelJsonData: lastDiff.snapshotState?.excelJsonData ?? lastSnap.excelJsonData,
        editorMetadata: lastDiff.snapshotState?.editorMetadata ?? lastSnap.editorMetadata
      };
    }
    return {
      templateText: lastSnap.templateText,
      excelJsonData: lastSnap.excelJsonData,
      editorMetadata: lastSnap.editorMetadata
    };
  };

  // Create a full baseline hourly snapshot
  const createSnapshot = (reason = 'hourly', customNote = '') => {
    const now = new Date();
    const snapId = `snap-${now.getTime()}`;
    const displayTime = `${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;

    const newSnap = {
      id: snapId,
      timestamp: now.toISOString(),
      displayTime,
      type: reason, // 'hourly' | 'manual' | 'init'
      note: customNote || (reason === 'hourly' ? 'Còpia automàtica d horària' : 'Punt de control manual'),
      templateText: store.templateText || '',
      excelJsonData: JSON.parse(JSON.stringify(store.excelJsonData || null)),
      editorMetadata: JSON.parse(JSON.stringify(store.editorMetadata || [])),
      diffs: []
    };

    historyData.value.push(newSnap);
    saveHistoryToStorage();
    store.addLog(`📜 Nova versió creada a l'històric: ${newSnap.note} (${displayTime})`, 'info');
    return newSnap;
  };

  // Record a delta diff for live edits
  const recordChangeDiff = (note = 'Canvi detectat') => {
    if (!isAutoRecording.value) return;

    loadHistory();
    const now = new Date();
    const nowTs = now.getTime();

    // 1. If no history exists, create initial baseline
    if (historyData.value.length === 0) {
      createSnapshot('init', 'Punt de control inicial');
      return;
    }

    const lastSnap = historyData.value[historyData.value.length - 1];
    const lastSnapTs = new Date(lastSnap.timestamp).getTime();

    // 2. Hourly check: If > 60 minutes have passed since last hourly snapshot, seal a new baseline
    if (nowTs - lastSnapTs > 3600000) {
      createSnapshot('hourly', 'Còpia d horària automàtica');
      return;
    }

    // 3. Compute diffs relative to latest state
    const latestState = getLatestState();
    const currentTpl = store.templateText || '';
    const currentData = store.excelJsonData || null;
    const currentMeta = store.editorMetadata || [];

    const textDiff = computeTextDiff(latestState.templateText, currentTpl);
    const dataDiff = computeJsonDiff(latestState.excelJsonData, currentData);
    const metaDiff = computeJsonDiff(latestState.editorMetadata, currentMeta);

    // Only record if something actually changed
    if (!textDiff && !dataDiff && !metaDiff) return;

    const diffEntry = {
      id: `diff-${nowTs}`,
      timestamp: now.toISOString(),
      displayTime: `${now.toLocaleDateString()} ${now.toLocaleTimeString()}`,
      note,
      textDiff,
      dataDiff,
      metaDiff,
      snapshotState: {
        templateText: currentTpl,
        excelJsonData: JSON.parse(JSON.stringify(currentData)),
        editorMetadata: JSON.parse(JSON.stringify(currentMeta))
      }
    };

    if (!lastSnap.diffs) lastSnap.diffs = [];
    lastSnap.diffs.push(diffEntry);
    saveHistoryToStorage();
  };

  // Restore options: full, template, data, schema
  const restoreVersion = (entry, mode = 'all') => {
    if (!entry) return;

    // Resolve state object from snapshot or diff entry
    const state = entry.snapshotState ? entry.snapshotState : {
      templateText: entry.templateText,
      excelJsonData: entry.excelJsonData,
      editorMetadata: entry.editorMetadata
    };

    isAutoRecording.value = false;

    if (mode === 'all' || mode === 'template') {
      if (state.templateText !== undefined) {
        store.templateText = state.templateText;
        localStorage.setItem('templateText', state.templateText);
        const pName = getProjectName();
        localStorage.setItem(`${pName}:doc:Document Principal:templateText`, state.templateText);
      }
    }

    if (mode === 'all' || mode === 'data') {
      if (state.excelJsonData !== undefined) {
        store.excelJsonData = JSON.parse(JSON.stringify(state.excelJsonData));
        const pName = getProjectName();
        localStorage.setItem(`${pName}:excelJsonData`, JSON.stringify(state.excelJsonData));
      }
    }

    if (mode === 'all' || mode === 'schema') {
      if (state.editorMetadata !== undefined) {
        store.editorMetadata = JSON.parse(JSON.stringify(state.editorMetadata));
        const pName = getProjectName();
        localStorage.setItem(`${pName}:editorMetadata`, JSON.stringify(state.editorMetadata));
      }
    }

    // Seal a new manual snapshot marking the restoration action
    setTimeout(() => {
      isAutoRecording.value = true;
      const modeLabels = {
        all: 'Totes les dades (Plantilla, Model i Esquema)',
        template: 'Només la Plantilla',
        data: 'Només les Dades',
        schema: 'Només l Esquema de Dades'
      };
      createSnapshot('manual', `Restauració de versió: ${modeLabels[mode]} (${entry.displayTime})`);
      store.addLog(`🔄 S'ha restaurat la versió (${modeLabels[mode]}) de ${entry.displayTime}`, 'success');
    }, 300);
  };

  // Auto-record debouncer for edits (configurable delay, default 5 seconds)
  let debounceTimer = null;
  const triggerDebouncedRecord = (note = 'Canvi de dades') => {
    if (debounceTimer) clearTimeout(debounceTimer);
    const delayMs = Math.max(1, (store.config?.autoSaveDebounceSeconds || 5)) * 1000;
    debounceTimer = setTimeout(() => {
      recordChangeDiff(note);
      debounceTimer = null;
    }, delayMs);
  };

  const flushPendingRecord = (note = 'Canvi de dades (sortida de cel·la)') => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      recordChangeDiff(note);
    }
  };

  const pauseAutoRecording = () => {
    isAutoRecording.value = false;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const resumeAutoRecording = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    isAutoRecording.value = true;
  };

  return {
    historyData,
    isHistoryModalOpen,
    isAutoRecording,
    loadHistory,
    createSnapshot,
    recordChangeDiff,
    triggerDebouncedRecord,
    flushPendingRecord,
    pauseAutoRecording,
    resumeAutoRecording,
    restoreVersion
  };
}
