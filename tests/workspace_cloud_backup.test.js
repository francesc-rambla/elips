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

import { describe, it, expect, vi } from 'vitest';
import { syncWholeWorkspace } from '../src/composables/useWorkspaceCloudBackup.js';

function makeDeps(overrides = {}) {
  const linked = new Set(overrides.linkedNames || []);
  const cloudProjects = overrides.cloudProjects || [];
  const snapshots = overrides.snapshots || {};
  const linkCalls = [];
  const seedCalls = [];
  const conflicts = [];
  const logs = [];
  return {
    linked,
    linkCalls,
    seedCalls,
    conflicts,
    logs,
    deps: {
      savedProjectNames: overrides.savedProjectNames || [],
      isLinked: (name) => linked.has(name),
      linkProject: (name, id) => { linked.add(name); linkCalls.push({ name, id }); },
      listMyCloudProjects: vi.fn(async () => cloudProjects),
      readLocalProjectSnapshot: async (name) => snapshots[name] || { name },
      seedCloudProjectFromSnapshot: async (id, name, snapshot) => { seedCalls.push({ id, name, snapshot }); },
      generateId: (() => { let i = 0; return () => `id-${++i}`; })(),
      logEvent: (text, type) => logs.push({ text, type }),
      onConflict: (c) => conflicts.push(c),
      raceDelayMs: 0,
      ...overrides.depOverrides,
    },
  };
}

describe('syncWholeWorkspace (Fase 35: còpia de seguretat automàtica de tot l\'espai de treball)', () => {
  it('crea i enllaça automàticament un projecte local sense cap xoc de nom al núvol', async () => {
    const { deps, linkCalls, seedCalls, logs } = makeDeps({
      savedProjectNames: ['ProjecteNou'],
      cloudProjects: [],
    });
    await syncWholeWorkspace(deps);
    expect(seedCalls).toEqual([{ id: 'id-1', name: 'ProjecteNou', snapshot: { name: 'ProjecteNou' } }]);
    expect(linkCalls).toEqual([{ name: 'ProjecteNou', id: 'id-1' }]);
    expect(logs.some((l) => l.text.includes('ProjecteNou') && l.type === 'info')).toBe(true);
  });

  it('mai toca un projecte que ja té un cloudProjectId desat', async () => {
    const { deps, seedCalls, conflicts } = makeDeps({
      savedProjectNames: ['JaEnllaçat'],
      linkedNames: ['JaEnllaçat'],
      cloudProjects: [],
    });
    await syncWholeWorkspace(deps);
    expect(deps.listMyCloudProjects).toHaveBeenCalledTimes(1); // crida única, igualment -- però res més
    expect(seedCalls).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it('un nom local que coincideix amb un projecte al núvol ja existent es registra com a conflicte, mai es crea ni se sobreescriu res', async () => {
    const { deps, seedCalls, linkCalls, conflicts } = makeDeps({
      savedProjectNames: ['Compartit'],
      cloudProjects: [{ projectId: 'cloud-1', projectName: 'Compartit', ownerEmail: 'algú@altre.com' }],
    });
    await syncWholeWorkspace(deps);
    expect(seedCalls).toEqual([]);
    expect(linkCalls).toEqual([]);
    expect(conflicts).toEqual([{ localName: 'Compartit', cloudProjectId: 'cloud-1', cloudProjectName: 'Compartit' }]);
  });

  it('barreja correctament projectes ja enllaçats, nous sense xoc, i en conflicte, en un sol escombrat', async () => {
    const { deps, seedCalls, linkCalls, conflicts } = makeDeps({
      savedProjectNames: ['JaEnllaçat', 'Nou', 'EnConflicte'],
      linkedNames: ['JaEnllaçat'],
      cloudProjects: [{ projectId: 'cloud-x', projectName: 'EnConflicte', ownerEmail: 'owner@test.com' }],
    });
    await syncWholeWorkspace(deps);
    expect(seedCalls.map((c) => c.name)).toEqual(['Nou']);
    expect(linkCalls.map((c) => c.name)).toEqual(['Nou']);
    expect(conflicts.map((c) => c.localName)).toEqual(['EnConflicte']);
  });

  it('amb raceDelayMs > 0, torna a comprovar abans de crear -- si un xoc apareix mentrestant, el tracta com a conflicte en lloc de crear-ne un duplicat', async () => {
    let call = 0;
    const { deps, seedCalls, conflicts } = makeDeps({
      savedProjectNames: ['Mateixa'],
      depOverrides: {
        raceDelayMs: 1,
        listMyCloudProjects: vi.fn(async () => {
          call += 1;
          if (call === 1) return [];
          return [{ projectId: 'cloud-race', projectName: 'Mateixa', ownerEmail: 'altre@test.com' }];
        }),
      },
    });
    await syncWholeWorkspace(deps);
    expect(seedCalls).toEqual([]);
    expect(conflicts).toEqual([{ localName: 'Mateixa', cloudProjectId: 'cloud-race', cloudProjectName: 'Mateixa' }]);
  });
});
