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
# Ported from src/composables/useWasmEngines.js (evaluateCustomFormula /
# evaluateComputedFields), moved here so calculated-field formulas execute
# inside Pyodide's WASM sandbox instead of via a JS `new Function(...)`
# (dynamic eval) in the page's own execution context — the browser tab that
# also holds cookies, localStorage and DOM access. A hostile formula string
# smuggled in via editor_metadata now runs inside a restricted Python `eval`
# with no builtins beyond a small whitelist, isolated in the WASM sandbox with
# no path back to `window`/`document`/network APIs.
#
# Foreign-key hydration of dynamic Select fields (hydrateModelWithForeignKeys
# in useWasmEngines.js) stays in JS: it is a data-shape transformation, not
# calculation, and JS calls it before handing data to evaluate_computed_fields.

import re
import json

from .text_utils import _custom_json_default

_CEF_RESERVED_TOKENS = {
    'SI', 'IF', 'ARRODONEIX', 'ROUND', 'ABS', 'MIN', 'MAX', 'OR', 'O', 'AND', 'I',
    'ANY', 'SOME', 'EVERY', 'ALL', 'Math', '__round', '__or', '__and',
    'CERT', 'FALS', 'cert', 'fals', 'is_cert', 'is_fals', '__is_cert', '__is_fals',
    'true', 'false', 'null', 'undefined', 'doc', 'dades', 'return', 'function',
    'abs', 'True', 'False', 'None', 'and', 'or', 'not', 'if', 'else', 'is', 'in',
    'SUM', 'AVERAGE', 'AVG', 'COUNT', 'SUMIF', '__agg', '__sumif', '__min', '__max',
}

_CEF_TOKEN_RE = re.compile(
    r'\b(?:[a-zA-Z_][a-zA-Z0-9_]*|doc\.[a-zA-Z0-9_.]+|dades\.[a-zA-Z0-9_.]+)'
    r'(?:\[\d+\])?(?:\.[a-zA-Z_][a-zA-Z0-9_.]*(?:\[\d+\])?)*\b'
)
_CEF_ARRAY_INDEX_RE = re.compile(r'^([a-zA-Z0-9_]+)\[(\d+)\]$')


def _cef_balanced_call_args(s, open_paren_idx):
    """Finds the matching ')' for a '(' at open_paren_idx, respecting nested
    parens and quoted strings. Returns (end_idx, args_str) or (None, None)."""
    depth = 1
    in_quotes = False
    quote_char = ''
    end_idx = None
    for i in range(open_paren_idx + 1, len(s)):
        ch = s[i]
        if in_quotes:
            if ch == quote_char:
                in_quotes = False
        elif ch in ('"', "'"):
            in_quotes = True
            quote_char = ch
        elif ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
            if depth == 0:
                end_idx = i
                break
    if end_idx is None:
        return None, None
    return end_idx, s[open_paren_idx + 1:end_idx]


def _cef_split_args(args_str):
    """Splits a function-call argument string on ';' or ',' at paren/quote depth 0."""
    parts = []
    current = ''
    depth = 0
    in_quotes = False
    quote_char = ''
    for ch in args_str:
        if in_quotes:
            current += ch
            if ch == quote_char:
                in_quotes = False
        elif ch in ('"', "'"):
            in_quotes = True
            quote_char = ch
            current += ch
        elif ch == '(':
            depth += 1
            current += ch
        elif ch == ')':
            depth -= 1
            current += ch
        elif ch in (';', ',') and depth == 0:
            parts.append(current.strip())
            current = ''
        else:
            current += ch
    parts.append(current.strip())
    return parts


def _cef_transform_if(s):
    """SI(cond; a; b) / IF(cond; a; b) -> Python ternary: ((a) if (cond) else (b))."""
    prev = None
    while prev != s:
        prev = s
        m = re.search(r'\b(SI|IF)\s*\(', s, re.IGNORECASE)
        if not m:
            break
        end_idx, args_str = _cef_balanced_call_args(s, m.end() - 1)
        if end_idx is None:
            break
        full_match = s[m.start():end_idx + 1]
        parts = _cef_split_args(args_str)
        if len(parts) >= 3:
            cond, t_val = parts[0], parts[1]
            f_val = ';'.join(parts[2:])
            s = s.replace(full_match, f'(({t_val}) if ({cond}) else ({f_val}))', 1)
        else:
            break
    return s


