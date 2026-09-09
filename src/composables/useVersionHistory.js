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
import { compare as jsonPatchCompare, applyPatch as jsonPatchApply } from 'fast-json-patch';
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

// Real, granular JSON diff for excelJsonData (the data model) -- RFC 6902
// JSON Patch via fast-json-patch, unlike computeJsonDiff above (which only
// compares TOP-LEVEL keys and stores the entire subtree whenever anything
// inside it changes). null/undefined are normalized to {} since
// jsonPatchCompare requires actual objects on both sides.
export const computeDataPatch = (oldObj, newObj) => {
  const a = oldObj && typeof oldObj === 'object' ? oldObj : {};
  const b = newObj && typeof newObj === 'object' ? newObj : {};
  const patch = jsonPatchCompare(a, b);
  return patch.length > 0 ? patch : null;
};

// Replays diffs[0..uptoDiffIndex] (inclusive) on top of snap's own baseline
// excelJsonData to reconstruct the full data model as of that point. Each
// diff's own dataPatch is relative to the state immediately before it (the
// previous diff, or the baseline if it's the first), so patches must be
// applied strictly in order from the baseline forward -- never in
// isolation. mutateDocument:false keeps this pure (never touches snap's
// own stored baseline object).
export const reconstructExcelJsonDataAt = (snap, uptoDiffIndex) => {
  let current = snap?.excelJsonData ? JSON.parse(JSON.stringify(snap.excelJsonData)) : null;
  const diffs = snap?.diffs || [];
  for (let i = 0; i <= uptoDiffIndex && i < diffs.length; i++) {
    const patch = diffs[i]?.dataPatch;
    if (patch && patch.length > 0) {
      try {
        current = jsonPatchApply(current || {}, patch, false, false).newDocument;
      } catch (err) {
        console.warn(`Error aplicant el pedaç de dades del diff #${i}:`, err);
      }
    }
  }
  return current;
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

  // Bumped on every loadHistory() call and on resetHistoryState(); a
  // loadHistory() call that resolves after a NEWER one has already started
  // (e.g. the user switched project again before the first load finished --
  // IndexedDB connections are opened fresh per call with no ordering
  // guarantee) checks its own captured epoch against this before ever
  // assigning historyData.value, so a stale/out-of-order load can never
  // clobber a newer project's history with an older project's data.
  let loadEpoch = 0;

  // Load history from IndexedDB + localStorage fallback
  const loadHistory = async () => {
    const myEpoch = ++loadEpoch;
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

      if (myEpoch !== loadEpoch) return; // a newer loadHistory()/resetHistoryState() has since started -- abandon

      if (loadedData && Array.isArray(loadedData)) {
        historyData.value = loadedData;
      } else {
        historyData.value = [];
      }
      latestStateCache = null; // may still hold the PREVIOUS project's reconstructed state

      // Check if baseline/hourly snapshot is needed on load
      checkAndTriggerHourlySnapshot();
    } catch (err) {
      console.warn("Error carregant històric de versions:", err);
      if (myEpoch === loadEpoch) historyData.value = [];
    }
  };

  // Synchronously clears in-memory history state -- called by App.vue right
  // after switching currentProjectName, BEFORE the (async) loadHistory() for
  // the new project resolves, so nothing can read/save the previous
  // project's history in that gap. Also invalidates any in-flight
  // loadHistory()/save from the previous project via the epoch counter.
  const resetHistoryState = () => {
    loadEpoch++;
    historyData.value = [];
    latestStateCache = null;
    if (saveHistoryTimer) {
      clearTimeout(saveHistoryTimer);
      saveHistoryTimer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  let saveHistoryTimer = null;
  const saveHistoryToStorage = () => {
    if (saveHistoryTimer) clearTimeout(saveHistoryTimer);
    // Captured NOW (schedule time), not when the timeout fires -- if the
    // active project changes during this 1s debounce, historyData.value
    // will ALSO have already been swapped to the new project's data by
    // resetHistoryState()/loadHistory() by the time this runs, so saving it
    // under either the old or the new key would be wrong. Comparing the two
    // lets us abort cleanly instead of corrupting either project's storage.
    const keyAtSchedule = getStorageKey();
    const epochAtSchedule = loadEpoch;
    saveHistoryTimer = setTimeout(async () => {
      saveHistoryTimer = null;
      if (loadEpoch !== epochAtSchedule || getStorageKey() !== keyAtSchedule) return;
      try {
        const key = keyAtSchedule;
        // Cap history at 25 snapshots to balance depth & performance
        if (historyData.value.length > 25) {
          historyData.value = historyData.value.slice(-25);
        }
        historyData.value.forEach(snap => {
          if (snap.diffs && snap.diffs.length > 20) {
            // Re-base before trimming: each kept diff's dataPatch is relative
            // to the reconstructed state right before it, so simply dropping
            // the oldest diffs would leave the remaining ones un-replayable
            // from snap.excelJsonData (they were computed against
            // intermediate states we'd no longer have). Reconstructing the
            // state as of the last DROPPED diff and promoting it to the
            // snapshot's own baseline keeps the kept diffs valid -- their
            // patches are already relative to exactly that point.
            const dropCount = snap.diffs.length - 20;
            const lastDropped = snap.diffs[dropCount - 1];
            snap.excelJsonData = reconstructExcelJsonDataAt(snap, dropCount - 1);
            snap.templateText = lastDropped.snapshotState?.templateText ?? lastDropped.templateText ?? snap.templateText;
            snap.editorMetadata = lastDropped.snapshotState?.editorMetadata ?? lastDropped.editorMetadata ?? snap.editorMetadata;
            snap.diffs = snap.diffs.slice(dropCount);
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
      tpl = lastDiff.templateText ?? tpl;
      meta = lastDiff.editorMetadata ?? meta;
      // Backward compatibility: history saved before this change stored a
      // full snapshotState.excelJsonData per diff instead of a dataPatch --
      // use it directly rather than trying to reconstruct from a patch that
      // was never computed.
      if (lastDiff.snapshotState) {
        tpl = lastDiff.snapshotState.templateText ?? tpl;
        data = lastDiff.snapshotState.excelJsonData ?? data;
        meta = lastDiff.snapshotState.editorMetadata ?? meta;
      } else {
        data = reconstructExcelJsonDataAt(lastSnap, lastSnap.diffs.length - 1);
      }
    }

    latestStateCache = { templateText: tpl, excelJsonData: data, editorMetadata: meta };
    return latestStateCache;
  };

  // Full {templateText, excelJsonData, editorMetadata} for ANY entry in the
  // timeline -- a baseline snapshot's own fields directly, or a diff
  // reconstructed by replaying its snapshot's dataPatch chain up to (and
  // including) it. Exported for VersionHistoryModal.vue, which only ever
  // needs the lightweight diff ops for display, and calls this on demand
  // (selecting an entry, or restoring it) rather than the app carrying a
  // full reconstructed copy per entry at all times.
  const reconstructStateForEntry = (snapId, diffId = null) => {
    const snap = historyData.value.find(s => s.id === snapId);
    if (!snap) return null;
    if (!diffId) {
      return {
        templateText: snap.templateText || '',
        excelJsonData: snap.excelJsonData || null,
        editorMetadata: snap.editorMetadata || []
      };
    }
    const diffs = snap.diffs || [];
    const diffIndex = diffs.findIndex(d => d.id === diffId);
    if (diffIndex === -1) return null;
    const diff = diffs[diffIndex];
    // Backward compatibility with pre-dataPatch history (see getLatestState).
    if (diff.snapshotState) {
      return {
        templateText: diff.snapshotState.templateText ?? (snap.templateText || ''),
        excelJsonData: diff.snapshotState.excelJsonData ?? snap.excelJsonData ?? null,
        editorMetadata: diff.snapshotState.editorMetadata ?? snap.editorMetadata ?? []
      };
    }
    return {
      templateText: diff.templateText ?? (snap.templateText || ''),
      excelJsonData: reconstructExcelJsonDataAt(snap, diffIndex),
      editorMetadata: diff.editorMetadata ?? (snap.editorMetadata || [])
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
    const dataPatch = computeDataPatch(latestState?.excelJsonData, currentData);
    const metaDiff = computeJsonDiff(latestState?.editorMetadata, currentMeta);

    // Only record if something actually changed
    if (!textDiff && !dataPatch && !metaDiff) return;

    // Update in-memory latest state cache
    latestStateCache = {
      templateText: currentTpl,
      excelJsonData: currentData ? JSON.parse(JSON.stringify(currentData)) : null,
      editorMetadata: currentMeta ? JSON.parse(JSON.stringify(currentMeta)) : []
    };

    // Only excelJsonData (the data model) is stored as a diff -- templateText
    // and editorMetadata stay full per entry (out of scope for this: they're
    // typically much smaller, and the reported storage problem was
    // specifically about the data model being duplicated in full on every
    // change).
    const diffEntry = {
      id: `diff-${nowTs}`,
      timestamp: now.toISOString(),
      displayTime: `${now.toLocaleDateString()} ${now.toLocaleTimeString()}`,
      note,
      textDiff,
      dataPatch,
      metaDiff,
      templateText: currentTpl,
      editorMetadata: latestStateCache.editorMetadata
    };

    if (!lastSnap.diffs) lastSnap.diffs = [];
    lastSnap.diffs.push(diffEntry);
    saveHistoryToStorage();
  };

  // Restore options: full, template, data, schema. `state` must already be
  // the FULLY RECONSTRUCTED {templateText, excelJsonData, editorMetadata}
  // for whichever entry is being restored -- the caller (VersionHistoryModal.vue)
  // resolves that via reconstructStateForEntry before emitting, since a diff
  // entry alone no longer carries a full excelJsonData copy to fall back to.
  const restoreVersion = (state, mode = 'all', displayTime = '') => {
    if (!state) return;

    isAutoRecording.value = false;
    const pName = getProjectName();
    const aDoc = localStorage.getItem(`${pName}:activeDocName`) || 'Document Principal';

    if (mode === 'all' || mode === 'template') {
      if (state.templateText !== undefined) {
        store.templateText = state.templateText;
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
      createSnapshot('manual', `Restauració de versió: ${modeLabels[mode]} (${displayTime})`);
      store.addLog(`🔄 S'ha restaurat la versió (${modeLabels[mode]}) de ${displayTime}`, 'success');
    }, 300);
  };

  // Auto-record debouncer for edits (configurable delay, default 5 seconds)
  let debounceTimer = null;
  const triggerDebouncedRecord = (note = 'Canvi de dades') => {
    if (debounceTimer) clearTimeout(debounceTimer);
    const delayMs = Math.max(1, (store.config?.autoSaveDebounceSeconds || 5)) * 1000;
    // Same epoch guard as saveHistoryToStorage: a project switch mid-debounce
    // (e.g. this was scheduled by the store.excelJsonData watcher firing on
    // the switch itself) resets historyData.value to [] synchronously via
    // resetHistoryState(), which would otherwise make recordChangeDiff treat
    // the new project as having no history yet and seal a premature 'init'
    // snapshot from whatever partial state exists mid-load.
    const epochAtSchedule = loadEpoch;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (loadEpoch !== epochAtSchedule) return;
      recordChangeDiff(note);
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
    resetHistoryState,
    reconstructStateForEntry,
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

