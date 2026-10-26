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
    async writeTextFile(name, text) {
      files.set(name, text);
    },
    async writeBinaryFile(name, blob) {
      files.set(name, blob);
    },
    async listDeltaFileUserIds(prefix = '') {
      const re = prefix
        ? new RegExp(`^collab_deltas_${prefix}_(.+)\\.jsonl$`)
        : /^collab_deltas_(?!(?:schema|template)_)(.+)\.jsonl$/;
      const ids = [];
      for (const name of files.keys()) {
        const m = re.exec(name);
        if (m) ids.push(m[1]);
      }
      return ids;
    },
    async listPresenceFileUserIds() {
      const ids = [];
      for (const name of files.keys()) {
        const m = /^collab_presence_(.+)\.json$/.exec(name);
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

function readSchemaDeltaEntries(fakeFolder, userId) {
  const text = fakeFolder._files.get(`collab_deltas_schema_${userId}.jsonl`) || '';
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
    // Kept close to the baseline's own updatedAt so Fase 4 compaction (time
    // threshold) doesn't trigger here -- compaction is covered by its own
    // tests and would truncate the pre-seeded entry below, unrelated to
    // what THIS test checks.
    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));

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
      { seq: 1, ts: '2026-01-01T00:00:00.500Z', userId: ownUserId, baselineSeq: 1, patch: [] },
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

function ownUserId() {
  let id = localStorage.getItem('elipsCollabUserId');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('elipsCollabUserId', id); }
  return id;
}