def _cef_transform_round(s):
    """ARRODONEIX(valor; decimals) / ROUND(...) -> __round(valor, decimals)."""
    prev = None
    while prev != s:
        prev = s
        m = re.search(r'\b(ARRODONEIX|ROUND)\s*\(', s, re.IGNORECASE)
        if not m:
            break
        end_idx, args_str = _cef_balanced_call_args(s, m.end() - 1)
        if end_idx is None:
            break
        full_match = s[m.start():end_idx + 1]
        parts = _cef_split_args(args_str)
        val_expr = parts[0] if parts and parts[0] else '0'
        prec_expr = parts[1] if len(parts) > 1 else '0'
        s = s.replace(full_match, f'__round({val_expr}, {prec_expr})', 1)
    return s


def _cef_transform_or_and(s):
    """OR(path)/AND(path) (plus O/I/ANY/SOME/EVERY/ALL synonyms) -> __or("path")/__and("path")."""
    prev = None
    while prev != s:
        prev = s
        m = re.search(r'\b(OR|O|AND|I|ANY|SOME|EVERY|ALL)\s*\(', s, re.IGNORECASE)
        if not m:
            break
        end_idx, arg_str = _cef_balanced_call_args(s, m.end() - 1)
        if end_idx is None:
            break
        fn_name = m.group(1).upper()
        full_match = s[m.start():end_idx + 1]
        # Escape backslashes before quotes (the original JS port only escaped
        # quotes, which could desync the generated string literal).
        escaped = arg_str.strip().replace('\\', '\\\\').replace('"', '\\"')
        if fn_name in ('OR', 'O', 'ANY', 'SOME'):
            s = s.replace(full_match, f'__or("{escaped}")', 1)
        elif fn_name in ('AND', 'I', 'EVERY', 'ALL'):
            s = s.replace(full_match, f'__and("{escaped}")', 1)
        else:
            break
    return s


def _cef_transform_agg(s):
    """SUM(path)/AVERAGE(path)/AVG(path)/COUNT(path)/MIN(path)/MAX(path) with a
    single dotted-path argument -> aggregation over a tabular group.column,
    reusing the same logic as the SUM/AVERAGE/COUNT/MIN/MAX calculated-field
    type (__agg("FN", "path")). MIN(a; b; ...)/MAX(a; b; ...) with 2+ args
    keep the documented element-wise behavior (__min(...)/__max(...) --
    this was documented but silently broken before, since no transform for
    it existed at all). SUMIF(critPath; criteri; sumPath) ->
    __sumif("critPath", "criteri", "sumPath"); criteri keeps any quotes it
    was written with so __sumif can tell a literal from a field-path
    reference (quoted = literal, unquoted = group.field path)."""
    prev = None
    while prev != s:
        prev = s
        m = re.search(r'\b(SUM|AVERAGE|AVG|COUNT|MIN|MAX|SUMIF)\s*\(', s, re.IGNORECASE)
        if not m:
            break
        end_idx, args_str = _cef_balanced_call_args(s, m.end() - 1)
        if end_idx is None:
            break
        fn_name = m.group(1).upper()
        full_match = s[m.start():end_idx + 1]
        parts = _cef_split_args(args_str)

        if fn_name == 'SUMIF':
            if len(parts) < 3 or not parts[0] or not parts[2]:
                break
            crit_path, criteria_raw = parts[0].strip(), parts[1].strip()
            sum_path = ';'.join(parts[2:]).strip()
            s = s.replace(full_match, f'__sumif({crit_path!r}, {criteria_raw!r}, {sum_path!r})', 1)
        elif fn_name in ('MIN', 'MAX') and len(parts) >= 2:
            helper = '__min' if fn_name == 'MIN' else '__max'
            s = s.replace(full_match, f'{helper}({", ".join(parts)})', 1)
        elif parts and parts[0]:
            s = s.replace(full_match, f'__agg({fn_name!r}, {parts[0].strip()!r})', 1)
        else:
            break
    return s


