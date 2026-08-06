import { ref } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import * as pandocModule from '../vendor/pandoc/pandoc.js';

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
from jinja2 import Environment, StrictUndefined, pass_context
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

def _detect_kind(rows):
    if not rows:
        return 'empty'
    if _is_kv_header(rows[0]):
        return 'kv_header'
    
    first = rows[0]
    headers = [v for v in first if v not in (None, '')]
    if len(headers) >= 3 and all(isinstance(v, str) for v in headers) and len(set(headers)) == len(headers):
        if len(rows) >= 2 and any(v not in (None,'') for v in rows[1]):
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

def _parse_table(rows):
    headers = [sanitize_id(h) for h in rows[0]]
    out = []
    for rr in rows[1:]:
        if all(v in (None, '') for v in rr):
            continue
        obj = {}
        for i, h in enumerate(headers):
            if h in (None, ''):
                continue
            obj[h] = rr[i] if i < len(rr) else None
        out.append(obj)
    return out

def _parse_sheet(ws, date_format='iso'):
    rows = _read_rows(ws, date_format)
    kind = _detect_kind(rows)
    if kind == 'kv_header':
        return 'kv', _parse_kv(rows, start_row=1)
    if kind == 'kv':
        return 'kv', _parse_kv(rows, start_row=0)
    if kind == 'tabular':
        return 'tabular', _parse_table(rows)
    return kind, None

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
    if os.path.exists('/work/in.json'):
        try:
            with open('/work/in.json', 'r', encoding='utf-8') as f:
                data = json.load(f)
                return _cast_numeric_strings(data)
        except Exception:
            pass

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

    sorted_raw_names = sorted(parsed.keys(), key=_sheet_depth)
    
    hierarchy_schema = {}

    for raw_name in sorted_raw_names:
        kind, data = parsed[raw_name]
        stripped = raw_name
        if has_prefixed_sheets:
            for pfx in valid_prefixes:
                if raw_name.upper().startswith(pfx):
                    stripped = raw_name[len(pfx):]
                    break
        
        parts = [sanitize_id(p) for p in stripped.split('.')]
        path_str = '.'.join(parts)
        
        fields = []
        if isinstance(data, list) and data:
            ref_k = next(iter(data[0].keys())) if len(parts) > 1 else None
            fields = [k for k in data[0].keys() if k != ref_k]
        elif isinstance(data, dict):
            fields = [k for k, v in data.items() if not isinstance(v, (list, dict))]
            
        if path_str not in hierarchy_schema:
            hierarchy_schema[path_str] = {'fields': fields, 'children': []}
        else:
            if fields:
                hierarchy_schema[path_str]['fields'] = fields
            
        if len(parts) > 1:
            parent_path_str = '.'.join(parts[:-1])
            sub_key = parts[-1]
            if parent_path_str not in hierarchy_schema:
                hierarchy_schema[parent_path_str] = {'fields': [], 'children': []}
            if sub_key not in hierarchy_schema[parent_path_str]['children']:
                hierarchy_schema[parent_path_str]['children'].append(sub_key)
        
        if len(parts) == 1:
            root[parts[0]] = data if data is not None else {}
        else:
            parent_parts = parts[:-1]
            sub_key = parts[-1]
            
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
                        if not parent:
                            parent[sub_key] = data_to_set
                            continue
                        
                        child_ref_key = next(iter(data_to_set[0].keys())) if data_to_set else None
                        
                        if child_ref_key and child_ref_key in parent:
                            groups = defaultdict(list)
                            for child_row in data_to_set:
                                ref_val = child_row.get(child_ref_key)
                                clean_child = {k: v for k, v in child_row.items() if k != child_ref_key}
                                groups[ref_val].append(clean_child)
                                
                            parent_ref_val = parent.get(child_ref_key)
                            parent[sub_key] = groups.get(parent_ref_val, [])
                        else:
                            parent[sub_key] = data_to_set
                    else:
                        parent[sub_key] = data_to_set

    root['_hierarchy_schema'] = hierarchy_schema
    return root

