import { describe, it, expect } from 'vitest';
import { computeTextDiff, computeJsonDiff } from '../src/composables/useVersionHistory.js';

describe('useVersionHistory - Algorísmica de Diferencials', () => {
  describe('computeTextDiff', () => {
    it('retorna null quan els dos textos de plantilla són exactament idèntics', () => {
      const text = "# Contracte de Serveis\nNom: {{ pres.pressupost }}";
      expect(computeTextDiff(text, text)).toBeNull();
    });

    it('detecta adicions de línies de text a la plantilla Jinja2', () => {
      const oldText = "# Títol";
      const newText = "# Títol\n{% for p in pres.parts %}\n{{ p.partida }}\n{% endfor %}";
      const diff = computeTextDiff(oldText, newText);
      expect(diff).not.toBeNull();
      expect(diff.some(d => d.type === 'add')).toBe(true);
    });

    it('detecta modificacions de línies existents', () => {
      const oldText = "Import: {{ pres.import }}";
      const newText = "Import total: {{ pres.import | format_currency }}";
      const diff = computeTextDiff(oldText, newText);
      expect(diff).not.toBeNull();
      expect(diff.some(d => d.type === 'mod' || d.type === 'add')).toBe(true);
    });

    it('detecta eliminació de línies', () => {
      const oldText = "Línia 1\nLínia 2\nLínia 3";
      const newText = "Línia 1\nLínia 3";
      const diff = computeTextDiff(oldText, newText);
      expect(diff).not.toBeNull();
      expect(diff.some(d => d.type === 'del')).toBe(true);
    });
  });

  describe('computeJsonDiff', () => {
    it('retorna null quan dos objectes de dades JSON són idèntics', () => {
      const obj = { pres: { pressupost: "Pressupost anual", import: 6270 } };
      expect(computeJsonDiff(obj, obj)).toBeNull();
    });

    it('detecta l\'afegit d\'una nova clau al model JSON', () => {
      const oldObj = { pres: { import: 100 } };
      const newObj = { pres: { import: 100, tipus_iva: 0.21 } };
      const diff = computeJsonDiff(oldObj, newObj);
      expect(diff).not.toBeNull();
      expect(diff.some(d => d.op === 'replace' || d.op === 'add')).toBe(true);
    });

    it('detecta la modificació de valors numèrics o de text', () => {
      const oldObj = { import: 100 };
      const newObj = { import: 250 };
      const diff = computeJsonDiff(oldObj, newObj);
      expect(diff).not.toBeNull();
      expect(diff[0].op).toBe('replace');
      expect(diff[0].oldValue).toBe(100);
      expect(diff[0].newValue).toBe(250);
    });

    it('detecta eliminacions de claus al model', () => {
      const oldObj = { key1: 'val1', key2: 'val2' };
      const newObj = { key1: 'val1' };
      const diff = computeJsonDiff(oldObj, newObj);
      expect(diff).not.toBeNull();
      expect(diff.some(d => d.op === 'remove')).toBe(true);
    });
  });
});
