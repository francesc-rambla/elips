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
import { computeDataPatch, computeMetaPatch, applyDataPatch } from '../src/utils/dataPatch.js';

describe('dataPatch', () => {
  it('computeDataPatch returns null when nothing changed', () => {
    const a = { pres: { parts: [{ nom: 'P1' }] } };
    const b = { pres: { parts: [{ nom: 'P1' }] } };
    expect(computeDataPatch(a, b)).toBeNull();
  });

  it('computeDataPatch + applyDataPatch round-trips a change', () => {
    const before = { pres: { parts: [{ nom: 'P1', import: 100 }] } };
    const after = { pres: { parts: [{ nom: 'P1', import: 150 }] } };
    const patch = computeDataPatch(before, after);
    expect(patch).not.toBeNull();
    const replayed = applyDataPatch(before, patch);
    expect(replayed).toEqual(after);
  });

  it('computeDataPatch normalizes null/undefined to {} on both sides', () => {
    expect(computeDataPatch(null, null)).toBeNull();
    const patch = computeDataPatch(null, { a: 1 });
    expect(patch).not.toBeNull();
    expect(applyDataPatch({}, patch)).toEqual({ a: 1 });
  });

  it('computeMetaPatch round-trips a change to an editorMetadata-shaped array', () => {
    const before = [{ element: 'preu', type: 'Number' }];
    const after = [{ element: 'preu', type: 'Currency' }];
    const patch = computeMetaPatch(before, after);
    expect(patch).not.toBeNull();
    expect(applyDataPatch(before, patch)).toEqual(after);
  });

  it('applyDataPatch returns the document unchanged for an empty/missing patch', () => {
    const doc = { a: 1 };
    expect(applyDataPatch(doc, null)).toBe(doc);
    expect(applyDataPatch(doc, [])).toBe(doc);
  });

  it('two independently computed patches from the same before/after state are identical (determinism)', () => {
    const before = { x: 1, y: { z: [1, 2, 3] } };
    const after = { x: 2, y: { z: [1, 2, 3, 4] } };
    const patch1 = computeDataPatch(before, after);
    const patch2 = computeDataPatch(before, after);
    expect(patch1).toEqual(patch2);
  });
});
