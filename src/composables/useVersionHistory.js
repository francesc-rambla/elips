/*
 * elips — Editor de LIcitacions PúbliqueS
 * Copyright (C) 2026  Francesc Rambla i Marigot
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { ref, computed, watch } from 'vue';
import { useWorkspaceStore } from '../stores/workspace.js';
import { saveDbItem, getDbItem } from '../utils/db.js';

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

  // Load history from IndexedDB + localStorage fallback
  const loadHistory = async () => {
    try {
      const key = getStorageKey();
      let loadedData = null;

      // 1. Try loading full history from IndexedDB
      try {
        const idbData = await getDbItem(key);
        if (idbData && Array.isArray(idbData) && idbData.length > 0) {
          loadedData = idbData;
        }
      } catch (_) {}

      // 2. Fallback to localStorage if not found in IndexedDB
      if (!loadedData) {
        const raw = localStorage.getItem(key);
        if (raw) {
          try {
            loadedData = JSON.parse(raw);
          } catch (_) {}
        }
      }

      if (loadedData && Array.isArray(loadedData)) {
        historyData.value = loadedData;
      } else {
        historyData.value = [];
      }

      // Check if baseline/hourly snapshot is needed on load
      checkAndTriggerHourlySnapshot();
    } catch (err) {
      console.warn("Error carregant històric de versions:", err);
      historyData.value = [];
    }
  };

  let saveHistoryTimer = null;
  const saveHistoryToStorage = () => {
    if (saveHistoryTimer) clearTimeout(saveHistoryTimer);
    saveHistoryTimer = setTimeout(async () => {
      saveHistoryTimer = null;
      try {
        const key = getStorageKey();
        // Cap history at 25 snapshots to balance depth & performance
        if (historyData.value.length > 25) {
          historyData.value = historyData.value.slice(-25);
        }
        historyData.value.forEach(snap => {
          if (snap.diffs && snap.diffs.length > 20) {
            snap.diffs = snap.diffs.slice(-20);
          }
        });

        // 1. Save full data to IndexedDB
        await saveDbItem(key, JSON.parse(JSON.stringify(historyData.value)));

        // 2. Save mirror to localStorage (with try/catch for quota protection)
        try {
          localStorage.setItem(key, JSON.stringify(historyData.value));
        } catch (lsErr) {
          console.warn("localStorage quota exceeded for history, saved to IndexedDB successfully.", lsErr);
        }
      } catch (err) {
        console.warn("Error desant històric de versions:", err);
      }
    }, 1000);
  };

  // In-memory cache of latest state to avoid continuous expensive JSON cloning
  let latestStateCache = null;

  const getLatestState = () => {
    if (latestStateCache) return latestStateCache;
    if (historyData.value.length === 0) return null;
    
    const lastSnap = historyData.value[historyData.value.length - 1];
    let tpl = lastSnap.templateText || '';
    let data = lastSnap.excelJsonData || null;
    let meta = lastSnap.editorMetadata || [];

    if (lastSnap.diffs && lastSnap.diffs.length > 0) {
      const lastDiff = lastSnap.diffs[lastSnap.diffs.length - 1];
      if (lastDiff.snapshotState) {
        tpl = lastDiff.snapshotState.templateText ?? tpl;
        data = lastDiff.snapshotState.excelJsonData ?? data;
        meta = lastDiff.snapshotState.editorMetadata ?? meta;
      }
    }

    latestStateCache = { templateText: tpl, excelJsonData: data, editorMetadata: meta };
    return latestStateCache;
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
      note: customNote || (reason === 'hourly' ? 'Còpia automàtica horària' : 'Punt de control manual'),
      templateText: store.templateText || '',
      excelJsonData: store.excelJsonData ? JSON.parse(JSON.stringify(store.excelJsonData)) : null,
      editorMetadata: store.editorMetadata ? JSON.parse(JSON.stringify(store.editorMetadata)) : [],
      diffs: []
    };

    latestStateCache = {
      templateText: newSnap.templateText,
      excelJsonData: newSnap.excelJsonData,
      editorMetadata: newSnap.editorMetadata
    };

    historyData.value.push(newSnap);
    saveHistoryToStorage();
    store.addLog(`📜 Nova versió creada a l'històric: ${newSnap.note} (${displayTime})`, 'info');
    return newSnap;
  };

  // Periodic hourly check
  const checkAndTriggerHourlySnapshot = () => {
    if (!isAutoRecording.value) return;
    const hasData = !!(store.excelJsonData || store.templateText);
    if (!hasData) return;

    const nowTs = Date.now();
    if (historyData.value.length === 0) {
      createSnapshot('init', 'Punt de control inicial');
      return;
    }

    const lastSnap = historyData.value[historyData.value.length - 1];
    const lastSnapTs = new Date(lastSnap.timestamp).getTime();

    // If >= 60 minutes have elapsed since last hourly snapshot, trigger automatic hourly snapshot
    if (nowTs - lastSnapTs >= 3600000) {
      createSnapshot('hourly', 'Còpia automàtica horària');
    }
  };

  // Active periodic background timer for hourly auto-snapshots
  let hourlyCheckInterval = null;
  const startHourlyCheckInterval = () => {
    if (hourlyCheckInterval) clearInterval(hourlyCheckInterval);
    // Check every 60 seconds
    hourlyCheckInterval = setInterval(() => {
      checkAndTriggerHourlySnapshot();
    }, 60000);
  };

  const stopHourlyCheckInterval = () => {
    if (hourlyCheckInterval) {
      clearInterval(hourlyCheckInterval);
      hourlyCheckInterval = null;
    }
  };

  // Record a delta diff for live edits
  const recordChangeDiff = (note = 'Canvi detectat') => {
    if (!isAutoRecording.value) return;

    const now = new Date();
    const nowTs = now.getTime();

    // 1. If no history exists, create initial baseline
    if (historyData.value.length === 0) {
      createSnapshot('init', 'Punt de control inicial');
      return;
    }

    const lastSnap = historyData.value[historyData.value.length - 1];
    const lastSnapTs = new Date(lastSnap.timestamp).getTime();

    // 2. Hourly check: If > 60 minutes have passed since last snapshot, seal a new baseline
    if (nowTs - lastSnapTs >= 3600000) {
      createSnapshot('hourly', 'Còpia horària automàtica');
      return;
    }

    // 3. Compute diffs relative to latest state
    const latestState = getLatestState();
    const currentTpl = store.templateText || '';
    const currentData = store.excelJsonData || null;
    const currentMeta = store.editorMetadata || [];

    const textDiff = computeTextDiff(latestState?.templateText, currentTpl);
    const dataDiff = computeJsonDiff(latestState?.excelJsonData, currentData);
    const metaDiff = computeJsonDiff(latestState?.editorMetadata, currentMeta);

    // Only record if something actually changed
    if (!textDiff && !dataDiff && !metaDiff) return;

    // Update in-memory latest state cache
    latestStateCache = {
      templateText: currentTpl,
      excelJsonData: currentData ? JSON.parse(JSON.stringify(currentData)) : null,
      editorMetadata: currentMeta ? JSON.parse(JSON.stringify(currentMeta)) : []
    };

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
        excelJsonData: latestStateCache.excelJsonData,
        editorMetadata: latestStateCache.editorMetadata
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
    const pName = getProjectName();
    const aDoc = localStorage.getItem(`${pName}:activeDocName`) || 'Document Principal';

    if (mode === 'all' || mode === 'template') {
      if (state.templateText !== undefined) {
        store.templateText = state.templateText;
        localStorage.setItem('templateText', state.templateText);
        localStorage.setItem(`${pName}:doc:${aDoc}:templateText`, state.templateText);
      }
    }

    if (mode === 'all' || mode === 'data') {
      if (state.excelJsonData !== undefined) {
        store.excelJsonData = JSON.parse(JSON.stringify(state.excelJsonData));
        localStorage.setItem(`${pName}:excelJsonData`, JSON.stringify(state.excelJsonData));
      }
    }

    if (mode === 'all' || mode === 'schema') {
      if (state.editorMetadata !== undefined) {
        store.editorMetadata = JSON.parse(JSON.stringify(state.editorMetadata));
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
        schema: "Només l'Esquema de Dades"
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
    restoreVersion,
    startHourlyCheckInterval,
    stopHourlyCheckInterval,
    checkAndTriggerHourlySnapshot
  };
}