describe('useCollabSync (Fase 4: compactació/rotació de base)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('compacts the baseline once enough time has passed since the last one, and truncates this client\'s own delta file down to only entries newer than it', async () => {
    const store = useWorkspaceStore();
    const baseline = { pres: { a: 1 } };
    store.excelJsonData = JSON.parse(JSON.stringify(baseline));
    store.config.collabPollIntervalSeconds = 1;
    vi.setSystemTime(new Date('2026-01-01T00:20:00.000Z'));

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline.json', baseline);
    await fakeFolder.writeJsonFile('collab_baseline.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });
    const userId = ownUserId();
    await fakeFolder.appendLinesToFile(`collab_deltas_${userId}.jsonl`, [
      { seq: 1, ts: '2026-01-01T00:00:01.000Z', userId, baselineSeq: 1, patch: [{ op: 'replace', path: '/pres/a', value: 2 }] },
    ]);

    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();
    await vi.advanceTimersByTimeAsync(1100);

    const meta = await fakeFolder.readJsonFile('collab_baseline.meta.json');
    expect(meta.seq).toBe(2);
    expect(await fakeFolder.readJsonFile('collab_baseline.json')).toEqual({ pres: { a: 2 } });
    // the only entry on disk predates the new baseline's cutoff -- already
    // folded into it, so it's dropped from this client's own file
    expect(readDeltaEntries(fakeFolder, userId)).toEqual([]);
  });

  it('does not compact when the baseline is recent and the delta count is low', async () => {
    const store = useWorkspaceStore();
    const baseline = { pres: { a: 1 } };
    store.excelJsonData = JSON.parse(JSON.stringify(baseline));
    store.config.collabPollIntervalSeconds = 1;
    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline.json', baseline);
    await fakeFolder.writeJsonFile('collab_baseline.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });

    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();
    await vi.advanceTimersByTimeAsync(1100);

    const meta = await fakeFolder.readJsonFile('collab_baseline.meta.json');
    expect(meta.seq).toBe(1); // unchanged -- no compaction triggered
  });

  it('refreshes collab_project.zip via the supplied buildProjectZipBlob when compacting', async () => {
    const store = useWorkspaceStore();
    const baseline = { pres: { a: 1 } };
    store.excelJsonData = JSON.parse(JSON.stringify(baseline));
    store.config.collabPollIntervalSeconds = 1;
    vi.setSystemTime(new Date('2026-01-01T00:20:00.000Z'));

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline.json', baseline);
    await fakeFolder.writeJsonFile('collab_baseline.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });

    const zipBlob = { marker: 'fake-zip' };
    const buildProjectZipBlob = vi.fn().mockResolvedValue(zipBlob);
    const { startCollabSync } = useCollabSync(fakeFolder, buildProjectZipBlob);
    await startCollabSync();
    await vi.advanceTimersByTimeAsync(1100);

    expect(buildProjectZipBlob).toHaveBeenCalled();
    expect(fakeFolder._files.get('collab_project.zip')).toBe(zipBlob);
  });
});

describe('useCollabSync (Fase 5: presència, participants i avís de conflicte)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes its own presence file every poll cycle', async () => {
    const store = useWorkspaceStore();
    store.excelJsonData = { pres: { a: 1 } };
    store.config.collabPollIntervalSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline.json', store.excelJsonData);
    await fakeFolder.writeJsonFile('collab_baseline.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });

    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();
    await vi.advanceTimersByTimeAsync(1100);

    const userId = ownUserId();
    const presence = await fakeFolder.readJsonFile(`collab_presence_${userId}.json`);
    expect(presence).toMatchObject({ displayName: expect.any(String) });
    expect(presence.lastSeen).toBeTruthy();
  });

  it('lists another connected peer (read from their presence file) as not stale when seen recently', async () => {
    const store = useWorkspaceStore();
    store.excelJsonData = { pres: { a: 1 } };
    store.config.collabPollIntervalSeconds = 1;
    vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'));

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline.json', store.excelJsonData);
    await fakeFolder.writeJsonFile('collab_baseline.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });
    await fakeFolder.writeJsonFile('collab_presence_peer-1.json', { displayName: 'Companya', lastSeen: '2026-01-01T00:00:09.000Z' });

    const { startCollabSync, connectedPeers } = useCollabSync(fakeFolder);
    await startCollabSync();
    await vi.advanceTimersByTimeAsync(1100);

    const peer = connectedPeers.value.find(p => p.userId === 'peer-1');
    expect(peer).toMatchObject({ displayName: 'Companya', isSelf: false, isStale: false });
  });

  it('marks a peer as stale once their presence has not been refreshed for a while', async () => {
    const store = useWorkspaceStore();
    store.excelJsonData = { pres: { a: 1 } };
    store.config.collabPollIntervalSeconds = 1;
    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline.json', store.excelJsonData);
    await fakeFolder.writeJsonFile('collab_baseline.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });
    await fakeFolder.writeJsonFile('collab_presence_peer-1.json', { displayName: 'Companya', lastSeen: '2026-01-01T00:00:00.000Z' });

    const { startCollabSync, connectedPeers } = useCollabSync(fakeFolder);
    await startCollabSync();
    await vi.advanceTimersByTimeAsync(1100);

    const peer = connectedPeers.value.find(p => p.userId === 'peer-1');
    expect(peer).toMatchObject({ isStale: true });
  });

  it('logs a visible warning when two different users touch the same path in the same batch', async () => {
    const store = useWorkspaceStore();
    const baseline = { pres: { import: 100 } };
    store.excelJsonData = JSON.parse(JSON.stringify(baseline));
    store.config.collabPollIntervalSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline.json', baseline);
    await fakeFolder.writeJsonFile('collab_baseline.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });
    await fakeFolder.appendLinesToFile('collab_deltas_z-peer.jsonl', [
      { seq: 1, ts: '2026-01-01T00:00:01.000Z', userId: 'z-peer', baselineSeq: 1, patch: [{ op: 'replace', path: '/pres/import', value: 111 }] },
    ]);
    await fakeFolder.appendLinesToFile('collab_deltas_a-peer.jsonl', [
      { seq: 1, ts: '2026-01-01T00:00:02.000Z', userId: 'a-peer', baselineSeq: 1, patch: [{ op: 'replace', path: '/pres/import', value: 222 }] },
    ]);

    const { startCollabSync, collabActivityLog } = useCollabSync(fakeFolder);
    await startCollabSync();
    await vi.advanceTimersByTimeAsync(1100);

    expect(store.excelJsonData).toEqual({ pres: { import: 222 } });
    const warning = collabActivityLog.value.find(e => e.type === 'warning' && e.text.includes('/pres/import'));
    expect(warning).toBeTruthy();
  });

  it('does not re-flag the same historical conflict on a later poll cycle', async () => {
    const store = useWorkspaceStore();
    const baseline = { pres: { import: 100 } };
    store.excelJsonData = JSON.parse(JSON.stringify(baseline));
    store.config.collabPollIntervalSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline.json', baseline);
    await fakeFolder.writeJsonFile('collab_baseline.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });
    await fakeFolder.appendLinesToFile('collab_deltas_z-peer.jsonl', [
      { seq: 1, ts: '2026-01-01T00:00:01.000Z', userId: 'z-peer', baselineSeq: 1, patch: [{ op: 'replace', path: '/pres/import', value: 111 }] },
    ]);
    await fakeFolder.appendLinesToFile('collab_deltas_a-peer.jsonl', [
      { seq: 1, ts: '2026-01-01T00:00:02.000Z', userId: 'a-peer', baselineSeq: 1, patch: [{ op: 'replace', path: '/pres/import', value: 222 }] },
    ]);

    const { startCollabSync, collabActivityLog } = useCollabSync(fakeFolder);
    await startCollabSync();
    await vi.advanceTimersByTimeAsync(1100);
    const countAfterFirstCycle = collabActivityLog.value.filter(e => e.type === 'warning').length;
    await vi.advanceTimersByTimeAsync(1100);
    const countAfterSecondCycle = collabActivityLog.value.filter(e => e.type === 'warning').length;

    expect(countAfterFirstCycle).toBe(1);
    expect(countAfterSecondCycle).toBe(1); // same conflict, not reported again
  });
});

describe('useCollabSync (Fase 7: canal d\'esquema -- editorMetadata)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures a local editorMetadata change into its own schema delta file, separate from the data channel', async () => {
    const store = useWorkspaceStore();
    store.excelJsonData = { pres: { import: 100 } };
    store.editorMetadata = [{ field: 'nom', label: 'Nom' }];
    store.config.collabCaptureDebounceSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();

    store.editorMetadata = [{ field: 'nom', label: 'Nom complet' }];
    await vi.advanceTimersByTimeAsync(1100);

    const userId = localStorage.getItem('elipsCollabUserId');
    const schemaEntries = readSchemaDeltaEntries(fakeFolder, userId);
    expect(schemaEntries.length).toBe(1);
    expect(schemaEntries[0].patch).toEqual([{ op: 'replace', path: '/0/label', value: 'Nom complet' }]);
    // The data channel's own delta file must stay untouched -- editing the
    // schema is not a data edit.
    expect(readDeltaEntries(fakeFolder, userId)).toEqual([]);
  });

  it('merges a peer\'s schema change into store.editorMetadata, independently of the data channel', async () => {
    const store = useWorkspaceStore();
    store.excelJsonData = { pres: { a: 1 } };
    const baselineSchema = [{ field: 'nom', label: 'Nom' }];
    store.editorMetadata = JSON.parse(JSON.stringify(baselineSchema));
    store.config.collabPollIntervalSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline_schema.json', baselineSchema);
    await fakeFolder.writeJsonFile('collab_baseline_schema.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });
    await fakeFolder.appendLinesToFile('collab_deltas_schema_peer-1.jsonl', [
      { seq: 1, ts: '2026-01-01T00:00:01.000Z', userId: 'peer-1', baselineSeq: 1, patch: [{ op: 'replace', path: '/0/label', value: 'Nom (actualitzat pel company)' }] },
    ]);

    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();
    await vi.advanceTimersByTimeAsync(1100);

    expect(store.editorMetadata).toEqual([{ field: 'nom', label: 'Nom (actualitzat pel company)' }]);
    // The (untouched) data baseline/channel must not have been disturbed.
    expect(store.excelJsonData).toEqual({ pres: { a: 1 } });
  });

  it('applying a remote schema merge is never re-captured as a new local schema delta entry (no feedback loop)', async () => {
    const store = useWorkspaceStore();
    store.excelJsonData = { pres: { a: 1 } };
    const baselineSchema = [{ field: 'nom', label: 'Nom' }, { field: 'cognoms', label: 'Cognoms' }];
    store.editorMetadata = JSON.parse(JSON.stringify(baselineSchema));
    store.config.collabPollIntervalSeconds = 1;
    store.config.collabCaptureDebounceSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline_schema.json', baselineSchema);
    await fakeFolder.writeJsonFile('collab_baseline_schema.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });
    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    await fakeFolder.appendLinesToFile('collab_deltas_schema_peer-1.jsonl', [
      { seq: 1, ts: '2026-01-01T00:00:01.000Z', userId: 'peer-1', baselineSeq: 1, patch: [{ op: 'replace', path: '/1/label', value: 'Cognoms (company)' }] },
    ]);

    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();
    await vi.advanceTimersByTimeAsync(2500);

    expect(store.editorMetadata).toEqual([{ field: 'nom', label: 'Nom' }, { field: 'cognoms', label: 'Cognoms (company)' }]);
    const userId = localStorage.getItem('elipsCollabUserId');
    expect(readSchemaDeltaEntries(fakeFolder, userId)).toEqual([]); // nothing captured back
  });

  it('the schema and data channels merge concurrent, unrelated remote changes independently in the same poll cycle', async () => {
    const store = useWorkspaceStore();
    store.excelJsonData = { pres: { a: 1 } };
    store.editorMetadata = [{ field: 'nom', label: 'Nom' }];
    store.config.collabPollIntervalSeconds = 1;

    const fakeFolder = makeFakeCollabFolder();
    await fakeFolder.writeJsonFile('collab_baseline.json', { pres: { a: 1 } });
    await fakeFolder.writeJsonFile('collab_baseline.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });
    await fakeFolder.appendLinesToFile('collab_deltas_peer-1.jsonl', [
      { seq: 1, ts: '2026-01-01T00:00:01.000Z', userId: 'peer-1', baselineSeq: 1, patch: [{ op: 'replace', path: '/pres/a', value: 2 }] },
    ]);
    await fakeFolder.writeJsonFile('collab_baseline_schema.json', [{ field: 'nom', label: 'Nom' }]);
    await fakeFolder.writeJsonFile('collab_baseline_schema.meta.json', { seq: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' });
    await fakeFolder.appendLinesToFile('collab_deltas_schema_peer-2.jsonl', [
      { seq: 1, ts: '2026-01-01T00:00:01.000Z', userId: 'peer-2', baselineSeq: 1, patch: [{ op: 'replace', path: '/0/label', value: 'Nom complet' }] },
    ]);

    const { startCollabSync } = useCollabSync(fakeFolder);
    await startCollabSync();
    await vi.advanceTimersByTimeAsync(1100);

    expect(store.excelJsonData).toEqual({ pres: { a: 2 } });
    expect(store.editorMetadata).toEqual([{ field: 'nom', label: 'Nom complet' }]);
  });
});
