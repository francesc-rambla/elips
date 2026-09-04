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
 * Reads and writes `store.editorMetadata` — the flat list of per-field config
 * (label, type, calculated-field formula, grid position, …) keyed by
 * `{ group, element }` — that both DataInspector.vue (root-level sheets) and
 * NestedDataNode.vue (nested tabular/KV groups) rely on. Extracted from
 * near-identical copies in both files; see the refactor plan's duplication
 * inventory. `groupPath` must always be the FULL dotted hierarchy path (e.g.
 * `pres.parts`), matching the convention the rest of the app uses — passing
 * a short local key here is exactly the bug fixed on 2026-09-01.
 */

/**
 * Finds the editor_metadata row for one field of one group, tolerating a few
 * historical spellings of the group name (short key, `OUT_`-prefixed, etc.)
 * so data saved before a naming convention was tightened up is still found.
 */
export function findElementMetadata(store, groupPath, elementName) {
  if (!store.editorMetadata) return null;
  const shortName = groupPath ? groupPath.split('.').pop() : '';
  const cleanGroup = groupPath ? groupPath.replace(/^OUT_/, '') : '';
  const cleanShort = shortName ? shortName.replace(/^OUT_/, '') : '';
  return store.editorMetadata.find(m =>
    m && m.element === elementName && (
      m.group === groupPath ||
      m.group === shortName ||
      m.group === cleanGroup ||
      m.group === cleanShort ||
      m.group === `OUT_${cleanGroup}`
    )
  ) || null;
}

/**
 * Lists the field names EXPLICITLY configured for a group via GroupConfigModal
 * (one editor_metadata row per field, excluding the group's own `_group_label`
 * header row) — this is the group's schema/column *definition*, independent of
 * whether any actual data rows exist for it. `extraGroupNames` adds extra
 * acceptable spellings to match (NestedDataNode.vue passes its own short
 * `arrayKey` alongside the full dotted path, same tolerance `groupLabel` above
 * already has).
 *
 * Used by NestedDataNode.vue's `effectiveFields` so a tabular group's columns
 * are known as soon as they are configured, even with zero rows — a brand
 * new nested table used to have no way to know its own columns until a row
 * existed to derive them from, which is exactly backwards (bug reported
 * 2026-09-04: "l'estructura de dades s'ha d'emmagatzemar de forma independent
 * a les dades").
 */
export function groupFieldElements(store, groupPath, extraGroupNames = []) {
  if (!store.editorMetadata || !groupPath) return [];
  const shortName = groupPath.split('.').pop();
  const candidates = [groupPath, shortName, ...extraGroupNames];
  const seen = new Set();
  const result = [];
  store.editorMetadata.forEach(m => {
    if (m && candidates.includes(m.group) && !m.isGroupHeader && m.element && !isInternalMetadataKey(m.element)) {
      if (!seen.has(m.element)) {
        seen.add(m.element);
        result.push(m.element);
      }
    }
  });
  return result;
}

/**
 * True for a key that stores internal app bookkeeping rather than an actual
 * user-facing data field — this codebase's convention (see TemplateEditor.vue's
 * `isInternalMetadataKey`, from `useLoopContext.js`) is that any key starting
 * with `_` is internal (`_group_label`, a group's title/layout header row;
 * `_hierarchy_schema`; `_sheet_info`; `_path`; …), alongside the editor_metadata
 * list itself. Both DataInspector.vue (root-level KV groups) and
 * NestedDataNode.vue (nested groups) use this so none of these ever render as
 * if they were a real field in the "Dades" tab form.
 */
export function isInternalMetadataKey(key) {
  if (typeof key !== 'string' || !key) return false;
  return key.startsWith('_') || key === 'editor_metadata' || key === 'editormetadata';
}

/** True if the field's metadata marks it as calculated (Computed type, calcFn, or a row-level formula). */
export function isFieldCalculated(store, groupPath, elementName) {
  const meta = findElementMetadata(store, groupPath, elementName);
  if (!meta) return false;
  if (meta.isCalculated === true || meta.sourceType === 'computed' || meta.type === 'Computed') {
    return true;
  }
  if (meta.calcFormula && String(meta.calcFormula).trim() !== '') {
    return true;
  }
  if (meta.calcFn && meta.calcFn !== 'NONE' && meta.calcFn !== '') {
    return Boolean(meta.calcVector || meta.calcFormula);
  }
  return false;
}