def update_excel_from_json(excel_path, json_str, out_excel_path):
    wb = load_workbook(excel_path)
    data = json.loads(json_str)
    
    valid_prefixes = ('OUT_', 'JSON_', 'EXPORT_')
    has_prefixed_sheets = any(sheet.upper().startswith(valid_prefixes) for sheet in wb.sheetnames)
    
    for sheet_name in wb.sheetnames:
        sheet_name_upper = sheet_name.upper()
        if has_prefixed_sheets and not sheet_name_upper.startswith(valid_prefixes):
            continue
            
        stripped_name = sheet_name
        if has_prefixed_sheets:
            for prefix in valid_prefixes:
                if sheet_name_upper.startswith(prefix):
                    stripped_name = sheet_name[len(prefix):]
                    break
                    
        sheet_id = sanitize_id(stripped_name)
        
        if sheet_id == 'editor_metadata':
            ws = wb[sheet_name]
            meta_data = data.get('editor_metadata', [])
            ws.delete_rows(1, ws.max_row)
            headers = ['group', 'element', 'type', 'options', 'sourceType', 'multiple', 'vectorPath', 'displayField', 'valueField', 'width']
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
            continue
            
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
                active_cols = [sanitize_id(k) for k in sheet_data[0].keys() if k]
            
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

    wb.save(out_excel_path)

# -------------------- Jinja: recuperació d'errors --------------------
RE_DOTTED = re.compile(r"\\b([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)+)\\b")

def _wrap_safe(val, path):
    if isinstance(val, dict):
        if isinstance(val, SafeDict):
            return val
        return SafeDict(val, path)
    elif isinstance(val, list):
        return [_wrap_safe(item, f"{path}[{idx}]") for idx, item in enumerate(val)]
    return val

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
    def __init__(self, d, path, enable_links=True):
        super().__init__()
        self._path = path
        self.enable_links = enable_links
        for k, v in d.items():
            sub_path = f"{path}.{k}" if path else k
            self[k] = _wrap_tracked(v, sub_path, enable_links)

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
    def __init__(self, lst, path, enable_links=True):
        super().__init__()
        self._path = path
        self.enable_links = enable_links
        for idx, item in enumerate(lst):
            sub_path = f"{path}.{idx}"
            self.append(_wrap_tracked(item, sub_path, enable_links))

def _wrap_tracked(val, path='', enable_links=True):
    if isinstance(val, dict):
        if isinstance(val, TrackedDict):
            return val
        return TrackedDict(val, path, enable_links)
    elif isinstance(val, list):
        if isinstance(val, TrackedList):
            return val
        return TrackedList(val, path, enable_links)
    elif isinstance(val, (SafeDict, Placeholder)):
        return val
    elif isinstance(val, TrackedValue):
        return val
    return TrackedValue(val, path, enable_links)

class SafeDict(dict):
    def __init__(self, d, path):
        super().__init__()
        self._path = path
        for k, v in d.items():
            self[k] = _wrap_safe(v, f"{path}.{k}")

    def __getitem__(self, key):
        if key not in self:
            return Placeholder(f"{self._path}.{key}")
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
            return Placeholder(f"{self._path}.{key}")
        return super().get(key, default)

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

def render_with_recovery(env, template_src, ctx, pass_label, max_fixes=1000):
    issues = []
    current_src = template_src
    for _ in range(max_fixes):
        try:
            out = env.from_string(current_src).render(**ctx)
            return out, issues
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

