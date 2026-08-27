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
});