def _cef_transform_cert_fals(s):
    s = re.sub(r'\b(CERT|is_cert)\s*\(', '__is_cert(', s, flags=re.IGNORECASE)
    s = re.sub(r'\b(FALS|is_fals)\s*\(', '__is_fals(', s, flags=re.IGNORECASE)
    return s


def _cef_parse_num_or_string(raw_val):
    """Returns either a number/bool (embedded later as a literal) or a Python
    `str` that is ALREADY valid quoted Python source (via repr) — mirroring
    the JS version's dual return type, which the caller dispatches on."""
    if isinstance(raw_val, bool):
        return raw_val
    if isinstance(raw_val, (int, float)):
        return raw_val
    if isinstance(raw_val, str):
        if raw_val.strip() == '':
            return 0
        try:
            return float(raw_val.replace(',', '.'))
        except ValueError:
            return repr(raw_val)
    return 0


def _cef_iter_tables(obj, depth=0):
    """Yields every list-of-dicts ("table") found in `obj`, at any depth
    (limited to 10, same as the other tree walkers in this file) -- used by
    _cef_get_nested_value's scalar-FK fallback below so it can find a target
    table nested inside a key-value group (e.g. `pressupost.partides`), not
    just one sitting at the top level of `global_data`."""
    if depth > 10 or not isinstance(obj, (dict, list)):
        return
    if isinstance(obj, list):
        if obj and isinstance(obj[0], dict):
            yield obj
        for item in obj:
            yield from _cef_iter_tables(item, depth + 1)
    else:
        for val in obj.values():
            yield from _cef_iter_tables(val, depth + 1)


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


def _cef_resolve_value(path_str, row, global_data):
    if not path_str:
        return None
    if isinstance(row, dict) and path_str in row:
        return _cef_parse_num_or_string(row[path_str])
    clean_path = re.sub(r'^(doc|dades)\.', '', path_str, flags=re.IGNORECASE)
    path_parts = [p for p in clean_path.split('.') if p]

    val = _cef_get_nested_value(row, path_parts, global_data)
    if val is not None:
        return _cef_parse_num_or_string(val)

    if global_data:
        val = _cef_get_nested_value(global_data, path_parts, global_data)
        if val is None and path_parts:
            prefixed = ['OUT_' + path_parts[0]] + path_parts[1:]
            val = _cef_get_nested_value(global_data, prefixed, global_data)
        if val is not None:
            return _cef_parse_num_or_string(val)
    return None


def _cef_is_cert(val):
    if val in (None, False, '', 0, 0.0, '0', '0.0'):
        return False
    if isinstance(val, str) and val.strip().upper() in ('NO', 'FALS', 'FALSE', '0', '0.0', 'N', 'OFF', 'DESACTIVAT'):
        return False
    return True


def _cef_is_fals(val):
    return not _cef_is_cert(val)


def _cef_extract_bool_val(val):
    if val in (None, False, 0, '0', '', '0.0'):
        return False
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return val != 0
    if isinstance(val, str):
        return val.strip().lower() in ('true', '1', 'si', 'sí', 'cert', 'yes')
    return bool(val)