def update_excel_from_json(excel_path, json_str, out_excel_path):
    wb = load_workbook(excel_path)
    data = json.loads(json_str)
    
    valid_prefixes = ('OUT_', 'JSON_', 'EXPORT_')
    has_prefixed_sheets = any(sheet.upper().startswith(valid_prefixes) for sheet in wb.sheetnames)
    
    for sheet_name in wb.sheetnames:
        sheet_name_upper = sheet_name.upper()
        if has_prefixed_sheets and not sheet_name_upper.startswith(valid_prefixes):
            continue
            
        stripped_name = sheet_name
        if has_prefixed_sheets:
            for prefix in valid_prefixes:
                if sheet_name_upper.startswith(prefix):
                    stripped_name = sheet_name[len(prefix):]
                    break
                    
        sheet_id = sanitize_id(stripped_name)
        if sheet_id in data:
            sheet_data = data[sheet_id]
            ws = wb[sheet_name]
            
            if sheet_id == 'editor_metadata':
                # Overwrite completely to ensure all new schema fields are present
                ws.delete_rows(1, ws.max_row)
                headers = ['group', 'element', 'type', 'options', 'sourceType', 'multiple', 'vectorPath', 'displayField', 'valueField', 'width']
                for c_idx, h in enumerate(headers):
                    ws.cell(1, c_idx + 1).value = h
                
                for r_idx, row_obj in enumerate(sheet_data):
                    excel_row = r_idx + 2
                    for c_idx, h in enumerate(headers):
                        val = row_obj.get(h, '')
                        if isinstance(val, list):
                            val = ', '.join(str(x) for x in val)
                        elif isinstance(val, bool):
                            val = int(val)
                        write_cell_value(ws, excel_row, c_idx + 1, val)
                ws.sheet_state = 'hidden'
                continue
                
            rows = _read_rows(ws, 'iso')
            kind = _detect_kind(rows)
            
            if kind in ('kv', 'kv_header'):
                start_row = 1 if kind == 'kv_header' else 0
                
                # First, find and update or delete existing keys
                # Iterate backwards to safely delete rows
                existing_keys = set()
                for r in range(ws.max_row, start_row, -1):
                    k_val = ws.cell(r, 1).value
                    if k_val not in (None, ''):
                        s_key = sanitize_id(k_val)
                        if s_key in sheet_data:
                            existing_keys.add(s_key)
                            val = sheet_data[s_key]
                            write_cell_value(ws, r, 2, val)
                        else:
                            # Key was deleted in JSON, delete row in Excel
                            ws.delete_rows(r)
                            
                # Now, add new keys that are not in Excel
                for k_val, val in sheet_data.items():
                    s_key = sanitize_id(k_val)
                    if s_key not in existing_keys:
                        next_row = ws.max_row + 1
                        ws.cell(next_row, 1).value = k_val # Use the key name directly
                        write_cell_value(ws, next_row, 2, val)
                            
            elif kind == 'tabular':
                # 1. Read existing headers from Excel row 1
                excel_headers = []
                for c in range(1, ws.max_column + 1):
                    val = ws.cell(1, c).value
                    excel_headers.append(sanitize_id(val) if val not in (None, '') else '')
                
                # 2. Determine current active columns from JSON sheet_data
                active_cols = []
                if sheet_data:
                    active_cols = [sanitize_id(k) for k in sheet_data[0].keys() if k]
                
                # 3. Handle deleted columns:
                # If a column header in Excel is NOT in active_cols, we delete it from Excel (iterate backwards!)
                for c_idx in range(len(excel_headers) - 1, -1, -1):
                    h = excel_headers[c_idx]
                    if h and h not in active_cols:
                        ws.delete_cols(c_idx + 1)
                
                # Re-read headers after deletion
                excel_headers = []
                for c in range(1, ws.max_column + 1):
                    val = ws.cell(1, c).value
                    excel_headers.append(sanitize_id(val) if val not in (None, '') else '')
                
                # 4. Handle added columns:
                # If a column in active_cols is NOT in excel_headers, append it at the end of Excel sheet
                for h in active_cols:
                    if h not in excel_headers:
                        new_col_idx = len(excel_headers) + 1
                        ws.cell(1, new_col_idx).value = h
                        excel_headers.append(h)
                
                # 5. Delete excess rows in Excel
                excess = ws.max_row - (len(sheet_data) + 1)
                if excess > 0:
                    ws.delete_rows(len(sheet_data) + 2, excess)
                    
                # 6. Write data cells
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
                            write_cell_value(ws, excel_row, c_idx + 1, val)
                            
        elif '.' in sheet_name:
            base_raw, sub_raw = sheet_name.split('.', 1)
            
            stripped_base = base_raw
            if has_prefixed_sheets:
                base_raw_upper = base_raw.upper()
                if not base_raw_upper.startswith(valid_prefixes):
                    continue
                for prefix in valid_prefixes:
                    if base_raw_upper.startswith(prefix):
                        stripped_base = base_raw[len(prefix):]
                        break
                        
            base_id = sanitize_id(stripped_base)
            sub_id = sanitize_id(sub_raw)
            
            if base_id in data and isinstance(data[base_id], list):
                ws = wb[sheet_name]
                if ws.max_row >= 2:
                    headers = [sanitize_id(ws.cell(1, c).value) for c in range(1, ws.max_column + 1)]
                    ref_key = headers[0]
                    
                    flat_rows = []
                    parent_key_field = list(data[base_id][0].keys())[0] if data[base_id] else None
                    
                    for parent_row in data[base_id]:
                        p_val = parent_row.get(parent_key_field)
                        children = parent_row.get(sub_id, [])
                        for child in children:
                            child_row = {ref_key: p_val}
                            child_row.update(child)
                            flat_rows.append(child_row)
                            
                    # Delete excess rows in Excel sub-sheet
                    excess = ws.max_row - (len(flat_rows) + 1)
                    if excess > 0:
                        ws.delete_rows(len(flat_rows) + 2, excess)
                        
                    # Write data
                    for r_idx, row_obj in enumerate(flat_rows):
                        excel_row = r_idx + 2
                        for c_idx, h in enumerate(headers):
                            if h and h in row_obj:
                                val = row_obj[h]
                                write_cell_value(ws, excel_row, c_idx + 1, val)
                                
    wb.save(out_excel_path)

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
        
    for sheet_name, sheet_content in data.items():
        ws = wb.create_sheet(title=str(sheet_name))
        if isinstance(sheet_content, dict):
            ws.append(["Clau", "Valor"])
            for k, v in sheet_content.items():
                if isinstance(v, (dict, list)):
                    continue
                ws.append([str(k), "" if v is None else str(v)])
        elif isinstance(sheet_content, list) and len(sheet_content) > 0:
            headers = [k for k in sheet_content[0].keys() if not isinstance(sheet_content[0][k], (dict, list))]
            ws.append(headers)
            for row in sheet_content:
                ws.append(["" if row.get(h) is None else str(row.get(h)) for h in headers])
        else:
            ws.append(["Dada"])
            ws.append([str(sheet_content)])
            
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

