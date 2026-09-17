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

"""Locale-aware number/currency/date-to-words spelling and elips' own Jinja2
filters (coin/number/percent/words/prefix/sort/where/cert/fals), plus
_register_common_filters, which wires all of them onto an Environment."""

from datetime import datetime, date

from jinja2 import pass_context

from .template_recovery import TrackedValue, _wrap_tracked


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
def filter_percent(context, value, precision=2, force_symbol=True):
    orig_path = getattr(value, '_path', None)
    enable_links = getattr(value, 'enable_links', True)
    val_raw = value.val if isinstance(value, TrackedValue) else value
    locale_code = get_locale_from_context(context)
    if val_raw in (None, ''):
        return _wrap_res('', orig_path, enable_links)

    if isinstance(val_raw, str):
        val_raw = val_raw.replace('%', '').strip()

    try:
        val = float(val_raw)
        precision = int(precision)
    except (ValueError, TypeError):
        return _wrap_res(val_raw, orig_path, enable_links)

    # Scale proportion to percentage if in range [-1.0, 1.0] non-zero (0.5 -> 50.0%)
    if -1.0 <= val <= 1.0 and val != 0:
        val = val * 100.0

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
        res_num = f"{formatted_int}{dec_sep}{decimal_part}"
        if res_num.endswith(dec_sep + '00'):
            res_num = res_num[:-3]
        elif res_num.endswith('0') and dec_sep in res_num:
            res_num = res_num[:-1]
    else:
        res_num = formatted_int

    res = f"{res_num}%" if force_symbol else res_num
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
    import re
    orig_path = getattr(value, '_path', None)
    enable_links = getattr(value, 'enable_links', True)
    val_raw = value.val if isinstance(value, TrackedValue) else value
    s = str(val_raw or '').strip()
    if not s:
        return _wrap_res(s, orig_path, enable_links)

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


class _DescKey:
    def __init__(self, obj):
        self.obj = obj

    def __lt__(self, other):
        return self.obj > other.obj

    def __gt__(self, other):
        return self.obj < other.obj

    def __eq__(self, other):
        return self.obj == other.obj

    def __le__(self, other):
        return self.obj >= other.obj

    def __ge__(self, other):
        return self.obj <= other.obj


def filter_sort(value, by=None, reverse=False, attribute=None, case_sensitive=False):
    if attribute and not by:
        by = attribute

    if value in (None, ''):
        return []

    orig_path = getattr(value, '_path', None)
    enable_links = getattr(value, 'enable_links', True)

    if isinstance(value, (list, tuple)):
        lst = list(value)
    else:
        return value

    if not lst:
        return lst

    if by is None or by == '' or by == []:
        first_item = lst[0]
        if isinstance(first_item, dict) and len(first_item) > 0:
            keys = [k for k in first_item.keys() if not str(k).startswith('_')]
            if keys:
                by = [keys[0]]
            else:
                by = []
        else:
            def _scalar_key(item):
                v = item.val if hasattr(item, 'val') else item
                if v is None:
                    return (1, '')
                return (0, v)
            sorted_lst = sorted(lst, key=_scalar_key, reverse=reverse)
            return _wrap_tracked(sorted_lst, orig_path, enable_links) if orig_path else sorted_lst

    if isinstance(by, str):
        keys_spec = [by]
    elif isinstance(by, (list, tuple)):
        keys_spec = list(by)
    else:
        keys_spec = [str(by)]

    def _sort_key(item):
        raw_item = item
        keys_tuple = []
        for spec in keys_spec:
            spec_str = str(spec).strip()
            desc = False
            col_name = spec_str
            if spec_str.startswith('-'):
                desc = True
                col_name = spec_str[1:].strip()
            elif spec_str.startswith('+'):
                col_name = spec_str[1:].strip()

            val = None
            if isinstance(raw_item, dict):
                val = raw_item.get(col_name)
            elif hasattr(raw_item, col_name):
                val = getattr(raw_item, col_name)

            if hasattr(val, 'val'):
                val = val.val

            if val is None:
                sort_v = ''
                type_rank = 2
            elif isinstance(val, (int, float)):
                sort_v = -float(val) if desc else float(val)
                type_rank = 0
            else:
                s_v = str(val).lower() if not case_sensitive else str(val)
                sort_v = _DescKey(s_v) if desc else s_v
                type_rank = 1

            keys_tuple.append((type_rank, sort_v))
        return tuple(keys_tuple)

    sorted_lst = sorted(lst, key=_sort_key, reverse=reverse)
    return _wrap_tracked(sorted_lst, orig_path, enable_links) if orig_path else sorted_lst