def _cef_eval_or_and(path_str, mode, row, global_data):
    clean_path = re.sub(r"^['\"]|['\"]$", '', path_str.strip())
    clean_path = re.sub(r'^(doc|dades)\.', '', clean_path, flags=re.IGNORECASE)
    parts = [p for p in clean_path.split('.') if p]
    if not parts:
        return False

    def collect_values(start_obj):
        if not isinstance(start_obj, (dict, list)):
            return None
        current = start_obj
        for i, part in enumerate(parts):
            if current is None:
                return None
            if isinstance(current, list):
                remaining = parts[i:]
                out = []
                for item in current:
                    if not isinstance(item, dict):
                        out.append(item)
                        continue
                    sub = item
                    for p in remaining:
                        if sub is None:
                            sub = None
                            break
                        sub = sub.get(p) if isinstance(sub, dict) else None
                    out.append(sub)
                return out
            current = current.get(part) if isinstance(current, dict) else None
        return current if isinstance(current, list) else [current]

    lst = collect_values(row)
    if (not lst) and global_data:
        lst = collect_values(global_data)
        if (not lst) and parts:
            sheet_key = parts[0]
            prefixed = global_data.get('OUT_' + sheet_key)
            if prefixed is not None:
                lst = collect_values({'OUT_' + sheet_key: prefixed})

    if not isinstance(lst, list):
        lst = []

    if mode == 'OR':
        return any(_cef_extract_bool_val(v) for v in lst)
    return len(lst) > 0 and all(_cef_extract_bool_val(v) for v in lst)


def _cef_normalize_number(n):
    """Rounds to 6 decimals and collapses whole-number floats to int (e.g.
    30.0 -> 30). JS's single Number type never carries this distinction —
    JSON.stringify(30.0) is "30" — so without this, a value that used to
    render as "30" in a generated document would render as "30.0" now that
    calculation happens in Python."""
    rounded = round(float(n) * 1000000) / 1000000
    if rounded == int(rounded) and abs(rounded) < 1e15:
        return int(rounded)
    return rounded


def _cef_reduce_numeric(fn, nums):
    """Shared numeric reducer for SUM/AVERAGE/MIN/MAX, used both by the
    calculated-field aggregation pass (run_agg_pass) and by the SUM/AVERAGE/
    MIN/MAX formula functions (_cef_eval_agg), so the math itself only
    exists in one place."""
    fn = (fn or 'SUM').upper()
    if fn == 'SUM':
        return _cef_normalize_number(sum(nums))
    if fn in ('AVG', 'AVERAGE'):
        return _cef_normalize_number(sum(nums) / len(nums)) if nums else 0
    if fn == 'MIN':
        return _cef_normalize_number(min(nums)) if nums else 0
    if fn == 'MAX':
        return _cef_normalize_number(max(nums)) if nums else 0
    return 0


def _cef_walk_to_list(start_obj, parts):
    """Walks `parts` through nested dicts starting at start_obj, stopping and
    returning the row list as soon as one is found along the way (a path
    segment that names an array key). If a list is reached before all parts
    are consumed, the remaining parts are looked up inside each row in turn
    (supports a nested table one level down inside another list's rows).
    Returns None if the path doesn't lead to a list."""
    current = start_obj
    for i, part in enumerate(parts):
        if isinstance(current, list):
            for item in current:
                if isinstance(item, dict):
                    sub = _cef_walk_to_list(item, parts[i:])
                    if sub is not None:
                        return sub
            return None
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current if isinstance(current, list) else None


def _cef_resolve_rows_for_path(path_str, row, global_data, need_col=True):
    """Resolves a dotted `group.table.column` (or, with need_col=False,
    `group.table`) path into (rows, col): `rows` is the list of row-dicts
    for the table, `col` is the trailing column name (None when need_col is
    False, or when the path has only one segment). Tries `row` first (the
    record currently being computed), then `global_data` (the whole tree),
    then an `OUT_`-prefixed root sheet name -- mirroring _cef_resolve_value's
    fallback order. This is the path-resolution counterpart of
    _cef_eval_or_and's `collect_values`, generalized to return whole rows
    (not a flattened list of one column's values) since SUMIF needs to read
    two columns -- criteria and sum -- off the same row."""
    if not path_str:
        return None, None
    clean = re.sub(r'^(doc|dades)\.', '', str(path_str).strip(), flags=re.IGNORECASE)
    parts = [p for p in clean.split('.') if p]
    if not parts:
        return None, None

    if need_col and len(parts) >= 2:
        group_parts, col = parts[:-1], parts[-1]
    else:
        group_parts, col = parts, None

    rows = _cef_walk_to_list(row, group_parts) if isinstance(row, (dict, list)) else None
    if rows is None and global_data:
        rows = _cef_walk_to_list(global_data, group_parts)
        if rows is None and group_parts:
            rows = _cef_walk_to_list(global_data, ['OUT_' + group_parts[0]] + group_parts[1:])
    return rows, col