def _filter_empty_rows(data):
    if isinstance(data, dict):
        new_dict = {}
        for k, v in data.items():
            if k == 'editor_metadata':
                new_dict[k] = v
            else:
                new_dict[k] = _filter_empty_rows(v)
        return new_dict
    elif isinstance(data, list):
        filtered_list = []
        for item in data:
            if isinstance(item, dict):
                is_empty = all(v in (0, 0.0, '', None, False) for v in item.values())
                if not is_empty:
                    filtered_list.append(_filter_empty_rows(item))
            else:
                filtered_list.append(_filter_empty_rows(item))
        return filtered_list
    return data

def render_md_two_pass_with_report(excel_path, template_path, date_format='iso', strict=False):
    raw_doc = excel_to_json(excel_path, date_format=date_format, strict=strict)
    doc = _filter_empty_rows(raw_doc)

    with open(template_path, 'r', encoding='utf-8') as f:
        tpl_src = f.read()

    # Pass 1: Clean Context without HTML links (for Pandoc / Word export)
    clean_ctx = _wrap_safe(doc, 'doc')
    if 'doc' not in clean_ctx:
        clean_ctx['doc'] = clean_ctx

    env_clean = Environment(undefined=StrictUndefined, autoescape=False, trim_blocks=True, lstrip_blocks=True)
    env_clean.filters['coin'] = filter_coin
    env_clean.filters['number'] = filter_number
    env_clean.filters['words'] = filter_words
    env_clean.filters['prefix'] = filter_prefix
    env_clean.globals['TRUE'] = True
    env_clean.globals['FALSE'] = False
    env_clean.globals['true'] = True
    env_clean.globals['false'] = False

    out1_clean, issues1 = render_with_recovery(env_clean, tpl_src, clean_ctx, 'primera')
    out2_clean, issues2 = render_with_recovery(env_clean, out1_clean, clean_ctx, 'segona')
    all_issues = issues1 + issues2

    # Pass 2: Tracked Context with HTML links (for HTML preview)
    html_ctx = _wrap_tracked(doc, '', enable_links=True)
    if 'doc' not in html_ctx:
        html_ctx['doc'] = html_ctx

    env_html = Environment(undefined=StrictUndefined, autoescape=False, trim_blocks=True, lstrip_blocks=True)
    env_html.filters['coin'] = filter_coin
    env_html.filters['number'] = filter_number
    env_html.filters['words'] = filter_words
    env_html.filters['prefix'] = filter_prefix
    env_html.globals['TRUE'] = True
    env_html.globals['FALSE'] = False
    env_html.globals['true'] = True
    env_html.globals['false'] = False

    out1_html, _ = render_with_recovery(env_html, tpl_src, html_ctx, 'primera_html')
    out2_html, _ = render_with_recovery(env_html, out1_html, html_ctx, 'segona_html')

    return json.dumps({
        'markdown': out2_clean,
        'htmlMarkdown': out2_html,
        'issues': all_issues
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
      const sheetData = parsed[sheetName];
      if (Array.isArray(sheetData)) {
        sheetData.forEach(row => {
          const isAllZeros = Object.values(row).every(val => 
            val === 0 || val === 0.0 || val === '' || val === null || val === undefined || val === false
          );
          if (isAllZeros) {
            Object.keys(row).forEach(key => {
              row[key] = '';
            });
          }
        });
      }
    });

    const cleanedJsonStr = JSON.stringify(parsed);
    
    // Save to in.json in Pyodide FS as well
    _pyodide.FS.writeFile('/work/in.json', new TextEncoder().encode(cleanedJsonStr));
    
    return parsed;
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
      } catch (err) {
        store.addLog(`Error al restaurar fitxer Excel virtual: ${err.message}`, 'warning');
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
    const dataToSave = jsonData || store.excelJsonData || {};
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
    return new Blob([excelBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  };

  return {
    initEngines,
    parseExcel,
    renderMarkdown,
    compileDocx,
    saveExcelData,
    writeVirtualExcel,
    isLoading
  };
}
