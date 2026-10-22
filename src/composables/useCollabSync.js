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

/**
 * Folder-based collaboration sync engine (see useCollabFolder.js for the
 * folder/file primitives this builds on, and the plan at
 * .claude/plans/unified-nibbling-adleman.md for the full design).
 *
 * Fase 2 (this file, for now): LOCAL EDIT CAPTURE ONLY -- a deep, debounced
 * watcher on store.excelJsonData diffs the current state against the last
 * known one and appends any change, as a fast-json-patch patch, to this
 * user's OWN delta file (collab_deltas_<userId>.jsonl). Nothing reads
 * anyone else's delta file yet and nothing merges remote changes back in
 * -- that is pollCycle() (Fase 3), which is also what will ever set
 * `isApplyingRemote` to true. It is already threaded through the capture
 * watcher now so that addition is a pure Fase-3 change to THIS file, not a
 * second pass over the watcher wiring.
 */

import { ref, watch } from 'vue';
import { useWorkspaceStore } from '../stores/workspace.js';
import { computeDataPatch } from '../utils/dataPatch.js';
import { getOrCreateUserId } from './useCollabIdentity.js';

/**
 * `collabFolder`: the object returned by useCollabFolder(projectNameRef) --
 * this composable only ever touches the folder through that API (never
 * picks its own handle), so the two stay in sync about which folder (if
 * any) is currently connected.
 */
export function useCollabSync(collabFolder) {
  const store = useWorkspaceStore();

  // The last state this client knows to already be reflected in the shared
  // folder -- the diff base for outgoing deltas (Fase 2) and, once Fase 3
  // lands, also the point newly-read remote deltas get compared against.
  const lastMergedState = ref(null);
  const lastSeenBaselineSeq = ref(0);
  // Set by pollCycle() (Fase 3) while it applies a remote merge to
  // store.excelJsonData, so the capture watcher below never mistakes that
  // assignment for a local edit and loops it straight back out again.
  const isApplyingRemote = ref(false);

  let nextSeq = 1;
  let stopWatcher = null;
  let debounceTimer = null;
  let running = false;

  const deltaFileName = () => `collab_deltas_${getOrCreateUserId()}.jsonl`;

  // Resumes this user's own seq counter from wherever their delta file
  // already left off (e.g. after a reconnect), rather than restarting at 1
  // and producing seq values that go backwards relative to entries already
  // on disk -- not required for Fase 3's own ordering (that replays by
  // timestamp, not seq), but confusing to leave inconsistent regardless.
  async function primeNextSeq() {
    const text = await collabFolder.readTextFile(deltaFileName());
    nextSeq = 1;
    if (!text) return;
    const lines = text.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return;
    try {
      const last = JSON.parse(lines[lines.length - 1]);
      if (typeof last.seq === 'number') nextSeq = last.seq + 1;
    } catch (_) {
      nextSeq = lines.length + 1;
    }
  }

  async function captureLocalChange() {
    if (isApplyingRemote.value || !running) return;
    const patch = computeDataPatch(lastMergedState.value, store.excelJsonData);
    if (!patch) return;
    const entry = {
      seq: nextSeq++,
      ts: new Date().toISOString(),
      userId: getOrCreateUserId(),
      baselineSeq: lastSeenBaselineSeq.value,
      patch,
    };
    try {
      await collabFolder.appendLinesToFile(deltaFileName(), [entry]);
      // Updated immediately (not on the next poll cycle) so this client
      // never re-diffs and re-appends its own just-written change.
      lastMergedState.value = JSON.parse(JSON.stringify(store.excelJsonData));
    } catch (e) {
      store.addLog(`Error en desar un canvi a la carpeta de col·laboració: ${e.message}`, 'error');
    }
  }

  async function startCollabSync() {
    if (running) return;
    running = true;
    lastMergedState.value = store.excelJsonData ? JSON.parse(JSON.stringify(store.excelJsonData)) : null;
    try {
      await primeNextSeq();
    } catch (e) {
      store.addLog(`Error en preparar la sincronització de col·laboració: ${e.message}`, 'warning');
    }

    stopWatcher = watch(() => store.excelJsonData, () => {
      clearTimeout(debounceTimer);
      const delaySec = store.config.collabCaptureDebounceSeconds || 5;
      debounceTimer = setTimeout(captureLocalChange, delaySec * 1000);
    }, { deep: true });
  }

  function stopCollabSync() {
    running = false;
    if (stopWatcher) {
      stopWatcher();
      stopWatcher = null;
    }
    clearTimeout(debounceTimer);
    debounceTimer = null;
    lastMergedState.value = null;
  }

  return {
    startCollabSync,
    stopCollabSync,
    isApplyingRemote,
    lastMergedState,
    lastSeenBaselineSeq,
  };
}
