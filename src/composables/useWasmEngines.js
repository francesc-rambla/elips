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

import { ref } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import * as pandocModule from '../vendor/pandoc/pandoc.js';
import { saveBinaryFile, getBinaryFile } from '../utils/db';
import enginePyCode from '../python/engine.py?raw';

// Save WebAssembly engine instances outside vue reactiveness scope for speed
var _pyodide = null;
var _pandoc = null;
var _initPromise = null;

export function useWasmEngines() {
  const store = useWorkspaceStore();
  const isLoading = ref(false);

  const initEngines = async () => {
    if (store.enginesReady && _pyodide) return;
    if (_initPromise) return _initPromise;

    const promise = (async () => {
      isLoading.value = true;
      store.clearLogs();
      store.addLog("S'està iniciant el procés de càrrega dels motors WASM...", 'info');

    try {
      // 1. Pyodide Initialization
      const pyIndexUrl = store.config.pyIndex.trim();
      store.addLog(`Carregant Pyodide Core des de ${pyIndexUrl}...`, 'info');
      
      if (!window.loadPyodide) {
        for (let i = 0; i < 30; i++) {
          if (window.loadPyodide) break;
          await new Promise(r => setTimeout(r, 300));
        }
        if (!window.loadPyodide) {
          throw new Error("El script de Pyodide no s'ha pogut carregar des del CDN o l'index.html.");
        }
      }
      
      _pyodide = await window.loadPyodide({ indexURL: pyIndexUrl });
      window._pyodide = _pyodide;
      store.addLog("Pyodide Core carregat correctament.", 'success');
      
      store.addLog("Carregant paquets Python (jinja2 + openpyxl)...", 'info');
      try {
        await _pyodide.loadPackage(["jinja2", "openpyxl"]);
      } catch (errPkg) {
        store.addLog("Carregant via micropip fallback...", 'info');
        await _pyodide.loadPackage(["jinja2", "micropip"]);
        await _pyodide.runPythonAsync(`
import micropip
try:
    await micropip.install('openpyxl')
except Exception:
    pass
        `);
      }
      store.addLog("Llibreries jinja2 i openpyxl carregades correctament en entorn Python.", 'success');

      // Injecting PyEngine logic
      store.addLog("S'està injectant la lògica de processament en Python...", 'info');
      await _pyodide.runPythonAsync(enginePyCode);
      store.addLog("Motor de dades Python vinculat correctament a Pyodide.", 'success');

      // 2. Pandoc WASM Initialization
      store.addLog("Inicialitzant motor Pandoc WASM...", 'info');
      await pandocModule.init(store.config.pandocWasmUrl);
      _pandoc = pandocModule;
      store.addLog("Mòdul de Pandoc integrat correctament.", 'success');
      
      try {
        const v = await _pandoc.query({ query: 'version' });
        store.addLog(`Pandoc WASM disponible. Versió del motor: ${v}`, 'success');
      } catch (e) {
        store.addLog("Pandoc WASM inicialitzat.", 'success');
      }

      // Write restored excel JSON data into virtual FS immediately on load
      ensureWorkDir();
      if (store.excelJsonData) {
        _pyodide.FS.writeFile('/work/in.json', new TextEncoder().encode(JSON.stringify(store.excelJsonData)));
        store.addLog("Dades de la sessió restaurada carregades en el sistema de fitxers de Pyodide.", 'info');
      }

      const pName = localStorage.getItem('currentProjectName') || 'Default';
      try {
        const buf = await getBinaryFile(`${pName}:excelFileBuffer`);
        if (buf) {
          _pyodide.FS.writeFile('/work/in.xlsx', new Uint8Array(buf));
        }
      } catch (_) {}

      store.enginesReady = true;
      store.addLog("Tots els motors WASM s'han carregat correctament.", 'success');

    } catch (e) {
      store.enginesReady = false;
      store.addLog(`Error de càrrega WASM: ${e.message}`, 'error');
      throw e;
    } finally {
      isLoading.value = false;
      _initPromise = null;
    }
  })();

  _initPromise = promise;
  return promise;
  };

  const ensureWorkDir = () => {
    try {
      _pyodide.FS.mkdir('/work');
    } catch (e) {
      // Ignorar si el directori ja existeix
    }
  };

  const writeVirtualExcel = (fileBuffer) => {
    if (!_pyodide) return;
    ensureWorkDir();
    _pyodide.FS.writeFile('/work/in.xlsx', new Uint8Array(fileBuffer));
  };

  const parseExcel = async (fileBuffer) => {
    if (!store.enginesReady || !_pyodide) {
      await initEngines();
    }
    if (!_pyodide) throw new Error("Pyodide no s'ha inicialitzat.");
    
    ensureWorkDir();
    
    // Clear any previous JSON cache before parsing the new Excel file
    try {
      _pyodide.FS.unlink('/work/in.json');
    } catch (_) {}
    
    _pyodide.FS.writeFile('/work/in.xlsx', new Uint8Array(fileBuffer));
    
    const fn = _pyodide.globals.get('render_json_text');
    const jsonStr = fn('/work/in.xlsx', store.config.dateFormat, store.config.strictMode);
    fn.destroy();
    
    store.rawPythonJsonStr = jsonStr;
    const parsed = JSON.parse(jsonStr);

    let parsedData = {};
    let parsedSchema = {};

    if (parsed && typeof parsed === 'object') {
      if (parsed.data && parsed.hierarchy_schema) {
        parsedData = parsed.data;
        parsedSchema = parsed.hierarchy_schema;
      } else {
        parsedData = parsed;
        if (parsedData._hierarchy_schema) {
          parsedSchema = parsedData._hierarchy_schema;
          delete parsedData._hierarchy_schema;
        }
      }
    }

    if (parsedData && parsedData._sheet_logs) {
      const logs = parsedData._sheet_logs;
      let logMsg = `📊 [RESUM DE DEPURACIÓ DE PESTANYES EXCEL]\n` +
                   `==================================================\n`;
      logs.forEach(s => {
        if (s.kind === 'omès') {
          logMsg += `▫️ Full "${s.name}": Omès (${s.reason})\n`;
        } else if (s.kind === 'error') {
          logMsg += `❌ Full "${s.name}": Error -> ${s.error}\n`;
        } else if (s.kind === 'tabular') {
          logMsg += `📋 Full "${s.name}": SÍ processat | Tipus: Tabular | ${s.cols} columnes | ${s.rows} files\n`;
        } else if (s.kind === 'kv') {
          logMsg += `🔑 Full "${s.name}": SÍ processat | Tipus: Clau/Valor (kv) | ${s.pairs} parelles clau/valor\n`;
        } else {
          logMsg += `ℹ️ Full "${s.name}": SÍ processat | Tipus: ${s.kind}\n`;
        }
      });
      store.addLog(logMsg, 'info');
      delete parsedData._sheet_logs;
    }

    if (parsedData && parsedData._excel_import_inspection) {
      store.excelImportInspection = parsedData._excel_import_inspection;
      delete parsedData._excel_import_inspection;
    }

    if (parsedData && parsedData.editor_metadata && Array.isArray(parsedData.editor_metadata)) {
      store.editorMetadata = parsedData.editor_metadata;
      delete parsedData.editor_metadata;
    }

    if (parsedData && parsedData._sheet_info && Array.isArray(parsedData._sheet_info)) {
      store.sheetInfo = parsedData._sheet_info;
      delete parsedData._sheet_info;
    }

    store.excelJsonData = parsedData;
    store.hierarchySchema = parsedSchema;

    const cleanedJsonStr = JSON.stringify(parsedData);
    
    // Save to in.json in Pyodide FS as well
    _pyodide.FS.writeFile('/work/in.json', new TextEncoder().encode(cleanedJsonStr));
    
    // Specific concise log for General / OUT_General tab requested by user
    const genData = parsedData.General || parsedData.OUT_General || null;
    if (genData) {
      store.addLog(`📄 [DADES PESTANYA General / OUT_General (Python Dict)]:\n${JSON.stringify(genData, null, 2)}`, 'info');
      store.addLog(`🐍 [JSON BRUT GENERAT PER A LA PESTANYA General / OUT_General]:\n${JSON.stringify(genData)}`, 'success');
    }

    if (parsedSchema && Object.keys(parsedSchema).length > 0) {
      store.addLog(`Esquema jeràrquic del llibre Excel (hierarchySchema):\n${JSON.stringify(parsedSchema, null, 2)}`, 'info');
    }
    
    return parsedData;
  };

  const renderMarkdown = async (templateText) => {
    if (!_pyodide) throw new Error("Pyodide no s'ha inicialitzat.");
    
    ensureWorkDir();
    _pyodide.FS.writeFile('/work/tpl.md.j2', new TextEncoder().encode(templateText));
    
    if (store.excelJsonData) {
      _pyodide.FS.writeFile('/work/in.json', new TextEncoder().encode(JSON.stringify(store.excelJsonData)));
    }
    
    // Check if original Excel exists in Pyodide FS
    let exists = false;
    try {
      _pyodide.FS.stat('/work/in.xlsx');
      exists = true;
    } catch (_) {}
    
    if (!exists && store.excelFile) {
      try {
        const buffer = await store.excelFile.arrayBuffer();
        _pyodide.FS.writeFile('/work/in.xlsx', new Uint8Array(buffer));
        exists = true;
      } catch (err) {
        store.addLog(`Error al restaurar fitxer Excel virtual: ${err.message}`, 'warning');
      }
    }

    if (!exists) {
      store.addLog("Sintetitzant fitxer Excel virtual (/work/in.xlsx) des de les dades del projecte...", "info");
      const pyCreateScript = `
import json
with open('/work/in.json', 'r', encoding='utf-8') as f:
    js_str = f.read()
create_default_workbook_from_json(js_str, '/work/in.xlsx')
orphan_count = update_excel_from_json('/work/in.xlsx', js_str, '/work/in.xlsx')
orphan_count
      `;
      const orphanCountCreate = await _pyodide.runPythonAsync(pyCreateScript);
      if (typeof orphanCountCreate === 'number' && orphanCountCreate > 0) {
        store.addLog("L'exportació a Excel ha trobat cel·les de destinació que contenien fórmules complexes. Per preservar la funcionalitat del full, els nous valors d'aquestes cel·les s'han desat al full 'orfes'.", "warning");
      }
    } else if (store.excelJsonData) {
      const pyUpdateScript = `
import json
with open('/work/in.json', 'r', encoding='utf-8') as f:
    js_str = f.read()
orphan_count = update_excel_from_json('/work/in.xlsx', js_str, '/work/in.xlsx')
orphan_count
      `;
      const orphanCountUpdate = await _pyodide.runPythonAsync(pyUpdateScript);
      if (typeof orphanCountUpdate === 'number' && orphanCountUpdate > 0) {
        store.addLog("L'exportació a Excel ha trobat cel·les de destinació que contenien fórmules complexes. Per preservar la funcionalitat del full, els nous valors d'aquestes cel·les s'han desat al full 'orfes'.", "warning");
      }
    }
    
    const fn = _pyodide.globals.get('render_md_two_pass_with_report');
    const payloadStr = fn('/work/in.xlsx', '/work/tpl.md.j2', store.config.dateFormat, store.config.strictMode);
    fn.destroy();
    
    return JSON.parse(payloadStr);
  };

  const compileDocx = async (markdownText, refDocBuffer, extraFilesMap) => {
    if (!_pandoc) throw new Error("Pandoc no s'ha inicialitzat.");
    
    const files = {};
    if (refDocBuffer) {
      files['reference.docx'] = new Blob([refDocBuffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    }
    
    for (const [name, buf] of Object.entries(extraFilesMap)) {
      files[name] = new Blob([buf], { type: 'application/octet-stream' });
    }
    
    const options = {
      from: 'markdown',
      to: 'docx',
      'output-file': store.outNameDocx,
      ...(refDocBuffer ? { 'reference-doc': 'reference.docx' } : {})
    };
    
    store.addLog("Compilant a Word (.docx) amb Pandoc...", 'info');
    const result = await _pandoc.convert(options, markdownText, files);
    
    if (result.stderr) {
      store.addLog(`Advertència de Pandoc: ${result.stderr}`, 'warning');
    }
    
    const outBlob = files[store.outNameDocx] || files['/stdout'] || files['stdout'];
    if (!outBlob) throw new Error("Pandoc no ha retornat cap document Word de sortida.");
    
    return outBlob instanceof Blob ? outBlob : new Blob([outBlob], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  };

  const saveExcelData = async (jsonData) => {
    if (!_pyodide) throw new Error("Pyodide no s'ha inicialitzat.");
    
    ensureWorkDir();
    
    // Write JSON to virtual FS
    let dataToSave = jsonData || store.excelJsonData || {};
    try {
      dataToSave = JSON.parse(JSON.stringify(dataToSave));
    } catch (_) {}

    if (store.editorMetadata && Array.isArray(store.editorMetadata) && store.editorMetadata.length > 0) {
      dataToSave.editor_metadata = store.editorMetadata;
    }
    if (store.sheetInfo && Array.isArray(store.sheetInfo) && store.sheetInfo.length > 0) {
      dataToSave._sheet_info = store.sheetInfo;
    }

    const jsonStr = JSON.stringify(dataToSave);
    _pyodide.FS.writeFile('/work/in.json', new TextEncoder().encode(jsonStr));
    
    // Check if original Excel exists
    let exists = false;
    try {
      _pyodide.FS.stat('/work/in.xlsx');
      exists = true;
    } catch (_) {}
    
    // Restore on-the-fly if missing but available in store
    if (!exists && store.excelFile) {
      try {
        const buffer = await store.excelFile.arrayBuffer();
        _pyodide.FS.writeFile('/work/in.xlsx', new Uint8Array(buffer));
        exists = true;
      } catch (err) {
        store.addLog(`Error al restaurar fitxer Excel virtual: ${err.message}`, 'warning');
      }
    }
    
    // If original Excel file is missing, synthesize a fresh Excel workbook from JSON on-the-fly!
    if (!exists) {
      store.addLog("Generant plantilla Excel (.xlsx) automàticament des de les dades del projecte...", "info");
      const pyCreateScript = `
import json
with open('/work/in.json', 'r', encoding='utf-8') as f:
    js_str = f.read()
create_default_workbook_from_json(js_str, '/work/in.xlsx')
      `;
      await _pyodide.runPythonAsync(pyCreateScript);
    }
    
    // Run python script to update Excel
    const pyScript = `
import json
with open('/work/in.json', 'r', encoding='utf-8') as f:
    js_str = f.read()
orphan_count = update_excel_from_json('/work/in.xlsx', js_str, '/work/out.xlsx')
orphan_count
    `;
    const orphanCount = await _pyodide.runPythonAsync(pyScript);
    if (typeof orphanCount === 'number' && orphanCount > 0) {
      store.addLog("L'exportació a Excel ha trobat cel·les de destinació que contenien fórmules complexes. Per preservar la funcionalitat del full, els nous valors d'aquestes cel·les s'han desat al full 'orfes'.", "warning");
    }
    
    // Read the updated Excel file from Pyodide virtual FS
    const excelBytes = _pyodide.FS.readFile('/work/out.xlsx');
    try {
      _pyodide.FS.writeFile('/work/in.xlsx', excelBytes);
    } catch (_) {}

    try {
      const pName = store.currentProjectName || localStorage.getItem('currentProjectName') || 'Default';
      const fileName = store.excelFileName || `${pName}.xlsx`;
      store.excelFileName = fileName;
      store.excelFile = new File([excelBytes], fileName, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      await saveBinaryFile(`${pName}:excelFileBuffer`, excelBytes.buffer);

      if (store.excelJsonData) {
        localStorage.setItem(`${pName}:excelJsonData`, JSON.stringify(store.excelJsonData));
      }
      if (store.editorMetadata) {
        localStorage.setItem(`${pName}:editorMetadata`, JSON.stringify(store.editorMetadata));
      }
      if (store.sheetInfo) {
        localStorage.setItem(`${pName}:sheetInfo`, JSON.stringify(store.sheetInfo));
      }
    } catch (e) {
      console.warn("Error desant el fitxer Excel a IndexedDB/localStorage:", e);
    }

    return new Blob([excelBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  };

  const hydrateModelWithForeignKeys = (rootData, editorMetadata) => {
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

    const resolveTargetTable = (targetPath) => {
      if (!targetPath) return null;
      if (Array.isArray(rootData[targetPath])) return rootData[targetPath];
      if (Array.isArray(rootData['OUT_' + targetPath])) return rootData['OUT_' + targetPath];
      const parts = targetPath.replace(/^doc\.|^dades\./, '').split('.');
      let curr = rootData;
      for (const p of parts) {
        if (curr && typeof curr === 'object') {
          curr = curr[p];
        } else {
          return null;
        }
      }
      return Array.isArray(curr) ? curr : null;
    };

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
          const targetTable = resolveTargetTable(meta.vectorPath);
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

        if (val && typeof val === 'object' && !val.toString) {
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
  };

  /**
   * Evaluates every calculated field in `dataObj` (row-level CUSTOM formulas,
   * then SUM/COUNT/AVERAGE/MIN/MAX/OR/AND aggregations) by delegating the
   * actual computation to Python's evaluate_computed_fields (src/python/engine.py),
   * which runs inside Pyodide's WASM sandbox instead of via a JS `new Function(...)`
   * in the page's own execution context. Mutates dataObj in place (so Vue's
   * reactivity keeps targeting the same objects/arrays) and returns it.
   *
   * Foreign-key hydration of dynamic Select fields (turning a scalar into a
   * rich object for display) stays in JS via hydrateModelWithForeignKeys: it's
   * a data-shape transformation, not calculation, so it runs first, in place,
   * exactly as before this was split across languages.
   */
  const evaluateComputedFields = (dataObj, metadataList = [], debugMode = store.debugComputedFields) => {
    if (!dataObj || typeof dataObj !== 'object') return dataObj;
    const metadata = metadataList.length > 0 ? metadataList : (dataObj.editor_metadata || store.editorMetadata || []);

    const computedMetas = metadata.filter(m =>
      m.isCalculated === true ||
      m.type === 'Computed' ||
      m.sourceType === 'computed' ||
      (m.calcFn && m.calcFn !== '' && m.calcFn !== 'NONE') ||
      (m.calcFormula && m.calcFormula.trim() !== '')
    );

    if (computedMetas.length === 0) {
      if (debugMode) {
        store.addLog(`🧮 [DEPURACIÓ CAMPS CALCULATS] No s'ha trobat cap camp marcat com a calculat (editor_metadata té ${metadata.length} metadades en total).`, 'warning');
      }
      return dataObj;
    }

    if (!_pyodide) {
      // Engines not ready yet (e.g. very first render before Pyodide loads):
      // skip silently, a later edit/save will trigger recomputation once ready.
      return dataObj;
    }

    const data = hydrateModelWithForeignKeys(dataObj, metadata);

    const fn = _pyodide.globals.get('evaluate_computed_fields');
    let resultStr;
    try {
      resultStr = fn(JSON.stringify(data), JSON.stringify(metadata), debugMode);
    } finally {
      fn.destroy();
    }

    let result;
    try {
      result = JSON.parse(resultStr);
    } catch (e) {
      store.addLog(`Error interpretant el resultat del motor de càlcul: ${e.message}`, 'error');
      return dataObj;
    }

    if (!result.success) {
      store.addLog(`Error avaluant camps calculats: ${result.error}`, 'error');
      return dataObj;
    }

    if (debugMode && Array.isArray(result.logs)) {
      result.logs.forEach(msg => {
        const level = msg.startsWith('⚠️') ? 'warning' : (msg.startsWith('✨') || msg.startsWith('📊') ? 'success' : 'info');
        store.addLog(msg, level);
      });
    }

    mergeComputedValuesInPlace(data, result.data);

    return dataObj;
  };

  /**
   * Copies leaf values from `source` into `target` in place, recursing through
   * parallel object/array structures (never replacing an intermediate object
   * or array's own identity) — so Vue's reactivity keeps tracking the same
   * refs a bound <input> is reading, instead of losing focus/cursor position
   * when a computed field elsewhere in the form updates.
   */
  const mergeComputedValuesInPlace = (target, source) => {
    if (Array.isArray(target) && Array.isArray(source)) {
      if (target.length !== source.length) return;
      for (let i = 0; i < target.length; i++) {
        mergeComputedValuesInPlace(target[i], source[i]);
      }
      return;
    }
    if (target && source && typeof target === 'object' && typeof source === 'object' && !Array.isArray(target) && !Array.isArray(source)) {
      Object.keys(source).forEach(k => {
        const sVal = source[k];
        const tVal = target[k];
        if (sVal && typeof sVal === 'object') {
          if (tVal && typeof tVal === 'object') {
            mergeComputedValuesInPlace(tVal, sVal);
          } else {
            target[k] = sVal;
          }
        } else if (tVal !== sVal) {
          target[k] = sVal;
        }
      });
    }
  };


  const saveExcelHierarchy = async (renamesMap) => {
    if (!_pyodide) throw new Error("Pyodide no està disponible.");
    const pName = store.currentProjectName || localStorage.getItem('currentProjectName') || 'Default';
    const buffer = await getBinaryFile(`${pName}:excelFileBuffer`);
    if (!buffer) throw new Error("No s'ha trobat el fitxer Excel a l'emmagatzematge local.");

    ensureWorkDir();
    _pyodide.FS.writeFile('/work/in.xlsx', new Uint8Array(buffer));
    const jsonConfig = JSON.stringify(renamesMap);

    const fn = _pyodide.globals.get('update_excel_hierarchy');
    fn('/work/in.xlsx', jsonConfig, '/work/out_hierarchy.xlsx');
    fn.destroy();

    const newBytes = _pyodide.FS.readFile('/work/out_hierarchy.xlsx');
    const newBuffer = newBytes.buffer;

    // Save updated ArrayBuffer back into IndexedDB & update store.excelFile
    await saveBinaryFile(`${pName}:excelFileBuffer`, newBuffer);
    const fileName = store.excelFileName || `${pName}.xlsx`;
    store.excelFile = new File([newBytes], fileName, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    store.excelFileSize = newBuffer.byteLength;

    // Re-parse the updated Excel file structure while preserving loaded data values
    const currentJsonData = store.excelJsonData ? JSON.parse(JSON.stringify(store.excelJsonData)) : {};
    const parsedData = await parseExcel(newBuffer);
    
    if (parsedData && typeof parsedData === 'object') {
      Object.keys(currentJsonData).forEach(key => {
        if (!key.startsWith('_') && currentJsonData[key] !== undefined) {
          parsedData[key] = currentJsonData[key];
        }
      });
    }

    store.excelJsonData = parsedData;

    store.addLog("Esquema de relacions i jerarquia d'Excel actualitzat correctament al full de càlcul.", "success");
    return parsedData;
  };

  return {
    initEngines,
    parseExcel,
    renderMarkdown,
    compileDocx,
    saveExcelData,
    saveExcelHierarchy,
    evaluateComputedFields,
    writeVirtualExcel,
    isLoading
  };
}
