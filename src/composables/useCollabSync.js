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
 * .claude/plans/unified-nibbling-adleman.md for the full design -- the
 * "Ampliació" section in particular describes this file's current shape).
 *
 * The merge/capture/compaction engine is written ONCE, as createDocChannel()
 * below, and instantiated per synced document ("channel") rather than
 * duplicated -- today only for `store.excelJsonData` (docKey 'data'), with
 * `editorMetadata` ("schema") and `templateText` ("template") channels
 * planned as later additions reusing the exact same engine. Each channel:
 *
 * - Captures local edits: a deep, debounced watcher diffs the current value
 *   against the last known one and appends any change, as a fast-json-patch
 *   patch, to this user's OWN delta file for that channel -- never another
 *   user's file, so concurrent writers never collide.
 * - Merges remote edits: on an interval, rereads its own baseline plus
 *   EVERY connected user's delta file for that channel (including this
 *   one's own), replays them all in a deterministic order on top of the
 *   baseline FROM SCRATCH each cycle, and -- if the result differs from
 *   what this client already has -- applies it to the store.
 * - Compacts: once a channel's delta files grow past a threshold (or
 *   enough time has passed), any client writes a new baseline = the
 *   already-merged state, and every client truncates its OWN delta file
 *   for that channel down to just the entries newer than it.
 *
 * Presence, the connected-peers list, and the activity log are channel-
 * agnostic (one presence file per user, one shared participant list/log
 * for CollabPanel.vue) and live at the outer useCollabSync() level, driven
 * by a single shared poll tick that runs every channel's own pollCycle().
 */

import { ref, watch, nextTick } from 'vue';
import { useWorkspaceStore } from '../stores/workspace.js';
import { computeDataPatch, applyDataPatch } from '../utils/dataPatch.js';
import { getOrCreateUserId, getDisplayNameOrFallback } from './useCollabIdentity.js';

const PROJECT_ZIP_FILE = 'collab_project.zip';

const COMPACT_LINE_THRESHOLD = 200; // total delta lines across every user, for one channel
const COMPACT_TIME_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes since that channel's own baseline updatedAt
const PEER_STALE_MS = 30 * 1000; // presence older than this shows as "possibly disconnected"
const ACTIVITY_LOG_MAX = 20;

// Parses one user's delta file into its individual JSON entries, tolerating
// a trailing partial/corrupt line (e.g. a concurrent writer caught
// mid-append) by skipping just that line rather than the whole file.
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

/**
 * One synced document's merge/capture/compaction engine, parameterized so
 * the exact same (already-tested) logic can be reused for `excelJsonData`,
 * `editorMetadata`, and `templateText` without copy-pasting it three times.
 *
 * `deltaFileName(userId)`/`baselineFile`/`baselineMetaFile`: this channel's
 * own filenames in the shared folder -- distinct per channel so their
 * baselines/deltas never collide on disk.
 * `listUserIds()`: discovers which users have a delta file for THIS channel
 * (mirrors useCollabFolder.js's listDeltaFileUserIds()).
 * `getLocal()`/`setLocal(value)`: read/write the relevant store field.
 * `wrap(value)`/`unwrap(wrapped)`: optional (default identity) -- lets a
 * non-object value (e.g. templateText's plain string) be carried through
 * the same object-shaped JSON-patch machinery as a `{text: value}`
 * envelope, unwrapped again only at the point of `setLocal`.
 * `computePatch(oldWrapped, newWrapped)`: `computeDataPatch`/
 * `computeMetaPatch`-shaped diff function for the (already-wrapped) doc.
 * `onApplyingRemoteChange(bool)`: optional hook fired whenever this
 * channel starts/stops applying a remote merge -- used by the template
 * channel to mirror the flag onto the store so TemplateEditor.vue can tell
 * "this external change is a live sync merge" apart from "this is a real
 * document switch" (see the plan's `collabApplyingRemoteTemplate` note).
 * `mergeMessage`/`compactMessage`: activity-log text for this channel.
 * `logEvent(text, type)`: shared logger (see useCollabSync()'s
 * `logCollabEvent`).
 */
