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

  const evaluateCustomFormula = (formulaStr, row, globalData = null) => {
    if (!formulaStr || typeof formulaStr !== 'string') return 0;
    try {
      let expr = formulaStr.trim();

      // 1. Transform SI(...) or IF(...) into JS ternary operators
      const transformIf = (str) => {
        let prev = '';
        while (prev !== str) {
          prev = str;
          const regex = /\b(SI|IF)\s*\(/i;
          const match = regex.exec(str);
          if (!match) break;

          const startIdx = match.index;
          const openParenIdx = startIdx + match[0].length - 1;
          let depth = 1;
          let endIdx = -1;
          let inQuotes = false;
          let quoteChar = '';

          for (let i = openParenIdx + 1; i < str.length; i++) {
            const ch = str[i];
            if (inQuotes) {
              if (ch === quoteChar) inQuotes = false;
            } else if (ch === '"' || ch === "'") {
              inQuotes = true;
              quoteChar = ch;
            } else if (ch === '(') {
              depth++;
            } else if (ch === ')') {
              depth--;
              if (depth === 0) {
                endIdx = i;
                break;
              }
            }
          }

          if (endIdx === -1) break;

          const fullMatch = str.substring(startIdx, endIdx + 1);
          const argsStr = str.substring(openParenIdx + 1, endIdx);

          const parts = [];
          let current = '';
          depth = 0;
          inQuotes = false;

          for (let i = 0; i < argsStr.length; i++) {
            const ch = argsStr[i];
            if (inQuotes) {
              if (ch === quoteChar) inQuotes = false;
              current += ch;
            } else if (ch === '"' || ch === "'") {
              inQuotes = true;
              quoteChar = ch;
              current += ch;
            } else if (ch === '(') {
              depth++;
              current += ch;
            } else if (ch === ')') {
              depth--;
              current += ch;
            } else if ((ch === ';' || ch === ',') && depth === 0) {
              parts.push(current.trim());
              current = '';
            } else {
              current += ch;
            }
          }
          parts.push(current.trim());

          if (parts.length >= 3) {
            const cond = parts[0];
            const tVal = parts[1];
            const fVal = parts.slice(2).join(';');
            const ternary = `( (${cond}) ? (${tVal}) : (${fVal}) )`;
            str = str.replace(fullMatch, ternary);
          } else {
            break;
          }
        }
        return str;
      };

      // 2. Transform ARRODONEIX(...) / ROUND(...) into __round(...)
      const transformRound = (str) => {
        let prev = '';
        while (prev !== str) {
          prev = str;
          const regex = /\b(ARRODONEIX|ROUND)\s*\(/i;
          const match = regex.exec(str);
          if (!match) break;

          const startIdx = match.index;
          const openParenIdx = startIdx + match[0].length - 1;
          let depth = 1;
          let endIdx = -1;
          let inQuotes = false;
          let quoteChar = '';

          for (let i = openParenIdx + 1; i < str.length; i++) {
            const ch = str[i];
            if (inQuotes) {
              if (ch === quoteChar) inQuotes = false;
            } else if (ch === '"' || ch === "'") {
              inQuotes = true;
              quoteChar = ch;
            } else if (ch === '(') {
              depth++;
            } else if (ch === ')') {
              depth--;
              if (depth === 0) {
                endIdx = i;
                break;
              }
            }
          }

          if (endIdx === -1) break;

          const fullMatch = str.substring(startIdx, endIdx + 1);
          const argsStr = str.substring(openParenIdx + 1, endIdx);

          const parts = [];
          let current = '';
          depth = 0;
          inQuotes = false;

          for (let i = 0; i < argsStr.length; i++) {
            const ch = argsStr[i];
            if (inQuotes) {
              if (ch === quoteChar) inQuotes = false;
              current += ch;
            } else if (ch === '"' || ch === "'") {
              inQuotes = true;
              quoteChar = ch;
              current += ch;
            } else if (ch === '(') {
              depth++;
              current += ch;
            } else if (ch === ')') {
              depth--;
              current += ch;
            } else if ((ch === ';' || ch === ',') && depth === 0) {
              parts.push(current.trim());
              current = '';
            } else {
              current += ch;
            }
          }
          parts.push(current.trim());

          const valExpr = parts[0] || '0';
          const precExpr = parts[1] !== undefined ? parts[1] : '0';
          const roundCall = `__round(${valExpr}, ${precExpr})`;
          str = str.replace(fullMatch, roundCall);
        }
        return str;
      };

      // 2. Transform OR(...) and AND(...) aggregated functions on vectors/arrays
      const transformOrAnd = (str) => {
        let prev = '';
        while (prev !== str) {
          prev = str;
          const regex = /\b(OR|O|AND|I|ANY|SOME|EVERY|ALL)\s*\(/i;
          const match = regex.exec(str);
          if (!match) break;

          const startIdx = match.index;
          const openParenIdx = startIdx + match[0].length - 1;
          let depth = 1;
          let endIdx = -1;
          let inQuotes = false;
          let quoteChar = '';

          for (let i = openParenIdx + 1; i < str.length; i++) {
            const ch = str[i];
            if (inQuotes) {
              if (ch === quoteChar) inQuotes = false;
            } else if (ch === '"' || ch === "'") {
              inQuotes = true;
              quoteChar = ch;
            } else if (ch === '(') {
              depth++;
            } else if (ch === ')') {
              depth--;
              if (depth === 0) {
                endIdx = i;
                break;
              }
            }
          }

          if (endIdx === -1) break;

          const fnName = match[1].toUpperCase();
          const fullMatch = str.substring(startIdx, endIdx + 1);
          const argStr = str.substring(openParenIdx + 1, endIdx).trim();

          if (['OR', 'O', 'ANY', 'SOME'].includes(fnName)) {
            str = str.replace(fullMatch, `__or("${argStr.replace(/"/g, '\\"')}")`);
          } else if (['AND', 'I', 'EVERY', 'ALL'].includes(fnName)) {
            str = str.replace(fullMatch, `__and("${argStr.replace(/"/g, '\\"')}")`);
          } else {
            break;
          }
        }
        return str;
      };

      // 3. Transform CERT(...) and FALS(...) into JS helper calls
      const transformCertFals = (str) => {
        let exprStr = str;
        exprStr = exprStr.replace(/\b(CERT|is_cert)\s*\(/gi, '__is_cert(');
        exprStr = exprStr.replace(/\b(FALS|is_fals)\s*\(/gi, '__is_fals(');
        return exprStr;
      };

      expr = transformIf(expr);
      expr = transformRound(expr);
      expr = transformOrAnd(expr);
      expr = transformCertFals(expr);

      // 4. Math replacements
      expr = expr.replace(/\bABS\s*\(/gi, 'Math.abs(');
      expr = expr.replace(/(^|[^<>=!])=([^=])/g, '$1==$2');
      expr = expr.replace(/<>/g, '!=');
      expr = expr.replace(/\^/g, '**');

      // 5. Value Resolution Context Helper
      const parseNumOrString = (rawVal) => {
        if (typeof rawVal === 'number') return rawVal;
        if (typeof rawVal === 'boolean') return rawVal;
        if (typeof rawVal === 'string') {
          if (rawVal.trim() === '') return 0;
          const parsed = parseFloat(rawVal.replace(',', '.'));
          return isNaN(parsed) ? `"${rawVal.replace(/"/g, '\\"')}"` : parsed;
        }
        return 0;
      };

      const getNestedValue = (obj, parts) => {
        let current = obj;
        for (let i = 0; i < parts.length; i++) {
          if (current === undefined || current === null) return undefined;
          const part = parts[i];

          const arrayMatch = part.match(/^([a-zA-Z0-9_]+)\[(\d+)\]$/);
          if (arrayMatch) {
            const arrKey = arrayMatch[1];
            const index = parseInt(arrayMatch[2], 10);
            current = current[arrKey];
            if (Array.isArray(current)) {
              current = current[index];
            } else {
              return undefined;
            }
          } else if (Array.isArray(current)) {
            const prop = part;
            const nums = current.map(item => item ? parseFloat(item[prop]) : NaN).filter(n => !isNaN(n));
            return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : 0;
          } else if (typeof current === 'object' && current !== null) {
            current = current[part];
          } else if (typeof current === 'string' || typeof current === 'number') {
            // Fallback: If current is a scalar FK value (e.g. "Tova"), attempt to lookup in global tables for matching row
            const gData = globalData || store.excelJsonData;
            let foundVal = undefined;
            if (gData) {
              for (const sheetKey of Object.keys(gData)) {
                const table = gData[sheetKey];
                if (Array.isArray(table)) {
                  const matchRow = table.find(r => r && typeof r === 'object' && Object.values(r).some(v => String(v) === String(current)));
                  if (matchRow && matchRow[part] !== undefined) {
                    foundVal = matchRow[part];
                    break;
                  }
                }
              }
            }
            if (foundVal !== undefined) {
              current = foundVal;
            } else {
              return undefined;
            }
          } else {
            return undefined;
          }
        }
        return current;
      };

      const resolveValue = (pathStr) => {
        if (!pathStr) return undefined;
        if (row && row[pathStr] !== undefined) {
          return parseNumOrString(row[pathStr]);
        }
        let cleanPath = pathStr.replace(/^(doc|dades)\./i, '');
        const pathParts = cleanPath.split('.').filter(Boolean);

        let val = getNestedValue(row, pathParts);
        if (val !== undefined) return parseNumOrString(val);

        const gData = globalData || store.excelJsonData;
        if (gData) {
          val = getNestedValue(gData, pathParts);
          if (val === undefined && pathParts.length > 0) {
            const prefixedParts = ['OUT_' + pathParts[0], ...pathParts.slice(1)];
            val = getNestedValue(gData, prefixedParts);
          }
          if (val !== undefined) return parseNumOrString(val);
        }
        return undefined;
      };

      // 6. Extract and replace all tokens/paths in formula
      const tokenRegex = /\b(?:[a-zA-Z_][a-zA-Z0-9_]*|doc\.[a-zA-Z0-9_.]+|dades\.[a-zA-Z0-9_.]+)(?:\[\d+\])?(?:\.[a-zA-Z_][a-zA-Z0-9_.]*(?:\[\d+\])?)*\b/g;
      const reservedKeywords = new Set([
        'SI', 'IF', 'ARRODONEIX', 'ROUND', 'ABS', 'MIN', 'MAX', 'OR', 'O', 'AND', 'I', 'ANY', 'SOME', 'EVERY', 'ALL', 'Math', '__round', '__or', '__and',
        'CERT', 'FALS', 'cert', 'fals', 'is_cert', 'is_fals', '__is_cert', '__is_fals',
        'true', 'false', 'null', 'undefined', 'doc', 'dades', 'return', 'function'
      ]);

      const foundTokens = new Set();
      let match;
      while ((match = tokenRegex.exec(expr)) !== null) {
        const t = match[0];
        if (!reservedKeywords.has(t) && !reservedKeywords.has(t.toUpperCase())) {
          foundTokens.add(t);
        }
      }

      const sortedTokens = Array.from(foundTokens).sort((a, b) => b.length - a.length);

      sortedTokens.forEach(t => {
        const resolvedVal = resolveValue(t);
        if (resolvedVal !== undefined) {
          const escapedToken = t.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
          const varRegex = new RegExp(`\\b${escapedToken}\\b`, 'g');
          expr = expr.replace(varRegex, typeof resolvedVal === 'string' ? resolvedVal : `(${resolvedVal})`);
        }
      });

      const __is_cert = (val) => {
        if (val === undefined || val === null || val === false || val === '' || val === 0 || val === 0.0 || val === '0' || val === '0.0') {
          return false;
        }
        if (typeof val === 'string') {
          const s = val.trim().toUpperCase();
          if (['NO', 'FALS', 'FALSE', '0', '0.0', 'N', 'OFF', 'DESACTIVAT'].includes(s)) {
            return false;
          }
        }
        return true;
      };
      const __is_fals = (val) => !__is_cert(val);

      const evalOrAndFn = (pathStr, mode) => {
        if (!pathStr) return false;
        let cleanPath = pathStr.trim().replace(/^['"]|['"]$/g, '').replace(/^(doc|dades)\./i, '');
        const parts = cleanPath.split('.').filter(Boolean);
        if (parts.length === 0) return false;

        const gData = globalData || store.excelJsonData;

        const collectValues = (startObj) => {
          if (!startObj || typeof startObj !== 'object') return null;
          let current = startObj;
          for (let i = 0; i < parts.length; i++) {
            if (current === undefined || current === null) return null;
            const part = parts[i];
            if (Array.isArray(current)) {
              const remainingProp = parts.slice(i).join('.');
              return current.map(item => {
                if (!item || typeof item !== 'object') return item;
                const propParts = remainingProp.split('.');
                let sub = item;
                for (const p of propParts) {
                  if (sub === undefined || sub === null) return undefined;
                  sub = sub[p];
                }
                return sub;
              });
            }
            current = current[part];
          }
          if (Array.isArray(current)) return current;
          return [current];
        };

        let list = collectValues(row);
        if ((!list || list.length === 0) && gData) {
          list = collectValues(gData);
          if ((!list || list.length === 0) && parts.length > 0) {
            const sheetKey = parts[0];
            if (gData['OUT_' + sheetKey]) {
              list = collectValues({ ['OUT_' + sheetKey]: gData['OUT_' + sheetKey] });
            }
          }
        }

        if (!list || !Array.isArray(list)) list = [];

        const extractBoolVal = (val) => {
          if (val === undefined || val === null || val === false || val === 0 || val === '0' || val === '' || val === '0.0') return false;
          if (typeof val === 'boolean') return val;
          if (typeof val === 'number') return val !== 0;
          if (typeof val === 'string') {
            const s = val.trim().toLowerCase();
            return ['true', '1', 'si', 'sí', 'cert', 'yes'].includes(s);
          }
          return Boolean(val);
        };

        if (mode === 'OR') {
          return list.some(extractBoolVal);
        } else {
          return list.length > 0 && list.every(extractBoolVal);
        }
      };

      const __or = (arg) => evalOrAndFn(String(arg), 'OR');
      const __and = (arg) => evalOrAndFn(String(arg), 'AND');

      const safeEval = new Function('__round', '__is_cert', '__is_fals', '__or', '__and', 'CERT', 'FALS', 'cert', 'fals', `"use strict"; return (${expr});`);
      const __round = (val, prec = 0) => {
        const p = Math.pow(10, prec);
        return Math.round(parseFloat(val) * p) / p;
      };

      const result = safeEval(__round, __is_cert, __is_fals, __or, __and, __is_cert, __is_fals, __is_cert, __is_fals);

      if (typeof result === 'number' && !isNaN(result) && isFinite(result)) {
        return Math.round(result * 1000000) / 1000000;
      } else if (typeof result === 'boolean') {
        return result;
          } else if (result !== undefined && result !== null) {
        return String(result);
      }
      return 0;
    } catch (err) {
      return row[formulaStr] !== undefined ? row[formulaStr] : 0;
    }
  };

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

    if (debugMode) {
      if (computedMetas.length === 0) {
        store.addLog(`🧮 [DEPURACIÓ CAMPS CALCULATS] No s'ha trobat cap camp marcat com a calculat (editor_metadata té ${metadata.length} metadades en total).`, 'warning');
      } else {
        store.addLog(`🧮 [DEPURACIÓ CAMPS CALCULATS] Detectats ${computedMetas.length} camps calculats:\n` +
          computedMetas.map(m => `  • [Grup: ${m.group || 'global'} | Camp: ${m.element}] Tipus: ${m.calcFn || 'CUSTOM'} | Fórmula/Vector: "${m.calcFormula || m.calcVector || ''}"`).join('\n'),
          'info'
        );
      }
    }

    if (computedMetas.length === 0) return dataObj;

    const data = hydrateModelWithForeignKeys(dataObj, metadata);

    const isCustomFn = (fn, formula) => {
      if (formula && formula.trim()) return true;
      const upper = (fn || '').toUpperCase();
      return upper === 'CUSTOM' || upper === 'FORMULA' || upper === '' || upper === 'NONE';
    };

    const isGroupMatch = (metaGroup, hint) => {
      if (!metaGroup) return true;
      if (!hint) return false;
      const cleanM = metaGroup.replace(/^OUT_/, '').toLowerCase();
      const cleanH = hint.replace(/^OUT_/, '').toLowerCase();
      if (cleanM === cleanH) return true;

      const gShort = cleanM.split('.').pop();
      const hShort = cleanH.split('.').pop();
      if (gShort === hShort) return true;

      const rootHints = ['doc', 'dades', 'global', 'header', 'general', 'presupost', 'pressupost', 'resum', 'summary', 'root', 'main', ''];
      if (rootHints.includes(cleanH) && rootHints.includes(cleanM)) return true;

      return false;
    };

    const customMetas = computedMetas.filter(m => isCustomFn(m.calcFn, m.calcFormula) && m.calcFormula);
    const aggMetas = computedMetas.filter(m => !isCustomFn(m.calcFn, m.calcFormula));

    // Helper to evaluate CUSTOM formulas on a container (bottom-up)
    const runCustomPass = (container, groupHint = '', visited = new Set()) => {
      if (!container || typeof container !== 'object') return;
      if (visited.has(container)) return;
      visited.add(container);

      if (Array.isArray(container)) {
        container.forEach(item => runCustomPass(item, groupHint, visited));
        return;
      }

      // First recurse into child objects/arrays (bottom-up)
      Object.keys(container).forEach(k => {
        if (k !== '_sheet_info' && k !== '_hierarchy_schema' && k !== 'editor_metadata') {
          const val = container[k];
          if (val && typeof val === 'object') {
            runCustomPass(val, Array.isArray(val) ? k : groupHint, visited);
          }
        }
      });

      // Evaluate CUSTOM formulas for this node
      customMetas.forEach(meta => {
        if (isGroupMatch(meta.group, groupHint)) {
          const calculatedVal = evaluateCustomFormula(meta.calcFormula, container, data);
          if (calculatedVal !== undefined && calculatedVal !== null) {
            const oldVal = container[meta.element];
            container[meta.element] = calculatedVal;
            if (debugMode) {
              store.addLog(`✨ [CÀLCUL CUSTOM] ${meta.group || groupHint}.${meta.element} = ${calculatedVal} (Fórmula: "${meta.calcFormula}", Anterior: ${oldVal})`, 'success');
            }
          }
        }
      });
    };

    // Helper to evaluate Aggregation (SUM, COUNT, AVG) formulas on a container (bottom-up)
    const runAggPass = (container, groupHint = '', visited = new Set()) => {
      if (!container || typeof container !== 'object') return;
      if (visited.has(container)) return;
      visited.add(container);

      if (Array.isArray(container)) {
        container.forEach(item => runAggPass(item, groupHint, visited));
        return;
      }

      // First recurse into child objects/arrays (bottom-up)
      Object.keys(container).forEach(k => {
        if (k !== '_sheet_info' && k !== '_hierarchy_schema' && k !== 'editor_metadata') {
          const val = container[k];
          if (val && typeof val === 'object') {
            runAggPass(val, Array.isArray(val) ? k : groupHint, visited);
          }
        }
      });

      // Evaluate Aggregation formulas for this node
      aggMetas.forEach(meta => {
        const targetVec = meta.calcVector;
        const fn = (meta.calcFn || 'SUM').toUpperCase();
        const col = meta.calcTargetCol;

        if (isGroupMatch(meta.group, groupHint) || (targetVec && container[targetVec])) {
          let childList = null;
          if (targetVec && Array.isArray(container[targetVec])) {
            childList = container[targetVec];
          } else if (targetVec && data[targetVec] && Array.isArray(data[targetVec])) {
            childList = data[targetVec];
          } else if (targetVec) {
            // Search recursively for targetVec in container (safely guarded against infinite loops)
            const findSubList = (obj, subVisited = new Set(), depth = 0) => {
              if (!obj || typeof obj !== 'object' || childList || depth > 5) return;
              if (subVisited.has(obj)) return;
              subVisited.add(obj);

              if (Array.isArray(obj[targetVec])) {
                childList = obj[targetVec];
                return;
              }
              Object.values(obj).forEach(val => {
                if (val && typeof val === 'object') findSubList(val, subVisited, depth + 1);
              });
            };
            findSubList(container);
          }

          if (childList) {
            let calculatedVal = 0;

            const extractVal = (child) => {
              if (child === null || child === undefined) return 0;
              if (typeof child === 'object') {
                if (col && child[col] !== undefined) {
                  const v = parseFloat(child[col]);
                  return isNaN(v) ? 0 : v;
                }
                // Fallback: find first numeric property if col is empty
                const firstNumKey = Object.keys(child).find(k => !k.startsWith('_') && !isNaN(parseFloat(child[k])));
                if (firstNumKey) {
                  const v = parseFloat(child[firstNumKey]);
                  return isNaN(v) ? 0 : v;
                }
                return 0;
              }
              const v = parseFloat(child);
              return isNaN(v) ? 0 : v;
            };

            const extractBool = (child) => {
              if (child === null || child === undefined) return false;
              let val = child;
              if (typeof child === 'object') {
                if (col && child[col] !== undefined) {
                  val = child[col];
                } else {
                  const firstBoolKey = Object.keys(child).find(k => !k.startsWith('_'));
                  if (firstBoolKey) val = child[firstBoolKey];
                }
              }
              if (typeof val === 'boolean') return val;
              if (typeof val === 'number') return val !== 0;
              if (typeof val === 'string') {
                const clean = val.trim().toLowerCase();
                return ['true', '1', 'si', 'sí', 'cert', 'yes'].includes(clean);
              }
              return Boolean(val);
            };

            if (fn === 'COUNT') {
              calculatedVal = childList.length;
            } else if (fn === 'SUM') {
              const total = childList.reduce((sum, child) => sum + extractVal(child), 0);
              calculatedVal = Math.round(total * 1000000) / 1000000;
            } else if (fn === 'AVG' || fn === 'AVERAGE') {
              const numbers = childList.map(extractVal);
              const avg = numbers.length > 0 ? numbers.reduce((a, b) => a + b, 0) / numbers.length : 0;
              calculatedVal = Math.round(avg * 1000000) / 1000000;
            } else if (fn === 'MIN') {
              const numbers = childList.map(extractVal);
              calculatedVal = numbers.length > 0 ? Math.min(...numbers) : 0;
            } else if (fn === 'MAX') {
              const numbers = childList.map(extractVal);
              calculatedVal = numbers.length > 0 ? Math.max(...numbers) : 0;
            } else if (fn === 'OR' || fn === 'O' || fn === 'SOME' || fn === 'ANY') {
              calculatedVal = childList.some(extractBool);
            } else if (fn === 'AND' || fn === 'I' || fn === 'EVERY' || fn === 'ALL') {
              calculatedVal = childList.length > 0 && childList.every(extractBool);
            }

            const oldVal = container[meta.element];
            container[meta.element] = calculatedVal;
            if (debugMode) {
              store.addLog(`📊 [CÀLCUL AGREGACIÓ] ${meta.group || groupHint}.${meta.element} = ${calculatedVal} (${fn} de '${targetVec}' [${childList.length} elements], Anterior: ${oldVal})`, 'success');
            }
          } else if (debugMode) {
            store.addLog(`⚠️ [CÀLCUL AGREGACIÓ] No s'ha trobat la llista '${targetVec}' per calcular ${meta.element}.`, 'warning');
          }
        }
      });
    };

    // PHASE 1: Run CUSTOM formulas across all sheets & sub-tables (bottom-up)
    Object.keys(data).forEach(key => {
      if (key !== '_sheet_info' && key !== '_hierarchy_schema' && key !== 'editor_metadata') {
        runCustomPass(data[key], key);
      }
    });

    // PHASE 2: Run SUM/COUNT/AVG aggregations across all sheets & sub-tables (bottom-up)
    Object.keys(data).forEach(key => {
      if (key !== '_sheet_info' && key !== '_hierarchy_schema' && key !== 'editor_metadata') {
        runAggPass(data[key], key);
      }
    });
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
