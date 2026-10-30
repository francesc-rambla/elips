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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { getOrCreateProjectDoc, closeProjectDoc, hasPersistedProjectDoc } from '../src/composables/useCollabDoc';

// In-memory fake standing in for getDbItem/saveDbItem (src/utils/db.js) --
// happy-dom (the Vitest environment this project uses) has no IndexedDB
// implementation, so the real db.js helpers are not testable directly here.
// Same injectable-dependency idiom already used throughout this codebase
// (findWorkingSignalingServer's probeFn/confirmFn, attachProjectTransferResponder's
// buildProjectZipBlob, etc.) -- useCollabDoc.js accepts getItem/setItem so
// production code can default to the real db.js while tests inject this.
function makeFakeDb() {
  const store = new Map();
  return {
    store,
    getItem: vi.fn((key) => Promise.resolve(store.get(key))),
    setItem: vi.fn((key, val) => { store.set(key, val); return Promise.resolve(true); }),
  };
}

describe('hasPersistedProjectDoc (Fase 16: decidir si val la pena carregar yjs)', () => {
  it('returns false without ever needing a Y module when nothing is persisted', async () => {
    const db = makeFakeDb();
    await expect(hasPersistedProjectDoc('Default', { getItem: db.getItem })).resolves.toBe(false);
  });

  it('returns true once something has been persisted for that project', async () => {
    const db = makeFakeDb();
    db.store.set('collabRealtimeDoc:Default', new Uint8Array([1, 2, 3]));
    await expect(hasPersistedProjectDoc('Default', { getItem: db.getItem })).resolves.toBe(true);
  });
});

describe('getOrCreateProjectDoc / closeProjectDoc (Fase 16: Y.Doc persistent per projecte)', () => {
  it('creates an empty doc when nothing was persisted before', async () => {
    const db = makeFakeDb();
    const doc = await getOrCreateProjectDoc(Y, 'ProjecteNou', { getItem: db.getItem, setItem: db.setItem });
    expect(doc.getText('template:Document Principal').toString()).toBe('');
    await closeProjectDoc('ProjecteNou');
  });

  it('reuses the SAME doc instance on a second call while it is still cached (not yet closed)', async () => {
    const db = makeFakeDb();
    const docA = await getOrCreateProjectDoc(Y, 'ProjecteCache', { getItem: db.getItem, setItem: db.setItem });
    const docB = await getOrCreateProjectDoc(Y, 'ProjecteCache', { getItem: db.getItem, setItem: db.setItem });
    expect(docB).toBe(docA);
    await closeProjectDoc('ProjecteCache');
  });

  it('persists edits (debounced) and restores them in a fresh doc after closing and reopening', async () => {
    vi.useFakeTimers();
    const db = makeFakeDb();
    const projectName = 'ProjecteOffline';
    const doc1 = await getOrCreateProjectDoc(Y, projectName, { getItem: db.getItem, setItem: db.setItem, debounceMs: 500 });
    const ytext = doc1.getText('template:Document Principal');
    doc1.transact(() => { ytext.insert(0, 'Hola món (edició offline)'); });

    // Abans que venci el debounce, encara no s'ha escrit res a la "IndexedDB".
    expect(db.setItem).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(db.setItem).toHaveBeenCalledTimes(1);

    // Simula tancar el projecte (flush final + destrucció) i tornar-lo a obrir.
    await closeProjectDoc(projectName);
    const doc2 = await getOrCreateProjectDoc(Y, projectName, { getItem: db.getItem, setItem: db.setItem });
    expect(doc2).not.toBe(doc1);
    expect(doc2.getText('template:Document Principal').toString()).toBe('Hola món (edició offline)');

    vi.useRealTimers();
  });

  it('closeProjectDoc flushes immediately even if the debounce timer has not fired yet', async () => {
    vi.useFakeTimers();
    const db = makeFakeDb();
    const projectName = 'ProjecteFlush';
    const doc1 = await getOrCreateProjectDoc(Y, projectName, { getItem: db.getItem, setItem: db.setItem, debounceMs: 5000 });
    doc1.transact(() => { doc1.getText('template:Document Principal').insert(0, 'canvi pendent'); });
    expect(db.setItem).not.toHaveBeenCalled();

    await closeProjectDoc(projectName);
    expect(db.setItem).toHaveBeenCalledTimes(1);

    const doc2 = await getOrCreateProjectDoc(Y, projectName, { getItem: db.getItem, setItem: db.setItem });
    expect(doc2.getText('template:Document Principal').toString()).toBe('canvi pendent');

    vi.useRealTimers();
  });

  it('closeProjectDoc is a no-op for a project that was never loaded', async () => {
    const db = makeFakeDb();
    await expect(closeProjectDoc('MaiObert')).resolves.toBeUndefined();
    expect(db.setItem).not.toHaveBeenCalled();
  });

  it('keeps two different projects fully independent in the cache', async () => {
    const db = makeFakeDb();
    const docA = await getOrCreateProjectDoc(Y, 'ProjecteA', { getItem: db.getItem, setItem: db.setItem });
    const docB = await getOrCreateProjectDoc(Y, 'ProjecteB', { getItem: db.getItem, setItem: db.setItem });
    expect(docA).not.toBe(docB);
    docA.transact(() => { docA.getText('template:Document Principal').insert(0, 'A'); });
    docB.transact(() => { docB.getText('template:Document Principal').insert(0, 'B'); });
    expect(docA.getText('template:Document Principal').toString()).toBe('A');
    expect(docB.getText('template:Document Principal').toString()).toBe('B');
    await closeProjectDoc('ProjecteA');
    await closeProjectDoc('ProjecteB');
  });
});
