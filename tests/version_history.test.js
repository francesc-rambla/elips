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

import { describe, it, expect } from 'vitest';
import {
  computeTextDiff,
  computeJsonDiff,
  computeDataPatch,
  computeMetaPatch,
  reconstructExcelJsonDataAt,
  reconstructEditorMetadataAt,
} from '../src/composables/useVersionHistory.js';

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

  // Regressió: l'històric de versions ja no guarda una còpia sencera
  // d'editorMetadata a cada diferencial (era la causa principal de
  // l'esgotament de l'espai de localStorage reportat pels usuaris) -- en
  // comptes d'això, es guarda un pedaç RFC 6902 (metaPatch) i es reconstrueix
  // reproduint-lo sobre la línia base del snapshot. Aquests tests cobreixen
  // que aquesta reconstrucció dona el mateix resultat que abans.
  describe('computeMetaPatch / reconstructEditorMetadataAt', () => {
    it('retorna null quan dos arrays de metadades són idèntics', () => {
      const meta = [{ element: 'preu', type: 'Number' }];
      expect(computeMetaPatch(meta, meta)).toBeNull();
    });

    it('genera un pedaç aplicable que reconstrueix un canvi simple', () => {
      const oldMeta = [{ element: 'preu', type: 'Number' }];
      const newMeta = [{ element: 'preu', type: 'Number' }, { element: 'unitats', type: 'Number' }];
      const patch = computeMetaPatch(oldMeta, newMeta);
      expect(patch).not.toBeNull();

      const snap = { editorMetadata: oldMeta, diffs: [{ metaPatch: patch }] };
      const reconstructed = reconstructEditorMetadataAt(snap, 0);
      expect(reconstructed).toEqual(newMeta);
    });

    it('reconstrueix correctament encadenant diversos pedaços successius', () => {
      const v0 = [{ element: 'preu', type: 'Number' }];
      const v1 = [{ element: 'preu', type: 'Number' }, { element: 'unitats', type: 'Number' }];
      const v2 = [{ element: 'preu', type: 'Currency' }, { element: 'unitats', type: 'Number' }];

      const snap = {
        editorMetadata: v0,
        diffs: [
          { metaPatch: computeMetaPatch(v0, v1) },
          { metaPatch: computeMetaPatch(v1, v2) },
        ],
      };

      expect(reconstructEditorMetadataAt(snap, 0)).toEqual(v1);
      expect(reconstructEditorMetadataAt(snap, 1)).toEqual(v2);
    });

    it('manté la compatibilitat retroactiva: un diff sense metaPatch (format antic) es queda en la línia base', () => {
      const baseline = [{ element: 'preu', type: 'Number' }];
      const snap = { editorMetadata: baseline, diffs: [{ /* format antic: sense metaPatch */ }] };
      expect(reconstructEditorMetadataAt(snap, 0)).toEqual(baseline);
    });
  });

  describe('computeDataPatch / reconstructExcelJsonDataAt (regressió de referència)', () => {
    it('reconstrueix excelJsonData igual que abans -- comportament ja existent, no tocat per aquest canvi', () => {
      const v0 = { pres: { import: 100 } };
      const v1 = { pres: { import: 250 } };
      const snap = { excelJsonData: v0, diffs: [{ dataPatch: computeDataPatch(v0, v1) }] };
      expect(reconstructExcelJsonDataAt(snap, 0)).toEqual(v1);
    });
  });
});
