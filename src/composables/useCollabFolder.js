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
 * Folder-based collaboration: picking a shared folder (normally one inside
 * the user's OneDrive-synced directory) via the File System Access API,
 * its permission lifecycle, and low-level read/write/list helpers over it.
 * No merge logic here -- that is useCollabSync.js, built on top of these
 * primitives. See the plan at .claude/plans/unified-nibbling-adleman.md for
 * the full design (file layout, merge algorithm, phased delivery).
 *
 * Only Chrome/Edge implement showDirectoryPicker -- every entry point here
 * is additive and optional, so the rest of the app is unaffected when it's
 * unavailable (see isCollabSupported).
 */

import { ref, computed } from 'vue';
import { useWorkspaceStore } from '../stores/workspace.js';
import { saveDbItem, getDbItem, deleteDbItem } from '../utils/db.js';
import { getOrCreateUserId } from './useCollabIdentity.js';

export const isCollabSupported = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

const DELTA_FILE_RE = /^collab_deltas_(.+)\.jsonl$/;
const PRESENCE_FILE_RE = /^collab_presence_(.+)\.json$/;

function handleStorageKey(projectName) {
  return `collabFolderHandle:${projectName}`;
}

/**
 * `projectNameRef`: a ref/computed tracking the currently active project
 * name (e.g. App.vue's local `currentProjectName`), read whenever the
 * folder handle needs to be looked up/stored -- not part of the Pinia
 * store, so it has to come from the caller rather than from
 * useWorkspaceStore() directly.
 */
export function useCollabFolder(projectNameRef) {
  const store = useWorkspaceStore();

  const folderStatus = ref(isCollabSupported ? 'disconnected' : 'unsupported');
  const folderHandle = ref(null);
  const folderName = computed(() => folderHandle.value?.name || '');

  const getHandle = () => {
    if (!folderHandle.value) throw new Error("Cap carpeta de col·laboració connectada.");
    return folderHandle.value;
  };

  // ---------------------------------------------------------------------
  // Low-level file I/O over the connected folder
  // ---------------------------------------------------------------------

  async function readJsonFile(name) {
    try {
      const fh = await getHandle().getFileHandle(name);
      const file = await fh.getFile();
      return JSON.parse(await file.text());
    } catch (e) {
      if (e.name === 'NotFoundError') return null;
      throw e;
    }
  }

  async function writeJsonFile(name, obj) {
    const fh = await getHandle().getFileHandle(name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(JSON.stringify(obj));
    await writable.close();
  }

  async function readTextFile(name) {
    try {
      const fh = await getHandle().getFileHandle(name);
      const file = await fh.getFile();
      return await file.text();
    } catch (e) {
      if (e.name === 'NotFoundError') return null;
      throw e;
    }
  }

  // Full overwrite (unlike appendLinesToFile below) -- used to rewrite a
  // delta file with only its still-relevant entries after a baseline
  // compaction (see useCollabSync.js's truncateOwnDeltaFile).
  async function writeTextFile(name, text) {
    const fh = await getHandle().getFileHandle(name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(text);
    await writable.close();
  }

  // Appends one JSON-stringified line per entry, without reading/rewriting
  // the file's existing content: createWritable({keepExistingData: true})
  // plus a positioned write at the file's current size is the File System
  // Access API's own append idiom (it has no dedicated "append mode").
  async function appendLinesToFile(name, entries) {
    const fh = await getHandle().getFileHandle(name, { create: true });
    const file = await fh.getFile();
    const addition = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    const writable = await fh.createWritable({ keepExistingData: true });
    await writable.write({ type: 'write', position: file.size, data: addition });
    await writable.close();
  }

  async function readBinaryFile(name) {
    try {
      const fh = await getHandle().getFileHandle(name);
      return await fh.getFile();
    } catch (e) {
      if (e.name === 'NotFoundError') return null;
      throw e;
    }
  }

  async function writeBinaryFile(name, blob) {
    const fh = await getHandle().getFileHandle(name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  // Lists this folder's own per-user delta/presence files, keyed by the
  // userId each one belongs to -- the mechanism by which useCollabSync
  // discovers OTHER connected users without knowing their ids in advance.
  async function listDeltaFileUserIds() {
    const ids = [];
    for await (const name of getHandle().keys()) {
      const m = DELTA_FILE_RE.exec(name);
      if (m) ids.push(m[1]);
    }
    return ids;
  }

  async function listPresenceFileUserIds() {
    const ids = [];
    for await (const name of getHandle().keys()) {
      const m = PRESENCE_FILE_RE.exec(name);
      if (m) ids.push(m[1]);
    }
    return ids;
  }

  // ---------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------

  /**
   * Used when a project is already open and the user wants to start
   * sharing it. `buildProjectZipBlob` is App.vue's existing
   * downloadAllProjectFiles() logic, factored out to return a Blob instead
   * of triggering a download -- reused here verbatim rather than
   * duplicated. If the chosen folder already holds someone else's
   * collab_project.zip, asks before overwriting it (never clobbers
   * silently) -- returns {cancelled: true} if the user backs out.
   */
  async function connectFolder(buildProjectZipBlob) {
    if (!isCollabSupported) return { cancelled: true };
    const handle = await window.showDirectoryPicker({ id: 'elips-collab', mode: 'readwrite' });

    const previousHandle = folderHandle.value;
    folderHandle.value = handle;
    try {
      const existing = await readBinaryFile('collab_project.zip');
      if (existing) {
        const proceed = confirm(
          "Aquesta carpeta ja conté un projecte de col·laboració (potser d'un company). " +
          "Prem D'acord per descartar-lo i desar-hi la versió actual d'aquest projecte, " +
          "o Cancel·la per no tocar-la (podeu carregar-lo en lloc d'això des de Gestió de Projectes)."
        );
        if (!proceed) {
          folderHandle.value = previousHandle;
          return { cancelled: true };
        }
      }

      const zipBlob = await buildProjectZipBlob();
      await writeBinaryFile('collab_project.zip', zipBlob);
      await writeJsonFile('collab_baseline.json', store.excelJsonData || {});
      await writeJsonFile('collab_baseline.meta.json', {
        seq: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: getOrCreateUserId(),
      });

      await saveDbItem(handleStorageKey(projectNameRef.value), handle);
      folderStatus.value = 'connected';
      store.addLog(`Carpeta de col·laboració connectada: '${handle.name}'.`, 'success');
      return { cancelled: false };
    } catch (e) {
      folderHandle.value = previousHandle;
      store.addLog(`Error en connectar la carpeta de col·laboració: ${e.message}`, 'error');
      throw e;
    }
  }

  /**
   * The other entry point: no project needs to be open beforehand. Reads
   * collab_project.zip from the chosen folder and hands it, as a real
   * File, straight to App.vue's existing importProjectZip() -- which
   * already accepts a File from an <input type=file> and needs no
   * adaptation to accept one from a FileSystemFileHandle instead. Once
   * that finishes (and so `projectNameRef` reflects the newly loaded
   * project's name), registers this same folder as that project's
   * collaboration folder.
   */
  async function loadProjectFromFolder(importProjectZipFile) {
    if (!isCollabSupported) return { cancelled: true };
    const handle = await window.showDirectoryPicker({ id: 'elips-collab', mode: 'readwrite' });

    folderHandle.value = handle;
    try {
      const zipFile = await readBinaryFile('collab_project.zip');
      if (!zipFile) {
        folderHandle.value = null;
        throw new Error("Aquesta carpeta no conté cap projecte d'elips compartit.");
      }
      await importProjectZipFile(zipFile);
      await saveDbItem(handleStorageKey(projectNameRef.value), handle);
      folderStatus.value = 'connected';
      store.addLog(`Projecte carregat des de la carpeta de col·laboració '${handle.name}'.`, 'success');
      return { cancelled: false };
    } catch (e) {
      folderHandle.value = null;
      store.addLog(`Error en carregar el projecte des de la carpeta: ${e.message}`, 'error');
      throw e;
    }
  }

  /** Called on project load, alongside loadHistory()/startHourlyCheckInterval()
   * -- resumes a previously connected folder for the CURRENT project without
   * re-prompting the user, unless the browser requires a fresh permission
   * grant (queryPermission() never re-prompts on its own; it can only tell
   * us whether requestPermission() would need to, which in turn needs a
   * user gesture elips can't fabricate at page-load time). */
  async function reconnectFolder() {
    if (!isCollabSupported) {
      folderStatus.value = 'unsupported';
      return;
    }
    const handle = await getDbItem(handleStorageKey(projectNameRef.value));
    if (!handle) {
      folderStatus.value = 'disconnected';
      return;
    }
    folderHandle.value = handle;
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    folderStatus.value = perm === 'granted' ? 'connected' : 'needs-permission';
  }

  /** Must be called from a real user gesture (e.g. a button click) --
   * requestPermission() silently fails to prompt otherwise. */
  async function requestPermission() {
    if (!folderHandle.value) return;
    const perm = await folderHandle.value.requestPermission({ mode: 'readwrite' });
    folderStatus.value = perm === 'granted' ? 'connected' : 'needs-permission';
  }

  async function disconnectFolder() {
    await deleteDbItem(handleStorageKey(projectNameRef.value));
    folderHandle.value = null;
    folderStatus.value = isCollabSupported ? 'disconnected' : 'unsupported';
  }

  return {
    isCollabSupported,
    folderStatus,
    folderName,
    connectFolder,
    loadProjectFromFolder,
    reconnectFolder,
    requestPermission,
    disconnectFolder,
    readJsonFile,
    writeJsonFile,
    readTextFile,
    writeTextFile,
    appendLinesToFile,
    readBinaryFile,
    writeBinaryFile,
    listDeltaFileUserIds,
    listPresenceFileUserIds,
  };
}
