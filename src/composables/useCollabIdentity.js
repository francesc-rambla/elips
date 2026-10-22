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
 * Stable per-browser identity for the folder-based collaboration feature
 * (see useCollabFolder.js/useCollabSync.js). There is no login/auth system
 * in elips -- this is a self-declared identity, scoped to the browser
 * profile, not to any one project: the same person keeps the same
 * `userId` across every project they collaborate on, so their delta file
 * name (`collab_deltas_<userId>.jsonl`) stays stable too.
 *
 * `userId` is the only thing that must never collide between two people
 * (it names each person's own append-only delta file -- see the plan's
 * "exactly one writer per file" invariant); `displayName` is purely
 * cosmetic (shown in the participant list and activity log) and freely
 * editable.
 */

const USER_ID_KEY = 'elipsCollabUserId';
const DISPLAY_NAME_KEY = 'elipsCollabDisplayName';

export function getOrCreateUserId() {
  let id = localStorage.getItem(USER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(USER_ID_KEY, id);
  }
  return id;
}

export function getDisplayName() {
  return localStorage.getItem(DISPLAY_NAME_KEY) || '';
}

export function setDisplayName(name) {
  const clean = String(name || '').trim();
  if (clean) {
    localStorage.setItem(DISPLAY_NAME_KEY, clean);
  } else {
    localStorage.removeItem(DISPLAY_NAME_KEY);
  }
}

/** Display name if the user has set one, else a short, stable fallback
 * derived from their own userId (never empty, so callers always have
 * something presentable to show). */
export function getDisplayNameOrFallback() {
  const name = getDisplayName();
  if (name) return name;
  return `Usuari ${getOrCreateUserId().slice(0, 4)}`;
}
