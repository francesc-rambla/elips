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
 * Fase 3: the merge/replay engine -- pollCycle(), on an interval, rereads
 * the shared baseline plus EVERY connected user's delta file (including
 * this one's own), replays them all in a deterministic order on top of the
 * baseline, and -- if the result differs from what this client already
 * has -- applies it to store.excelJsonData.
 *
 * Fase 4 (this file, now): compaction -- once the combined delta files grow
 * past a threshold (or enough time has passed since the last compaction),
 * any client writes a new baseline = the already-merged state, and every
 * client (not just the one that wrote it) truncates its OWN delta file down
 * to just the entries newer than that new baseline, bounding how large
 * these files grow indefinitely.
 *
 * Fase 5 (this file, now): presence (so CollabPanel.vue can show who's
 * connected), a bounded activity log, and a same-path conflict warning when
 * two different users' deltas, newly seen in the same poll cycle, touched
 * the exact same JSON path (still resolved silently by timestamp --this is
 * visibility only, not a different resolution strategy).
 */

import { ref, watch, nextTick } from 'vue';
import { useWorkspaceStore } from '../stores/workspace.js';
import { computeDataPatch, applyDataPatch } from '../utils/dataPatch.js';
import { getOrCreateUserId, getDisplayNameOrFallback } from './useCollabIdentity.js';

const BASELINE_FILE = 'collab_baseline.json';
const BASELINE_META_FILE = 'collab_baseline.meta.json';
const PROJECT_ZIP_FILE = 'collab_project.zip';

const COMPACT_LINE_THRESHOLD = 200; // total delta lines across every user
const COMPACT_TIME_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes since the baseline's own updatedAt
const PEER_STALE_MS = 30 * 1000; // presence older than this shows as "possibly disconnected"
const ACTIVITY_LOG_MAX = 20;

/**
 * `collabFolder`: the object returned by useCollabFolder(projectNameRef) --
 * this composable only ever touches the folder through that API (never
 * picks its own handle), so the two stay in sync about which folder (if
 * any) is currently connected.
 * `buildProjectZipBlob`: App.vue's existing project-ZIP builder (the same
 * one connectFolder() seeds the folder with), reused here to refresh
 * collab_project.zip at compaction time so a later loadProjectFromFolder()
 * doesn't pick up an overly stale template/schema snapshot.
 */