/** The configured form label for a field, falling back to its raw element key when none is set. */
export function fieldLabel(store, groupPath, elementName) {
  const meta = findElementMetadata(store, groupPath, elementName);
  if (meta && meta.label && meta.label.trim()) {
    return meta.label.trim();
  }
  return elementName;
}

/**
 * The configured display label for a whole group (its `_group_label` header
 * row), falling back to the raw group name when none is set. `extraGroupNames`
 * lets a caller add extra acceptable spellings to match against — NestedDataNode.vue
 * uses this to also match its own `fullPath`.
 */
export function groupLabel(store, groupName, extraGroupNames = []) {
  if (!groupName) return '';
  if (store.editorMetadata) {
    const candidates = [groupName, groupName.split('.').pop(), ...extraGroupNames];
    const meta = store.editorMetadata.find(m =>
      candidates.includes(m.group) &&
      (m.element === '_group_label' || m.element === '_group' || m.isGroupHeader) &&
      m.label && m.label.trim()
    );
    if (meta) {
      return meta.label.trim();
    }
  }
  return groupName;
}

/**
 * Walks `root` (normally `store.excelJsonData`) following the dotted schema
 * path `pathParts` (e.g. `['pres', 'parts', 'activitats']`) and returns every
 * node found there — an array walks into EVERY item at that hop, so a
 * repeating parent (`pres.parts`) yields one result per row for a path
 * nested inside it (`pres.parts.activitats`), not just the first. Used to
 * find every place a group's real data lives so a config save can seed newly
 * configured fields into all of them, mirroring how `editor_metadata` is
 * already shared by group name across every sibling row.
 */
function collectNodesAtSchemaPath(root, pathParts) {
  const results = [];
  const walk = (node, parts) => {
    if (!node || typeof node !== 'object') return;
    if (parts.length === 0) {
      results.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(item => walk(item, parts));
      return;
    }
    const [head, ...rest] = parts;
    if (head in node) {
      walk(node[head], rest);
    }
  };
  walk(root, pathParts);
  return results;
}

/**
 * Replaces a group's editor_metadata entries with the output of
 * GroupConfigModal's save event: a `_group_label` header row (layout, item
 * title formula, group label) plus one row per configured field.
 *
 * `legacyGroupNames` are extra group-name spellings to also clear before
 * rewriting — passing the short local key here (as NestedDataNode.vue does)
 * makes re-saving a group self-heal any entries mistakenly saved under that
 * key before the 2026-09-01 fix.
 *
 * `ensureFieldKeys`, when true, backfills every newly-configured field as an
 * empty string on data that already exists — a KV (object, not array)
 * group's own keys, or every existing row of a tabular (array) group —
 * so already-entered rows immediately show the new field as an editable
 * blank instead of it being absent from that row's own object. A tabular
 * group with ZERO rows is deliberately left with zero rows: its column
 * DEFINITION lives in editor_metadata itself now (see
 * `groupFieldElements`/`effectiveFields` in NestedDataNode.vue), independent
 * of whether any data exists for it, so there is nothing left to "backfill"
 * for an empty group — no data row needs to be fabricated just to give the
 * columns somewhere to be discovered from (the bug fixed 2026-09-04:
 * "l'estructura de dades s'ha d'emmagatzemar de forma independent a les
 * dades" — a table with 0 rows must still know its own columns, and must
 * still render as having 0 rows).
 * `groupPath` may be a dotted nested path (e.g. `pres.parts.activitats`); a
 * tabular group nested inside a repeating parent is looked up under EVERY
 * matching parent row, not just the first, matching the same
 * shared-schema-across-siblings guarantee `editor_metadata` already has.
 *
 * `saveExcelData`/`evaluateComputedFields` are the corresponding functions
 * from `useWasmEngines()`; passed in rather than imported so this module has
 * no dependency on Pyodide being initialized.
 *
 * `analyzeMirrorPattern`/`applyMirrorColumn` (also from `useWasmEngines()`),
 * when passed, are used for any field in `data.configList` that is genuinely
 * NEW (not already a key of the group's real data, checked before any of the
 * above mutates it): if the sheet's
 * existing columns turn out to be a simple cell-by-cell mirror of another
 * sheet (`=SourceSheet!Cell` formulas), the user is asked whether to ALSO add
 * the new column to that source sheet, replicating the formula convention —
 * otherwise the OUT_ sheet's new column would silently be left disconnected
 * from wherever the group's real data actually lives (see bug report:
 * OUT_nomconjunt mirroring a `nomconjunt` sheet). When the pattern looks like
 * a mirror but is too ambiguous to replicate safely (mixed source sheets, a
 * non-formula cell, ...), the user is warned instead and nothing is written
 * automatically — they are told to add the column directly in the
 * spreadsheet. A sheet with no formulas at all (the ordinary case) triggers
 * neither prompt.
 */
