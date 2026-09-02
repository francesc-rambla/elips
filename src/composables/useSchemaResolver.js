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
 * Shared helpers for resolving nodes in `store.hierarchySchema` (the tree the
 * Python engine derives from dotted Excel sheet names, e.g. `pres.parts.activitats`)
 * by a data path.
 *
 * Extracted from DataInspector.vue, NestedDataNode.vue and TemplateEditor.vue,
 * which each carried an identical copy — see the "Verified duplication
 * inventory" in the refactor plan. Behavior is unchanged from the original
 * copies; this file only centralizes them.
 */

/** True for any value that isn't a plain object or array (i.e. renders as a single form field, not a nested group). */
export function isPrimitive(val) {
  return !Array.isArray(val) && (typeof val !== 'object' || val === null);
}

/** A schema node is "real" only if it actually describes at least one field or child group — empty placeholder nodes should be skipped by callers. */
export function isNonEmptySchema(s) {
  if (!s || typeof s !== 'object') return false;
  const hasFields = Array.isArray(s.fields) && s.fields.length > 0;
  const hasChildren = s.children && (Array.isArray(s.children) ? s.children.length > 0 : Object.keys(s.children).length > 0);
  return hasFields || hasChildren;
}

/**
 * Finds the hierarchy-schema node for a given dotted data path, trying
 * progressively looser strategies since `targetPath` may come from several
 * different sources (a Jinja loop variable, a stored `data_path`, a raw
 * sheet key) that don't always agree on exact spelling:
 *
 *   1. an exact `data_path` match on any node in `dict`
 *   2. a flat lookup using the cleaned path as the object key directly
 *   3. walking the tree segment by segment via `.children`
 *   4. matching by key/`data_path` suffix (last path segment)
 *   5. a full depth-first search as a last resort
 *
 * Returns an empty `{ fields: [], children: {} }` schema (never null/undefined)
 * so callers can use the result without an extra existence check.
 */
export function universalFindSchema(targetPath, dict) {
  if (!dict || !targetPath) return { fields: [], children: {} };

  const cleanP = String(targetPath).replace(/\.\d+\b/g, '').replace(/^#?(dades|doc)\./, '');

  // 1. Direct match by node's data_path property
  for (const [k, val] of Object.entries(dict)) {
    if (val && typeof val === 'object' && val.data_path === cleanP && isNonEmptySchema(val)) {
      return val;
    }
  }

  // 2. Direct Flat Key Lookup
  if (dict[cleanP] && isNonEmptySchema(dict[cleanP])) {
    return dict[cleanP];
  }

  // 3. Direct Tree Path Traversal
  const parts = cleanP.split('.').filter(Boolean);
  let curr = dict;
  let foundTree = null;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (curr && typeof curr === 'object') {
      const node = curr[p] || (curr.children && typeof curr.children === 'object' && !Array.isArray(curr.children) ? curr.children[p] : null);
      if (node) {
        foundTree = node;
        curr = node.children;
      } else {
        foundTree = null;
        break;
      }
    }
  }
  if (isNonEmptySchema(foundTree)) {
    return foundTree;
  }

  // 4. Search by key suffix or data_path
  const lastKey = parts[parts.length - 1];
  for (const [sKey, sVal] of Object.entries(dict)) {
    if ((sKey === cleanP || sKey === lastKey || sKey.endsWith(`.${lastKey}`) || sVal?.data_path === cleanP || sVal?.data_path?.endsWith(`.${lastKey}`)) && isNonEmptySchema(sVal)) {
      return sVal;
    }
  }

  // 5. Deep DFS
  const dfs = (nodeObj) => {
    if (!nodeObj || typeof nodeObj !== 'object') return null;
    for (const [k, v] of Object.entries(nodeObj)) {
      if ((k === lastKey || k === cleanP || v?.data_path === cleanP) && isNonEmptySchema(v)) {
        return v;
      }
      if (v && v.children && typeof v.children === 'object' && !Array.isArray(v.children)) {
        const sub = dfs(v.children);
        if (sub) return sub;
      }
    }
    return null;
  };

  const dfsResult = dfs(dict);
  if (dfsResult) return dfsResult;

  return { fields: [], children: {} };
}