export function useCollabSync(collabFolder, buildProjectZipBlob) {
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

  // Fase 5: who else is connected (from collab_presence_*.json), and a
  // bounded, newest-first log of collaboration events for CollabPanel.vue.
  const connectedPeers = ref([]);
  const collabActivityLog = ref([]);

  let baseline = null; // last-read collab_baseline.json content (full tree)
  let nextSeq = 1;
  let stopWatcher = null;
  let debounceTimer = null;
  let pollTimer = null;
  let pollRunning = false;
  let running = false;
  // The latest entry timestamp already considered for conflict detection,
  // so the SAME historical collision isn't re-flagged on every subsequent
  // poll cycle (every cycle replays ALL entries from scratch, but only
  // entries newer than this are "new" since the last time we looked).
  let lastConflictCheckTs = '';
  // userId -> displayName, refreshed each cycle from presence files, reused
  // to show a name rather than a raw id in conflict-warning text.
  const knownDisplayNames = new Map();

  const deltaFileName = (userId) => `collab_deltas_${userId}.jsonl`;
  const presenceFileName = (userId) => `collab_presence_${userId}.json`;

  function logCollabEvent(text, type = 'info') {
    store.addLog(text, type);
    collabActivityLog.value.unshift({ time: new Date().toLocaleTimeString(), text, type });
    if (collabActivityLog.value.length > ACTIVITY_LOG_MAX) {
      collabActivityLog.value.length = ACTIVITY_LOG_MAX;
    }
  }

  function displayNameFor(userId) {
    if (userId === getOrCreateUserId()) return `${getDisplayNameOrFallback()} (tu)`;
    return knownDisplayNames.get(userId) || `Usuari ${String(userId).slice(0, 4)}`;
  }

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
      logCollabEvent(`Error en desar un canvi a la carpeta de col·laboració: ${e.message}`, 'error');
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

  async function writeOwnPresence() {
    try {
      await collabFolder.writeJsonFile(presenceFileName(getOrCreateUserId()), {
        displayName: getDisplayNameOrFallback(),
        lastSeen: new Date().toISOString(),
      });
    } catch (_) {
      // best-effort -- presence is cosmetic (participant list), never worth
      // failing the whole poll cycle over.
    }
  }

  async function refreshConnectedPeers() {
    try {
      const userIds = await collabFolder.listPresenceFileUserIds();
      const peers = [];
      const now = Date.now();
      for (const userId of userIds) {
        const presence = await collabFolder.readJsonFile(presenceFileName(userId));
        if (!presence) continue;
        knownDisplayNames.set(userId, presence.displayName || `Usuari ${userId.slice(0, 4)}`);
        const lastSeenMs = presence.lastSeen ? new Date(presence.lastSeen).getTime() : 0;
        peers.push({
          userId,
          displayName: presence.displayName || `Usuari ${userId.slice(0, 4)}`,
          lastSeen: presence.lastSeen || null,
          isSelf: userId === getOrCreateUserId(),
          isStale: !lastSeenMs || (now - lastSeenMs) > PEER_STALE_MS,
        });
      }
      peers.sort((a, b) => (a.isSelf === b.isSelf ? 0 : a.isSelf ? -1 : 1));
      connectedPeers.value = peers;
    } catch (_) {
      // best-effort, same reasoning as writeOwnPresence
    }
  }

  // Flags (without changing how the merge itself resolves them) when two
  // DIFFERENT users' entries, both newer than the last time this was
  // checked, touch the exact same JSON path -- a visible, non-blocking
  // heads-up, not a second conflict-resolution strategy. Checked against
  // "newer than last check" rather than every entry every cycle, so the
  // SAME historical collision is only ever reported once.
  function detectAndLogConflicts(sortedEntries) {
    const newEntries = sortedEntries.filter(e => e.ts > lastConflictCheckTs);
    if (newEntries.length === 0) return;

    const byPath = new Map(); // path -> [{userId, ts}]
    for (const entry of newEntries) {
      if (!entry.patch) continue;
      for (const op of entry.patch) {
        if (!op.path) continue;
        if (!byPath.has(op.path)) byPath.set(op.path, []);
        byPath.get(op.path).push({ userId: entry.userId, ts: entry.ts });
      }
    }
    for (const [path, touches] of byPath) {
      const distinctUsers = new Set(touches.map(t => t.userId));
      if (distinctUsers.size < 2) continue;
      touches.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      const winner = touches[touches.length - 1];
      logCollabEvent(
        `Canvi simultani detectat a "${path}": s'ha mantingut la versió de ${displayNameFor(winner.userId)} (la més recent).`,
        'warning'
      );
    }
    lastConflictCheckTs = newEntries[newEntries.length - 1].ts;
  }

  function shouldCompact(meta, totalEntryCount) {
    if (totalEntryCount >= COMPACT_LINE_THRESHOLD) return true;
    if (meta?.updatedAt) {
      const age = Date.now() - new Date(meta.updatedAt).getTime();
      if (age >= COMPACT_TIME_THRESHOLD_MS) return true;
    }
    return false;
  }

  // Keeps only the entries newer than `cutoffIso` (already folded into the
  // new baseline, by construction) -- a client truncates ONLY its own file,
  // never another user's, so this never races with anyone else's append.
  async function truncateOwnDeltaFile(cutoffIso) {
    const name = deltaFileName(getOrCreateUserId());
    const text = await collabFolder.readTextFile(name);
    if (!text) return;
    const kept = parseDeltaEntries(text).filter(e => e.ts > cutoffIso);
    const newText = kept.length ? kept.map(e => JSON.stringify(e)).join('\n') + '\n' : '';
    await collabFolder.writeTextFile(name, newText);
  }

  async function maybeCompact(meta, merged, totalEntryCount) {
    if (!shouldCompact(meta, totalEntryCount)) return;
    try {
      // Optimistic check: re-read meta right before writing, only proceed
      // if it still matches what this cycle started with -- narrows
      // (doesn't eliminate) the race with another client compacting at the
      // same time; a residual race is harmless since both would compute
      // the same content anyway.
      const freshMeta = await collabFolder.readJsonFile(BASELINE_META_FILE);
      if (freshMeta && meta && freshMeta.seq !== meta.seq) return; // someone else already compacted this cycle

      const newSeq = (meta?.seq || 0) + 1;
      const updatedAt = new Date().toISOString();
      await collabFolder.writeJsonFile(BASELINE_FILE, merged);
      await collabFolder.writeJsonFile(BASELINE_META_FILE, { seq: newSeq, updatedAt, updatedBy: getOrCreateUserId() });
      baseline = merged;
      lastSeenBaselineSeq.value = newSeq;

      if (buildProjectZipBlob) {
        try {
          const zipBlob = await buildProjectZipBlob();
          await collabFolder.writeBinaryFile(PROJECT_ZIP_FILE, zipBlob);
        } catch (_) {
          // best-effort -- a stale project ZIP isn't critical enough to
          // fail the whole compaction over.
        }
      }

      await truncateOwnDeltaFile(updatedAt);
      logCollabEvent("S'ha compactat la carpeta de col·laboració (nova base comuna).", 'info');
    } catch (e) {
      logCollabEvent(`Error en compactar la carpeta de col·laboració: ${e.message}`, 'warning');
    }
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
          // The new baseline already incorporates every entry up to its own
          // updatedAt, by construction -- safe for THIS client to drop them
          // from its own file even if it wasn't the one that compacted.
          await truncateOwnDeltaFile(meta.updatedAt);
        }
      }

      await writeOwnPresence();
      await refreshConnectedPeers();

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

      detectAndLogConflicts(allEntries);

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
        logCollabEvent("S'han incorporat canvis d'altres persones des de la carpeta de col·laboració.", 'info');
      }

      await maybeCompact(meta, merged, allEntries.length);
      lastSyncError.value = null;
    } catch (e) {
      lastSyncError.value = e.message;
      logCollabEvent(`Error en sincronitzar amb la carpeta de col·laboració: ${e.message}`, 'error');
    } finally {
      pollRunning = false;
    }
  }

  async function startCollabSync() {
    if (running) return;
    running = true;
    baseline = null;
    lastSeenBaselineSeq.value = 0;
    lastConflictCheckTs = '';
    knownDisplayNames.clear();
    connectedPeers.value = [];
    lastMergedState.value = store.excelJsonData ? JSON.parse(JSON.stringify(store.excelJsonData)) : null;
    try {
      await primeNextSeq();
    } catch (e) {
      logCollabEvent(`Error en preparar la sincronització de col·laboració: ${e.message}`, 'warning');
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
    connectedPeers.value = [];
  }

  return {
    startCollabSync,
    stopCollabSync,
    isApplyingRemote,
    lastMergedState,
    lastSeenBaselineSeq,
    lastSyncError,
    connectedPeers,
    collabActivityLog,
  };
}
