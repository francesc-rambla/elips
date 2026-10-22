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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

beforeEach(() => {
  if (typeof globalThis.localStorage === 'undefined') {
    const storage = new Map();
    globalThis.localStorage = {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, val) => storage.set(key, String(val)),
      removeItem: (key) => storage.delete(key),
      clear: () => storage.clear(),
    };
  }
  globalThis.localStorage.clear();
  setActivePinia(createPinia());
});

import { useWorkspaceStore } from '../src/stores/workspace.js';
import { useCollabSync } from '../src/composables/useCollabSync.js';

/** Minimal in-memory stand-in for useCollabFolder.js's returned API --
 * only the two methods useCollabSync.js actually calls. */
function makeFakeCollabFolder() {
  const files = new Map(); // name -> string content
  return {
    async readTextFile(name) {
      return files.has(name) ? files.get(name) : null;
    },
    async appendLinesToFile(name, entries) {
      const addition = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      files.set(name, (files.get(name) || '') + addition);
    },
    _files: files,
  };
}

function readDeltaEntries(fakeFolder, userId) {
  const text = fakeFolder._files.get(`collab_deltas_${userId}.jsonl`) || '';
  return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('useCollabSync (Fase 2: captura de deltes, només escriptura)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures a local change into the own delta file after the debounce delay', async () => {
    const store = useWorkspaceStore();
    store.excelJsonData = { pres: { import: 100 } };
    store.config.collabCaptureDebounceSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();

    store.excelJsonData = { pres: { import: 150 } };
    await vi.advanceTimersByTimeAsync(1100);

    const userId = localStorage.getItem('elipsCollabUserId');
    const entries = readDeltaEntries(fakeFolder, userId);
    expect(entries.length).toBe(1);
    expect(entries[0].seq).toBe(1);
    expect(entries[0].patch).toEqual([{ op: 'replace', path: '/pres/import', value: 150 }]);
  });

  it('does not write an entry when nothing actually changed', async () => {
    const store = useWorkspaceStore();
    store.excelJsonData = { pres: { import: 100 } };
    store.config.collabCaptureDebounceSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();

    // Reassign to a structurally-identical (but new) object -- still
    // triggers the deep watcher, but computeDataPatch should see no diff.
    store.excelJsonData = { pres: { import: 100 } };
    await vi.advanceTimersByTimeAsync(1100);

    const userId = localStorage.getItem('elipsCollabUserId');
    expect(readDeltaEntries(fakeFolder, userId)).toEqual([]);
  });

  it('debounces rapid successive edits into a single delta entry', async () => {
    const store = useWorkspaceStore();
    store.excelJsonData = { pres: { import: 100 } };
    store.config.collabCaptureDebounceSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();

    store.excelJsonData = { pres: { import: 110 } };
    await vi.advanceTimersByTimeAsync(300);
    store.excelJsonData = { pres: { import: 120 } };
    await vi.advanceTimersByTimeAsync(300);
    store.excelJsonData = { pres: { import: 130 } };
    await vi.advanceTimersByTimeAsync(1100);

    const userId = localStorage.getItem('elipsCollabUserId');
    const entries = readDeltaEntries(fakeFolder, userId);
    expect(entries.length).toBe(1);
    expect(entries[0].patch).toEqual([{ op: 'replace', path: '/pres/import', value: 130 }]);
  });

  it('resumes the seq counter from an existing delta file instead of restarting at 1', async () => {
    const store = useWorkspaceStore();
    store.excelJsonData = { pres: { import: 100 } };
    store.config.collabCaptureDebounceSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    const userId = localStorage.getItem('elipsCollabUserId') || (() => {
      const id = crypto.randomUUID();
      localStorage.setItem('elipsCollabUserId', id);
      return id;
    })();
    fakeFolder._files.set(`collab_deltas_${userId}.jsonl`, JSON.stringify({ seq: 5, ts: '2026-01-01T00:00:00.000Z', userId, patch: [] }) + '\n');

    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();

    store.excelJsonData = { pres: { import: 200 } };
    await vi.advanceTimersByTimeAsync(1100);

    const entries = readDeltaEntries(fakeFolder, userId);
    expect(entries.length).toBe(2);
    expect(entries[1].seq).toBe(6);
  });

  it('stopCollabSync cancels a pending debounced capture', async () => {
    const store = useWorkspaceStore();
    store.excelJsonData = { pres: { import: 100 } };
    store.config.collabCaptureDebounceSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    const { startCollabSync, stopCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();

    store.excelJsonData = { pres: { import: 999 } };
    stopCollabSync();
    await vi.advanceTimersByTimeAsync(2000);

    const userId = localStorage.getItem('elipsCollabUserId');
    expect(readDeltaEntries(fakeFolder, userId)).toEqual([]);
  });
});
