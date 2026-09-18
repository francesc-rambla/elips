# elips — Editor de LIcitacions PúbliqueS
# Copyright (C) 2026  Francesc Rambla i Marigot
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""Excel <-> JSON conversion: reading a workbook into the app's data tree
plus hierarchy schema, and writing JSON data back into an existing workbook
(including simple-link-formula and complex-formula/orphan preservation)."""

import re
import json

from openpyxl import load_workbook

from .text_utils import sanitize_id, _col_letter, _col_index_from_letter, _custom_json_default, _to_jsonable

SIMPLE_LINK_REGEX = re.compile(r"^=[+]?(?:(?:'([^']+)'|([A-Za-z0-9_\.]+))!)?[$]?[A-Za-z]+[$]?[0-9]+$", re.IGNORECASE)
REF_REGEX = re.compile(r"=[+]?(?:'([^']+)'|([A-Za-z0-9_\.]+))!([A-Za-z0-9$]+)", re.IGNORECASE)


def is_simple_link_formula(val_str):
    if not isinstance(val_str, str):
        return False
    s = val_str.strip()
    if not s.startswith('='):
        return False
    return bool(SIMPLE_LINK_REGEX.match(s))


def get_referenced_cell(ws, cell):
    val = str(cell.value or '').strip()
    if not val.startswith('='):
        return None
    m = REF_REGEX.search(val)
    if m:
        target_sheet_name = m.group(1) or m.group(2)
        cell_coord = m.group(3).replace('$', '')
        wb = ws.parent

        matched_sheet = None
        target_upper = target_sheet_name.upper()

        # 1. Exact or case-insensitive match
        for s in wb.sheetnames:
            if s.upper() == target_upper:
                matched_sheet = s
                break

        # 2. Try with or without valid prefixes (OUT_, JSON_, EXPORT_)
        if not matched_sheet:
            prefixes = ('OUT_', 'JSON_', 'EXPORT_')
            clean_target = target_upper
            for pfx in prefixes:
                if clean_target.startswith(pfx):
                    clean_target = clean_target[len(pfx):]
                    break

            for s in wb.sheetnames:
                s_clean = s.upper()
                for pfx in prefixes:
                    if s_clean.startswith(pfx):
                        s_clean = s_clean[len(pfx):]
                        break
                if s_clean == clean_target:
                    matched_sheet = s
                    break

        # 3. Create target sheet on-the-fly if missing in workbook
        if not matched_sheet:
            try:
                matched_sheet = target_sheet_name
                wb.create_sheet(title=matched_sheet)
            except Exception:
                pass

        if matched_sheet and matched_sheet in wb.sheetnames:
            from openpyxl.cell.cell import MergedCell
            target_ws = wb[matched_sheet]
            ref_c = target_ws[cell_coord]
            if isinstance(ref_c, MergedCell) or type(ref_c).__name__ == 'MergedCell':
                for rng in target_ws.merged_cells.ranges:
                    if ref_c.coordinate in rng:
                        ref_c = target_ws.cell(rng.min_row, rng.min_col)
                        break
            return ref_c

    return None


def write_cell_value(ws, row_idx, col_idx, value, orphan_records=None):
    from openpyxl.utils import get_column_letter
    from openpyxl.cell.cell import MergedCell

    cell = ws.cell(row_idx, col_idx)
    if isinstance(cell, MergedCell) or type(cell).__name__ == 'MergedCell':
        for rng in ws.merged_cells.ranges:
            if cell.coordinate in rng:
                cell = ws.cell(rng.min_row, rng.min_col)
                break

    target_cell = cell
    visited = set()

    current_val_str = str(cell.value or '').strip()

    # 1. Auto-propagate reference formula if current cell lacks formula but preceding row in column has a simple link formula
    if (cell.value is None or current_val_str == '' or not current_val_str.startswith('=')) and row_idx > 2:
        for ref_r in range(2, row_idx):
            prev_cell = ws.cell(ref_r, col_idx)
            if is_simple_link_formula(str(prev_cell.value or '')):
                ref_target = get_referenced_cell(ws, prev_cell)
                if ref_target is not None:
                    ref_sheet_name = ref_target.parent.title
                    col_letter = get_column_letter(col_idx)
                    propagated_formula = f"='{ref_sheet_name}'!{col_letter}{row_idx}"
                    cell.value = propagated_formula
                    target_cell = cell
                    current_val_str = propagated_formula
                    break

    # 2. Check if destination cell itself is a Complex Formula (starts with '=' but is NOT a simple 1-to-1 link)
    if current_val_str.startswith('='):
        if not is_simple_link_formula(current_val_str):
            if orphan_records is not None:
                orphan_records.append({
                    'Full': ws.title,
                    'Coordenada': cell.coordinate,
                    'Fórmula Original': current_val_str,
                    'Valor No Escrit': value
                })
            return

    # 3. Traverse simple link reference chain
    while True:
        target_val_str = str(target_cell.value or '').strip()
        if target_val_str.startswith('='):
            if not is_simple_link_formula(target_val_str):
                if orphan_records is not None:
                    orphan_records.append({
                        'Full': target_cell.parent.title,
                        'Coordenada': target_cell.coordinate,
                        'Fórmula Original': target_val_str,
                        'Valor No Escrit': value
                    })
                return

        ref_cell = get_referenced_cell(target_cell.parent, target_cell)
        if ref_cell is None:
            break
        ref_key = f"{ref_cell.parent.title}!{ref_cell.coordinate}"
        if ref_key in visited:
            break
        visited.add(ref_key)
        target_cell = ref_cell

    if isinstance(value, (list, dict)):
        value = json.dumps(value, ensure_ascii=False, default=_custom_json_default)

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

    if isinstance(target_cell, MergedCell) or type(target_cell).__name__ == 'MergedCell':
        for rng in target_cell.parent.merged_cells.ranges:
            if target_cell.coordinate in rng:
                target_cell = target_cell.parent.cell(rng.min_row, rng.min_col)
                break

    if not (isinstance(target_cell, MergedCell) or type(target_cell).__name__ == 'MergedCell'):
        target_cell.value = value


def _resolve_simple_cell_ref(form_str, wb_data, wb_formula, current_ws_name='', visited=None):
    if visited is None:
        visited = set()
    if not isinstance(form_str, str) or not form_str.startswith('='):
        return False, None
    clean = form_str.strip()
    if clean in visited:
        return True, ''
    visited.add(clean)

    m = re.match(r"^=[+]?(?:'([^']+)'|([A-Za-z0-9_\.]+))![$]?([A-Za-z]+)[$]?([0-9]+)$", clean)
    if m:
        target_sheet = m.group(1) or m.group(2)
        col_str = m.group(3).upper()
        row_num = int(m.group(4))

        resolved_sheet = target_sheet
        if resolved_sheet not in wb_data.sheetnames:
            if f"OUT_{resolved_sheet}" in wb_data.sheetnames:
                resolved_sheet = f"OUT_{resolved_sheet}"
            elif resolved_sheet.startswith("OUT_") and resolved_sheet[4:] in wb_data.sheetnames:
                resolved_sheet = resolved_sheet[4:]

        if resolved_sheet in wb_data.sheetnames:
            col_num = 0
            for char in col_str:
                col_num = col_num * 26 + (ord(char) - ord('A') + 1)

            ws_d = wb_data[resolved_sheet]
            ws_f = wb_formula[resolved_sheet]

            val_d = ws_d.cell(row_num, col_num).value
            val_f = ws_f.cell(row_num, col_num).value

            if isinstance(val_f, str) and val_f.startswith('='):
                is_sub, sub_val = _resolve_simple_cell_ref(val_f, wb_data, wb_formula, resolved_sheet, visited)
                if is_sub:
                    return True, sub_val

            if val_d is not None and str(val_d).strip() != '':
                return True, val_d
            if val_f is not None and not str(val_f).startswith('='):
                return True, val_f
            return True, ''
    return False, None


def _read_rows(ws_d, ws_f=None, wb_data=None, wb_formula=None, ws_name='', date_format='iso'):
    ws_f = ws_f if ws_f is not None else ws_d
    rows = []
    max_c = ws_d.max_column
    for r in range(1, ws_d.max_row + 1):
        row = []
        for c in range(1, max_c + 1):
            val_d = ws_d.cell(r, c).value
            val_f = ws_f.cell(r, c).value if ws_f else val_d

            val = _to_jsonable(val_d, date_format)
            if wb_data and wb_formula and isinstance(val_f, str) and val_f.startswith('='):
                is_link, target_val = _resolve_simple_cell_ref(val_f, wb_data, wb_formula, ws_name)
                if is_link:
                    if target_val not in (None, ''):
                        val = _to_jsonable(target_val, date_format)
                    else:
                        val = ''
                else:
                    if val is None:
                        val = ''
            elif val is None:
                val = _to_jsonable(val_f, date_format) if val_f is not None else ''

            row.append(val)

        if all(v in (None, '') for v in row):
            continue
        rows.append(row)
    return rows


def _is_kv_header(first_row):
    if not first_row or len(first_row) < 2:
        return False
    a = str(first_row[0]).strip().lower() if first_row[0] not in (None, '') else ''
    b = str(first_row[1]).strip().lower() if first_row[1] not in (None, '') else ''
    return (a in ('clau', 'key') and b in ('valor', 'value'))


def _validate_and_detect_kind(rows, raw_name=""):
    raw_upper = (raw_name or "").upper()
    valid_pfxs = ('OUT_', 'EXPORT_', 'JSON_')
    is_prefixed = any(raw_upper.startswith(pfx) for pfx in valid_pfxs)
    is_dotted = '.' in raw_name

    if not rows:
        if is_prefixed or is_dotted:
            return 'tabular'
        return 'kv'

    if _is_kv_header(rows[0]):
        return 'kv_header'

    first = rows[0]
    headers_non_empty = [v for v in first if v not in (None, '')]

    # Single-level sheets (without dots in name) with fewer than 3 columns default to KV
    is_tabular = is_dotted or (len(headers_non_empty) >= 3)

    if not is_tabular:
        return 'kv'

    header_row_idx = 0
    if len(headers_non_empty) <= 1 and len(rows) > 1:
        r1_non_empty = [v for v in rows[1] if v not in (None, '')]
        if len(r1_non_empty) >= 2:
            header_row_idx = 1

    header_row = rows[header_row_idx]

    seen_raw_headers = {}
    seen_clean_headers = {}
    valid_count = 0

    for col_idx_0, raw_val in enumerate(header_row):
        if raw_val in (None, ''):
            continue

        col_letter = _col_letter(col_idx_0 + 1)

        if not isinstance(raw_val, str):
            raise ValueError(f"El full '{raw_name}' té una estructura tabular però la capçalera '{raw_val}' (columna {col_letter}) no és un text.")

        clean_h = sanitize_id(raw_val)
        if not clean_h:
            raise ValueError(f"El full '{raw_name}' té una estructura tabular però la capçalera '{raw_val}' (columna {col_letter}) no és un text vàlid.")

        if raw_val in seen_raw_headers:
            prev_col_letter = _col_letter(seen_raw_headers[raw_val] + 1)
            raise ValueError(f"El full '{raw_name}' té una estructura tabular però les capçaleres de les columnes {prev_col_letter} i {col_letter} ('{raw_val}') són iguals.")

        if clean_h in seen_clean_headers:
            prev_col_letter = _col_letter(seen_clean_headers[clean_h] + 1)
            prev_raw = header_row[seen_clean_headers[clean_h]]
            raise ValueError(f"El full '{raw_name}' té una estructura tabular però les capçaleres de les columnes {prev_col_letter} i {col_letter} ('{prev_raw}' i '{raw_val}') són iguals.")

        seen_raw_headers[raw_val] = col_idx_0
        seen_clean_headers[clean_h] = col_idx_0
        valid_count += 1

    if valid_count == 0:
        raise ValueError(f"El full '{raw_name}' té una estructura tabular però la fila {header_row_idx + 1} no conté cap capçalera vàlida.")

    return 'tabular', header_row_idx


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


def _parse_table(rows, header_row_idx=0):
    if not rows or len(rows) <= header_row_idx:
        return []
    header_row = rows[header_row_idx]
    headers = []
    for col_idx, raw_h in enumerate(header_row):
        if raw_h in (None, ''):
            continue
        clean_h = sanitize_id(str(raw_h))
        if clean_h:
            headers.append((col_idx, clean_h))

    if not headers:
        return []

    out = []
    for rr in rows[header_row_idx + 1:]:
        if all(v in (None, '', 0, 0.0, '0', '0.0', '00:00:00', False) for v in rr):
            continue
        obj = {}
        for col_idx, h_name in headers:
            val = rr[col_idx] if col_idx < len(rr) else None
            obj[h_name] = val if val is not None else ''
        out.append(obj)
    return out


def _parse_sheet(ws_d, ws_f, wb_data, wb_formula, date_format='iso'):
    rows = _read_rows(ws_d, ws_f, wb_data, wb_formula, ws_d.title, date_format)
    kind_res = _validate_and_detect_kind(rows, ws_d.title)
    if isinstance(kind_res, tuple):
        kind, header_row_idx = kind_res
    else:
        kind = kind_res
        header_row_idx = 0

    headers = []
    if rows and len(rows) > header_row_idx:
        headers = [sanitize_id(h) for h in rows[header_row_idx] if h not in (None, '')]

    if kind == 'kv_header':
        return 'kv', _parse_kv(rows, start_row=1), headers
    if kind == 'kv':
        return 'kv', _parse_kv(rows, start_row=0), headers
    if kind == 'tabular':
        return 'tabular', _parse_table(rows, header_row_idx=header_row_idx), headers
    return kind, [], headers


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
        is_id_key = any(term in str(p_ref_key or '').lower() for term in ['id', 'codi', 'code', 'ref', 'key', 'num'])

        alt_sub_key = sub_key + 's' if not sub_key.endswith('s') else sub_key[:-1]
        children = p_item.get(sub_key)
        if children is None:
            children = p_item.get(alt_sub_key, [])

        if isinstance(children, list):
            for child in children:
                if isinstance(child, dict):
                    row = {}
                    child_lower = {str(k).strip().lower(): k for k in child.keys()}
                    if p_ref_key and p_ref_val is not None and is_id_key:
                        p_lower = str(p_ref_key).strip().lower()
                        if p_lower in child_lower:
                            row[child_lower[p_lower]] = p_ref_val
                        else:
                            row[p_ref_key] = p_ref_val
                    for k, v in child.items():
                        if not isinstance(v, (list, dict)):
                            if k not in row:
                                row[k] = v
                    flat_rows.append(row)
    return flat_rows


def _is_dummy_key(val):
    if val is None:
        return True
    s = str(val).strip()
    return s in ('', '0', '0.0', '0.00', 'None', 'null', 'false', 'FALSE')


def excel_to_json(excel_path, date_format='iso', strict=False):
    wb_data = load_workbook(excel_path, data_only=True)
    wb_formula = load_workbook(excel_path, data_only=False)
    parsed = {}
    sheet_logs = []
    import_inspection = {}

    valid_prefixes = ('OUT_', 'JSON_', 'EXPORT_')
    has_prefixed_sheets = any(sheet.upper().startswith(valid_prefixes) for sheet in wb_data.sheetnames if not sheet.startswith('_'))

    sheet_order = []
    for raw_name in wb_data.sheetnames:
        if raw_name in ('editor_metadata', 'editormetadata', '_hierarchy_schema', '_hierarchy_metadata') or raw_name.startswith('_sheet_info'):
            sheet_logs.append({
                'name': raw_name,
                'processed': False,
                'kind': 'omès',
                'reason': 'Pestanya interna del sistema'
            })
            continue

        raw_upper = raw_name.upper()
        should_process = True
        if has_prefixed_sheets and not any(raw_upper.startswith(pfx) for pfx in valid_prefixes):
            should_process = False

        if not should_process:
            sheet_logs.append({
                'name': raw_name,
                'processed': False,
                'kind': 'omès',
                'reason': 'Sense prefix de processament (OUT_)'
            })
            continue

        try:
            kind, data, headers = _parse_sheet(wb_data[raw_name], wb_formula[raw_name], wb_data, wb_formula, date_format)
            parsed[raw_name] = (kind, data, headers)
            sheet_order.append(raw_name)

            clean_n = raw_name
            if has_prefixed_sheets:
                for pfx in valid_prefixes:
                    if raw_name.upper().startswith(pfx):
                        clean_n = raw_name[len(pfx):]
                        break

            inspection_rows = []
            if kind == 'tabular' and isinstance(data, list):
                for r_idx, row in enumerate(data, 1):
                    prims = [v for k, v in row.items() if not k.startswith('_') and not isinstance(v, (dict, list))]
                    is_empty = (len(prims) == 0) or all(v in (0, 0.0, '', None, False, '0', '0.0') for v in prims)
                    inspection_rows.append({
                        'index': r_idx,
                        'status': 'discarded' if is_empty else 'kept',
                        'reason': 'Fila buida / ceros de fórmula' if is_empty else 'Conté dades vàlides',
                        'data': row
                    })
            elif kind == 'kv' and isinstance(data, dict):
                for k, v in data.items():
                    is_empty = (v is None or (isinstance(v, str) and v.strip() == ''))
                    inspection_rows.append({
                        'index': k,
                        'status': 'discarded' if is_empty else 'kept',
                        'reason': 'Valor buit' if is_empty else 'Clau amb valor',
                        'data': {'key': k, 'value': v}
                    })

            import_inspection[raw_name] = {
                'raw_name': raw_name,
                'clean_name': clean_n,
                'kind': kind,
                'headers': headers or [],
                'total_rows': len(inspection_rows),
                'kept_count': sum(1 for r in inspection_rows if r['status'] == 'kept'),
                'discarded_count': sum(1 for r in inspection_rows if r['status'] == 'discarded'),
                'rows': inspection_rows
            }

            if kind == 'tabular':
                n_cols = len(headers) if headers else (len(data[0].keys()) if (isinstance(data, list) and data) else 0)
                n_rows = len(data) if isinstance(data, list) else 0
                sheet_logs.append({
                    'name': raw_name,
                    'processed': True,
                    'kind': 'tabular',
                    'cols': n_cols,
                    'rows': n_rows
                })
            elif kind == 'kv':
                n_pairs = len(data) if isinstance(data, dict) else 0
                sheet_logs.append({
                    'name': raw_name,
                    'processed': True,
                    'kind': 'kv',
                    'pairs': n_pairs
                })
            else:
                sheet_logs.append({
                    'name': raw_name,
                    'processed': True,
                    'kind': str(kind),
                    'pairs': len(data) if isinstance(data, dict) else (len(data) if isinstance(data, list) else 0)
                })
        except Exception as err:
            sheet_logs.append({
                'name': raw_name,
                'processed': False,
                'kind': 'error',
                'error': str(err)
            })

    custom_hierarchy_keys = {}
    if "_hierarchy_metadata" in wb_data.sheetnames:
        try:
            ws_meta = wb_data["_hierarchy_metadata"]
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

    root = {}
    hierarchy_schema = {}

    for raw_name in sheet_order:
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
            sub_path_str = '.'.join(parts[:idx + 1])
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
                # Only initialize path if parent keys don't exist at all in root
                curr_n = root
                can_create = True
                for p in parent_parts:
                    if p not in curr_n:
                        curr_n[p] = {}
                    elif isinstance(curr_n[p], list):
                        can_create = False
                        break
                    elif not isinstance(curr_n[p], dict):
                        can_create = False
                        break
                    curr_n = curr_n[p]
                if can_create:
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

                        # Determine if parent sheet is a KV (Key-Value) sheet or single root entity
                        parent_path_str = '.'.join(parent_parts)
                        parent_kind = None
                        for r_name, p_tuple in parsed.items():
                            r_stripped = r_name
                            if has_prefixed_sheets:
                                for pfx in valid_prefixes:
                                    if r_name.upper().startswith(pfx):
                                        r_stripped = r_name[len(pfx):]
                                        break
                            if '.'.join([sanitize_id(p) for p in r_stripped.split('.')]) == parent_path_str:
                                parent_kind = p_tuple[0]
                                break

                        # If parent is a KV entity or single root dictionary (not an item in a tabular parent list), ALL rows belong to parent[sub_key]
                        is_parent_root_dict = (len(parent_parts) == 1 and isinstance(root.get(parent_parts[0]), dict))
                        if parent_kind in ('kv', 'kv_header') or is_parent_root_dict:
                            parent[sub_key] = data_to_set
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
                                    # The child's own copy of `ck` is dropped once grouping is
                                    # resolved (see the case-insensitive branch below for why):
                                    # it's now redundant with the row's position in the tree.
                                    matched_children = [
                                        {k: v for k, v in c.items() if k != ck}
                                        for c in data_to_set
                                        if isinstance(c, dict) and str(c.get(ck, '')).strip() == p_val
                                    ]
                                    parent[sub_key] = matched_children
                                    continue

                            # Case-insensitive key matching between parent and child row keys
                            parent_keys_lower = {str(k).strip().lower(): k for k in parent.keys() if k and not _is_dummy_key(parent[k])}
                            common_pairs = []
                            for ck in sample_child.keys():
                                ck_lower = str(ck).strip().lower()
                                if ck_lower in parent_keys_lower:
                                    pk = parent_keys_lower[ck_lower]
                                    common_pairs.append((pk, ck))

                            id_pairs = [(pk, ck) for pk, ck in common_pairs if any(term in ck.lower() for term in ['id', 'codi', 'code', 'ref', 'key', 'num'])]
                            matching_pairs = id_pairs if id_pairs else common_pairs

                            if matching_pairs:
                                # Drop the column(s) used to match each child to its parent from
                                # the child's own copy in the tree once the match is resolved --
                                # it's a tabular-Excel artifact (the foreign key), not real data
                                # of the child itself. The nesting IS the relationship now, so
                                # there's no longer a redundant, independently-editable copy of
                                # it that can drift out of sync with which parent a row actually
                                # sits under (the app used to let users edit this field directly
                                # like any other, or leave it stale after moving a row to a
                                # different parent -- reconstructed instead at Excel-export time,
                                # see _extract_flat_rows_for_sheet).
                                strip_keys = {ck for _pk, ck in matching_pairs}
                                matched_children = [
                                    {k: v for k, v in c.items() if k not in strip_keys}
                                    for c in data_to_set
                                    if isinstance(c, dict) and all(str(c.get(ck, '')).strip() == str(parent.get(pk, '')).strip() for pk, ck in matching_pairs)
                                ]
                                parent[sub_key] = matched_children
                            else:
                                parent[sub_key] = []
                        else:
                            parent[sub_key] = []
                    else:
                        parent[sub_key] = data_to_set

    sheet_info_list = []
    for raw_name in sheet_order:
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

    meta_list = []
    if 'editor_metadata' in wb_data.sheetnames:
        try:
            ws_meta = wb_data['editor_metadata']
            headers = [str(ws_meta.cell(1, c).value or '').strip() for c in range(1, ws_meta.max_column + 1)]
            for r in range(2, ws_meta.max_row + 1):
                row_vals = [ws_meta.cell(r, c).value for c in range(1, len(headers) + 1)]
                if all(v in (None, '') for v in row_vals):
                    continue
                row_dict = {}
                for h, v in zip(headers, row_vals):
                    if h:
                        if v is None:
                            row_dict[h] = ''
                        elif isinstance(v, (int, float, bool, str)):
                            row_dict[h] = v
                        else:
                            row_dict[h] = str(v)
                if row_dict.get('group') or row_dict.get('element'):
                    if 'multiple' in row_dict:
                        row_dict['multiple'] = bool(row_dict['multiple']) if row_dict['multiple'] not in ('', None, 0, '0', False) else False
                    meta_list.append(row_dict)
        except Exception:
            pass

    existing_sheet_info = []
    if '_sheet_info' in wb_data.sheetnames:
        try:
            ws_si = wb_data['_sheet_info']
            headers = [str(ws_si.cell(1, c).value or '').strip() for c in range(1, ws_si.max_column + 1)]
            for r in range(2, ws_si.max_row + 1):
                row_vals = [ws_si.cell(r, c).value for c in range(1, len(headers) + 1)]
                if all(v in (None, '') for v in row_vals):
                    continue
                row_dict = {}
                for h, v in zip(headers, row_vals):
                    if h:
                        if v is None:
                            row_dict[h] = ''
                        elif isinstance(v, (int, float, bool, str)):
                            row_dict[h] = v
                        else:
                            row_dict[h] = str(v)
                if row_dict.get('clean_name') or row_dict.get('raw_name'):
                    if isinstance(row_dict.get('headers'), str):
                        row_dict['headers'] = [h.strip() for h in row_dict['headers'].split(',') if h.strip()]
                    existing_sheet_info.append(row_dict)
        except Exception:
            pass

    root['_sheet_info'] = existing_sheet_info if existing_sheet_info else sheet_info_list
    root['_sheet_logs'] = sheet_logs
    root['_excel_import_inspection'] = import_inspection
    root['editor_metadata'] = meta_list

    return {
        'data': root,
        'hierarchy_schema': hierarchy_schema
    }


def _strip_ref_keys_recursive(data_node, schema_node, ancestor_ref_keys=frozenset()):
    if not isinstance(schema_node, dict):
        return
    children_schema = schema_node.get('children') or {}
    if not children_schema:
        return

    # A KV group's data_node is a single dict (one "item"); a tabular
    # group's is the list of its rows, each row its own "item".
    items = data_node if isinstance(data_node, list) else ([data_node] if isinstance(data_node, dict) else [])

    for item in items:
        if not isinstance(item, dict):
            continue
        for child_name, child_schema in children_schema.items():
            if child_name not in item:
                continue
            child_data = item[child_name]
            child_ref_key = child_schema.get('ref_key')
            # Strip this level's own ref_key (its link to its immediate
            # parent) AND every ancestor's, since some source workbooks
            # denormalize a grandparent's (or higher) key straight down onto
            # a grandchild sheet too (e.g. a `costs` row carrying both its
            # own activity's `idActivitat` and that activity's part's
            # `idPartida`) -- same redundant, driftable-copy problem, just
            # one level further removed.
            keys_to_strip = ancestor_ref_keys | ({child_ref_key} if child_ref_key else set())
            if keys_to_strip and isinstance(child_data, list):
                for row in child_data:
                    if isinstance(row, dict):
                        for k in keys_to_strip:
                            row.pop(k, None)
            _strip_ref_keys_recursive(child_data, child_schema, keys_to_strip)


def strip_hierarchy_ref_keys(data_json, hierarchy_schema_json):
    """One-time cleanup for a project loaded from a state saved before
    excel_to_json stopped storing each child row's own copy of the column
    that links it to its parent (the foreign key, e.g. `idPartida` on a
    `pres.parts.activitats` row) -- that field is now purely reconstructed
    at Excel-export time from the row's actual position in the tree (see
    _extract_flat_rows_for_sheet), never stored, so it can no longer drift
    out of sync with which parent a row actually sits under (by direct
    editing, or by moving a row to a different parent without updating its
    own copy of the key). Walks hierarchy_schema (as returned by
    excel_to_json) alongside data_json and deletes any such leftover field
    it finds. Safe to call on already-clean data (nothing to remove -> no-op);
    never raises, since it's meant to run on every project load."""
    try:
        data = json.loads(data_json)
        schema = json.loads(hierarchy_schema_json) if hierarchy_schema_json else {}
        if not isinstance(data, dict) or not isinstance(schema, dict):
            return data_json
        for top_name, top_schema in schema.items():
            if top_name in data:
                _strip_ref_keys_recursive(data[top_name], top_schema)
        return json.dumps(data, ensure_ascii=False, default=_custom_json_default)
    except Exception:
        return data_json


