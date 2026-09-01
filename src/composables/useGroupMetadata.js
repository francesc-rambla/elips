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
 * Replaces a group's editor_metadata entries with the output of
 * GroupConfigModal's save event: a `_group_label` header row (layout, item
 * title formula, group label) plus one row per configured field.
 *
 * `legacyGroupNames` are extra group-name spellings to also clear before
 * rewriting — passing the short local key here (as NestedDataNode.vue does)
 * makes re-saving a group self-heal any entries mistakenly saved under that
 * key before the 2026-09-01 fix.
 *
 * `ensureKvKeys`, when true, adds empty string values to `store.excelJsonData`
 * for any newly-configured field not yet present on a KV (object, not array)
 * group — DataInspector.vue needs this for root-level KV sheets;
 * NestedDataNode.vue's groups are always backed by real data already.
 *
 * `saveExcelData`/`evaluateComputedFields` are the corresponding functions
 * from `useWasmEngines()`; passed in rather than imported so this module has
 * no dependency on Pyodide being initialized.
 */
export function saveGroupConfig(store, { groupPath, legacyGroupNames = [], data, ensureKvKeys = false, saveExcelData, evaluateComputedFields }) {
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

  if (ensureKvKeys && store.excelJsonData && store.excelJsonData[groupPath]) {
    const sheetData = store.excelJsonData[groupPath];
    if (typeof sheetData === 'object' && !Array.isArray(sheetData)) {
      data.configList.forEach(item => {
        if (!(item.element in sheetData)) {
          sheetData[item.element] = '';
        }
      });
    }
  }

  store.addLog(`Configuració desada per al grup '${groupPath}'.`, 'success');

  if (store.excelJsonData) {
    store.excelJsonData = JSON.parse(JSON.stringify(store.excelJsonData));
    if (saveExcelData) saveExcelData();
    if (evaluateComputedFields) evaluateComputedFields(store.excelJsonData);
  }
}
