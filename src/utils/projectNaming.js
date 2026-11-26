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

/**
 * Fase 31 (veure .claude/plans/unified-nibbling-adleman.md): unir-se a un
 * projecte al núvol SEMPRE crea un projecte local nou (amb el nom real del
 * projecte al núvol), mai sobreescriu el que ja tinguis obert -- aquesta
 * funció tria el nom local a fer servir, desduplicat contra els noms ja
 * existents amb un sufix " (2)", " (3)"... (mateix patró "humà" que
 * qualsevol gestor de fitxers usa per a una còpia).
 */
export function dedupeProjectName(baseName, existingNames) {
  const clean = String(baseName || '').trim() || 'Projecte del núvol';
  const existing = existingNames || [];
  if (!existing.includes(clean)) return clean;
  let i = 2;
  while (existing.includes(`${clean} (${i})`)) {
    i += 1;
  }
  return `${clean} (${i})`;
}
