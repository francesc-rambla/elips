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

/**
 * True for any value that isn't a plain object or array (i.e. renders as a
 * single form field, not a nested group) -- ALSO true for a hydrated
 * dynamic-Select foreign-key value (see hydrateModelWithForeignKeys in
 * useWasmEngines.js): that function turns a field's plain scalar (an id) into
 * a rich object carrying the related row's columns, tagged with `_default_val`,
 * so `part.descripcio` works wherever the field is referenced. Semantically
 * that field is still a single scalar form field, never a nested group to
 * recurse into -- without this check, every isPrimitive-gated "is this a
 * plain field or a child group/table" decision across the app (which fields
 * of a KV group to render, which fields of a table row, etc.) would
 * misclassify it as a child group the instant it successfully hydrates, and
 * whatever consumes that misclassification (e.g. NestedDataNode mounted for
 * a "child" that isn't actually an array) would then stomp the hydrated
 * value.
 */
/**
 * Unwraps a hydrated dynamic-Select foreign-key value (see isPrimitive above)
 * back to its plain scalar (the id `<option :value>` was built from), so a
 * native `<select>` bound to this field can find/keep its selection --
 * `<select v-model>` matches the bound value against each `<option>`'s plain
 * value with a structural equality check that never coerces an object to a
 * string, so binding the hydrated OBJECT directly always looks unselected
 * once hydration replaces the raw id with it. Any other value (not yet
 * hydrated, or not an FK field at all) passes through unchanged.
 */
export function unwrapFkValue(val) {
  return (val && typeof val === 'object' && !Array.isArray(val) && val._default_val !== undefined) ? val._default_val : val;
}

