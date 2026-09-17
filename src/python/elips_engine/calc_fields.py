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

# Calculated-field evaluation engine (SI/ARRODONEIX/CONCAT/MONEDA/... mini-language)
#
# The formula mini-language itself (lexer/parser/AST/evaluator) lives in the
# `.formula` subpackage -- evaluate_custom_formula below is a thin wrapper
# around it, kept here (rather than just re-exporting the subpackage's
# function directly under this name) because run_custom_pass/run_agg_pass in
# this file are its actual callers and belong next to the tree-walking
# machinery that invokes them per row/group.
#
# Foreign-key hydration of dynamic Select fields (hydrateModelWithForeignKeys
# in useWasmEngines.js) stays in JS: it is a data-shape transformation, not
# calculation, and JS calls it before handing data to evaluate_computed_fields.

import re
import json

from .text_utils import _custom_json_default
from .formula import evaluate_formula, validate_formula_syntax
from .formula.primitives import (
    is_cert as _cef_is_cert,
    is_fals as _cef_is_fals,
    extract_bool_val as _cef_extract_bool_val,
    normalize_number as _cef_normalize_number,
    reduce_numeric as _cef_reduce_numeric,
    coerce_num_or_str as _cef_coerce_num_or_str,
    criteria_matches as _cef_criteria_cell_matches,
    iter_tables as _cef_iter_tables,
    extract_row_val as _cef_extract_val,
)

_CEF_ARRAY_INDEX_RE = re.compile(r'^([a-zA-Z0-9_]+)\[(\d+)\]$')


def _cef_get_nested_value(obj, parts, global_data):
    current = obj
    for part in parts:
        if current is None:
            return None
        m = _CEF_ARRAY_INDEX_RE.match(part)
        if m:
            arr_key, idx = m.group(1), int(m.group(2))
            arr = current.get(arr_key) if isinstance(current, dict) else None
            current = arr[idx] if isinstance(arr, list) and idx < len(arr) else None
            if current is None:
                return None
        elif isinstance(current, list):
            nums = []
            for item in current:
                if isinstance(item, dict) and part in item:
                    try:
                        nums.append(float(item[part]))
                    except (TypeError, ValueError):
                        pass
            return sum(nums) if nums else 0
        elif isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, (str, int, float)):
            # Fallback: current is a scalar FK value (e.g. "PART-01"); look it
            # up in the global tables for a row that carries this `part` field.
            found_val = None
            if global_data:
                for table in _cef_iter_tables(global_data):
                    match_row = next((r for r in table if isinstance(r, dict)
                                       and any(str(v) == str(current) for v in r.values())), None)
                    if match_row is not None and part in match_row:
                        found_val = match_row[part]
                        break
            if found_val is not None:
                current = found_val
            else:
                return None
        else:
            return None
    return current


def _cef_normalize_criteria(raw, row, global_data):
    """Resolves a SUMIF criteria argument using the quoting convention: a
    value wrapped in matching '...'/"..." is a literal (quotes stripped);
    anything else is tried as a group.field path first and only falls back
    to being used as a literal if that path doesn't resolve to anything --
    the same tolerant, no-hard-parser style as the rest of this file."""
    if raw is None:
        return None
    s = str(raw).strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'"):
        return _cef_coerce_num_or_str(s[1:-1])

    if isinstance(row, dict) and s in row:
        return _cef_coerce_num_or_str(row[s])
    clean = re.sub(r'^(doc|dades)\.', '', s, flags=re.IGNORECASE)
    parts = [p for p in clean.split('.') if p]
    val = _cef_get_nested_value(row, parts, global_data) if parts else None
    if val is None and global_data:
        val = _cef_get_nested_value(global_data, parts, global_data)
        if val is None and parts:
            val = _cef_get_nested_value(global_data, ['OUT_' + parts[0]] + parts[1:], global_data)
    if val is not None:
        return _cef_coerce_num_or_str(val)
    return _cef_coerce_num_or_str(s)


def evaluate_custom_formula(formula_str, row, global_data=None):
    """Evaluates one CUSTOM-formula string (the SI/ARRODONEIX/CONCAT/MONEDA/...
    mini-language) against `row` (the record being computed) and `global_data`
    (the whole data tree, for cross-group lookups). Returns a number, bool or
    string, or `row.get(formula_str)` as a last-resort fallback on any error —
    matching the JS version's forgiving behavior (a broken formula shouldn't
    crash the form, just leave the field showing something recognizable)."""
    return evaluate_formula(formula_str, row, global_data)


def validate_custom_formula_syntax(formula_str):
    """Parses `formula_str` without evaluating it, to surface a malformed
    formula immediately (e.g. from a "Comprova fórmula" button in the group
    config UI, mirroring validate_template_syntax for templates)."""
    return validate_formula_syntax(formula_str)


def _cef_is_custom_fn(fn, formula):
    if formula and str(formula).strip():
        return True
    upper = (fn or '').upper()
    return upper in ('CUSTOM', 'FORMULA', '', 'NONE')


