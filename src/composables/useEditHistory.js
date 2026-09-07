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

import { ref, computed } from 'vue';

// In-session Ctrl+Z/Ctrl+Y undo/redo for a single text value — a linear
// stack of full-text snapshots (simple and correct for a document-sized
// string; no need for a diff/patch structure at this scale). Distinct from
// useVersionHistory.js, which persists hourly/manual checkpoints to
// IndexedDB for recovering hours/days-old state — this is purely in-memory,
// fast, per-edit history for the editor's own Ctrl+Z.
//
// TemplateEditor.vue's Visual and Codi tabs both read/write the same
// editorText, so one shared instance (not one per tab) is exactly right: an
// edit made from either tab pushes into the same stack, and Undo/Redo work
// regardless of which tab is currently active.
export function useEditHistory(initialValue = '', { debounceMs = 500 } = {}) {
  const history = ref([initialValue]);
  const index = ref(0);
  let debounceTimer = null;

  const canUndo = computed(() => index.value > 0);
  const canRedo = computed(() => index.value < history.value.length - 1);

  // Coalesces a burst of rapid edits (e.g. every keystroke of normal typing)
  // into one undo step; pass immediate: true for a single, discrete action
  // (inserting a table/block/chip, a toolbar formatting command, undo/redo
  // itself) that should always be its own step regardless of timing.
  const push = (value, { immediate = false } = {}) => {
    if (value === history.value[index.value]) return;
    const commit = () => {
      debounceTimer = null;
      // A later push() during the debounce window already advanced past
      // any stale redo entries when IT ran; only trim here if this is the
      // very first push since the last committed state.
      if (index.value < history.value.length - 1) {
        history.value = history.value.slice(0, index.value + 1);
      }
      history.value.push(value);
      index.value = history.value.length - 1;
    };
    if (debounceTimer) clearTimeout(debounceTimer);
    if (immediate || debounceMs <= 0) {
      commit();
    } else {
      // Still trim any stale redo branch immediately so canRedo reflects
      // reality while the debounce is pending, even though the new
      // snapshot itself is committed later.
      if (index.value < history.value.length - 1) {
        history.value = history.value.slice(0, index.value + 1);
      }
      debounceTimer = setTimeout(commit, debounceMs);
    }
  };

  // Applies whatever is pending immediately (e.g. before navigating away),
  // without waiting out the debounce window.
  const flush = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const undo = () => {
    flush();
    if (!canUndo.value) return undefined;
    index.value--;
    return history.value[index.value];
  };

  const redo = () => {
    flush();
    if (!canRedo.value) return undefined;
    index.value++;
    return history.value[index.value];
  };

  // Reinitializes the stack around a fresh starting value (e.g. opening a
  // different cell/document in the editor) — history from the previous
  // document must never bleed into the new one's undo stack.
  const reset = (value) => {
    flush();
    history.value = [value];
    index.value = 0;
  };

  return { canUndo, canRedo, push, undo, redo, reset, flush };
}
