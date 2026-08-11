import { ref } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import * as pandocModule from '../vendor/pandoc/pandoc.js';
import { saveBinaryFile, getBinaryFile } from '../utils/db';

// Save WebAssembly engine instances outside vue reactiveness scope for speed
let _pyodide = null;
let _pandoc = null;

export function useWasmEngines() {
  const store = useWorkspaceStore();
  const isLoading = ref(false);

  const initEngines = async () => {
    if (store.enginesReady) return;
    isLoading.value = true;
    store.clearLogs();
    store.addLog("S'està iniciant el procés de càrrega dels motors WASM...", 'info');

    try {
      // 1. Pyodide Initialization
      const pyIndexUrl = store.config.pyIndex.trim();
      store.addLog(`Carregant Pyodide Core des de ${pyIndexUrl}...`, 'info');
      
      if (!window.loadPyodide) {
        throw new Error("El script de Pyodide no està carregat a l'index.html.");
      }
      
      _pyodide = await window.loadPyodide({ indexURL: pyIndexUrl });
      store.addLog("Pyodide Core carregat correctament.", 'success');
      
      store.addLog("Instal·lant llibreria micropip per gestionar dependències...", 'info');
      await _pyodide.loadPackage("micropip");
      
      store.addLog("Instal·lant dependències en segon pla (jinja2 + openpyxl)...", 'info');
      await _pyodide.runPythonAsync(`
import micropip
await micropip.install(['jinja2', 'openpyxl'])
print('Instal·lació de dependències completada')
      `);
      store.addLog("Llibreries jinja2 i openpyxl disponibles en entorn Python.", 'success');

      // Injecting PyEngine logic
      store.addLog("S'està injectant la lògica de processament en Python...", 'info');
      const pyCode = `
import re
import json
import os
from datetime import datetime, date
from collections import defaultdict
from decimal import Decimal

from openpyxl import load_workbook
from jinja2 import Environment, StrictUndefined, DebugUndefined, Undefined, pass_context
from jinja2.exceptions import UndefinedError, TemplateSyntaxError

def sanitize_empty_jinja_tags(src):
    if not src:
        return src
    src = re.sub(r'\\{\\{\\s*\\}\\}', '[Variable sense nom]', src)
    src = re.sub(r'\\{\\%\\s*\\%\\}', '', src)
    return src

def render_with_recovery(env, template_src, ctx, pass_label, max_fixes=1000):
    issues = []
    current_src = sanitize_empty_jinja_tags(template_src)
    for _ in range(max_fixes):
        try:
            out = env.from_string(current_src).render(**ctx)
            return out, issues
        except TemplateSyntaxError as e:
            lineno = getattr(e, 'lineno', None)
            lines = current_src.splitlines()
            if lineno and 1 <= lineno <= len(lines):
                bad_line = lines[lineno-1]
                fixed_line = re.sub(r'\\{\\{\\s*\\}\\}', '[Variable sense nom]', bad_line)
                if fixed_line == bad_line:
                    fixed_line = re.sub(r'\\{\\{\\s*', '{{ _var_indefinida_', bad_line)
                lines[lineno-1] = fixed_line
                current_src = '\\n'.join(lines)
                issues.append({
                    'pass': pass_label,
                    'line': lineno,
                    'key': 'syntax_error',
                    'message': f"Error de sintaxi Jinja2 a la línia {lineno}. S'ha corregit automàticament."
                })
                continue
            raise e
        except UndefinedError as e:
            lineno = getattr(e, 'lineno', None)
            line_text = _get_line(current_src, lineno)
            keypath = _parse_missing(e, line_text)
            keypath = '.'.join(sanitize_id(p) for p in str(keypath).split('.'))
            
            issues.append({
                'pass': pass_label,
                'line': lineno,
                'key': keypath,
                'message': f"Clau no definida '{keypath}' resolta amb marcador a la línia {lineno} de la {pass_label} passada."
            })
            
            if '.' in keypath:
                parent, last = _ensure_path(ctx, keypath)
                if parent is not None and last is not None:
                    parent[last] = _placeholder(keypath)
            else:
                ctx[keypath] = _placeholder(keypath)
            continue
    raise UndefinedError(f"Massa variables indefinides; s'han corregit {len(issues)} variables sense èxit.")
def sanitize_id(s, allow_dots=False):
    s = '' if s is None else str(s)
    s = s.replace(' ', '_')
    if allow_dots and '.' in s:
        parts = [sanitize_id(p, allow_dots=False) for p in s.split('.')]
        return '.'.join(parts)
    s = re.sub(r'[^A-Za-z0-9_]', '_', s)
    s = re.sub(r'_+', '_', s).strip('_')
    if not s:
        s = '_'
    if not re.match(r'^[A-Za-z_]', s):
        s = '_' + s
    return s

# -------------------- Excel -> JSON --------------------
def _to_jsonable(v, date_format='iso'):
    if isinstance(v, datetime):
        v = v.date()
    if isinstance(v, date):
        return v.isoformat() if date_format == 'iso' else v.strftime('%d/%m/%Y')
    if isinstance(v, Decimal):
        if v == v.to_integral_value():
            return int(v)
        return float(v)
    return v

def _read_rows(ws, date_format='iso'):
    rows = []
    for r in range(1, ws.max_row + 1):
        row = [_to_jsonable(ws.cell(r, c).value, date_format) for c in range(1, ws.max_column + 1)]
        if all(v is None or v == '' for v in row):
            continue
        while row and (row[-1] is None or row[-1] == ''):
            row.pop()
        rows.append(row)
    return rows

def _is_kv_header(first_row):
    if not first_row or len(first_row) < 2:
        return False
    a = str(first_row[0]).strip().lower() if first_row[0] not in (None,'') else ''
    b = str(first_row[1]).strip().lower() if first_row[1] not in (None,'') else ''
    return (a in ('clau','key') and b in ('valor','value'))

def _detect_kind(rows, raw_name=""):
    if not rows:
        return 'tabular' if '.' in raw_name else 'kv'
    if '.' in raw_name:
        return 'tabular'
    if _is_kv_header(rows[0]):
        return 'kv_header'
    
    first = rows[0]
    headers = [v for v in first if v not in (None, '')]
    if len(headers) >= 3 and all(isinstance(v, str) for v in headers) and len(set(headers)) == len(headers):
        return 'tabular'
    return 'kv'

def _parse_kv(rows, start_row=0):
    out = {}
    for rr in rows[start_row:]:
        if not rr:
            continue
        k = rr[0]
        if k in (None, ''):
            continue
        v = rr[1] if len(rr) > 1 else None
        out[sanitize_id(k)] = v
    return out

def _is_value_empty(val):
    if val is None:
        return True
    if isinstance(val, bool):
        return not val
    if isinstance(val, (int, float, Decimal)):
        return val == 0
    if isinstance(val, str):
        s = val.strip()
        if not s or s in ('0', '0.0', '0.00', '0,00', 'None', 'null', 'false', 'FALSE'):
            return True
        return False
    if isinstance(val, (list, dict)):
        return len(val) == 0
    return False

def _is_row_empty(item, visited=None, depth=0, max_depth=15):
    if depth > max_depth:
        return False
    if visited is None:
        visited = set()
    if isinstance(item, (dict, list)):
        item_id = id(item)
        if item_id in visited:
            return True
        visited.add(item_id)

    if not isinstance(item, dict):
        return _is_value_empty(item)
    for k, v in item.items():
        if k in ('editor_metadata', '_hierarchy_schema', '_path'):
            continue
        if isinstance(v, list):
            non_empty_children = [child for child in v if not _is_row_empty(child, visited, depth + 1, max_depth)]
            if non_empty_children:
                return False
        elif isinstance(v, dict):
            if not _is_row_empty(v, visited, depth + 1, max_depth):
                return False
        else:
            if not _is_value_empty(v):
                return False
    return True

def _parse_table(rows):
    if not rows:
        return []
    headers = [sanitize_id(h) for h in rows[0] if h not in (None, '')]
    out = []
    for rr in rows[1:]:
        if all(v in (None, '') for v in rr):
            continue
        obj = {}
        for i, h in enumerate(headers):
            if h in (None, ''):
                continue
            obj[h] = rr[i] if i < len(rr) else None
        if not _is_row_empty(obj):
            out.append(obj)
    return out

def _parse_sheet(ws, date_format='iso'):
    rows = _read_rows(ws, date_format)
    kind = _detect_kind(rows, ws.title)
    headers = []
    if rows:
        headers = [sanitize_id(h) for h in rows[0] if h not in (None, '')]
        
    if kind == 'kv_header':
        return 'kv', _parse_kv(rows, start_row=1), headers
    if kind == 'kv':
        return 'kv', _parse_kv(rows, start_row=0), headers
    if kind == 'tabular':
        return 'tabular', _parse_table(rows), headers
    return kind, [], headers

def _cast_numeric_strings(obj):
    if isinstance(obj, dict):
        return {k: _cast_numeric_strings(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_cast_numeric_strings(item) for item in obj]
    elif isinstance(obj, str):
        s = obj.strip()
        # Try casting to integer (ignoring leading zeros to preserve phone numbers, zip codes, etc.)
        if (s.isdigit() and (len(s) == 1 or not s.startswith('0'))) or (s.startswith('-') and s[1:].isdigit() and (len(s[1:]) == 1 or not s[1:].startswith('0'))):
            try:
                return int(s)
            except ValueError:
                pass
        # Try casting to float
        if '.' in s:
            try:
                return float(s)
            except ValueError:
                pass
    return obj

def _get_nested_containers(root, path_parts):
    containers = [root]
    for p in path_parts:
        next_containers = []
        for c in containers:
            if isinstance(c, dict):
                if p in c:
                    val = c[p]
                    if isinstance(val, list):
                        next_containers.extend(val)
                    elif isinstance(val, dict):
                        next_containers.append(val)
            elif isinstance(c, list):
                for item in c:
                    if isinstance(item, dict) and p in item:
                        val = item[p]
                        if isinstance(val, list):
                            next_containers.extend(val)
                        elif isinstance(val, dict):
                            next_containers.append(val)
        containers = next_containers
    return containers

def _extract_flat_rows_for_sheet(data, raw_sheet_name, has_prefixed_sheets, valid_prefixes):
    stripped = raw_sheet_name
    if has_prefixed_sheets:
        for pfx in valid_prefixes:
            if raw_sheet_name.upper().startswith(pfx):
                stripped = raw_sheet_name[len(pfx):]
                break
    parts = [sanitize_id(p) for p in stripped.split('.')]
    
    if len(parts) == 1:
        val = data.get(parts[0])
        if isinstance(val, list):
            clean_rows = []
            for r in val:
                if isinstance(r, dict):
                    clean_rows.append({k: v for k, v in r.items() if not isinstance(v, (list, dict))})
            return clean_rows
        return val

    parent_parts = parts[:-1]
    sub_key = parts[-1]
    
    parents = _get_nested_containers(data, parent_parts)
    flat_rows = []
    
    for p_item in parents:
        if not isinstance(p_item, dict):
            continue
        p_ref_key = next(iter(p_item.keys())) if p_item else None
        p_ref_val = p_item.get(p_ref_key) if p_ref_key else None
        
        children = p_item.get(sub_key, [])
        if isinstance(children, list):
            for child in children:
                if isinstance(child, dict):
                    row = {}
                    if p_ref_key and p_ref_val is not None:
                        row[p_ref_key] = p_ref_val
                    for k, v in child.items():
                        if not isinstance(v, (list, dict)):
                            row[k] = v
                    flat_rows.append(row)
    return flat_rows

def excel_to_json(excel_path, date_format='iso', strict=False):
    wb = load_workbook(excel_path, data_only=True)
    parsed = {}
    
    valid_prefixes = ('OUT_', 'JSON_', 'EXPORT_')
    has_prefixed_sheets = any(sheet.upper().startswith(valid_prefixes) for sheet in wb.sheetnames)
    
    for raw_name in wb.sheetnames:
        if has_prefixed_sheets:
            raw_upper = raw_name.upper()
            if raw_upper.startswith(valid_prefixes):
                parsed[raw_name] = _parse_sheet(wb[raw_name], date_format)
        else:
            parsed[raw_name] = _parse_sheet(wb[raw_name], date_format)

    def _sheet_depth(raw):
        s = raw
        if has_prefixed_sheets:
            for pfx in valid_prefixes:
                if raw.upper().startswith(pfx):
                    s = raw[len(pfx):]
                    break
        return (s.count('.'), len(s))

    custom_hierarchy_keys = {}
    if "_hierarchy_metadata" in wb.sheetnames:
        try:
            ws_meta = wb["_hierarchy_metadata"]
            rows = list(ws_meta.iter_rows(values_only=True))
            if len(rows) > 1:
                for r in rows[1:]:
                    if r and len(r) >= 3 and r[0]:
                        custom_hierarchy_keys[str(r[0]).strip()] = {
                            'parent_key': str(r[1] or '').strip(),
                            'child_key': str(r[2] or '').strip()
                        }
        except Exception:
            pass

    sorted_raw_names = sorted(parsed.keys(), key=_sheet_depth)
    
    root = {}
    hierarchy_schema = {}

    for raw_name in sorted_raw_names:
        kind, data, headers = parsed[raw_name]
        stripped = raw_name
        if has_prefixed_sheets:
            for pfx in valid_prefixes:
                if raw_name.upper().startswith(pfx):
                    stripped = raw_name[len(pfx):]
                    break
        
        parts = [sanitize_id(p) for p in stripped.split('.')]
        path_str = '.'.join(parts)
        
        parent_is_tabular = (len(parts) > 2)
        ref_k = None
        if parent_is_tabular:
            ref_k = headers[0] if (headers and len(parts) > 1) else (next(iter(data[0].keys())) if (isinstance(data, list) and data and len(parts) > 1) else None)

        fields = []
        if kind == 'tabular':
            if headers:
                fields = [h for h in headers if h != ref_k]
            elif isinstance(data, list) and data:
                fields = [k for k in data[0].keys() if k != ref_k]
        elif isinstance(data, dict):
            ref_k = None
            fields = [k for k, v in data.items() if not isinstance(v, (list, dict))]
            
        # Build recursive schema tree
        curr_schema_dict = hierarchy_schema
        for idx, part in enumerate(parts):
            is_last = (idx == len(parts) - 1)
            sub_path_str = '.'.join(parts[:idx+1])
            if part not in curr_schema_dict:
                curr_schema_dict[part] = {
                    'sheet': raw_name if is_last else '',
                    'data_path': sub_path_str,
                    'kind': kind if is_last else 'tabular',
                    'ref_key': ref_k if is_last else None,
                    'fields': fields if is_last else [],
                    'children': {}
                }
            else:
                curr_schema_dict[part]['data_path'] = sub_path_str
                if is_last:
                    curr_schema_dict[part]['sheet'] = raw_name
                    curr_schema_dict[part]['kind'] = kind
                    curr_schema_dict[part]['ref_key'] = ref_k
                    curr_schema_dict[part]['fields'] = fields
            
            curr_schema_dict = curr_schema_dict[part]['children']
        
        if len(parts) == 1:
            if parts[0] not in root:
                root[parts[0]] = data if data is not None else {}
            else:
                if isinstance(data, dict) and isinstance(root[parts[0]], dict):
                    for k, v in data.items():
                        root[parts[0]][k] = v
                else:
                    root[parts[0]] = data if data is not None else {}
        else:
            parent_parts = parts[:-1]
            sub_key = parts[-1]
            curr_sub_path = '.'.join(parts)
            
            parents = _get_nested_containers(root, parent_parts)
            if not parents:
                continue
                
            for parent in parents:
                if isinstance(parent, dict):
                    if data is None:
                        data_to_set = []
                    else:
                        data_to_set = data
                    
                    if isinstance(data_to_set, list):
                        if not parent or not data_to_set:
                            parent[sub_key] = data_to_set if data_to_set is not None else []
                            continue
                        
                        sample_child = data_to_set[0]
                        if isinstance(sample_child, dict):
                            # Check explicit user-defined foreign keys first
                            c_custom = custom_hierarchy_keys.get(curr_sub_path) if custom_hierarchy_keys else None
                            if c_custom and c_custom.get('parent_key') and c_custom.get('child_key'):
                                pk = c_custom['parent_key']
                                ck = c_custom['child_key']
                                if pk in parent:
                                    p_val = str(parent[pk]).strip()
                                    matched_children = [
                                        c for c in data_to_set
                                        if isinstance(c, dict) and str(c.get(ck, '')).strip() == p_val
                                    ]
                                    parent[sub_key] = matched_children
                                    continue

                            common_keys = [k for k in sample_child.keys() if k in parent and parent[k] is not None and str(parent[k]).strip() != '']
                            id_keys = [k for k in common_keys if any(term in k.lower() for term in ['id', 'codi', 'code', 'ref', 'key', 'num'])]
                            matching_keys = id_keys if id_keys else common_keys
                            
                            if matching_keys:
                                matched_children = [
                                    c for c in data_to_set
                                    if isinstance(c, dict) and all(str(c.get(k, '')).strip() == str(parent[k]).strip() for k in matching_keys)
                                ]
                                parent[sub_key] = matched_children
                            else:
                                parent[sub_key] = data_to_set
                        else:
                            parent[sub_key] = data_to_set
                    else:
                        parent[sub_key] = data_to_set

    sheet_info_list = []
    for raw_name in sorted_raw_names:
        if raw_name in ('editor_metadata', '_hierarchy_metadata'):
            continue
        kind, data, headers = parsed[raw_name]
        stripped = raw_name
        pfx = ''
        if has_prefixed_sheets:
            for p in valid_prefixes:
                if raw_name.upper().startswith(p):
                    pfx = p
                    stripped = raw_name[len(p):]
                    break
        parts = [sanitize_id(p) for p in stripped.split('.')]
        full_path = '.'.join(parts)
        
        c_custom = custom_hierarchy_keys.get(full_path, {})
        sheet_info_list.append({
            'raw_name': raw_name,
            'prefix': pfx,
            'clean_name': parts[-1],
            'parent_path': '.'.join(parts[:-1]),
            'full_path': full_path,
            'kind': kind,
            'headers': headers or [],
            'parent_ref_key': c_custom.get('parent_key', ''),
            'child_ref_key': c_custom.get('child_key', '')
        })

    root['_sheet_info'] = sheet_info_list
    if 'editor_metadata' in parsed and isinstance(parsed['editor_metadata'][1], list):
        root['editor_metadata'] = parsed['editor_metadata'][1]

    return {
        'data': root,
        'hierarchy_schema': hierarchy_schema
    }

def update_excel_from_json(excel_path, json_str, out_excel_path):
    wb = load_workbook(excel_path)
    data = json.loads(json_str)
    
    valid_prefixes = ('OUT_', 'JSON_', 'EXPORT_')
    has_prefixed_sheets = any(sheet.upper().startswith(valid_prefixes) for sheet in wb.sheetnames if not sheet.startswith('_') and sheet != 'editor_metadata')
    
    internal_sheets = ('editor_metadata', 'editormetadata', '_sheet_info', '_hierarchy_schema', '_hierarchy_metadata', 'headers')

    # Remove internal system phantom sheets only
    for s_name in list(wb.sheetnames):
        s_lower = s_name.lower()
        if s_lower in ('_sheet_info', '_sheet_info.headers', 'headers') or s_lower.startswith('_sheet_info'):
            del wb[s_name]

    for sheet_name in list(wb.sheetnames):
        sheet_name_upper = sheet_name.upper()
        sheet_id = sanitize_id(sheet_name)

        if sheet_id in ('editor_metadata', 'editormetadata'):
            continue  # Handled explicitly at the end

        if has_prefixed_sheets and not sheet_name_upper.startswith(valid_prefixes):
            continue
            
        stripped_name = sheet_name
        if has_prefixed_sheets:
            for prefix in valid_prefixes:
                if sheet_name_upper.startswith(prefix):
                    stripped_name = sheet_name[len(prefix):]
                    break
            
        ws = wb[sheet_name]
        sheet_data = _extract_flat_rows_for_sheet(data, sheet_name, has_prefixed_sheets, valid_prefixes)
        if sheet_data is None:
            continue
            
        rows = _read_rows(ws, 'iso')
        kind = _detect_kind(rows)
        
        if kind in ('kv', 'kv_header'):
            start_row = 1 if kind == 'kv_header' else 0
            if isinstance(sheet_data, dict):
                existing_keys = set()
                for r in range(ws.max_row, start_row, -1):
                    k_val = ws.cell(r, 1).value
                    if k_val not in (None, ''):
                        s_key = sanitize_id(k_val)
                        if s_key in sheet_data:
                            existing_keys.add(s_key)
                            val = sheet_data[s_key]
                            if not isinstance(val, (list, dict)):
                                write_cell_value(ws, r, 2, val)
                        else:
                            ws.delete_rows(r)
                            
                for k_val, val in sheet_data.items():
                    if isinstance(val, (list, dict)):
                        continue
                    s_key = sanitize_id(k_val)
                    if s_key not in existing_keys:
                        next_row = ws.max_row + 1
                        ws.cell(next_row, 1).value = k_val
                        write_cell_value(ws, next_row, 2, val)
                        
        elif kind == 'tabular' and isinstance(sheet_data, list):
            excel_headers = []
            for c in range(1, ws.max_column + 1):
                val = ws.cell(1, c).value
                excel_headers.append(sanitize_id(val) if val not in (None, '') else '')
            
            active_cols = []
            if sheet_data:
                active_cols = [sanitize_id(k) for k in sheet_data[0].keys() if k and k not in internal_sheets and not str(k).startswith('_')]
            
            for c_idx in range(len(excel_headers) - 1, -1, -1):
                h = excel_headers[c_idx]
                if h and h not in active_cols:
                    ws.delete_cols(c_idx + 1)
            
            excel_headers = []
            for c in range(1, ws.max_column + 1):
                val = ws.cell(1, c).value
                excel_headers.append(sanitize_id(val) if val not in (None, '') else '')
            
            for h in active_cols:
                if h not in excel_headers:
                    new_col_idx = len(excel_headers) + 1
                    ws.cell(1, new_col_idx).value = h
                    excel_headers.append(h)
            
            excess = ws.max_row - (len(sheet_data) + 1)
            if excess > 0:
                ws.delete_rows(len(sheet_data) + 2, excess)
                
            for r_idx, row_obj in enumerate(sheet_data):
                excel_row = r_idx + 2
                for c_idx, h in enumerate(excel_headers):
                    matched_key = None
                    for key in row_obj.keys():
                        if sanitize_id(key) == h:
                            matched_key = key
                            break
                    if matched_key is not None:
                        val = row_obj[matched_key]
                        if not isinstance(val, (list, dict)):
                            write_cell_value(ws, excel_row, c_idx + 1, val)

    # EXPLICITLY write editor_metadata sheet with all 14 config columns regardless of prefixes!
    meta_data = data.get('editor_metadata') or data.get('editorMetadata') or []
    if 'editor_metadata' in wb.sheetnames:
        ws = wb['editor_metadata']
    else:
        ws = wb.create_sheet(title='editor_metadata')

    ws.delete_rows(1, max(ws.max_row, 1))
    headers = ['group', 'element', 'type', 'options', 'sourceType', 'multiple', 'vectorPath', 'displayField', 'valueField', 'width', 'calcFn', 'calcVector', 'calcTargetCol', 'calcFormula', 'gridRow', 'gridOrder']
    for c_idx, h in enumerate(headers):
        ws.cell(1, c_idx + 1).value = h
    
    for r_idx, row_obj in enumerate(meta_data):
        excel_row = r_idx + 2
        for c_idx, h in enumerate(headers):
            val = row_obj.get(h, '')
            if isinstance(val, list):
                val = ', '.join(str(x) for x in val)
            elif isinstance(val, bool):
                val = int(val)
            write_cell_value(ws, excel_row, c_idx + 1, val)
    ws.sheet_state = 'hidden'

    wb.save(out_excel_path)

def update_excel_hierarchy(excel_path, hierarchy_config_json, out_excel_path):
    wb = load_workbook(excel_path)
    config = json.loads(hierarchy_config_json)
    
    renames = config.get("renames", {}) if isinstance(config, dict) else (config if isinstance(config, dict) else {})
    for old_sheet, new_name in renames.items():
        if old_sheet in wb.sheetnames and new_name and old_sheet != new_name:
            wb[old_sheet].title = new_name
            
    custom_keys = config.get("custom_keys", {}) if isinstance(config, dict) else {}
    if custom_keys:
        if "_hierarchy_metadata" in wb.sheetnames:
            ws_meta = wb["_hierarchy_metadata"]
            ws_meta.delete_rows(1, ws_meta.max_row)
        else:
            ws_meta = wb.create_sheet("_hierarchy_metadata")
        ws_meta.append(["sub_path", "parent_key", "child_key"])
        for sub_path, k_dict in custom_keys.items():
            if isinstance(k_dict, dict) and (k_dict.get("parent_key") or k_dict.get("child_key")):
                ws_meta.append([sub_path, k_dict.get("parent_key", ""), k_dict.get("child_key", "")])
        ws_meta.sheet_state = "hidden"

    wb.save(out_excel_path)
    return True

# -------------------- Jinja: recuperació d'errors --------------------
RE_DOTTED = re.compile(r"\\b([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)+)\\b")

class TrackedValue:
    def __init__(self, val, path, enable_links=True):
        self.val = val
        self._path = path
        self.enable_links = enable_links

    def __str__(self):
        if self.val is None:
            return ''
        s = str(self.val)
        if self.enable_links and self._path:
            return f'<a href="#dades.{self._path}" class="data-link" data-path="{self._path}">{s}</a>'
        return s

    def __repr__(self):
        return str(self)

    def __html__(self):
        return str(self)

    def __bool__(self):
        return bool(self.val)

    def __len__(self):
        if hasattr(self.val, '__len__'):
            return len(self.val)
        return 0

    def __int__(self):
        return int(self.val)

    def __float__(self):
        return float(self.val)

    def __hash__(self):
        return hash(self.val)

    def __eq__(self, other):
        o = other.val if isinstance(other, TrackedValue) else other
        return self.val == o

    def __ne__(self, other):
        o = other.val if isinstance(other, TrackedValue) else other
        return self.val != o

    def __lt__(self, other):
        o = other.val if isinstance(other, TrackedValue) else other
        return self.val < o

    def __le__(self, other):
        o = other.val if isinstance(other, TrackedValue) else other
        return self.val <= o

    def __gt__(self, other):
        o = other.val if isinstance(other, TrackedValue) else other
        return self.val > o

    def __ge__(self, other):
        o = other.val if isinstance(other, TrackedValue) else other
        return self.val >= o

    def __add__(self, other):
        o = other.val if isinstance(other, TrackedValue) else other
        res = self.val + o
        return TrackedValue(res, self._path, self.enable_links)

    def __radd__(self, other):
        o = other.val if isinstance(other, TrackedValue) else other
        res = o + self.val
        return TrackedValue(res, self._path, self.enable_links)

    def __sub__(self, other):
        o = other.val if isinstance(other, TrackedValue) else other
        res = self.val - o
        return TrackedValue(res, self._path, self.enable_links)

    def __rsub__(self, other):
        o = other.val if isinstance(other, TrackedValue) else other
        res = o - self.val
        return TrackedValue(res, self._path, self.enable_links)

    def __mul__(self, other):
        o = other.val if isinstance(other, TrackedValue) else other
        res = self.val * o
        return TrackedValue(res, self._path, self.enable_links)

    def __rmul__(self, other):
        o = other.val if isinstance(other, TrackedValue) else other
        res = o * self.val
        return TrackedValue(res, self._path, self.enable_links)

    def __truediv__(self, other):
        o = other.val if isinstance(other, TrackedValue) else other
        res = self.val / o
        return TrackedValue(res, self._path, self.enable_links)

    def __rtruediv__(self, other):
        o = other.val if isinstance(other, TrackedValue) else other
        res = o / self.val
        return TrackedValue(res, self._path, self.enable_links)

class TrackedDict(dict):
    def __init__(self, d, path, enable_links=True, visited=None):
        super().__init__()
        self._path = path
        self.enable_links = enable_links
        if visited is None:
            visited = set()
        for k, v in d.items():
            sub_path = f"{path}.{k}" if path else k
            self[k] = _wrap_tracked(v, sub_path, enable_links, visited)

    def __getitem__(self, key):
        if key not in self:
            p = f"{self._path}.{key}" if self._path else str(key)
            return Placeholder(p)
        return super().__getitem__(key)

    def __getattr__(self, name):
        if name.startswith('_') or name in ('get', 'keys', 'items', 'values'):
            raise AttributeError(name)
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name)

    def get(self, key, default=None):
        if key not in self:
            p = f"{self._path}.{key}" if self._path else str(key)
            return Placeholder(p)
        return super().get(key, default)

class TrackedList(list):
    def __init__(self, lst, path, enable_links=True, visited=None):
        super().__init__()
        self._path = path
        self.enable_links = enable_links
        if visited is None:
            visited = set()
        for idx, item in enumerate(lst):
            sub_path = f"{path}.{idx}"
            self.append(_wrap_tracked(item, sub_path, enable_links, visited))

def _wrap_tracked(val, path='', enable_links=True, visited=None):
    if visited is None:
        visited = set()
    if isinstance(val, (dict, list)):
        val_id = id(val)
        if val_id in visited:
            return val
        visited.add(val_id)

    if isinstance(val, dict):
        if isinstance(val, TrackedDict):
            return val
        return TrackedDict(val, path, enable_links, visited)
    elif isinstance(val, list):
        if isinstance(val, TrackedList):
            return val
        return TrackedList(val, path, enable_links, visited)
    elif isinstance(val, (SafeDict, Placeholder)):
        return val
    elif isinstance(val, TrackedValue):
        return val
    return TrackedValue(val, path, enable_links)

class Placeholder:
    def __init__(self, path):
        self._path = path

    def __getattr__(self, name):
        if name.startswith('_') or name in ('get', 'keys', 'items', 'values'):
            raise AttributeError(name)
        return Placeholder(f"{self._path}.{name}")

    def __getitem__(self, key):
        return Placeholder(f"{self._path}[{key}]")

    def __iter__(self):
        return iter([Placeholder(f"{self._path}[0]")])

    def __len__(self):
        return 1

    def __str__(self):
        return f"[{self._path}]"

    def __repr__(self):
        return f"[{self._path}]"

    def __html__(self):
        return f"[{self._path}]"

    def __add__(self, other):
        return Placeholder(f"{self._path} + {other}")
    def __radd__(self, other):
        return Placeholder(f"{other} + {self._path}")
    def __sub__(self, other):
        return Placeholder(f"{self._path} - {other}")
    def __rsub__(self, other):
        return Placeholder(f"{other} - {self._path}")
    def __mul__(self, other):
        return Placeholder(f"{self._path} * {other}")
    def __rmul__(self, other):
        return Placeholder(f"{other} * {self._path}")
    def __truediv__(self, other):
        return Placeholder(f"{self._path} / {other}")
    def __rtruediv__(self, other):
        return Placeholder(f"{other} / {self._path}")

def _placeholder(path):
    return Placeholder(path)

def _get_line(src, lineno):
    if not lineno:
        return ''
    lines = src.splitlines()
    if 1 <= lineno <= len(lines):
        return lines[lineno-1]
    return ''

def _parse_missing(e, line_text):
    msg = str(e)
    m = re.search(r"has no attribute '([^']+)'", msg)
    attr = m.group(1) if m else None

    candidates = RE_DOTTED.findall(line_text or '')
    if attr and candidates:
        for c in candidates:
            if c.endswith('.' + sanitize_id(attr)) or c.endswith('.' + attr):
                return c
    if len(candidates) == 1:
        return candidates[0]
    if attr:
        return attr
    return msg

def _ensure_path(ctx, path):
    parts = path.split('.')
    if not parts:
        return None, None
    cur = ctx
    for p in parts[:-1]:
        if p not in cur or not isinstance(cur.get(p), dict):
            cur[p] = {}
        cur = cur[p]
    return cur, parts[-1]

def render_with_recovery(env, template_src, ctx, pass_label, max_fixes=50):
    issues = []
    current_src = template_src
    last_keypath = None
    repeat_count = 0
    
    for _ in range(max_fixes):
        try:
            out = env.from_string(current_src).render(**ctx)
            return out, issues
        except UndefinedError as e:
            lineno = getattr(e, 'lineno', None)
            line_text = _get_line(current_src, lineno)
            keypath = _parse_missing(e, line_text)
            keypath = '.'.join(sanitize_id(p) for p in str(keypath).split('.'))
            
            if keypath == last_keypath:
                repeat_count += 1
                if repeat_count > 3:
                    break
            else:
                last_keypath = keypath
                repeat_count = 0

            issues.append({
                'pass': pass_label,
                'line': lineno,
                'key': keypath,
                'message': f"Clau no definida '{keypath}' resolta amb marcador a la línia {lineno} de la {pass_label} passada."
            })
            
            if '.' in keypath:
                parent, last = _ensure_path(ctx, keypath)
                if parent is not None and last is not None:
                    parent[last] = _placeholder(keypath)
            else:
                ctx[keypath] = _placeholder(keypath)
            continue

    # Fallback to non-strict environment if recovery loop gets stuck
    env_lax = Environment(undefined=DebugUndefined, autoescape=False, trim_blocks=False, lstrip_blocks=False)
    env_lax.filters.update(env.filters)
    env_lax.globals.update(env.globals)
    try:
        out = env_lax.from_string(current_src).render(**ctx)
        return out, issues
    except Exception:
        return current_src, issues

REF_REGEX = re.compile(r"^=[+]?(?:'([^']+)'|([A-Za-z0-9_]+))!([A-Za-z0-9$]+)$")

def get_referenced_cell(ws, cell):
    val = str(cell.value or '').strip()
    if not val.startswith('='):
        return None
    m = REF_REGEX.match(val)
    if m:
        sheet_name = m.group(1) or m.group(2)
        cell_coord = m.group(3).replace('$', '')
        wb = ws.parent
        if sheet_name in wb.sheetnames:
            return wb[sheet_name][cell_coord]
    return None

def write_cell_value(ws, row_idx, col_idx, value):
    cell = ws.cell(row_idx, col_idx)
    target_cell = cell
    visited = set()
    while True:
        ref_cell = get_referenced_cell(target_cell.parent, target_cell)
        if ref_cell is None:
            break
        ref_key = f"{ref_cell.parent.title}!{ref_cell.coordinate}"
        if ref_key in visited:
            break
        visited.add(ref_key)
        target_cell = ref_cell
    
    if isinstance(value, (list, dict)):
        value = json.dumps(value, ensure_ascii=False)

    # Cast value to correct type before writing
    if isinstance(value, str):
        s = value.strip()
        if (s.isdigit() and (len(s) == 1 or not s.startswith('0'))) or (s.startswith('-') and s[1:].isdigit() and (len(s[1:]) == 1 or not s[1:].startswith('0'))):
            try:
                value = int(s)
            except ValueError:
                pass
        elif '.' in s:
            try:
                value = float(s)
            except ValueError:
                pass
                
    target_cell.value = value

def create_default_workbook_from_json(json_str, out_path):
    import json
    from openpyxl import Workbook
    try:
        data = json.loads(json_str)
    except Exception:
        data = {}
        
    wb = Workbook()
    if wb.active:
        wb.remove(wb.active)
        
    internal_keys = ('editor_metadata', 'editormetadata', '_sheet_info', '_hierarchy_schema', '_hierarchy_metadata', 'headers')

    # Create primary data sheets only
    for sheet_name, sheet_content in data.items():
        if sheet_name in internal_keys or str(sheet_name).startswith('_'):
            continue
            
        ws = wb.create_sheet(title=str(sheet_name))
        if isinstance(sheet_content, dict):
            ws.append(["Clau", "Valor"])
            for k, v in sheet_content.items():
                if isinstance(v, (dict, list)) or k in internal_keys or str(k).startswith('_'):
                    continue
                ws.append([str(k), "" if v is None else str(v)])
        elif isinstance(sheet_content, list) and len(sheet_content) > 0:
            headers = [k for k in sheet_content[0].keys() if not isinstance(sheet_content[0][k], (dict, list)) and k not in internal_keys and not str(k).startswith('_')]
            ws.append(headers)
            for row in sheet_content:
                if isinstance(row, dict):
                    ws.append(["" if row.get(h) is None else str(row.get(h)) for h in headers])

    # Write editor_metadata sheet cleanly with all 16 columns
    editor_meta = data.get('editor_metadata') or data.get('editorMetadata') or []
    if editor_meta:
        ws = wb.create_sheet(title='editor_metadata')
        headers = ['group', 'element', 'type', 'options', 'sourceType', 'multiple', 'vectorPath', 'displayField', 'valueField', 'width', 'calcFn', 'calcVector', 'calcTargetCol', 'calcFormula', 'gridRow', 'gridOrder']
        ws.append(headers)
        for row_obj in editor_meta:
            if isinstance(row_obj, dict):
                ws.append(["" if row_obj.get(h) is None else (", ".join(str(x) for x in row_obj[h]) if isinstance(row_obj[h], list) else str(row_obj[h])) for h in headers])
        ws.sheet_state = 'hidden'

    if not wb.sheetnames:
        wb.create_sheet(title="Dades")
        
    wb.save(out_path)

# -------------------- Localized Formatting Filters & Spelling --------------------
def get_locale_from_context(context):
    for key in ('config', 'CONFIG'):
        cfg = context.get(key)
        if isinstance(cfg, dict):
            locale_val = cfg.get('locale')
            if locale_val:
                return str(locale_val).strip()
    return 'ca_ES'

def catalan_number_to_words(number):
    if number == 0:
        return "zero"
    units = ["", "un", "dos", "tres", "quatre", "cinc", "sis", "set", "vuit", "nou"]
    units_f = ["", "una", "dues", "tres", "quatre", "cinc", "sis", "set", "vuit", "nou"]
    teens = ["deu", "onze", "dotze", "tretze", "catorze", "quinze", "setze", "disset", "divuit", "dinou"]
    tens = ["", "", "vint", "trenta", "quaranta", "cinquanta", "seixanta", "setanta", "vuitanta", "noranta"]
    
    def _convert_below_1000(n, feminine=False):
        if n == 0:
            return ""
        res = []
        h = n // 100
        rem = n % 100
        if h > 0:
            if h == 1:
                res.append("cent")
            else:
                res.append(f"{units_f[h] if feminine else units[h]}-cents")
        if rem > 0:
            if rem < 10:
                res.append(units_f[rem] if feminine else units[rem])
            elif rem < 20:
                res.append(teens[rem - 10])
            else:
                t = rem // 10
                u = rem % 10
                if t == 2:
                    if u == 0:
                        res.append("vint")
                    else:
                        res.append(f"vint-i-{units_f[u] if feminine else units[u]}")
                else:
                    if u == 0:
                        res.append(tens[t])
                    else:
                        res.append(f"{tens[t]}-{units_f[u] if feminine else units[u]}")
        return " ".join(res)

    millions = number // 1000000
    rem = number % 1000000
    thousands = rem // 1000
    rem_units = rem % 1000
    
    parts = []
    if millions > 0:
        if millions == 1:
            parts.append("un milió")
        else:
            parts.append(f"{_convert_below_1000(millions)} milions")
    if thousands > 0:
        if thousands == 1:
            parts.append("mil")
        else:
            parts.append(f"{_convert_below_1000(thousands)} mil")
    if rem_units > 0 or not parts:
        parts.append(_convert_below_1000(rem_units))
    return " ".join(parts).strip()

def catalan_currency_to_words(val):
    euros = int(val)
    cents = int(round((val - euros) * 100))
    if euros == 1:
        euros_str = "un euro"
    else:
        euros_str = f"{catalan_number_to_words(euros)} euros"
    if cents == 0:
        return euros_str
    if cents == 1:
        cents_str = "un cèntim"
    else:
        cents_str = f"{catalan_number_to_words(cents)} cèntims"
    return f"{euros_str} amb {cents_str}"

def catalan_date_to_words(d):
    months = ["", "gener", "febrer", "març", "abril", "maig", "juny", "juliol", "agost", "setembre", "octubre", "novembre", "desembre"]
    day = d.day
    month = d.month
    year = d.year
    day_str = "primer" if day == 1 else catalan_number_to_words(day)
    return f"{day_str} de {months[month]} de {catalan_number_to_words(year)}"

def spanish_number_to_words(number):
    if number == 0:
        return "cero"
    units = ["", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"]
    teens = ["diez", "once", "doce", "trece", "catorce", "quince", "dieciseis", "diecisiete", "dieciocho", "diecinueve"]
    tens = ["", "", "veinte", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"]
    hundreds = ["", "cien", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"]
    
    def _convert_below_1000(n):
        if n == 0:
            return ""
        res = []
        h = n // 100
        rem = n % 100
        if h > 0:
            if h == 1 and rem == 0:
                res.append("cien")
            elif h == 1:
                res.append("ciento")
            else:
                res.append(hundreds[h])
        if rem > 0:
            if rem < 10:
                res.append(units[rem])
            elif rem < 20:
                res.append(teens[rem - 10])
            elif rem < 30:
                if rem == 20:
                    res.append("veinte")
                else:
                    res.append(f"veinti{units[rem%10]}")
            else:
                t = rem // 10
                u = rem % 10
                if u == 0:
                    res.append(tens[t])
                else:
                    res.append(f"{tens[t]} y {units[u]}")
        return " ".join(res)

    millions = number // 1000000
    rem = number % 1000000
    thousands = rem // 1000
    rem_units = rem % 1000
    
    parts = []
    if millions > 0:
        if millions == 1:
            parts.append("un millón")
        else:
            parts.append(f"{_convert_below_1000(millions)} millones")
    if thousands > 0:
        if thousands == 1:
            parts.append("mil")
        else:
            t_str = _convert_below_1000(thousands)
            if t_str.endswith("uno"):
                t_str = t_str[:-3] + "ún"
            parts.append(f"{t_str} mil")
    if rem_units > 0 or not parts:
        parts.append(_convert_below_1000(rem_units))
    return " ".join(parts).strip()

def spanish_currency_to_words(val):
    euros = int(val)
    cents = int(round((val - euros) * 100))
    if euros == 1:
        euros_str = "un euro"
    else:
        euros_str = f"{spanish_number_to_words(euros)} euros"
    if cents == 0:
        return euros_str
    if cents == 1:
        cents_str = "un céntimo"
    else:
        cents_str = f"{spanish_number_to_words(cents)} céntimos"
    return f"{euros_str} con {cents_str}"

def spanish_date_to_words(d):
    months = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
    day = d.day
    month = d.month
    year = d.year
    return f"{spanish_number_to_words(day)} de {months[month]} de {spanish_number_to_words(year)}"

def english_number_to_words(number):
    if number == 0:
        return "zero"
    units = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
    teens = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
    tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
    
    def _convert_below_1000(n):
        if n == 0:
            return ""
        res = []
        h = n // 100
        rem = n % 100
        if h > 0:
            res.append(f"{units[h]} hundred")
        if rem > 0:
            if rem < 10:
                res.append(units[rem])
            elif rem < 20:
                res.append(teens[rem - 10])
            else:
                t = rem // 10
                u = rem % 10
                if u == 0:
                    res.append(tens[t])
                else:
                    res.append(f"{tens[t]}-{units[u]}")
        return " ".join(res)
        
    millions = number // 1000000
    rem = number % 1000000
    thousands = rem // 1000
    rem_units = rem % 1000
    
    parts = []
    if millions > 0:
        parts.append(f"{_convert_below_1000(millions)} million")
    if thousands > 0:
        parts.append(f"{_convert_below_1000(thousands)} thousand")
    if rem_units > 0 or not parts:
        parts.append(_convert_below_1000(rem_units))
    return " ".join(parts).strip()

def english_currency_to_words(val):
    dollars = int(val)
    cents = int(round((val - dollars) * 100))
    dollars_str = "one dollar" if dollars == 1 else f"{english_number_to_words(dollars)} dollars"
    if cents == 0:
        return dollars_str
    cents_str = "one cent" if cents == 1 else f"{english_number_to_words(cents)} cents"
    return f"{dollars_str} and {cents_str}"

def english_ordinal_words(n):
    words = {
        1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth",
        6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth",
        11: "eleventh", 12: "twelfth", 13: "thirteenth", 14: "fourteenth",
        15: "fifteenth", 16: "sixteen", 17: "seventeenth", 18: "eighteenth",
        19: "nineteenth", 20: "twentieth", 30: "thirtieth"
    }
    if n in words:
        return words[n]
    if n < 30:
        return f"twenty-{words[n%10]}"
    if n < 40:
        return f"thirty-{words[n%10]}"
    return english_number_to_words(n)

def english_date_to_words(d):
    months = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    return f"{english_ordinal_words(d.day)} of {months[d.month]}, {english_number_to_words(d.year)}"

def _wrap_res(res, orig_path, enable_links):
    if orig_path:
        return TrackedValue(res, orig_path, enable_links)
    return res

@pass_context
def filter_coin(context, value, currency_symbol=None):
    orig_path = getattr(value, '_path', None)
    enable_links = getattr(value, 'enable_links', True)
    val_raw = value.val if isinstance(value, TrackedValue) else value
    locale_code = get_locale_from_context(context)
    if val_raw in (None, ''):
        return _wrap_res('', orig_path, enable_links)
    try:
        val = float(val_raw)
    except (ValueError, TypeError):
        return _wrap_res(val_raw, orig_path, enable_links)
    dec_sep = ','
    thousands_sep = '.'
    curr_before = False
    locale_lower = locale_code.lower()
    if any(x in locale_lower for x in ('en_us', 'en_gb', 'en_ca', 'en_au')):
        dec_sep = '.'
        thousands_sep = ','
        curr_before = True
    if currency_symbol is None:
        if 'en_us' in locale_lower:
            currency_symbol = '$'
        elif 'en_gb' in locale_lower:
            currency_symbol = '£'
        else:
            currency_symbol = '€'
    val_str = f"{val:.2f}"
    parts = val_str.split('.')
    integer_part = parts[0]
    decimal_part = parts[1]
    is_neg = integer_part.startswith('-')
    if is_neg:
        integer_part = integer_part[1:]
    thousands_list = []
    while len(integer_part) > 3:
        thousands_list.insert(0, integer_part[-3:])
        integer_part = integer_part[:-3]
    thousands_list.insert(0, integer_part)
    formatted_int = (('-' if is_neg else '') + thousands_sep.join(thousands_list))
    formatted_num = f"{formatted_int}{dec_sep}{decimal_part}"
    if curr_before:
        res = f"{currency_symbol}{formatted_num}"
    else:
        res = f"{formatted_num}{currency_symbol}"
    return _wrap_res(res, orig_path, enable_links)

@pass_context
def filter_number(context, value, precision=2):
    orig_path = getattr(value, '_path', None)
    enable_links = getattr(value, 'enable_links', True)
    val_raw = value.val if isinstance(value, TrackedValue) else value
    locale_code = get_locale_from_context(context)
    if val_raw in (None, ''):
        return _wrap_res('', orig_path, enable_links)
    try:
        val = float(val_raw)
        precision = int(precision)
    except (ValueError, TypeError):
        return _wrap_res(val_raw, orig_path, enable_links)
    dec_sep = ','
    thousands_sep = '.'
    locale_lower = locale_code.lower()
    if any(x in locale_lower for x in ('en_us', 'en_gb', 'en_ca', 'en_au')):
        dec_sep = '.'
        thousands_sep = ','
    val_str = f"{val:.{precision}f}"
    parts = val_str.split('.')
    integer_part = parts[0]
    decimal_part = parts[1] if len(parts) > 1 else ''
    is_neg = integer_part.startswith('-')
    if is_neg:
        integer_part = integer_part[1:]
    thousands_list = []
    while len(integer_part) > 3:
        thousands_list.insert(0, integer_part[-3:])
        integer_part = integer_part[:-3]
    thousands_list.insert(0, integer_part)
    formatted_int = (('-' if is_neg else '') + thousands_sep.join(thousands_list))
    if precision > 0:
        res = f"{formatted_int}{dec_sep}{decimal_part}"
    else:
        res = formatted_int
    return _wrap_res(res, orig_path, enable_links)

@pass_context
def filter_words(context, value, mode=None):
    orig_path = getattr(value, '_path', None)
    enable_links = getattr(value, 'enable_links', True)
    val_raw = value.val if isinstance(value, TrackedValue) else value
    locale_code = get_locale_from_context(context)
    locale_lower = locale_code.lower()
    d = None
    if isinstance(val_raw, (datetime, date)):
        d = val_raw
    elif isinstance(val_raw, str):
        for fmt in ('%Y-%m-%d', '%d/%m/%Y', '%Y-%m-%d %H:%M:%S'):
            try:
                d = datetime.strptime(val_raw.strip(), fmt).date()
                break
            except ValueError:
                pass
    if d is not None:
        if 'es_es' in locale_lower:
            res = spanish_date_to_words(d)
        elif 'en_us' in locale_lower or 'en_gb' in locale_lower:
            res = english_date_to_words(d)
        else:
            res = catalan_date_to_words(d)
        return _wrap_res(res, orig_path, enable_links)
    try:
        val = float(val_raw)
    except (ValueError, TypeError):
        return _wrap_res(val_raw, orig_path, enable_links)
    if mode is None:
        mode = 'coin'
    if mode == 'coin':
        if 'es_es' in locale_lower:
            res = spanish_currency_to_words(val)
        elif 'en_us' in locale_lower or 'en_gb' in locale_lower:
            res = english_currency_to_words(val)
        else:
            res = catalan_currency_to_words(val)
    else:
        integer_part = int(val)
        decimal_part = int(round((val - integer_part) * 100))
        if 'es_es' in locale_lower:
            int_str = spanish_number_to_words(integer_part)
            if decimal_part > 0:
                res = f"{int_str} con {spanish_number_to_words(decimal_part)}"
            else:
                res = int_str
        elif 'en_us' in locale_lower or 'en_gb' in locale_lower:
            int_str = english_number_to_words(integer_part)
            if decimal_part > 0:
                res = f"{int_str} point {english_number_to_words(decimal_part)}"
            else:
                res = int_str
        else:
            int_str = catalan_number_to_words(integer_part)
            if decimal_part > 0:
                res = f"{int_str} amb {catalan_number_to_words(decimal_part)}"
            else:
                res = int_str
    return _wrap_res(res, orig_path, enable_links)

def filter_prefix(value, fallback, elided):
    orig_path = getattr(value, '_path', None)
    enable_links = getattr(value, 'enable_links', True)
    val_raw = value.val if isinstance(value, TrackedValue) else value
    s = str(val_raw or '').strip()
    if not s:
        return _wrap_res(s, orig_path, enable_links)
    
    import re
    is_elision = bool(re.match(r"^(?:[aeiouàéèíóòúüïAEIOUÀÉÈÍÓÒÚÜÏ]|[hH][aeiouàéèíóòúüïAEIOUÀÉÈÍÓÒÚÜÏ])", s))
    pfx = elided if is_elision else fallback
    
    if pfx.endswith("'") or pfx.endswith("’"):
        res = f"{pfx}{s}"
    else:
        if pfx.endswith(" "):
            res = f"{pfx}{s}"
        else:
            res = f"{pfx} {s}"
    return _wrap_res(res, orig_path, enable_links)

def render_json_text(excel_path, date_format='iso', strict=False):
    doc = excel_to_json(excel_path, date_format=date_format, strict=strict)
    return json.dumps(doc, ensure_ascii=False, indent=2)

def _filter_empty_rows(data, visited=None, depth=0, max_depth=15):
    if depth > max_depth:
        return data
    if visited is None:
        visited = set()
    if isinstance(data, (dict, list)):
        data_id = id(data)
        if data_id in visited:
            return data
        visited.add(data_id)

    if isinstance(data, dict):
        new_dict = {}
        for k, v in data.items():
            if k in ('editor_metadata', '_hierarchy_schema'):
                new_dict[k] = v
            else:
                new_dict[k] = _filter_empty_rows(v, visited, depth + 1, max_depth)
        return new_dict
    elif isinstance(data, list):
        filtered_list = []
        for item in data:
            if isinstance(item, dict):
                if not _is_row_empty(item, visited.copy(), depth + 1, max_depth):
                    filtered_list.append(_filter_empty_rows(item, visited, depth + 1, max_depth))
            else:
                if not _is_value_empty(item):
                    filtered_list.append(_filter_empty_rows(item, visited, depth + 1, max_depth))
        return filtered_list
    return data

def _wrap_tracked(val, path='', enable_links=True, visited=None):
    if visited is None:
        visited = set()
    if isinstance(val, (dict, list)):
        val_id = id(val)
        if val_id in visited:
            return val
        visited.add(val_id)

    if isinstance(val, dict):
        if isinstance(val, TrackedDict):
            return val
        return TrackedDict(val, path, enable_links, visited)
    elif isinstance(val, list):
        if isinstance(val, TrackedList):
            return val
        return TrackedList(val, path, enable_links, visited)
    elif isinstance(val, (SafeDict, Placeholder)):
        return val
    elif isinstance(val, TrackedValue):
        return val
    return TrackedValue(val, path, enable_links)

class SafeDict(dict):
    def __init__(self, d, path='', visited=None):
        super().__init__()
        self._path = path
        if visited is None:
            visited = set()
        if isinstance(d, dict):
            for k, v in d.items():
                self[k] = _wrap_safe(v, f"{path}.{k}" if path else k, visited)

    def __getitem__(self, key):
        if key not in self:
            return Placeholder(f"{self._path}.{key}" if self._path else str(key))
        return super().__getitem__(key)

    def __getattr__(self, name):
        if name.startswith('_') or name in ('get', 'keys', 'items', 'values'):
            raise AttributeError(name)
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name)

    def get(self, key, default=None):
        if key not in self:
            return Placeholder(f"{self._path}.{key}" if self._path else str(key))
        return super().get(key, default)

def _wrap_safe(val, path='', visited=None):
    if visited is None:
        visited = set()
    if isinstance(val, (dict, list)):
        val_id = id(val)
        if val_id in visited:
            return val
        visited.add(val_id)

    if isinstance(val, dict):
        if isinstance(val, SafeDict):
            return val
        return SafeDict(val, path, visited)
    elif isinstance(val, list):
        return [_wrap_safe(item, f"{path}.{idx}", visited) for idx, item in enumerate(val)]
    elif isinstance(val, Placeholder):
        return val
    return val

def render_md_two_pass_with_report(excel_path, template_path, date_format='iso', strict=False):
    import traceback
    try:
        raw_doc = excel_to_json(excel_path, date_format=date_format, strict=strict)
        doc = _filter_empty_rows(raw_doc)

        # Merge latest JSON from /work/in.json if present
        try:
            if os.path.exists('/work/in.json'):
                with open('/work/in.json', 'r', encoding='utf-8') as f:
                    json_data = json.load(f)
                    if isinstance(json_data, dict):
                        for k, v in json_data.items():
                            if k not in doc or not doc[k]:
                                doc[k] = v
                            elif isinstance(v, dict) and isinstance(doc[k], dict):
                                for sub_k, sub_v in v.items():
                                    if sub_k not in doc[k] or not doc[k][sub_k]:
                                        doc[k][sub_k] = sub_v
        except Exception:
            pass

        with open(template_path, 'r', encoding='utf-8') as f:
            tpl_src = f.read()

        def _normalize_markdown_headings(text):
            if not text:
                return text
            lines = text.split('\\n')
            out = []
            for i, line in enumerate(lines):
                stripped = line.lstrip()
                if stripped.startswith('#') and i > 0:
                    if out and out[-1].strip() != '':
                        out.append('')
                out.append(line)
            return '\\n'.join(out)

        # Pass 1: Clean Context without HTML links (for Pandoc / Word export)
        clean_ctx = _wrap_safe(doc, '')
        if 'doc' not in clean_ctx:
            clean_ctx['doc'] = clean_ctx

        env_clean = Environment(undefined=StrictUndefined, autoescape=False, trim_blocks=False, lstrip_blocks=False)
        env_clean.filters['coin'] = filter_coin
        env_clean.filters['number'] = filter_number
        env_clean.filters['words'] = filter_words
        env_clean.filters['prefix'] = filter_prefix
        env_clean.globals['TRUE'] = True
        env_clean.globals['FALSE'] = False
        env_clean.globals['true'] = True
        env_clean.globals['false'] = False

        out1_clean, issues1 = render_with_recovery(env_clean, tpl_src, clean_ctx, 'primera')
        if '{{' in out1_clean or '{%' in out1_clean:
            out2_clean, issues2 = render_with_recovery(env_clean, out1_clean, clean_ctx, 'segona')
        else:
            out2_clean = out1_clean
            issues2 = []
        all_issues = issues1 + issues2

        # Pass 2: Tracked Context with HTML links (for HTML preview)
        html_ctx = _wrap_tracked(doc, '', enable_links=True)
        if 'doc' not in html_ctx:
            html_ctx['doc'] = html_ctx

        env_html = Environment(undefined=StrictUndefined, autoescape=False, trim_blocks=False, lstrip_blocks=False)
        env_html.filters['coin'] = filter_coin
        env_html.filters['number'] = filter_number
        env_html.filters['words'] = filter_words
        env_html.filters['prefix'] = filter_prefix
        env_html.globals['TRUE'] = True
        env_html.globals['FALSE'] = False
        env_html.globals['true'] = True
        env_html.globals['false'] = False

        out1_html, _ = render_with_recovery(env_html, tpl_src, html_ctx, 'primera_html')
        if '{{' in out1_html or '{%' in out1_html:
            out2_html, _ = render_with_recovery(env_html, out1_html, html_ctx, 'segona_html')
        else:
            out2_html = out1_html

        out2_clean = _normalize_markdown_headings(out2_clean)
        out2_html = _normalize_markdown_headings(out2_html)

        return json.dumps({
            'success': True,
            'markdown': out2_clean,
            'htmlMarkdown': out2_html,
            'issues': all_issues
        }, ensure_ascii=False)
    except Exception as ex:
        tb_str = traceback.format_exc()
        lineno = getattr(ex, 'lineno', None)
        msg = str(ex)
        return json.dumps({
            'success': False,
            'error': f"Error de conversió Jinja2: {msg}",
            'message': msg,
            'traceback': tb_str,
            'line': lineno
        }, ensure_ascii=False)
      `;
      await _pyodide.runPythonAsync(pyCode);
      store.addLog("Motor de dades Python vinculat correctament a Pyodide.", 'success');

      // 2. Pandoc WASM Initialization
      store.addLog("Inicialitzant motor Pandoc WASM...", 'info');
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
      store.addLog(`Error de càrrega WASM: ${e.message}`, 'error');
      throw e;
    } finally {
      isLoading.value = false;
    }
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
    
    const parsed = JSON.parse(jsonStr);
    
    // Clean all-zeros or empty rows to empty strings to avoid showing '0' for blank formula rows
    Object.keys(parsed).forEach(sheetName => {
      if (sheetName === '_hierarchy_schema') return;
      const sheetData = parsed[sheetName];
      if (Array.isArray(sheetData)) {
        sheetData.forEach(row => {
          if (row && typeof row === 'object') {
            const primitiveValues = Object.entries(row)
              .filter(([k, v]) => !Array.isArray(v) && typeof v !== 'object')
              .map(([k, v]) => v);
            const isAllZeros = primitiveValues.length > 0 && primitiveValues.every(val => 
              val === 0 || val === 0.0 || val === '' || val === null || val === undefined || val === false
            );
            if (isAllZeros) {
              Object.keys(row).forEach(key => {
                if (!Array.isArray(row[key]) && typeof row[key] !== 'object') {
                  row[key] = '';
                }
              });
            }
          }
        });
      }
    });

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

    if (parsedData && parsedData._hierarchy_schema) {
      delete parsedData._hierarchy_schema;
    }

    if (parsedData && parsedData.editor_metadata && Array.isArray(parsedData.editor_metadata)) {
      store.editorMetadata = parsedData.editor_metadata;
    }

    store.excelJsonData = parsedData;
    store.hierarchySchema = parsedSchema;

    const cleanedJsonStr = JSON.stringify(parsedData);
    
    // Save to in.json in Pyodide FS as well
    _pyodide.FS.writeFile('/work/in.json', new TextEncoder().encode(cleanedJsonStr));
    
    // Log structure details clearly to app log terminal
    if (parsedSchema && Object.keys(parsedSchema).length > 0) {
      store.addLog(`Esquema jeràrquic del llibre Excel (hierarchySchema):\n${JSON.stringify(parsedSchema, null, 2)}`, 'info');
    }
    store.addLog(`Arbre JSON de dades carregat des de l'Excel:\n${JSON.stringify(parsedData, null, 2)}`, 'info');
    
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
update_excel_from_json('/work/in.xlsx', js_str, '/work/in.xlsx')
      `;
      await _pyodide.runPythonAsync(pyCreateScript);
    } else if (store.excelJsonData) {
      const pyUpdateScript = `
import json
with open('/work/in.json', 'r', encoding='utf-8') as f:
    js_str = f.read()
update_excel_from_json('/work/in.xlsx', js_str, '/work/in.xlsx')
      `;
      await _pyodide.runPythonAsync(pyUpdateScript);
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
update_excel_from_json('/work/in.xlsx', js_str, '/work/out.xlsx')
    `;
    await _pyodide.runPythonAsync(pyScript);
    
    // Read the updated Excel file from Pyodide virtual FS
    const excelBytes = _pyodide.FS.readFile('/work/out.xlsx');
    try {
      _pyodide.FS.writeFile('/work/in.xlsx', excelBytes);
    } catch (_) {}

    // Persist binary buffer into store.excelFile and IndexedDB persistent storage
    try {
      const pName = store.currentProjectName || localStorage.getItem('currentProjectName') || 'Default';
      const fileName = store.excelFileName || `${pName}.xlsx`;
      store.excelFileName = fileName;
      store.excelFile = new File([excelBytes], fileName, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    await saveBinaryFile(`${pName}:excelFileBuffer`, excelBytes.buffer);
    } catch (e) {
      console.warn("Error desant el fitxer Excel a IndexedDB:", e);
    }

    return new Blob([excelBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
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

      expr = transformIf(expr);
      expr = transformRound(expr);

      // 3. Math replacements
      expr = expr.replace(/\bABS\s*\(/gi, 'Math.abs(');
      expr = expr.replace(/(^|[^<>=!])=([^=])/g, '$1==$2');
      expr = expr.replace(/<>/g, '!=');
      expr = expr.replace(/\^/g, '**');

      // 4. Value Resolution Context Helper
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
          } else if (typeof current === 'object') {
            current = current[part];
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

      // 5. Extract and replace all tokens/paths in formula
      const tokenRegex = /\b(?:[a-zA-Z_][a-zA-Z0-9_]*|doc\.[a-zA-Z0-9_.]+|dades\.[a-zA-Z0-9_.]+)(?:\[\d+\])?(?:\.[a-zA-Z_][a-zA-Z0-9_.]*(?:\[\d+\])?)*\b/g;
      const reservedKeywords = new Set([
        'SI', 'IF', 'ARRODONEIX', 'ROUND', 'ABS', 'MIN', 'MAX', 'Math', '__round',
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

      const safeEval = new Function('__round', `"use strict"; return (${expr});`);
      const __round = (val, prec = 0) => {
        const p = Math.pow(10, prec);
        return Math.round(parseFloat(val) * p) / p;
      };

      const result = safeEval(__round);

      if (typeof result === 'number' && !isNaN(result) && isFinite(result)) {
        return Math.round(result * 100) / 100;
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

  const evaluateComputedFields = (data) => {
    if (!data || !store.editorMetadata || !Array.isArray(store.editorMetadata) || store.editorMetadata.length === 0) return;

    const computedMetas = store.editorMetadata.filter(m => m.type === 'Computed');
    if (computedMetas.length === 0) return;

    const customMetas = computedMetas.filter(m => (m.calcFn || '').toUpperCase() === 'CUSTOM' && m.calcFormula);
    const aggMetas = computedMetas.filter(m => (m.calcFn || '').toUpperCase() !== 'CUSTOM');

    // Helper to evaluate CUSTOM formulas on a container (bottom-up)
    const runCustomPass = (container, groupHint = '') => {
      if (!container || typeof container !== 'object') return;

      if (Array.isArray(container)) {
        container.forEach(item => runCustomPass(item, groupHint));
        return;
      }

      // First recurse into child objects/arrays (bottom-up)
      Object.keys(container).forEach(k => {
        if (k !== '_sheet_info' && k !== '_hierarchy_schema' && k !== 'editor_metadata') {
          const val = container[k];
          if (val && typeof val === 'object') {
            runCustomPass(val, Array.isArray(val) ? k : groupHint);
          }
        }
      });

      // Evaluate CUSTOM formulas for this node
      customMetas.forEach(meta => {
        if (!meta.group || meta.group === groupHint || (meta.element in container)) {
          const calculatedVal = evaluateCustomFormula(meta.calcFormula, container, data);
          if (container[meta.element] !== calculatedVal) {
            container[meta.element] = calculatedVal;
          }
        }
      });
    };

    // Helper to evaluate Aggregation (SUM, COUNT, AVG) formulas on a container (bottom-up)
    const runAggPass = (container, groupHint = '') => {
      if (!container || typeof container !== 'object') return;

      if (Array.isArray(container)) {
        container.forEach(item => runAggPass(item, groupHint));
        return;
      }

      // First recurse into child objects/arrays (bottom-up)
      Object.keys(container).forEach(k => {
        if (k !== '_sheet_info' && k !== '_hierarchy_schema' && k !== 'editor_metadata') {
          const val = container[k];
          if (val && typeof val === 'object') {
            runAggPass(val, Array.isArray(val) ? k : groupHint);
          }
        }
      });

      // Evaluate Aggregation formulas for this node
      aggMetas.forEach(meta => {
        const targetVec = meta.calcVector;
        const fn = (meta.calcFn || 'SUM').toUpperCase();
        const col = meta.calcTargetCol;

        if (!meta.group || meta.group === groupHint || (targetVec && container[targetVec]) || (meta.element in container)) {
          let childList = null;
          if (targetVec && Array.isArray(container[targetVec])) {
            childList = container[targetVec];
          } else if (targetVec && data[targetVec] && Array.isArray(data[targetVec])) {
            childList = data[targetVec];
          }

          if (childList) {
            let calculatedVal = 0;
            if (fn === 'COUNT') {
              calculatedVal = childList.length;
            } else if (fn === 'SUM' && col) {
              const total = childList.reduce((sum, child) => {
                const val = parseFloat(child[col]);
                return sum + (isNaN(val) ? 0 : val);
              }, 0);
              calculatedVal = Math.round(total * 100) / 100;
            } else if (fn === 'AVG' && col) {
              const numbers = childList.map(c => parseFloat(c[col])).filter(n => !isNaN(n));
              const avg = numbers.length > 0 ? numbers.reduce((a, b) => a + b, 0) / numbers.length : 0;
              calculatedVal = Math.round(avg * 100) / 100;
            }

            if (container[meta.element] !== calculatedVal) {
              container[meta.element] = calculatedVal;
            }
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

    // Re-parse the updated Excel file
    const parsedData = await parseExcel(newBuffer);
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
