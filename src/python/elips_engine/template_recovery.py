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

"""Jinja2 error recovery: the Tracked*/Placeholder/SafeDict class family the
two render passes wrap the data tree in, and the "render, catch
UndefinedError, patch in a Placeholder, re-render" loop that lets a template
referencing a missing/misspelled path degrade to a visible marker instead of
crashing the whole document."""

import re

from jinja2 import Environment, DebugUndefined
from jinja2.exceptions import UndefinedError, TemplateSyntaxError

from .text_utils import sanitize_id

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

    def __getattr__(self, name):
        if name.startswith('_') or name in ('val', 'enable_links', 'get', 'keys', 'items', 'values'):
            raise AttributeError(name)
        if name in ('value', 'val'):
            return TrackedValue(self.val, f"{self._path}.{name}" if self._path else name, self.enable_links)

        # On-the-fly Foreign Key lookup: search global doc for matching row
        if hasattr(self, '_doc_ref') and isinstance(self._doc_ref, dict) and self.val not in (None, ''):
            val_str = str(self.val)
            for sheet_name, sheet_data in self._doc_ref.items():
                if isinstance(sheet_data, list):
                    for row in sheet_data:
                        if isinstance(row, dict):
                            if any(str(v) == val_str for k_v, v in row.items() if not k_v.startswith('_')):
                                if name in row:
                                    return _wrap_tracked(row[name], f"{self._path}.{name}" if self._path else name, self.enable_links, doc_ref=self._doc_ref)

        return Placeholder(f"{self._path}.{name}" if self._path else name)

    def __getitem__(self, item):
        try:
            return self.__getattr__(str(item))
        except AttributeError:
            return Placeholder(f"{self._path}.{item}" if self._path else str(item))

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

    def __str__(self):
        if '_default_val' in self:
            # Use the raw scalar here, not the wrapped TrackedValue stored in
            # self['_default_val'] — that one already carries its own
            # `<a>`-link wrapper (added when the FK row's field values were
            # wrapped), and re-wrapping its rendered string in another `<a>`
            # would produce invalid nested anchors in the HTML preview.
            raw = super().__getitem__('_default_val')
            raw_val = raw.val if isinstance(raw, TrackedValue) else raw
            val_str = str(raw_val)
            if getattr(self, 'enable_links', True) and getattr(self, '_path', ''):
                clean_path = self._path.lstrip('.')
                return f'<a href="#dades.{clean_path}" class="data-link" title="Anar a la dada: {clean_path}">{val_str}</a>'
            return val_str
        return super().__str__()


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

    def __str__(self):
        if '_default_val' in self:
            return str(self['_default_val'])
        return super().__str__()


def _placeholder(path):
    return Placeholder(path)


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


def _get_line(src, lineno):
    if not lineno:
        return ''
    lines = src.splitlines()
    if 1 <= lineno <= len(lines):
        return lines[lineno - 1]
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
        except TemplateSyntaxError as e:
            lineno = getattr(e, 'lineno', None)
            msg = str(e)
            lines = current_src.splitlines()
            issues.append({
                'pass': pass_label,
                'line': lineno,
                'key': 'syntax_error',
                'message': f"Sintaxi Jinja2 no vàlida a la línia {lineno}: '{msg}'. S'ha corregit automàticament."
            })
            if lineno and 1 <= lineno <= len(lines):
                bad_line = lines[lineno - 1]
                lines[lineno - 1] = bad_line.replace('{{', '&#123;&#123;').replace('}}', '&#125;&#125;').replace('{%', '&#123;&#37;').replace('%}', '&#37;&#125;')
                current_src = '\\n'.join(lines)
                continue
            break
        except Exception as e:
            msg = str(e)
            issues.append({
                'pass': pass_label,
                'line': 0,
                'key': 'render_error',
                'message': f"Error de renderitzat ({pass_label}): {msg}"
            })
            break

    # Fallback to non-strict environment if recovery loop gets stuck.
    # trim_blocks/lstrip_blocks=True (matching env_clean/env_html below):
    # without them, a {% for %}/{% endif %}/etc. tag's own newline survives
    # in the output, leaving a blank line before/after every loop iteration
    # and every if/endif — breaking Markdown tables (a blank line ends a
    # table) and adding unwanted spacing between guarded paragraphs.
    env_lax = Environment(undefined=DebugUndefined, autoescape=False, trim_blocks=True, lstrip_blocks=True)
    env_lax.filters.update(env.filters)
    env_lax.globals.update(env.globals)
    try:
        out = env_lax.from_string(current_src).render(**ctx)
        return out, issues
    except Exception:
        return current_src, issues