def _cef_coerce_num_or_str(raw_val):
    """Like _cef_parse_num_or_string but returns the actual runtime value
    (a number or a plain string) rather than source-embeddable repr text --
    for direct comparison (SUMIF criteria matching), not for splicing into
    an eval'd expression string."""
    if isinstance(raw_val, bool) or isinstance(raw_val, (int, float)):
        return raw_val
    if isinstance(raw_val, str):
        s = raw_val.strip()
        if s == '':
            return ''
        try:
            return float(s.replace(',', '.'))
        except ValueError:
            return raw_val
    return raw_val


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


def _cef_criteria_cell_matches(cell_val, criteria_val):
    """Tolerant SUMIF-style comparison: numeric when both sides parse as
    numbers, case-insensitive string compare otherwise (same forgiving
    spirit as _cef_extract_bool_val elsewhere in this file)."""
    if cell_val is None or criteria_val is None:
        return cell_val == criteria_val
    try:
        return float(cell_val) == float(criteria_val)
    except (TypeError, ValueError):
        return str(cell_val).strip().lower() == str(criteria_val).strip().lower()


def _cef_eval_agg(fn, path_str, row, global_data):
    """SUM/AVERAGE/AVG/COUNT/MIN/MAX(group.table[.column]) as used from
    inside a formula -- resolves the row list via _cef_resolve_rows_for_path
    and reduces it with the same _cef_reduce_numeric used by the
    calculated-field aggregation pass."""
    fn = (fn or 'SUM').upper()
    if fn == 'COUNT':
        rows, _ = _cef_resolve_rows_for_path(path_str, row, global_data, need_col=False)
        return len(rows) if rows else 0
    rows, col = _cef_resolve_rows_for_path(path_str, row, global_data)
    if not rows:
        return 0
    return _cef_reduce_numeric(fn, [_cef_extract_val(r, col) for r in rows])


def _cef_eval_sumif(crit_path, criteria_raw, sum_path, row, global_data):
    """SUMIF(critPath; criteri; sumPath) as used from inside a formula --
    resolves the row list from `sum_path`, reads the criteria column named
    by the last segment of `crit_path` off each row (trusting it shares the
    same table as `sum_path`), and sums `sum_path`'s column only for rows
    where that criteria column matches (via _cef_criteria_cell_matches,
    shared with the SUMIF calculated-field type in run_agg_pass)."""
    rows, sum_col = _cef_resolve_rows_for_path(sum_path, row, global_data)
    if not rows:
        return 0
    crit_col = str(crit_path).strip().split('.')[-1] if crit_path else None
    criteria_val = _cef_normalize_criteria(criteria_raw, row, global_data)
    total = sum(_cef_extract_val(r, sum_col) for r in rows
                if isinstance(r, dict) and _cef_criteria_cell_matches(r.get(crit_col), criteria_val))
    return _cef_normalize_number(total)