export async function saveGroupConfig(store, { groupPath, legacyGroupNames = [], data, ensureFieldKeys = false, saveExcelData, evaluateComputedFields, analyzeMirrorPattern, applyMirrorColumn }) {
  // "Newly added" is judged against the REAL data the group already has, not
  // against editor_metadata — a group configured for the first time (no prior
  // metadata at all, e.g. a sheet freshly uploaded from an existing Excel
  // file) would otherwise have every one of its already-populated columns
  // misreported as "new" just because none of them had a metadata row yet.
  const groupNodes = (store.excelJsonData && groupPath) ? collectNodesAtSchemaPath(store.excelJsonData, groupPath.split('.')) : [];
  const preExistingKeys = new Set();
  groupNodes.forEach(node => {
    if (Array.isArray(node)) {
      node.forEach(row => { if (row && typeof row === 'object' && !Array.isArray(row)) Object.keys(row).forEach(k => preExistingKeys.add(k)); });
    } else if (node && typeof node === 'object') {
      Object.keys(node).forEach(k => preExistingKeys.add(k));
    }
  });
  const newlyAddedFields = data.configList.filter(item => !preExistingKeys.has(item.element)).map(item => item.element);

  store.editorMetadata = store.editorMetadata.filter(m => m.group !== groupPath && !legacyGroupNames.includes(m.group));

  const groupMeta = {
    group: groupPath,
    element: '_group_label',
    isGroupHeader: true,
    groupLayout: data.selectedLayout,
    itemTitleFormula: data.itemTitleFormula || ''
  };
  if (data.groupLabel && data.groupLabel.trim()) {
    groupMeta.label = data.groupLabel.trim();
  }
  store.editorMetadata.push(groupMeta);

  data.configList.forEach(item => {
    const meta = {
      group: groupPath,
      element: item.element,
      type: item.type
    };
    if (item.label && item.label.trim()) {
      meta.label = item.label.trim();
    }
    if (item.type === 'Select') {
      meta.sourceType = item.sourceType;
      meta.multiple = !!item.multiple;
      if (item.sourceType === 'dynamic') {
        meta.vectorPath = item.vectorPath;
        meta.displayField = item.displayField;
        meta.valueField = item.valueField;
      } else {
        meta.options = (item.optionsRaw || '').split(',').map(x => x.trim()).filter(x => x);
      }
    }
    meta.isCalculated = !!item.isCalculated;
    if (item.isCalculated || item.type === 'Computed') {
      meta.isCalculated = true;
      meta.sourceType = 'computed';
      meta.calcFn = item.calcFn || 'CUSTOM';
      meta.calcVector = item.calcVector || '';
      meta.calcTargetCol = item.calcTargetCol || '';
      meta.calcFormula = item.calcFormula || '';
    } else {
      meta.isCalculated = false;
      if (item.type !== 'Select') {
        meta.sourceType = 'static';
      }
      meta.calcFn = 'NONE';
      meta.calcVector = '';
      meta.calcTargetCol = '';
      meta.calcFormula = '';
    }
    if (item.type === 'Table') {
      meta.vectorPath = item.vectorPath;
    }

    if (item.width) meta.width = item.width;
    if (item.gridRow) meta.gridRow = item.gridRow;
    if (item.gridOrder) meta.gridOrder = item.gridOrder;
    if (item.gridFill) meta.gridFill = item.gridFill;

    store.editorMetadata.push(meta);
  });

  if (ensureFieldKeys && store.excelJsonData && groupPath) {
    // groupNodes was already computed above (before any config was applied)
    // to tell new fields from existing ones — the same live references are
    // still valid to mutate here, since nothing in between replaced them.
    //
    // A tabular (array) group's column DEFINITION now comes from
    // editor_metadata itself (see groupFieldElements/effectiveFields in
    // NestedDataNode.vue), independent of whether it has any rows — so a
    // brand-new, still-empty tabular group is intentionally left with ZERO
    // rows here rather than seeded with a fake one just so the columns had
    // somewhere to "live" (that hack, previously needed because the column
    // list used to be derived from row data, produced a phantom row the user
    // never asked for; bug reported 2026-09-04: "la definició no pot
    // dependre del fet que hi hagi o no dades"). Existing rows still get any
    // newly-configured field backfilled, so already-entered data keeps
    // working with the new field turning up as an editable blank on them.
    groupNodes.forEach(sheetData => {
      if (Array.isArray(sheetData)) {
        sheetData.forEach(row => {
          if (row && typeof row === 'object' && !Array.isArray(row)) {
            data.configList.forEach(item => {
              if (!(item.element in row)) row[item.element] = '';
            });
          }
        });
      } else if (sheetData && typeof sheetData === 'object') {
        data.configList.forEach(item => {
          if (!(item.element in sheetData)) {
            sheetData[item.element] = '';
          }
        });
      }
    });
  }

  // Reasons analyze_mirror_pattern (engine.py) returns when the sheet clearly
  // WAS attempting a formula-based mirror but not cleanly enough to replicate
  // automatically — as opposed to 'sheet_not_found'/'no_data_rows'/
  // 'no_formulas_found'/'no_excel_file', which just mean "not a mirror sheet
  // at all" (the overwhelming majority case) and should stay silent.
  const AMBIGUOUS_MIRROR_REASONS = new Set([
    'multiple_or_no_source_sheets',
    'non_formula_or_complex_cell',
    'unparseable_formula',
    'unparseable_cell_ref',
    'column_maps_to_multiple_source_columns',
    'inconsistent_row_offset',
    'duplicate_source_column_mapping',
  ]);

  if (newlyAddedFields.length > 0 && analyzeMirrorPattern) {
    try {
      const analysis = await analyzeMirrorPattern(groupPath);
      if (analysis.is_mirror) {
        const fieldsLabel = newlyAddedFields.join(', ');
        const confirmed = window.confirm(
          `El full d'aquest grup sembla ser un mirall del full '${analysis.source_sheet}' ` +
          `(les seves columnes existents són fórmules que hi apunten).\n\n` +
          `Vols afegir també el/s camp/s nou/s (${fieldsLabel}) al full '${analysis.source_sheet}', ` +
          `replicant aquesta mateixa fórmula, perquè quedin enllaçats?`
        );
        if (confirmed && applyMirrorColumn) {
          for (const fieldName of newlyAddedFields) {
            const result = await applyMirrorColumn(groupPath, fieldName);
            if (result.applied) {
              store.addLog(`Camp '${fieldName}' afegit també al full '${result.source_sheet}' (columna ${result.source_col}), enllaçat des de '${groupPath}' (columna ${result.out_col}).`, 'success');
            } else {
              store.addLog(`No s'ha pogut afegir el camp '${fieldName}' al full font: ${result.reason}. Afegeix-lo manualment al full de càlcul.`, 'warning');
            }
          }
        }
      } else if (AMBIGUOUS_MIRROR_REASONS.has(analysis.reason)) {
        window.alert(
          `Aquest full sembla ser (parcialment) un mirall d'un altre full mitjançant fórmules, ` +
          `però el patró no és prou clar o uniforme perquè elips pugui afegir-hi automàticament ` +
          `la/les nova/ves columna/es (${newlyAddedFields.join(', ')}).\n\n` +
          `Afegeix aquesta columna directament al full de càlcul si també ha d'estar enllaçada.`
        );
        store.addLog(`El camp/s nou/s (${newlyAddedFields.join(', ')}) de '${groupPath}' no s'ha/n pogut enllaçar automàticament amb el full font (motiu: ${analysis.reason}).`, 'warning');
      }
    } catch (e) {
      // Never let a mirror-detection failure block saving the actual configuration.
      store.addLog(`No s'ha pogut analitzar si '${groupPath}' és un mirall d'un altre full: ${e.message || e}`, 'warning');
    }
  }

  store.addLog(`Configuració desada per al grup '${groupPath}'.`, 'success');

  if (store.excelJsonData) {
    store.excelJsonData = JSON.parse(JSON.stringify(store.excelJsonData));
    if (saveExcelData) saveExcelData();
    if (evaluateComputedFields) evaluateComputedFields(store.excelJsonData);
  }
}