def _cef_is_group_match(meta_group, hint):
    if not meta_group:
        return True
    if not hint:
        return False
    clean_m = re.sub(r'^OUT_', '', meta_group, flags=re.IGNORECASE).lower()
    clean_h = re.sub(r'^OUT_', '', hint, flags=re.IGNORECASE).lower()
    if clean_m == clean_h:
        return True
    if clean_m.split('.')[-1] == clean_h.split('.')[-1]:
        return True
    root_hints = {'doc', 'dades', 'global', 'header', 'general', 'presupost', 'pressupost', 'resum', 'summary', 'root', 'main', ''}
    return clean_h in root_hints and clean_m in root_hints


def find_sub_list(obj, target_vec, sub_visited=None, depth=0):
    """Recursively searches container (dict values or list items, at any
    depth up to 5) for the first dict that has target_vec as an array key."""
    if sub_visited is None:
        sub_visited = set()
    if not isinstance(obj, (dict, list)) or depth > 5:
        return None
    oid = id(obj)
    if oid in sub_visited:
        return None
    sub_visited.add(oid)

    if isinstance(obj, dict) and isinstance(obj.get(target_vec), list):
        return obj[target_vec]

    children = obj.values() if isinstance(obj, dict) else obj
    for child in children:
        if isinstance(child, (dict, list)):
            found = find_sub_list(child, target_vec, sub_visited, depth + 1)
            if found is not None:
                return found
    return None


def run_custom_pass(container, custom_metas, data, debug_mode, logs, group_hint='', visited=None):
    if visited is None:
        visited = set()
    if not isinstance(container, (dict, list)):
        return
    cid = id(container)
    if cid in visited:
        return
    visited.add(cid)

    if isinstance(container, list):
        for item in container:
            run_custom_pass(item, custom_metas, data, debug_mode, logs, group_hint, visited)
        return

    for k, v in container.items():
        if k in ('_sheet_info', '_hierarchy_schema', 'editor_metadata'):
            continue
        # A hydrated dynamic-Select FK value (see hydrateModelWithForeignKeys
        # in useWasmEngines.js) is a dict carrying the related row's own
        # columns, tagged with `_default_val` -- semantically still this
        # field's own scalar value, never a nested group to recurse into.
        # Recursing into it here (as any other non-list dict child) would
        # reuse the PARENT's group_hint unchanged (only list children get
        # their own), so a calculated field whose element name happens to
        # also exist as a column on the related row (e.g. both `prova` and
        # the FK-related `cataleg.items` row have a `preu` column) would
        # get evaluated a second time against the hydrated object itself
        # and overwrite that column with the wrong (usually 0) result.
        if isinstance(v, dict) and '_default_val' in v:
            continue
        if isinstance(v, (dict, list)):
            run_custom_pass(v, custom_metas, data, debug_mode, logs, k if isinstance(v, list) else group_hint, visited)

    for meta in custom_metas:
        if _cef_is_group_match(meta.get('group'), group_hint):
            calculated_val = evaluate_custom_formula(meta.get('calcFormula'), container, data)
            if calculated_val is not None:
                old_val = container.get(meta.get('element'))
                container[meta.get('element')] = calculated_val
                if debug_mode:
                    logs.append(f"✨ [CÀLCUL CUSTOM] {meta.get('group') or group_hint}.{meta.get('element')} = {calculated_val} "
                                f"(Fórmula: \"{meta.get('calcFormula')}\", Anterior: {old_val})")


