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
 * Fase 35 (veure pla, "Fases 34-37"): l'escombrat automàtic que fa de la
 * sincronització al núvol una còpia de seguretat de TOT l'espai de treball
 * local, no només del projecte activat manualment -- per a cada projecte de
 * `savedProjectsList` que encara no tingui cap `cloudProjectId` desat, si no
 * hi ha cap projecte al núvol amb aquest mateix nom se'n crea un en segon
 * pla (sense cap clic); si ja n'hi ha un amb el mateix nom (un xoc real,
 * mai vist abans d'aquesta fase perquè l'activació manual no ho permetia),
 * es registra com a conflicte pendent en lloc de sobreescriure o duplicar
 * res en silenci -- la resolució (Fase 36) decideix què fer-ne.
 *
 * Totes les dependències són injectables (mateix idioma que
 * `findWorkingSignalingServer` a `useCollabRealtime.js`) perquè la funció
 * sencera sigui provable amb Vitest sense muntar `App.vue` (que no té cap
 * test unitari propi -- les seves pròpies crides es verifiquen en viu).
 */

const DEFAULT_RACE_DELAY_MS = 300;

/**
 * `deps`:
 * - `savedProjectNames`: array de noms (una còpia; no es muta).
 * - `isLinked(name)`: `${name}:cloudProjectId` ja desat localment?
 * - `linkProject(name, id)`: desa l'enllaç local acabat de crear.
 * - `listMyCloudProjects()`: `cloud.listMyCloudProjects` (useCloudSync.js).
 * - `readLocalProjectSnapshot(name)`: `src/utils/projectSnapshot.js`.
 * - `seedCloudProjectFromSnapshot(id, name, snapshot)`: `cloud.seedCloudProjectFromSnapshot`.
 * - `generateId()`: per defecte `crypto.randomUUID()`.
 * - `logEvent(text, type)`.
 * - `onConflict({localName, cloudProjectId, cloudProjectName})`.
 * - `raceDelayMs`: espera abans de confirmar "cap xoc" i crear-lo de debò --
 *   mitigació (no eliminació total, vegeu el pla) de la carrera de dos
 *   navegadors signant-se gairebé alhora amb un nom mai sincronitzat per
 *   cap banda encara.
 */
export async function syncWholeWorkspace({
  savedProjectNames,
  isLinked,
  linkProject,
  listMyCloudProjects,
  readLocalProjectSnapshot,
  seedCloudProjectFromSnapshot,
  generateId = () => crypto.randomUUID(),
  logEvent = () => {},
  onConflict = () => {},
  raceDelayMs = DEFAULT_RACE_DELAY_MS,
}) {
  const existingByName = new Map((await listMyCloudProjects()).map((p) => [p.projectName, p]));
  for (const name of savedProjectNames) {
    if (isLinked(name)) continue;
    let match = existingByName.get(name);
    if (!match && raceDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, raceDelayMs));
      match = new Map((await listMyCloudProjects()).map((p) => [p.projectName, p])).get(name);
    }
    if (match) {
      onConflict({ localName: name, cloudProjectId: match.projectId, cloudProjectName: match.projectName });
      continue;
    }
    const snapshot = await readLocalProjectSnapshot(name);
    const id = generateId();
    await seedCloudProjectFromSnapshot(id, name, snapshot);
    linkProject(name, id);
    logEvent(`Còpia de seguretat al núvol creada per al projecte '${name}'.`, 'info');
  }
}
