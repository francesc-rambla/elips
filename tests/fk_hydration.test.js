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
import { hydrateModelWithForeignKeys } from '../src/composables/useSchemaResolver.js';

describe('hydrateModelWithForeignKeys', () => {
  it('hydrates a dynamic Select several groups deep (regression: recursion never used to reach past the first nested level)', () => {
    // Mirrors the real-world shape reported by a user: pres (kv) > parts
    // (table) > activitats (table, nested per part) > costs (table, nested
    // per activitat), with a dynamic Select `perfil_producte` pointing at a
    // top-level `preus` table.
    const data = {
      pres: {
        parts: [
          {
            idPartida: 'P1',
            activitats: [
              {
                idActivitat: 'A1',
                costs: [
                  { funcio: 'Consultoria', perfil_producte: 'E2', preu: 0 },
                ],
              },
            ],
          },
        ],
      },
      preus: [
        { element: 'E1', descriptor: 'Element U', preu: 13.5 },
        { element: 'E2', descriptor: 'Element D', preu: 15 },
        { element: 'E3', descriptor: 'Element T', preu: 18.5 },
      ],
    };
    const metadata = [
      {
        group: 'pres.parts.activitats.costs', element: 'perfil_producte', type: 'Select',
        sourceType: 'dynamic', vectorPath: 'preus', displayField: 'element', valueField: 'element',
      },
    ];

    hydrateModelWithForeignKeys(data, metadata);

    const cost = data.pres.parts[0].activitats[0].costs[0];
    expect(cost.perfil_producte).toBeTypeOf('object');
    expect(cost.perfil_producte.element).toBe('E2');
    expect(cost.perfil_producte.preu).toBe(15);
    expect(cost.perfil_producte._default_val).toBe('E2');
  });

  it('hydrates independently to the correct row per selected value, even when several nested cost rows share the same column names as the target table (name-collision self-match regression)', () => {
    const data = {
      pres: {
        parts: [
          {
            idPartida: 'P1',
            activitats: [
              { idActivitat: 'A1', costs: [{ perfil_producte: 'E1', preu: 0 }] },
              { idActivitat: 'A2', costs: [{ perfil_producte: 'E3', preu: 0 }] },
            ],
          },
        ],
      },
      preus: [
        { element: 'E1', preu: 13.5 },
        { element: 'E2', preu: 15 },
        { element: 'E3', preu: 18.5 },
      ],
    };
    const metadata = [
      {
        group: 'pres.parts.activitats.costs', element: 'perfil_producte', type: 'Select',
        sourceType: 'dynamic', vectorPath: 'preus', displayField: 'element', valueField: 'element',
      },
    ];

    hydrateModelWithForeignKeys(data, metadata);

    const [cost1] = data.pres.parts[0].activitats[0].costs;
    const [cost2] = data.pres.parts[0].activitats[1].costs;
    expect(cost1.perfil_producte.preu).toBe(13.5);
    expect(cost2.perfil_producte.preu).toBe(18.5);
  });

  it('does not re-descend into an already-hydrated FK object as if it were a child group', () => {
    const data = {
      grup: {
        item: 'E1',
      },
      taula: [{ element: 'E1', preu: 42 }],
    };
    const metadata = [
      {
        group: 'grup', element: 'item', type: 'Select',
        sourceType: 'dynamic', vectorPath: 'taula', displayField: 'element', valueField: 'element',
      },
    ];

    expect(() => hydrateModelWithForeignKeys(data, metadata)).not.toThrow();
    expect(data.grup.item.preu).toBe(42);

    // A second pass (as happens on every recompute) must be a no-op, not an
    // attempt to walk the hydrated object's own keys as a nested group.
    expect(() => hydrateModelWithForeignKeys(data, metadata)).not.toThrow();
    expect(data.grup.item.preu).toBe(42);
  });
});