function createDocChannel({
  docKey,
  collabFolder,
  deltaFileName,
  baselineFile,
  baselineMetaFile,
  listUserIds,
  getLocal,
  setLocal,
  wrap = (v) => v,
  unwrap = (v) => v,
  computePatch,
  onApplyingRemoteChange,
  mergeMessage,
  compactMessage,
  logEvent,
}) {
  const isApplyingRemote = ref(false);
  const lastMergedState = ref(null);
  const lastSeenBaselineSeq = ref(0);

  let baseline = null; // last-read baseline file content (wrapped form)
  let nextSeq = 1;
  let lastConflictCheckTs = '';
  let debounceTimer = null;

  function setApplyingRemote(v) {
    isApplyingRemote.value = v;
    if (onApplyingRemoteChange) onApplyingRemoteChange(v);
  }

  const ownDeltaFileName = () => deltaFileName(getOrCreateUserId());

  // Resumes this user's own seq counter from wherever their delta file
  // already left off (e.g. after a reconnect), rather than restarting at 1
  // and producing seq values that go backwards relative to entries already
  // on disk.
  async function primeNextSeq() {
    const text = await collabFolder.readTextFile(ownDeltaFileName());
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
    if (isApplyingRemote.value) return;
    const patch = computePatch(lastMergedState.value, wrap(getLocal()));
    if (!patch) return;
    const entry = {
      seq: nextSeq++,
      ts: new Date().toISOString(),
      userId: getOrCreateUserId(),
      baselineSeq: lastSeenBaselineSeq.value,
      patch,
    };
    try {
      await collabFolder.appendLinesToFile(ownDeltaFileName(), [entry]);
      // Updated immediately (not on the next poll cycle) so this client
      // never re-diffs and re-appends its own just-written change.
      lastMergedState.value = JSON.parse(JSON.stringify(wrap(getLocal())));
    } catch (e) {
      logEvent(`Error en desar un canvi a la carpeta de col·laboració: ${e.message}`, 'error');
    }
  }

  function scheduleCaptureOnChange(debounceMs) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(captureLocalChange, debounceMs);
  }

  function cancelPendingCapture() {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  // Flags (without changing how the merge itself resolves them) when two
  // DIFFERENT users' entries, both newer than the last time this was
  // checked, touch the exact same JSON path -- a visible, non-blocking
  // heads-up, not a second conflict-resolution strategy.
  function detectAndLogConflicts(sortedEntries, displayNameFor) {
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
      logEvent(
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
    const name = ownDeltaFileName();
    const text = await collabFolder.readTextFile(name);
    if (!text) return;
    const kept = parseDeltaEntries(text).filter(e => e.ts > cutoffIso);
    const newText = kept.length ? kept.map(e => JSON.stringify(e)).join('\n') + '\n' : '';
    await collabFolder.writeTextFile(name, newText);
  }

  // Returns true if this cycle actually compacted (so the outer poll tick
  // can decide whether to refresh the shared collab_project.zip once).
  async function maybeCompact(meta, merged, totalEntryCount) {
    if (!shouldCompact(meta, totalEntryCount)) return false;
    try {
      // Optimistic check: re-read meta right before writing, only proceed
      // if it still matches what this cycle started with -- narrows
      // (doesn't eliminate) the race with another client compacting at the
      // same time; a residual race is harmless since both would compute
      // the same content anyway.
      const freshMeta = await collabFolder.readJsonFile(baselineMetaFile);
      if (freshMeta && meta && freshMeta.seq !== meta.seq) return false;

      const newSeq = (meta?.seq || 0) + 1;
      const updatedAt = new Date().toISOString();
      await collabFolder.writeJsonFile(baselineFile, merged);
      await collabFolder.writeJsonFile(baselineMetaFile, { seq: newSeq, updatedAt, updatedBy: getOrCreateUserId() });
      baseline = merged;
      lastSeenBaselineSeq.value = newSeq;

      await truncateOwnDeltaFile(updatedAt);
      logEvent(compactMessage, 'info');
      return true;
    } catch (e) {
      logEvent(`Error en compactar la carpeta de col·laboració: ${e.message}`, 'warning');
      return false;
    }
  }

  // Returns true if this cycle compacted this channel's baseline.
  async function pollCycle(displayNameFor) {
    const meta = await collabFolder.readJsonFile(baselineMetaFile);
    if (meta && meta.seq !== lastSeenBaselineSeq.value) {
      const freshBaseline = await collabFolder.readJsonFile(baselineFile);
      if (freshBaseline !== null) {
        baseline = freshBaseline;
        lastSeenBaselineSeq.value = meta.seq;
        // The new baseline already incorporates every entry up to its own
        // updatedAt, by construction -- safe for THIS client to drop them
        // from its own file even if it wasn't the one that compacted.
        await truncateOwnDeltaFile(meta.updatedAt);
      }
    }

    if (baseline === null) return false; // nothing to merge against yet

    const userIds = await listUserIds();
    const allEntries = [];
    for (const userId of userIds) {
      const text = await collabFolder.readTextFile(deltaFileName(userId));
      allEntries.push(...parseDeltaEntries(text));
    }
    // Deterministic order: by timestamp, tie-broken by userId -- NEVER
    // applied incrementally from whatever the store already has, always
    // replayed from the baseline fresh, so two users touching the same
    // path converge on the same result regardless of poll timing.
    allEntries.sort((a, b) => {
      if (a.ts < b.ts) return -1;
      if (a.ts > b.ts) return 1;
      return String(a.userId).localeCompare(String(b.userId));
    });

    detectAndLogConflicts(allEntries, displayNameFor);

    let merged = JSON.parse(JSON.stringify(baseline));
    for (const entry of allEntries) {
      if (entry.patch && entry.patch.length > 0) {
        merged = applyDataPatch(merged, entry.patch);
      }
    }

    if (JSON.stringify(merged) !== JSON.stringify(lastMergedState.value)) {
      setApplyingRemote(true);
      setLocal(unwrap(merged));
      await nextTick();
      setApplyingRemote(false);
      // Re-read via getLocal() (not `merged`) AFTER nextTick: a downstream
      // watcher (e.g. DataInspector.vue's calculated-fields recompute) may
      // have further mutated the store synchronously during that same
      // flush, and lastMergedState must reflect that final state, not the
      // pre-recompute one, or the very next capture would mis-diff against
      // stale data and re-emit the recompute's own output as a fresh edit.
      lastMergedState.value = JSON.parse(JSON.stringify(wrap(getLocal())));
      logEvent(mergeMessage, 'info');
    }

    return await maybeCompact(meta, merged, allEntries.length);
  }

  async function start() {
    baseline = null;
    lastSeenBaselineSeq.value = 0;
    lastConflictCheckTs = '';
    const local = getLocal();
    lastMergedState.value = local !== undefined && local !== null ? JSON.parse(JSON.stringify(wrap(local))) : null;
    try {
      await primeNextSeq();
    } catch (e) {
      logEvent(`Error en preparar la sincronització de col·laboració: ${e.message}`, 'warning');
    }
  }

  function stop() {
    cancelPendingCapture();
    baseline = null;
    lastMergedState.value = null;
  }

  return {
    docKey,
    isApplyingRemote,
    lastMergedState,
    lastSeenBaselineSeq,
    scheduleCaptureOnChange,
    cancelPendingCapture,
    pollCycle,
    start,
    stop,
  };
}

/**
 * `collabFolder`: the object returned by useCollabFolder(projectNameRef) --
 * this composable only ever touches the folder through that API.
 * `buildProjectZipBlob`: App.vue's existing project-ZIP builder, reused
 * here to refresh collab_project.zip whenever any channel compacts, so a
 * later loadProjectFromFolder() doesn't pick up an overly stale snapshot.
 */
export function useCollabSync(collabFolder, buildProjectZipBlob) {
  const store = useWorkspaceStore();

  const lastSyncError = ref(null);
  const connectedPeers = ref([]);
  const collabActivityLog = ref([]);

  let running = false;
  let pollRunning = false;
  let pollTimer = null;
  let stopWatchers = [];
  // userId -> displayName, refreshed each cycle from presence files, reused
  // to show a name rather than a raw id in conflict-warning text.
  const knownDisplayNames = new Map();

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

  const dataChannel = createDocChannel({
    docKey: 'data',
    collabFolder,
    deltaFileName: (userId) => `collab_deltas_${userId}.jsonl`,
    baselineFile: 'collab_baseline.json',
    baselineMetaFile: 'collab_baseline.meta.json',
    listUserIds: () => collabFolder.listDeltaFileUserIds(),
    getLocal: () => store.excelJsonData,
    setLocal: (v) => { store.excelJsonData = v; },
    computePatch: computeDataPatch,
    mergeMessage: "S'han incorporat canvis d'altres persones des de la carpeta de col·laboració.",
    compactMessage: "S'ha compactat la carpeta de col·laboració (nova base comuna).",
    logEvent: logCollabEvent,
  });

  const channels = [dataChannel];

  async function runPollTick() {
    if (!running || pollRunning) return;
    pollRunning = true;
    try {
      await writeOwnPresence();
      await refreshConnectedPeers();

      let anyCompacted = false;
      for (const channel of channels) {
        const compacted = await channel.pollCycle(displayNameFor);
        anyCompacted = anyCompacted || compacted;
      }

      if (anyCompacted && buildProjectZipBlob) {
        try {
          const zipBlob = await buildProjectZipBlob();
          await collabFolder.writeBinaryFile(PROJECT_ZIP_FILE, zipBlob);
        } catch (_) {
          // best-effort -- a stale project ZIP isn't critical enough to
          // fail the whole poll tick over.
        }
      }

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
    connectedPeers.value = [];
    knownDisplayNames.clear();

    for (const channel of channels) {
      await channel.start();
    }

    const dataWatchStop = watch(() => store.excelJsonData, () => {
      // Checked here (not only inside captureLocalChange, which only runs
      // once the debounce timer fires, seconds later -- by then the flag
      // would already be back to false) so a change caused by an
      // in-progress remote merge is never even scheduled for capture.
      if (dataChannel.isApplyingRemote.value) return;
      const delaySec = store.config.collabCaptureDebounceSeconds || 5;
      dataChannel.scheduleCaptureOnChange(delaySec * 1000);
    }, { deep: true });
    stopWatchers = [dataWatchStop];

    const pollDelayMs = (store.config.collabPollIntervalSeconds || 5) * 1000;
    pollTimer = setInterval(runPollTick, pollDelayMs);
    runPollTick(); // don't wait a full interval for the first read
  }

  function stopCollabSync() {
    running = false;
    stopWatchers.forEach((stop) => stop());
    stopWatchers = [];
    clearInterval(pollTimer);
    pollTimer = null;
    channels.forEach((channel) => channel.stop());
    connectedPeers.value = [];
  }

  return {
    startCollabSync,
    stopCollabSync,
    isApplyingRemote: dataChannel.isApplyingRemote,
    lastMergedState: dataChannel.lastMergedState,
    lastSeenBaselineSeq: dataChannel.lastSeenBaselineSeq,
    lastSyncError,
    connectedPeers,
    collabActivityLog,
  };
}
