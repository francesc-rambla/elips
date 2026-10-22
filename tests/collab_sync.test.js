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
 * just the methods useCollabSync.js actually calls. */
function makeFakeCollabFolder() {
  const files = new Map(); // name -> string content
  return {
    async readTextFile(name) {
      return files.has(name) ? files.get(name) : null;
    },
    async readJsonFile(name) {
      const text = files.has(name) ? files.get(name) : null;
      return text === null ? null : JSON.parse(text);
    },
    async writeJsonFile(name, obj) {
      files.set(name, JSON.stringify(obj));
    },
    async appendLinesToFile(name, entries) {
      const addition = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      files.set(name, (files.get(name) || '') + addition);
    },
    async listDeltaFileUserIds() {
      const ids = [];
      for (const name of files.keys()) {
        const m = /^collab_deltas_(.+)\.jsonl$/.exec(name);
        if (m) ids.push(m[1]);
      }
      return ids;
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

describe('useCollabSync (Fase 3: motor de fusió/repetició)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges a peer change (a different path) into store.excelJsonData', async () => {
    const store = useWorkspaceStore();
    const baseline = { pres: { a: 1, b: 2 } };
    store.excelJsonData = JSON.parse(JSON.stringify(baseline));
    store.config.collabPollIntervalSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline.json', baseline);
    await fakeFolder.writeJsonFile('collab_baseline.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });
    await fakeFolder.appendLinesToFile('collab_deltas_peer-1.jsonl', [
      { seq: 1, ts: '2026-01-01T00:00:01.000Z', userId: 'peer-1', baselineSeq: 1, patch: [{ op: 'replace', path: '/pres/b', value: 20 }] },
    ]);

    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();
    await vi.advanceTimersByTimeAsync(1100);

    expect(store.excelJsonData).toEqual({ pres: { a: 1, b: 20 } });
  });

  it('merges changes from several different peers at once', async () => {
    const store = useWorkspaceStore();
    const baseline = { pres: { a: 1, b: 2, c: 3 } };
    store.excelJsonData = JSON.parse(JSON.stringify(baseline));
    store.config.collabPollIntervalSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline.json', baseline);
    await fakeFolder.writeJsonFile('collab_baseline.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });
    await fakeFolder.appendLinesToFile('collab_deltas_peer-1.jsonl', [
      { seq: 1, ts: '2026-01-01T00:00:01.000Z', userId: 'peer-1', baselineSeq: 1, patch: [{ op: 'replace', path: '/pres/b', value: 20 }] },
    ]);
    await fakeFolder.appendLinesToFile('collab_deltas_peer-2.jsonl', [
      { seq: 1, ts: '2026-01-01T00:00:02.000Z', userId: 'peer-2', baselineSeq: 1, patch: [{ op: 'replace', path: '/pres/c', value: 30 }] },
    ]);

    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();
    await vi.advanceTimersByTimeAsync(1100);

    expect(store.excelJsonData).toEqual({ pres: { a: 1, b: 20, c: 30 } });
  });

  it('a same-path conflict converges on the later timestamp, regardless of userId order', async () => {
    const store = useWorkspaceStore();
    const baseline = { pres: { import: 100 } };
    store.excelJsonData = JSON.parse(JSON.stringify(baseline));
    store.config.collabPollIntervalSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline.json', baseline);
    await fakeFolder.writeJsonFile('collab_baseline.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });
    // "z-peer" writes FIRST (earlier ts) but would sort AFTER "a-peer" by
    // userId alone -- the later timestamp must still win.
    await fakeFolder.appendLinesToFile('collab_deltas_z-peer.jsonl', [
      { seq: 1, ts: '2026-01-01T00:00:01.000Z', userId: 'z-peer', baselineSeq: 1, patch: [{ op: 'replace', path: '/pres/import', value: 111 }] },
    ]);
    await fakeFolder.appendLinesToFile('collab_deltas_a-peer.jsonl', [
      { seq: 1, ts: '2026-01-01T00:00:02.000Z', userId: 'a-peer', baselineSeq: 1, patch: [{ op: 'replace', path: '/pres/import', value: 222 }] },
    ]);

    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();
    await vi.advanceTimersByTimeAsync(1100);

    expect(store.excelJsonData).toEqual({ pres: { import: 222 } });
  });

  it('applying a remote merge is never re-captured as a new local delta entry (no feedback loop)', async () => {
    const store = useWorkspaceStore();
    const baseline = { pres: { a: 1, b: 2 } };
    store.excelJsonData = JSON.parse(JSON.stringify(baseline));
    store.config.collabPollIntervalSeconds = 1;
    store.config.collabCaptureDebounceSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline.json', baseline);
    await fakeFolder.writeJsonFile('collab_baseline.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });
    await fakeFolder.appendLinesToFile('collab_deltas_peer-1.jsonl', [
      { seq: 1, ts: '2026-01-01T00:00:01.000Z', userId: 'peer-1', baselineSeq: 1, patch: [{ op: 'replace', path: '/pres/b', value: 20 }] },
    ]);
    // This client's own delta file already has an (unrelated, irrelevant to
    // this check) prior entry, so we can tell apart "nothing new was
    // appended" from "the file never existed".
    const ownUserId = (() => {
      let id = localStorage.getItem('elipsCollabUserId');
      if (!id) { id = crypto.randomUUID(); localStorage.setItem('elipsCollabUserId', id); }
      return id;
    })();
    await fakeFolder.appendLinesToFile(`collab_deltas_${ownUserId}.jsonl`, [
      { seq: 1, ts: '2025-12-31T00:00:00.000Z', userId: ownUserId, baselineSeq: 1, patch: [] },
    ]);

    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();
    // Let the poll cycle apply the remote merge, THEN also let the local
    // capture debounce window pass -- if the merge's own
    // store.excelJsonData assignment were mistaken for a local edit, a
    // second entry would appear here.
    await vi.advanceTimersByTimeAsync(2500);

    expect(store.excelJsonData).toEqual({ pres: { a: 1, b: 20 } });
    const ownEntries = readDeltaEntries(fakeFolder, ownUserId);
    expect(ownEntries.length).toBe(1); // still just the pre-seeded entry -- nothing new appended
  });

  it('does not touch store.excelJsonData when the merge result is unchanged', async () => {
    const store = useWorkspaceStore();
    const baseline = { pres: { a: 1 } };
    store.excelJsonData = JSON.parse(JSON.stringify(baseline));
    store.config.collabPollIntervalSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline.json', baseline);
    await fakeFolder.writeJsonFile('collab_baseline.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });
    // No delta files at all -- merged state should equal the baseline,
    // which already equals what the store has.
    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();

    const refBefore = store.excelJsonData;
    await vi.advanceTimersByTimeAsync(1100);
    expect(store.excelJsonData).toBe(refBefore); // same object reference -- no reassignment happened
  });
});