def update_excel_from_json(excel_path, json_str, out_excel_path):
    wb = load_workbook(excel_path)
    data = json.loads(json_str)
    orphan_records = []

    valid_prefixes = ('OUT_', 'JSON_', 'EXPORT_')
    has_prefixed_sheets = any(sheet.upper().startswith(valid_prefixes) for sheet in wb.sheetnames if not sheet.startswith('_') and sheet != 'editor_metadata')

    internal_sheets = ('editor_metadata', 'editormetadata', '_sheet_info', '_hierarchy_schema', '_hierarchy_metadata', 'headers', 'orfes')

    # Remove internal system phantom sheets only (never delete _sheet_info metadata sheet)
    for s_name in list(wb.sheetnames):
        s_lower = s_name.lower()
        if s_lower in ('_sheet_info.headers', 'headers') or s_lower.startswith('_sheet_info.'):
            del wb[s_name]

    unprefixed_sheets = [s for s in wb.sheetnames if not any(s.upper().startswith(pfx) for pfx in valid_prefixes) and s not in internal_sheets]
    prefixed_sheets = [s for s in wb.sheetnames if any(s.upper().startswith(pfx) for pfx in valid_prefixes) and s not in internal_sheets]

    sheets_to_process = prefixed_sheets if prefixed_sheets else unprefixed_sheets
    for sheet_name in sheets_to_process:
        sheet_name_upper = sheet_name.upper()
        sheet_id = sanitize_id(sheet_name)

        if sheet_id in ('editor_metadata', 'editormetadata', 'orfes'):
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

        rows = _read_rows(ws, ws, wb, wb, sheet_name, 'iso')
        kind_res = _validate_and_detect_kind(rows, sheet_name)
        if isinstance(kind_res, tuple):
            kind, header_row_idx = kind_res
        else:
            kind = kind_res

        if kind in ('kv', 'kv_header'):
            start_row = 1 if kind == 'kv_header' else 0
            if isinstance(sheet_data, dict):
                existing_keys = set()
                for r in range(ws.max_row, start_row, -1):
                    k_cell = ws.cell(r, 1)
                    k_val = k_cell.value
                    k_str = str(k_val or '').strip()
                    if k_str.startswith('=') and is_simple_link_formula(k_str):
                        t_cell = get_referenced_cell(ws, k_cell)
                        if t_cell is not None:
                            k_val = t_cell.value
                    if k_val not in (None, ''):
                        s_key = sanitize_id(k_val)
                        if s_key in sheet_data:
                            existing_keys.add(s_key)
                            val = sheet_data[s_key]
                            if not isinstance(val, (list, dict)):
                                write_cell_value(ws, r, 2, val, orphan_records)
                        else:
                            ws.delete_rows(r)

                for k_val, val in sheet_data.items():
                    if isinstance(val, (list, dict)):
                        continue
                    # Internal bookkeeping keys (a group's own '_group_label'
                    # header, '_hierarchy_schema', '_sheet_info', '_path', ...)
                    # must never be written out as a real spreadsheet row, the
                    # same way the 'tabular' branch above already excludes
                    # underscore-prefixed columns.
                    if str(k_val).startswith('_'):
                        continue
                    s_key = sanitize_id(k_val)
                    if s_key not in existing_keys:
                        next_row = ws.max_row + 1
                        ws.cell(next_row, 1).value = k_val
                        write_cell_value(ws, next_row, 2, val, orphan_records)

        elif kind == 'tabular' and isinstance(sheet_data, list):
            if not sheet_data:
                continue

            excel_headers = []
            for c in range(1, ws.max_column + 1):
                cell_c = ws.cell(1, c)
                val = cell_c.value
                val_str = str(val or '').strip()
                if val_str.startswith('=') and is_simple_link_formula(val_str):
                    t_cell = get_referenced_cell(ws, cell_c)
                    if t_cell is not None:
                        val = t_cell.value
                excel_headers.append(sanitize_id(val) if val not in (None, '') else '')

            active_cols = [sanitize_id(k) for k in sheet_data[0].keys() if k and k not in internal_sheets and not str(k).startswith('_')]

            if active_cols:
                for c_idx in range(len(excel_headers) - 1, -1, -1):
                    h = excel_headers[c_idx]
                    if h and h not in active_cols:
                        ws.delete_cols(c_idx + 1)

            excel_headers = []
            for c in range(1, ws.max_column + 1):
                cell_c = ws.cell(1, c)
                val = cell_c.value
                val_str = str(val or '').strip()
                if val_str.startswith('=') and is_simple_link_formula(val_str):
                    t_cell = get_referenced_cell(ws, cell_c)
                    if t_cell is not None:
                        val = t_cell.value
                excel_headers.append(sanitize_id(val) if val not in (None, '') else '')

            for h in active_cols:
                if h not in excel_headers:
                    new_col_idx = len(excel_headers) + 1
                    ws.cell(1, new_col_idx).value = h
                    excel_headers.append(h)

            # Only delete excess rows if they do not contain template formula links
            for r in range(ws.max_row, len(sheet_data) + 1, -1):
                has_formula = any(str(ws.cell(r, c).value or '').strip().startswith('=') for c in range(1, ws.max_column + 1))
                if not has_formula:
                    ws.delete_rows(r)

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
                            write_cell_value(ws, excel_row, c_idx + 1, val, orphan_records)

    # EXPLICITLY write editor_metadata sheet with all 14 config columns regardless of prefixes!
    meta_data = data.get('editor_metadata') or data.get('editorMetadata') or []
    if 'editor_metadata' in wb.sheetnames:
        ws = wb['editor_metadata']
    else:
        ws = wb.create_sheet(title='editor_metadata')

    ws.delete_rows(1, max(ws.max_row, 1))
    headers = ['group', 'element', 'type', 'options', 'sourceType', 'multiple', 'vectorPath', 'displayField', 'valueField', 'width', 'calcFn', 'calcVector', 'calcTargetCol', 'calcFormula', 'gridRow', 'gridOrder', 'gridFill', 'label', 'groupLayout', 'itemTitleFormula']
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

    # EXPLICITLY write _sheet_info sheet as hidden metadata sheet if available
    sheet_info_data = data.get('_sheet_info') or []
    if sheet_info_data and isinstance(sheet_info_data, list):
        if '_sheet_info' in wb.sheetnames:
            ws_info = wb['_sheet_info']
            ws_info.delete_rows(1, max(ws_info.max_row, 1))
        else:
            ws_info = wb.create_sheet(title='_sheet_info')

        info_headers = ['raw_name', 'prefix', 'clean_name', 'parent_path', 'full_path', 'kind', 'headers', 'parent_ref_key', 'child_ref_key']
        for c_idx, h in enumerate(info_headers):
            ws_info.cell(1, c_idx + 1).value = h

        for r_idx, row_obj in enumerate(sheet_info_data):
            excel_row = r_idx + 2
            if isinstance(row_obj, dict):
                for c_idx, h in enumerate(info_headers):
                    val = row_obj.get(h, '')
                    if isinstance(val, list):
                        val = ', '.join(str(x) for x in val)
                    write_cell_value(ws_info, excel_row, c_idx + 1, val)
        ws_info.sheet_state = 'hidden'

    # EXPLICITLY write 'orfes' sheet if any complex formula destination cells were encountered!
    if orphan_records:
        if 'orfes' in wb.sheetnames:
            ws_orfes = wb['orfes']
            ws_orfes.delete_rows(1, max(ws_orfes.max_row, 1))
        else:
            ws_orfes = wb.create_sheet(title='orfes')

        orfes_headers = ['Full', 'Coordenada', 'Fórmula Original', 'Valor No Escrit']
        for c_idx, h in enumerate(orfes_headers):
            ws_orfes.cell(1, c_idx + 1).value = h

        for r_idx, o_rec in enumerate(orphan_records):
            r_num = r_idx + 2
            ws_orfes.cell(r_num, 1).value = str(o_rec.get('Full', ''))
            ws_orfes.cell(r_num, 2).value = str(o_rec.get('Coordenada', ''))
            orig_formula = str(o_rec.get('Fórmula Original', ''))
            if orig_formula.startswith('='):
                orig_formula = "'" + orig_formula
            ws_orfes.cell(r_num, 3).value = orig_formula
            val_no_escrit = o_rec.get('Valor No Escrit', '')
            if isinstance(val_no_escrit, (list, dict)):
                val_no_escrit = json.dumps(val_no_escrit, ensure_ascii=False)
            ws_orfes.cell(r_num, 4).value = val_no_escrit

    wb.save(out_excel_path)
    return len(orphan_records)


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


def create_default_workbook_from_json(json_str, out_path):
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
        headers = ['group', 'element', 'type', 'options', 'sourceType', 'multiple', 'vectorPath', 'displayField', 'valueField', 'width', 'calcFn', 'calcVector', 'calcTargetCol', 'calcFormula', 'gridRow', 'gridOrder', 'gridFill', 'label', 'groupLayout', 'itemTitleFormula']
        ws.append(headers)
        for row_obj in editor_meta:
            if isinstance(row_obj, dict):
                ws.append(["" if row_obj.get(h) is None else (", ".join(str(x) for x in row_obj[h]) if isinstance(row_obj[h], list) else str(row_obj[h])) for h in headers])
        ws.sheet_state = 'hidden'

    if not wb.sheetnames:
        wb.create_sheet(title="Dades")

    wb.save(out_path)