export function isPrimitive(val) {
  if (val && typeof val === 'object' && !Array.isArray(val) && val._default_val !== undefined) {
    return true;
  }
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

/**
 * Resolves a dynamic Select field's `vectorPath` (the name of the array to
 * list rows from) against `store.excelJsonData`, trying progressively
 * looser strategies -- `vectorPath` is normally just the bare array key
 * (e.g. `partides`) even when that array is nested inside a key-value group
 * (e.g. `pressupost.partides`), because that's what the config UI's own
 * table picker (`GroupConfigModal.vue`'s `getAvailableTables`) offers.
 *
 *   1. a direct top-level array key
 *   2. an `OUT_`-prefixed top-level array key
 *   3. a dotted path, walked segment by segment
 *   4. a full recursive search for a nested array under that key, anywhere
 *      in the tree (depth-limited) -- this is what step 1's mismatch with
 *      the config UI's own (recursive) table discovery used to miss
 *
 * Returns the row array, or `null` if nothing matches.
 */
export function resolveVectorList(rootData, vectorName, depth = 0) {
  if (!vectorName || !rootData || typeof rootData !== 'object' || depth > 10) return null;
  if (Array.isArray(rootData[vectorName])) return rootData[vectorName];
  if (Array.isArray(rootData['OUT_' + vectorName])) return rootData['OUT_' + vectorName];

  if (vectorName.includes('.')) {
    const parts = vectorName.replace(/^doc\.|^dades\./, '').split('.');
    let curr = rootData;
    for (const p of parts) {
      curr = (curr && typeof curr === 'object') ? curr[p] : null;
    }
    if (Array.isArray(curr)) return curr;
  }

  const children = Array.isArray(rootData) ? rootData : Object.values(rootData);
  for (const val of children) {
    if (val && typeof val === 'object') {
      if (!Array.isArray(val) && Array.isArray(val[vectorName])) return val[vectorName];
      const found = resolveVectorList(val, vectorName, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Turns every dynamic-Select foreign-key field's plain scalar value (an id)
 * into the related row's full data, so `partida.descripcio`-style dotted
 * access works directly on the live model -- both for calculated-field
 * formulas (see _walk_path's scalar fallback in
 * elips_engine/formula/evaluator.py, which only needs to run at all for a
 * field this function failed to hydrate) and for display. Mutates `rootData`
 * in place (so Vue's reactivity keeps targeting the same objects/arrays) and
 * returns it. Mirrors hydrate_foreign_keys in
 * src/python/elips_engine/fk_hydration.py (document-generation pipeline);
 * kept separate since this one runs in the browser before any Python is
 * involved.
 *
 * Extracted as a top-level function (rather than a closure nested inside
 * useWasmEngines' composable body, as it originally was) specifically so it
 * can be called and tested on its own -- the previous nested version had a
 * real bug that went unnoticed for exactly that reason: `!val.toString` was
 * meant to stop recursion from re-entering an already-hydrated FK object
 * (which has `_default_val`) as if it were a plain child group, but EVERY
 * JS object/array already inherits `toString` from its prototype, so the
 * condition was always false and recursion into ANY nested group never ran
 * past the sheet/group directly under the root. A field several groups deep
 * (e.g. `pres.parts.activitats.costs.perfil_producte`) was therefore never
 * hydrated at all -- its formula (`perfil_producte.preu`) kept resolving via
 * evaluator.py's blind scalar-FK fallback instead (a search across every
 * table in the tree for ANY row containing the selected value), which
 * happened to land on the right row only when no OTHER row anywhere in the
 * document also used that same value, explaining why some dropdown options
 * "worked" and others silently kept a stale price.
 */
export function hydrateModelWithForeignKeys(rootData, editorMetadata) {
  if (!rootData || typeof rootData !== 'object') return rootData;
  const metaList = editorMetadata || rootData.editor_metadata || [];
  if (!Array.isArray(metaList) || metaList.length === 0) return rootData;

  const dynamicMetaMap = {};
  metaList.forEach(meta => {
    if (meta && meta.type === 'Select' && meta.sourceType === 'dynamic' && meta.vectorPath) {
      const group = meta.group || '';
      const elem = meta.element || '';
      if (group && elem) {
        dynamicMetaMap[`${group}.${elem}`] = meta;
        const shortGroup = group.split('.').pop();
        dynamicMetaMap[`${shortGroup}.${elem}`] = meta;
        const cleanGroup = group.replace(/^OUT_/, '');
        dynamicMetaMap[`${cleanGroup}.${elem}`] = meta;
        const cleanShort = shortGroup.replace(/^OUT_/, '');
        dynamicMetaMap[`${cleanShort}.${elem}`] = meta;
      }
    }
  });

  if (Object.keys(dynamicMetaMap).length === 0) return rootData;

  const processGroup = (groupName, groupData) => {
    if (!groupData || typeof groupData !== 'object') return;

    if (Array.isArray(groupData)) {
      groupData.forEach(row => processGroup(groupName, row));
      return;
    }

    Object.keys(groupData).forEach(elemKey => {
      const val = groupData[elemKey];
      const metaKey = `${groupName}.${elemKey}`;
      const meta = dynamicMetaMap[metaKey];

      if (meta && val !== null && val !== undefined && val !== '' && typeof val !== 'object') {
        const targetTable = resolveVectorList(rootData, meta.vectorPath);
        if (targetTable && targetTable.length > 0) {
          const valField = meta.valueField || Object.keys(targetTable[0] || {})[0] || '';
          const dispField = meta.displayField || valField;

          const matchedRow = targetTable.find(r => {
            if (!r || typeof r !== 'object') return false;
            return String(r[valField]) === String(val) || String(r[dispField]) === String(val);
          });

          if (matchedRow) {
            const hydratedObj = Object.assign({}, matchedRow);
            const defaultScalar = matchedRow[valField] !== undefined ? matchedRow[valField] : val;
            hydratedObj._default_val = defaultScalar;
            hydratedObj.value = defaultScalar;
            hydratedObj.val = defaultScalar;
            hydratedObj.toString = () => String(defaultScalar);
            hydratedObj.valueOf = () => defaultScalar;
            groupData[elemKey] = hydratedObj;
          }
        }
      }

      // Recurse into any plain nested object/array (a child KV group or
      // table) -- but not into a value this function already hydrated
      // above (or on a previous pass), which carries `_default_val` and
      // must stay a single scalar-like form field, never be walked as if
      // it were a child group.
      if (val && typeof val === 'object' && val._default_val === undefined) {
        const childGroupPath = `${groupName}.${elemKey}`;
        processGroup(childGroupPath, val);
      }
    });
  };

  Object.keys(rootData).forEach(sheetOrGroupName => {
    if (sheetOrGroupName !== 'editor_metadata' && sheetOrGroupName !== '_hierarchy_schema') {
      processGroup(sheetOrGroupName, rootData[sheetOrGroupName]);
    }
  });

  return rootData;
}
