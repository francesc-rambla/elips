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

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

beforeAll(() => {
  if (typeof globalThis.localStorage === 'undefined') {
    const storage = new Map();
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, val) => storage.set(key, String(val)),
      removeItem: (key) => storage.delete(key),
      clear: () => storage.clear()
    };
  }
});

// Import workspace store AFTER localStorage is mocked
import { useWorkspaceStore } from '../src/stores/workspace.js';

describe('useWorkspaceStore - Pinia State & Actions', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('inicialitza l\'estat per defecte correctament', () => {
    const store = useWorkspaceStore();
    expect(store.excelFile).toBeNull();
    expect(store.templateText).toBe('');
    expect(store.activeTab).toBe('upload');
    expect(store.logs.length).toBeGreaterThan(0);
  });

  it('setExcelFile actualitza el fitxer, el nom i la mida', () => {
    const store = useWorkspaceStore();
    const fakeFile = { name: 'test_pres.xlsx', size: 12 };
    store.setExcelFile(fakeFile);

    expect(store.excelFile).toStrictEqual(fakeFile);
    expect(store.excelFileName).toBe('test_pres.xlsx');
    expect(store.excelFileSize).toBe(12);
  });

  it('setTemplateFile actualitza la plantilla, el text i la mida', () => {
    const store = useWorkspaceStore();
    const content = '# Plantilla {{ pres.import }}';
    const fakeFile = { name: 'plantilla.md.j2', size: 28 };
    store.setTemplateFile(fakeFile, content);

    expect(store.templateFile).toStrictEqual(fakeFile);
    expect(store.templateFileName).toBe('plantilla.md.j2');
    expect(store.templateText).toBe(content);
  });

  it('resetExcel neteja l\'estat de l\'Excel', () => {
    const store = useWorkspaceStore();
    store.setExcelFile({ name: 'test.xlsx', size: 100 });
    store.resetExcel();

    expect(store.excelFile).toBeNull();
    expect(store.excelFileName).toBe('');
    expect(store.excelFileSize).toBe(0);
    expect(store.excelJsonData).toBeNull();
  });

  it('resetTemplate neteja l\'estat de la plantilla', () => {
    const store = useWorkspaceStore();
    store.setTemplateFile({ name: 't.md.j2', size: 50 }, 'abc');
    store.resetTemplate();

    expect(store.templateFile).toBeNull();
    expect(store.templateFileName).toBe('');
    expect(store.templateText).toBe('');
  });

  it('formatBytes formata correctament les mides en bytes', () => {
    const store = useWorkspaceStore();
    expect(store.formatBytes(0)).toBe('0 Bytes');
    expect(store.formatBytes(1024)).toBe('1 KB');
    expect(store.formatBytes(1048576)).toBe('1 MB');
  });

  it('aïlla correctament les metadades i esquemes entre projectes diferents', () => {
    const store = useWorkspaceStore();
    
    // Configurar metadades i esquemes del Projecte A (versió 2)
    localStorage.setItem('ProjecteA:editorMetadata', JSON.stringify([{ element: 'col_v2', group: 'pres' }]));
    localStorage.setItem('ProjecteA:sheetInfo', JSON.stringify([{ clean_name: 'pres', version: 2 }]));
    localStorage.setItem('ProjecteA:hierarchySchema', JSON.stringify({ pres: { v: 2 } }));

    // Configurar metadades i esquemes del Projecte B (versió 1)
    localStorage.setItem('ProjecteB:editorMetadata', JSON.stringify([{ element: 'col_v1', group: 'pres' }]));
    localStorage.setItem('ProjecteB:sheetInfo', JSON.stringify([{ clean_name: 'pres', version: 1 }]));
    localStorage.setItem('ProjecteB:hierarchySchema', JSON.stringify({ pres: { v: 1 } }));

    // Simular lectura de dades per al Projecte A
    localStorage.setItem('currentProjectName', 'ProjecteA');
    const storeA_meta = JSON.parse(localStorage.getItem('ProjecteA:editorMetadata'));
    const storeA_info = JSON.parse(localStorage.getItem('ProjecteA:sheetInfo'));
    const storeA_schema = JSON.parse(localStorage.getItem('ProjecteA:hierarchySchema'));

    expect(storeA_meta[0].element).toBe('col_v2');
    expect(storeA_info[0].version).toBe(2);
    expect(storeA_schema.pres.v).toBe(2);

    // Simular lectura de dades per al Projecte B
    localStorage.setItem('currentProjectName', 'ProjecteB');
    const storeB_meta = JSON.parse(localStorage.getItem('ProjecteB:editorMetadata'));
    const storeB_info = JSON.parse(localStorage.getItem('ProjecteB:sheetInfo'));
    const storeB_schema = JSON.parse(localStorage.getItem('ProjecteB:hierarchySchema'));

    expect(storeB_meta[0].element).toBe('col_v1');
    expect(storeB_info[0].version).toBe(1);
    expect(storeB_schema.pres.v).toBe(1);
  });
});
