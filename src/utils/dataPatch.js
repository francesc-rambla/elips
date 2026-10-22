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
 * Shared RFC 6902 JSON Patch (fast-json-patch) helpers for diffing/replaying
 * `excelJsonData`-shaped trees. Extracted from useVersionHistory.js (which
 * originally defined these for its own baseline+diff timeline) so the
 * collaboration sync engine (useCollabSync.js) can reuse the exact same
 * diff/apply primitives without a second fast-json-patch wiring, and without
 * useCollabSync.js depending on the (stateful, component-local)
 * useVersionHistory() composable just to reach two pure functions.
 */

import { compare as jsonPatchCompare, applyPatch as jsonPatchApply } from 'fast-json-patch';

export { jsonPatchCompare, jsonPatchApply };

// null/undefined are normalized to {} since jsonPatchCompare requires actual
// objects on both sides.
export const computeDataPatch = (oldObj, newObj) => {
  const a = oldObj && typeof oldObj === 'object' ? oldObj : {};
  const b = newObj && typeof newObj === 'object' ? newObj : {};
  const patch = jsonPatchCompare(a, b);
  return patch.length > 0 ? patch : null;
};

// Same RFC 6902 patch as computeDataPatch, for editorMetadata (an array of
// field-config objects) -- null/undefined normalized to [] instead of {}.
export const computeMetaPatch = (oldMeta, newMeta) => {
  const a = Array.isArray(oldMeta) ? oldMeta : [];
  const b = Array.isArray(newMeta) ? newMeta : [];
  const patch = jsonPatchCompare(a, b);
  return patch.length > 0 ? patch : null;
};

/**
 * Applies a fast-json-patch patch array to `doc`, returning the resulting
 * document -- mutateDocument:false keeps this pure (never touches `doc`
 * itself), matching the exact idiom useVersionHistory.js's
 * reconstructExcelJsonDataAt already relied on inline. Returns `doc`
 * unchanged if `patch` is empty/missing.
 */
export const applyDataPatch = (doc, patch) => {
  if (!patch || patch.length === 0) return doc;
  return jsonPatchApply(doc, patch, false, false).newDocument;
};