def evaluate_custom_formula(formula_str, row, global_data=None):
    """Evaluates one CUSTOM-formula string (the SI/ARRODONEIX/CONCAT/MONEDA/...
    mini-language) against `row` (the record being computed) and `global_data`
    (the whole data tree, for cross-group lookups). Returns a number, bool or
    string, or `row.get(formula_str)` as a last-resort fallback on any error —
    matching the JS version's forgiving behavior (a broken formula shouldn't
    crash the form, just leave the field showing something recognizable)."""
    if not formula_str or not isinstance(formula_str, str):
        return 0
    try:
        expr = formula_str.strip()

        # Defense in depth: even with a restricted __builtins__, Python's eval()
        # still allows plain attribute access, which is enough for the classic
        # `().__class__.__bases__[0].__subclasses__()`-style sandbox escape (that
        # chain, and `__import__(...)`, both require a literal '__'). A bare
        # `import`/`eval`/`open`/... call can't do anything here regardless —
        # eval() only accepts expressions, so `import` is a SyntaxError inside
        # it, and every other name in that family is simply absent from the
        # restricted __builtins__ below — so only '__' itself needs blocking.
        # (Field names like "import" — Catalan for "amount" — are common and
        # legitimate in this app's domain and must not be caught here.)
        if '__' in expr:
            return row.get(formula_str, 0) if isinstance(row, dict) else 0

        expr = _cef_transform_if(expr)
        expr = _cef_transform_round(expr)
        expr = _cef_transform_or_and(expr)
        expr = _cef_transform_agg(expr)
        expr = _cef_transform_cert_fals(expr)

        expr = re.sub(r'\bABS\s*\(', 'abs(', expr, flags=re.IGNORECASE)
        expr = re.sub(r'(^|[^<>=!])=([^=])', r'\1==\2', expr)
        expr = expr.replace('<>', '!=')
        expr = expr.replace('^', '**')

        # Mask quoted string literals (e.g. from __or("path")/__sumif(...))
        # before token substitution: without this, a token that happens to
        # fall inside a literal meant for __or/__and/__sumif gets matched by
        # _CEF_TOKEN_RE and resolved/spliced in right there, corrupting the
        # literal the callee expected to receive intact (this used to break
        # e.g. OR(a.b.c) whenever a.b.c was also a resolvable field/path).
        _cef_quoted_literals = []

        def _cef_mask_quotes(mo):
            _cef_quoted_literals.append(mo.group(0))
            return f'\x00Q{len(_cef_quoted_literals) - 1}\x00'

        expr = re.sub(r'"[^"]*"|\'[^\']*\'', _cef_mask_quotes, expr)

        found_tokens = set()
        for m in _CEF_TOKEN_RE.finditer(expr):
            t = m.group(0)
            if t not in _CEF_RESERVED_TOKENS and t.upper() not in _CEF_RESERVED_TOKENS:
                found_tokens.add(t)

        for t in sorted(found_tokens, key=len, reverse=True):
            resolved = _cef_resolve_value(t, row, global_data)
            if resolved is not None:
                replacement = resolved if isinstance(resolved, str) else f'({resolved!r})'
                expr = re.sub(r'\b' + re.escape(t) + r'\b', lambda _m: replacement, expr)

        for i, literal in enumerate(_cef_quoted_literals):
            expr = expr.replace(f'\x00Q{i}\x00', literal)

        safe_globals = {
            '__builtins__': {'abs': abs, 'min': min, 'max': max, 'True': True, 'False': False, 'None': None},
            '__round': lambda val, prec=0: round(float(val), int(prec)) if str(val).strip() != '' else 0,
            '__is_cert': _cef_is_cert,
            '__is_fals': _cef_is_fals,
            '__or': lambda arg: _cef_eval_or_and(str(arg), 'OR', row, global_data),
            '__and': lambda arg: _cef_eval_or_and(str(arg), 'AND', row, global_data),
            '__min': min, '__max': max,
            '__agg': lambda fn, path: _cef_eval_agg(fn, path, row, global_data),
            '__sumif': lambda cp, cr, sp: _cef_eval_sumif(cp, cr, sp, row, global_data),
            'CERT': _cef_is_cert, 'FALS': _cef_is_fals, 'cert': _cef_is_cert, 'fals': _cef_is_fals,
        }
        result = eval(expr, safe_globals, {})

        if isinstance(result, bool):
            return result
        if isinstance(result, (int, float)):
            return _cef_normalize_number(result)
        if result is not None:
            return str(result)
        return 0
    except Exception:
        return row.get(formula_str, 0) if isinstance(row, dict) else 0


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


def _cef_extract_val(child, col):
    if child is None:
        return 0
    if isinstance(child, dict):
        if col and child.get(col) is not None:
            try:
                return float(child[col])
            except (TypeError, ValueError):
                return 0
        for k, v in child.items():
            if not str(k).startswith('_'):
                try:
                    return float(v)
                except (TypeError, ValueError):
                    continue
        return 0
    try:
        return float(child)
    except (TypeError, ValueError):
        return 0


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
