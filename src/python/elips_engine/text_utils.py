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

"""Small standalone helpers with no dependency on any other module in this
package — string/column sanitizing and JSON-value coercion, shared by
excel_io, mirror_pattern and calc_fields."""

import re
import unicodedata
from datetime import datetime, date, time, timedelta
from decimal import Decimal


def sanitize_id(s, allow_dots=False):
    s = '' if s is None else str(s)
    s = s.replace(' ', '_')
    if allow_dots and '.' in s:
        parts = [sanitize_id(p, allow_dots=False) for p in s.split('.')]
        return '.'.join(parts)
    s = ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')
    s = re.sub(r'[^A-Za-z0-9_]', '_', s)
    s = re.sub(r'_+', '_', s).strip('_')
    if not s:
        s = '_'
    if not re.match(r'^[A-Za-z_]', s):
        s = '_' + s
    return s


def _col_letter(col_idx_1):
    result = ""
    n = col_idx_1
    while n > 0:
        n, remainder = divmod(n - 1, 26)
        result = chr(65 + remainder) + result
    return result


def _col_index_from_letter(letter):
    idx = 0
    for ch in letter.upper():
        idx = idx * 26 + (ord(ch) - ord('A') + 1)
    return idx


def _custom_json_default(o):
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    if isinstance(o, time):
        return o.isoformat()
    if isinstance(o, timedelta):
        return str(o)
    if isinstance(o, Decimal):
        if o == o.to_integral_value():
            return int(o)
        return float(o)
    if isinstance(o, bytes):
        return o.decode('utf-8', errors='ignore')
    return str(o)


def _to_jsonable(v, date_format='iso'):
    if v is None:
        return None
    if isinstance(v, (int, float, bool, str)):
        return v
    if isinstance(v, datetime):
        v = v.date()
    if isinstance(v, date):
        return v.isoformat() if date_format == 'iso' else v.strftime('%d/%m/%Y')
    if isinstance(v, time):
        return v.isoformat()
    if isinstance(v, timedelta):
        return str(v)
    if isinstance(v, Decimal):
        if v == v.to_integral_value():
            return int(v)
        return float(v)
    if isinstance(v, bytes):
        return v.decode('utf-8', errors='ignore')
    return str(v)


def _cast_numeric_strings(obj):
    """Not called anywhere in this codebase today (kept as-is from the
    original single-file engine.py rather than dropped during the module
    split — deleting genuinely-unused code is a separate decision from
    reorganizing files)."""
    if isinstance(obj, dict):
        return {k: _cast_numeric_strings(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_cast_numeric_strings(item) for item in obj]
    elif isinstance(obj, str):
        s = obj.strip()
        if (s.isdigit() and (len(s) == 1 or not s.startswith('0'))) or (s.startswith('-') and s[1:].isdigit() and (len(s[1:]) == 1 or not s[1:].startswith('0'))):
            try:
                return int(s)
            except ValueError:
                pass
        if '.' in s:
            try:
                return float(s)
            except ValueError:
                pass
    return obj
