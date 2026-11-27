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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readLocalProjectSnapshot, writeLocalProjectSnapshot } from '../src/utils/projectSnapshot.js';

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
});

// Fake en memòria per a getItem/setItem/deleteItem (mateix patró ja
// establert a tests/collab_doc.test.js -- happy-dom no té cap IndexedDB
// real, per això readLocalProjectSnapshot/writeLocalProjectSnapshot accepten
// aquests tres com a injectables).
function makeFakeDb() {
  const store = new Map();
  return {
    store,
    getItem: vi.fn((key) => Promise.resolve(store.get(key))),
    setItem: vi.fn((key, val) => { store.set(key, val); return Promise.resolve(true); }),
    deleteItem: vi.fn((key) => { store.delete(key); return Promise.resolve(true); }),
  };
}

describe('readLocalProjectSnapshot / writeLocalProjectSnapshot (Fase 34: primitives de projecte no actiu)', () => {
  it('escriu i rellegeix un projecte complet (dades, esquema, documents, fitxers binaris) sense tocar store.*', async () => {
    const db = makeFakeDb();
    const snapshot = {
      excelJsonData: { General: { nom: 'Expedient 1' } },
      editorMetadata: [{ key: 'nom', label: 'Nom' }],
      sheetInfo: [{ sheet: 'General' }],
      hierarchySchema: { General: { children: {} } },
      documentsList: ['Document Principal', 'Annex'],
      excelFileName: 'origen.xlsx',
      excelFileBuffer: new ArrayBuffer(8),
      docs: {
        'Document Principal': { templateText: 'Plantilla principal', refDocFileName: '', refDocBuffer: null },
        Annex: { templateText: 'Plantilla annex', refDocFileName: 'ref.docx', refDocBuffer: new ArrayBuffer(4) },
      },
    };

    await writeLocalProjectSnapshot('ProjecteProva', snapshot, { setItem: db.setItem, deleteItem: db.deleteItem });

    expect(JSON.parse(localStorage.getItem('ProjecteProva:documentsList'))).toEqual(['Document Principal', 'Annex']);
    expect(localStorage.getItem('ProjecteProva:activeDocName')).toBe('Document Principal');
    expect(JSON.parse(localStorage.getItem('ProjecteProva:excelJsonData'))).toEqual({ General: { nom: 'Expedient 1' } });
    expect(localStorage.getItem('ProjecteProva:doc:Annex:templateText')).toBe('Plantilla annex');
    expect(localStorage.getItem('ProjecteProva:doc:Annex:refDocFileName')).toBe('ref.docx');
    expect(db.store.get('ProjecteProva:excelFileBuffer')).toBe(snapshot.excelFileBuffer);
    expect(db.store.get('ProjecteProva:doc:Annex:refDocBuffer')).toBe(snapshot.docs.Annex.refDocBuffer);
    // El document SENSE fitxer de referència no ha d'haver deixat cap clau
    // de nom de fitxer penjada.
    expect(localStorage.getItem('ProjecteProva:doc:Document Principal:refDocFileName')).toBeNull();

    const reread = await readLocalProjectSnapshot('ProjecteProva', { getItem: db.getItem });
    expect(reread).toEqual(snapshot);
  });

  it('readLocalProjectSnapshot dona valors per defecte raonables per a un projecte mai escrit abans', async () => {
    const db = makeFakeDb();
    const snapshot = await readLocalProjectSnapshot('ProjecteInexistent', { getItem: db.getItem });
    expect(snapshot).toEqual({
      excelJsonData: null,
      editorMetadata: [],
      sheetInfo: [],
      hierarchySchema: {},
      documentsList: ['Document Principal'],
      excelFileName: '',
      excelFileBuffer: null,
      docs: { 'Document Principal': { templateText: '', refDocFileName: '', refDocBuffer: null } },
    });
  });

  it('escriure sobre un projecte ja existent substitueix completament el seu contingut (sobreescriptura, opció b/c de la Fase 36)', async () => {
    const db = makeFakeDb();
    await writeLocalProjectSnapshot('ProjecteProva', {
      excelJsonData: { General: { nom: 'Versió vella' } },
      editorMetadata: [], sheetInfo: [], hierarchySchema: {}, documentsList: ['Document Principal'],
      excelFileName: '', excelFileBuffer: null, docs: { 'Document Principal': { templateText: 'Vell', refDocFileName: '', refDocBuffer: null } },
    }, { setItem: db.setItem, deleteItem: db.deleteItem });

    await writeLocalProjectSnapshot('ProjecteProva', {
      excelJsonData: { General: { nom: 'Versió nova' } },
      editorMetadata: [], sheetInfo: [], hierarchySchema: {}, documentsList: ['Document Principal'],
      excelFileName: '', excelFileBuffer: null, docs: { 'Document Principal': { templateText: 'Nou', refDocFileName: '', refDocBuffer: null } },
    }, { setItem: db.setItem, deleteItem: db.deleteItem });

    const reread = await readLocalProjectSnapshot('ProjecteProva', { getItem: db.getItem });
    expect(reread.excelJsonData).toEqual({ General: { nom: 'Versió nova' } });
    expect(reread.docs['Document Principal'].templateText).toBe('Nou');
  });
});