def run_agg_pass(container, agg_metas, data, debug_mode, logs, group_hint='', visited=None):
    if visited is None:
        visited = set()
    if not isinstance(container, (dict, list)):
        return
    cid = id(container)
    if cid in visited:
        return
    visited.add(cid)

    if isinstance(container, list):
        for item in container:
            run_agg_pass(item, agg_metas, data, debug_mode, logs, group_hint, visited)
        return

    for k, v in container.items():
        if k in ('_sheet_info', '_hierarchy_schema', 'editor_metadata'):
            continue
        # Same reasoning as the equivalent guard in run_custom_pass above:
        # a hydrated FK value is a leaf scalar, not a nested group.
        if isinstance(v, dict) and '_default_val' in v:
            continue
        if isinstance(v, (dict, list)):
            run_agg_pass(v, agg_metas, data, debug_mode, logs, k if isinstance(v, list) else group_hint, visited)

    for meta in agg_metas:
        target_vec = meta.get('calcVector')
        fn = (meta.get('calcFn') or 'SUM').upper()
        col = meta.get('calcTargetCol')

        if _cef_is_group_match(meta.get('group'), group_hint) or (target_vec and isinstance(container.get(target_vec), list)):
            child_list = None
            if target_vec and isinstance(container.get(target_vec), list):
                child_list = container[target_vec]
            elif target_vec and isinstance(data.get(target_vec), list):
                child_list = data[target_vec]
            elif target_vec:
                child_list = find_sub_list(container, target_vec)

            if child_list is not None:
                if fn == 'COUNT':
                    calculated_val = len(child_list)
                elif fn in ('SUM', 'AVG', 'AVERAGE', 'MIN', 'MAX'):
                    calculated_val = _cef_reduce_numeric(fn, [_cef_extract_val(c, col) for c in child_list])
                elif fn == 'SUMIF':
                    crit_col = meta.get('calcCriteriaCol')
                    crit_val = _cef_normalize_criteria(meta.get('calcCriteriaValue'), container, data)
                    calculated_val = _cef_normalize_number(sum(
                        _cef_extract_val(c, col) for c in child_list
                        if isinstance(c, dict) and _cef_criteria_cell_matches(c.get(crit_col), crit_val)
                    ))
                elif fn in ('OR', 'O', 'SOME', 'ANY'):
                    calculated_val = any(_cef_extract_bool_val(c.get(col) if col and isinstance(c, dict) else c) for c in child_list)
                elif fn in ('AND', 'I', 'EVERY', 'ALL'):
                    calculated_val = len(child_list) > 0 and all(_cef_extract_bool_val(c.get(col) if col and isinstance(c, dict) else c) for c in child_list)
                else:
                    continue

                old_val = container.get(meta.get('element'))
                container[meta.get('element')] = calculated_val
                if debug_mode:
                    logs.append(f"📊 [CÀLCUL AGREGACIÓ] {meta.get('group') or group_hint}.{meta.get('element')} = {calculated_val} "
                                f"({fn} de '{target_vec}' [{len(child_list)} elements], Anterior: {old_val})")
            elif debug_mode:
                logs.append(f"⚠️ [CÀLCUL AGREGACIÓ] No s'ha trobat la llista '{target_vec}' per calcular {meta.get('element')}.")


def evaluate_computed_fields(data_json, metadata_json, debug_mode=False):
    """Two-phase bottom-up evaluation of every calculated field in `data_json`:
    first row-level CUSTOM formulas (evaluate_custom_formula), then SUM/COUNT/
    AVERAGE/MIN/MAX/OR/AND aggregations that read the just-computed CUSTOM
    values from child tables. Mutates and returns a JSON string of the full
    data tree (mirroring the JS version's in-place mutation of store.excelJsonData,
    so Vue's reactivity still targets the same paths after the round trip).

    `data_json` must already have dynamic Select fields hydrated (done in JS
    by hydrateModelWithForeignKeys before this is called) — this function only
    computes formulas/aggregations, it does not resolve foreign keys.
    """
    try:
        data = json.loads(data_json)
        metadata = json.loads(metadata_json) if metadata_json else []
    except Exception as ex:
        return json.dumps({'success': False, 'error': str(ex)})

    if not isinstance(data, dict):
        return json.dumps({'success': True, 'data': data, 'logs': []})

    logs = []

    computed_metas = [m for m in metadata if isinstance(m, dict) and (
        m.get('isCalculated') is True or
        m.get('type') == 'Computed' or
        m.get('sourceType') == 'computed' or
        (m.get('calcFn') and m.get('calcFn') not in ('', 'NONE')) or
        (m.get('calcFormula') and str(m.get('calcFormula')).strip() != '')
    )]

    if debug_mode:
        if not computed_metas:
            logs.append(f"🧮 [DEPURACIÓ CAMPS CALCULATS] No s'ha trobat cap camp marcat com a calculat (editor_metadata té {len(metadata)} metadades en total).")
        else:
            details = '\n'.join(
                f"  • [Grup: {m.get('group') or 'global'} | Camp: {m.get('element')}] "
                f"Tipus: {m.get('calcFn') or 'CUSTOM'} | Fórmula/Vector: \"{m.get('calcFormula') or m.get('calcVector') or ''}\""
                for m in computed_metas
            )
            logs.append(f"🧮 [DEPURACIÓ CAMPS CALCULATS] Detectats {len(computed_metas)} camps calculats:\n{details}")

    if not computed_metas:
        return json.dumps({'success': True, 'data': data, 'logs': logs})

    custom_metas = [m for m in computed_metas if _cef_is_custom_fn(m.get('calcFn'), m.get('calcFormula')) and m.get('calcFormula')]
    agg_metas = [m for m in computed_metas if not _cef_is_custom_fn(m.get('calcFn'), m.get('calcFormula'))]

    for key, val in list(data.items()):
        if key not in ('_sheet_info', '_hierarchy_schema', 'editor_metadata'):
            run_custom_pass(val, custom_metas, data, debug_mode, logs, key)

    for key, val in list(data.items()):
        if key not in ('_sheet_info', '_hierarchy_schema', 'editor_metadata'):
            run_agg_pass(val, agg_metas, data, debug_mode, logs, key)

    return json.dumps({'success': True, 'data': data, 'logs': logs}, ensure_ascii=False, default=_custom_json_default)
