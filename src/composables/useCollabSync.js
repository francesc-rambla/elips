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
 * Fase 2: local edit capture -- a deep, debounced watcher on
 * store.excelJsonData diffs the current state against the last known one
 * and appends any change, as a fast-json-patch patch, to this user's OWN
 * delta file (collab_deltas_<userId>.jsonl).
 *
 * Fase 3 (this file, now): the merge/replay engine -- pollCycle(), on an
 * interval, rereads the shared baseline plus EVERY connected user's delta
 * file (including this one's own), replays them all in a deterministic
 * order on top of the baseline, and -- if the result differs from what
 * this client already has -- applies it to store.excelJsonData. Nothing
 * writes a new baseline or compacts delta files yet (Fase 4).
 */

import { ref, watch, nextTick } from 'vue';
import { useWorkspaceStore } from '../stores/workspace.js';
import { computeDataPatch, applyDataPatch } from '../utils/dataPatch.js';
import { getOrCreateUserId } from './useCollabIdentity.js';

const BASELINE_FILE = 'collab_baseline.json';
const BASELINE_META_FILE = 'collab_baseline.meta.json';

/**
 * `collabFolder`: the object returned by useCollabFolder(projectNameRef) --
 * this composable only ever touches the folder through that API (never
 * picks its own handle), so the two stay in sync about which folder (if
 * any) is currently connected.
 */
export function useCollabSync(collabFolder) {
  const store = useWorkspaceStore();

  // The last state this client knows to already be reflected in the shared
  // folder -- the diff base for outgoing deltas, and the point newly-read
  // remote deltas get compared against to decide whether anything actually
  // changed.
  const lastMergedState = ref(null);
  const lastSeenBaselineSeq = ref(0);
  // Set while pollCycle() applies a remote merge to store.excelJsonData, so
  // the capture watcher below never mistakes that assignment (or a
  // calculated-field recompute it triggers downstream, e.g.
  // DataInspector.vue's own watcher) for a local edit and loops it straight
  // back out as a new delta entry.
  const isApplyingRemote = ref(false);
  const lastSyncError = ref(null);

  let baseline = null; // last-read collab_baseline.json content (full tree)
  let nextSeq = 1;
  let stopWatcher = null;
  let debounceTimer = null;
  let pollTimer = null;
  let pollRunning = false;
  let running = false;

  const deltaFileName = (userId) => `collab_deltas_${userId}.jsonl`;

  // Resumes this user's own seq counter from wherever their delta file
  // already left off (e.g. after a reconnect), rather than restarting at 1
  // and producing seq values that go backwards relative to entries already
  // on disk -- not required for pollCycle's own ordering (that replays by
  // timestamp, not seq), but confusing to leave inconsistent regardless.
  async function primeNextSeq() {
    const text = await collabFolder.readTextFile(deltaFileName(getOrCreateUserId()));
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
      await collabFolder.appendLinesToFile(deltaFileName(getOrCreateUserId()), [entry]);
      // Updated immediately (not on the next poll cycle) so this client
      // never re-diffs and re-appends its own just-written change.
      lastMergedState.value = JSON.parse(JSON.stringify(store.excelJsonData));
    } catch (e) {
      store.addLog(`Error en desar un canvi a la carpeta de col·laboració: ${e.message}`, 'error');
    }
  }

  // Parses one user's delta file into its individual JSON entries,
  // tolerating a trailing partial/corrupt line (e.g. a concurrent writer
  // caught mid-append) by skipping just that line rather than the whole
  // file.
  function parseDeltaEntries(text) {
    if (!text) return [];
    const entries = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch (_) {
        // skip -- likely a partially-written trailing line
      }
    }
    return entries;
  }

  async function pollCycle() {
    if (!running || pollRunning) return;
    pollRunning = true;
    try {
      const meta = await collabFolder.readJsonFile(BASELINE_META_FILE);
      if (meta && meta.seq !== lastSeenBaselineSeq.value) {
        const freshBaseline = await collabFolder.readJsonFile(BASELINE_FILE);
        if (freshBaseline !== null) {
          baseline = freshBaseline;
          lastSeenBaselineSeq.value = meta.seq;
        }
      }
      if (!baseline) return; // nothing to merge against yet

      const userIds = await collabFolder.listDeltaFileUserIds();
      const allEntries = [];
      for (const userId of userIds) {
        const text = await collabFolder.readTextFile(deltaFileName(userId));
        allEntries.push(...parseDeltaEntries(text));
      }
      // Deterministic order: by timestamp, tie-broken by userId -- NEVER
      // applied incrementally from whatever store.excelJsonData already is,
      // always replayed from the baseline fresh, so two users touching the
      // same path converge on the same result regardless of poll timing.
      allEntries.sort((a, b) => {
        if (a.ts < b.ts) return -1;
        if (a.ts > b.ts) return 1;
        return String(a.userId).localeCompare(String(b.userId));
      });

      let merged = JSON.parse(JSON.stringify(baseline));
      for (const entry of allEntries) {
        if (entry.patch && entry.patch.length > 0) {
          merged = applyDataPatch(merged, entry.patch);
        }
      }

      if (JSON.stringify(merged) !== JSON.stringify(lastMergedState.value)) {
        isApplyingRemote.value = true;
        store.excelJsonData = merged;
        await nextTick();
        isApplyingRemote.value = false;
        // Re-read store.excelJsonData (not `merged`) AFTER nextTick: a
        // downstream watcher (e.g. DataInspector.vue's calculated-fields
        // recompute) may have further mutated it synchronously during that
        // same flush, and lastMergedState must reflect that final state,
        // not the pre-recompute one, or the very next capture would
        // mis-diff against stale data and re-emit the recompute's own
        // output as if it were a fresh local edit.
        lastMergedState.value = JSON.parse(JSON.stringify(store.excelJsonData));
        store.addLog("S'han incorporat canvis d'altres persones des de la carpeta de col·laboració.", 'info');
      }
      lastSyncError.value = null;
    } catch (e) {
      lastSyncError.value = e.message;
      store.addLog(`Error en sincronitzar amb la carpeta de col·laboració: ${e.message}`, 'error');
    } finally {
      pollRunning = false;
    }
  }

  async function startCollabSync() {
    if (running) return;
    running = true;
    baseline = null;
    lastSeenBaselineSeq.value = 0;
    lastMergedState.value = store.excelJsonData ? JSON.parse(JSON.stringify(store.excelJsonData)) : null;
    try {
      await primeNextSeq();
    } catch (e) {
      store.addLog(`Error en preparar la sincronització de col·laboració: ${e.message}`, 'warning');
    }

    stopWatcher = watch(() => store.excelJsonData, () => {
      // Checked here (not only inside captureLocalChange, which only runs
      // once the debounce timer fires, seconds later -- by then the flag
      // would already be back to false) so a change caused by an
      // in-progress remote merge is never even scheduled for capture.
      if (isApplyingRemote.value) return;
      clearTimeout(debounceTimer);
      const delaySec = store.config.collabCaptureDebounceSeconds || 5;
      debounceTimer = setTimeout(captureLocalChange, delaySec * 1000);
    }, { deep: true });

    const pollDelayMs = (store.config.collabPollIntervalSeconds || 5) * 1000;
    pollTimer = setInterval(pollCycle, pollDelayMs);
    pollCycle(); // don't wait a full interval for the first read
  }

  function stopCollabSync() {
    running = false;
    if (stopWatcher) {
      stopWatcher();
      stopWatcher = null;
    }
    clearTimeout(debounceTimer);
    debounceTimer = null;
    clearInterval(pollTimer);
    pollTimer = null;
    baseline = null;
    lastMergedState.value = null;
  }

  return {
    startCollabSync,
    stopCollabSync,
    isApplyingRemote,
    lastMergedState,
    lastSeenBaselineSeq,
    lastSyncError,
  };
}
