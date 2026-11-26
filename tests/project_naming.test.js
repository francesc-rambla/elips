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
import { dedupeProjectName } from '../src/utils/projectNaming.js';

describe('dedupeProjectName (Fase 31)', () => {
  it('retorna el nom tal qual si encara no existeix', () => {
    expect(dedupeProjectName('Projecte Compartit', ['Default'])).toBe('Projecte Compartit');
  });

  it('afegeix " (2)" si el nom ja existeix', () => {
    expect(dedupeProjectName('Projecte Compartit', ['Default', 'Projecte Compartit'])).toBe('Projecte Compartit (2)');
  });

  it('salta al primer sufix lliure si " (2)" també existeix', () => {
    expect(dedupeProjectName('Projecte Compartit', ['Projecte Compartit', 'Projecte Compartit (2)', 'Projecte Compartit (3)'])).toBe('Projecte Compartit (4)');
  });

  it('no es confon per un forat al mig (p. ex. "(2)" esborrat però "(3)" encara present)', () => {
    expect(dedupeProjectName('X', ['X', 'X (3)'])).toBe('X (2)');
  });

  it('un nom buit/nul cau a un valor per defecte, no deixa cap projecte sense nom', () => {
    expect(dedupeProjectName('', [])).toBe('Projecte del núvol');
    expect(dedupeProjectName(null, ['Projecte del núvol'])).toBe('Projecte del núvol (2)');
  });

  it('una llista d\'existents buida o absent mai llança', () => {
    expect(dedupeProjectName('Sol', undefined)).toBe('Sol');
    expect(dedupeProjectName('Sol', [])).toBe('Sol');
  });
});