def filter_where(value, criteria=None, **kwargs):
    if value in (None, ''):
        return []

    orig_path = getattr(value, '_path', None)
    enable_links = getattr(value, 'enable_links', True)

    if isinstance(value, (list, tuple)):
        lst = list(value)
    else:
        return value

    target_criteria = {}
    if isinstance(criteria, dict):
        target_criteria.update(criteria)
    elif isinstance(criteria, str) and kwargs:
        target_criteria[criteria] = list(kwargs.values())[0]
    target_criteria.update(kwargs)

    if not target_criteria:
        res = [item for item in lst if item]
        return _wrap_tracked(res, orig_path, enable_links) if orig_path else res

    def _matches_item(item):
        for col_name, req_val in target_criteria.items():
            col_str = str(col_name).strip()
            item_val = None
            if isinstance(item, dict):
                item_val = item.get(col_str)
            elif hasattr(item, col_str):
                item_val = getattr(item, col_str)

            if hasattr(item_val, 'val'):
                item_val = item_val.val

            def _single_match(act, exp):
                if exp is None:
                    return act is None or act == ''
                if act is None:
                    return False
                try:
                    act_num = float(act)
                    exp_num = float(exp)
                    return act_num == exp_num
                except (ValueError, TypeError):
                    pass
                return str(act).strip().lower() == str(exp).strip().lower()

            if isinstance(req_val, (list, tuple, set)):
                if not any(_single_match(item_val, rv) for rv in req_val):
                    return False
            else:
                if not _single_match(item_val, req_val):
                    return False
        return True

    res = [item for item in lst if _matches_item(item)]
    return _wrap_tracked(res, orig_path, enable_links) if orig_path else res


def is_excel_true(val):
    if hasattr(val, 'val'):
        val = val.val
    if val in (None, '', 0, 0.0, False, '0', '0.0'):
        return False
    if isinstance(val, str):
        v_str = val.strip().upper()
        if v_str in ('NO', 'FALS', 'FALSE', '0', '0.0', 'N', 'OFF', 'DESACTIVAT'):
            return False
    return True


def filter_cert(value):
    return is_excel_true(value)


def filter_fals(value):
    return not is_excel_true(value)


def _register_common_filters(env):
    """Wires elips' own Jinja2 filters/tests/globals onto an Environment.
    Shared by the two main render passes and by render_expression_preview
    so a filter behaves identically in the real document and in the
    variable modal's live preview."""
    env.filters['coin'] = filter_coin
    env.filters['number'] = filter_number
    env.filters['percent'] = filter_percent
    env.filters['percentatge'] = filter_percent
    env.filters['porcentaje'] = filter_percent
    env.filters['pct'] = filter_percent
    env.filters['words'] = filter_words
    env.filters['prefix'] = filter_prefix
    env.filters['sort'] = filter_sort
    env.filters['filter'] = filter_where
    env.filters['where'] = filter_where
    env.filters['CERT'] = filter_cert
    env.filters['cert'] = filter_cert
    env.filters['FALS'] = filter_fals
    env.filters['fals'] = filter_fals
    env.filters['IS_CERT'] = filter_cert
    env.filters['is_cert'] = filter_cert
    env.filters['IS_FALS'] = filter_fals
    env.filters['is_fals'] = filter_fals
    env.tests['CERT'] = filter_cert
    env.tests['cert'] = filter_cert
    env.tests['FALS'] = filter_fals
    env.tests['fals'] = filter_fals
    env.tests['is_cert'] = filter_cert
    env.tests['is_fals'] = filter_fals
    env.globals['TRUE'] = True
    env.globals['FALSE'] = False
    env.globals['true'] = True
    env.globals['false'] = False
    env.globals['CERT'] = filter_cert
    env.globals['FALS'] = filter_fals
    env.globals['cert'] = filter_cert
    env.globals['fals'] = filter_fals
    env.globals['is_excel_true'] = is_excel_true
