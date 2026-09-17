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

"""Small value-coercion/comparison primitives shared by the formula
evaluator (this subpackage) and calc_fields.py's SUMIF-as-calculated-field-
type aggregation (run_agg_pass) -- kept in this leaf module, with no
dependency on calc_fields.py, so both sides can import from here without a
circular import (calc_fields.py imports evaluate_custom_formula from this
subpackage's __init__)."""


def is_cert(val):
    if val in (None, False, '', 0, 0.0, '0', '0.0'):
        return False
    if isinstance(val, str) and val.strip().upper() in ('NO', 'FALS', 'FALSE', '0', '0.0', 'N', 'OFF', 'DESACTIVAT'):
        return False
    return True


def is_fals(val):
    return not is_cert(val)


def extract_bool_val(val):
    if val in (None, False, 0, '0', '', '0.0'):
        return False
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return val != 0
    if isinstance(val, str):
        return val.strip().lower() in ('true', '1', 'si', 'sí', 'cert', 'yes')
    return bool(val)


def normalize_number(n):
    """Rounds to 6 decimals and collapses whole-number floats to int (e.g.
    30.0 -> 30). JS's single Number type never carries this distinction —
    JSON.stringify(30.0) is "30" — so without this, a value that used to
    render as "30" in a generated document would render as "30.0" now that
    calculation happens in Python."""
    rounded = round(float(n) * 1000000) / 1000000
    if rounded == int(rounded) and abs(rounded) < 1e15:
        return int(rounded)
    return rounded


def reduce_numeric(fn, nums):
    """Shared numeric reducer for SUM/AVERAGE/MIN/MAX."""
    fn = (fn or 'SUM').upper()
    if fn == 'SUM':
        return normalize_number(sum(nums))
    if fn in ('AVG', 'AVERAGE'):
        return normalize_number(sum(nums) / len(nums)) if nums else 0
    if fn == 'MIN':
        return normalize_number(min(nums)) if nums else 0
    if fn == 'MAX':
        return normalize_number(max(nums)) if nums else 0
    return 0


def coerce_num_or_str(raw_val):
    """Coerces a raw value to a number when it looks like one, else returns
    it unchanged as a plain string/other value -- for direct comparison
    (SUMIF criteria matching), never for splicing into source text."""
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


def criteria_matches(cell_val, criteria_val):
    """Tolerant SUMIF-style comparison: numeric when both sides parse as
    numbers, case-insensitive string compare otherwise."""
    if cell_val is None or criteria_val is None:
        return cell_val == criteria_val
    try:
        return float(cell_val) == float(criteria_val)
    except (TypeError, ValueError):
        return str(cell_val).strip().lower() == str(criteria_val).strip().lower()


def iter_tables(obj, depth=0):
    """Yields every list-of-dicts ("table") found in `obj`, at any depth
    (limited to 10) -- used by the foreign-key scalar fallback (a formula
    token resolves to a scalar FK value like "PART-01" and the next path
    segment names a column on the related row) so it can find the related
    table nested inside a key-value group, not just one sitting at the top
    level of the data tree."""
    if depth > 10 or not isinstance(obj, (dict, list)):
        return
    if isinstance(obj, list):
        if obj and isinstance(obj[0], dict):
            yield obj
        for item in obj:
            yield from iter_tables(item, depth + 1)
    else:
        for val in obj.values():
            yield from iter_tables(val, depth + 1)


def extract_row_val(child, col):
    """Reads a numeric value off one aggregated row: `child[col]` when `col`
    is given and present, else the first non-underscore-prefixed field that
    parses as a number, else 0 (or `child` itself coerced, when it's not a
    dict at all -- an aggregated list of plain numbers rather than rows)."""
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


def as_number(v):
    """Coerces a single (possibly missing/unparsable) value to a float for
    an aggregation reducer, defaulting to 0 -- the SUM/AVERAGE/MIN/MAX
    family's tolerant behavior (never raises on a row with a blank or
    non-numeric column)."""
    if v is None:
        return 0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0
