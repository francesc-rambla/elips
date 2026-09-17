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

"""AST node types for the calculated-field formula mini-language. Plain
classes with __slots__ rather than a heavier dataclass/namedtuple mix, kept
dependency-free so this module (like the rest of this subpackage) can be
reused unmodified outside Pyodide."""


class Num:
    __slots__ = ('value',)

    def __init__(self, value):
        self.value = value

    def __repr__(self):
        return f'Num({self.value!r})'


class Str:
    __slots__ = ('value',)

    def __init__(self, value):
        self.value = value

    def __repr__(self):
        return f'Str({self.value!r})'


class Bool:
    __slots__ = ('value',)

    def __init__(self, value):
        self.value = value

    def __repr__(self):
        return f'Bool({self.value!r})'


class Null:
    __slots__ = ()

    def __repr__(self):
        return 'Null()'


class Path:
    """A dotted/indexed reference such as `pres.parts[0].import`. `segments`
    is a list of ('attr', name) / ('index', ast_node) tuples -- an index
    segment holds an *expression* node (evaluated at runtime), not a raw
    literal, so `parts[i]` with a variable index is supported too."""
    __slots__ = ('segments',)

    def __init__(self, segments):
        self.segments = segments

    def __repr__(self):
        return f'Path({self.segments!r})'


class Call:
    __slots__ = ('name', 'args')

    def __init__(self, name, args):
        self.name = name
        self.args = args

    def __repr__(self):
        return f'Call({self.name!r}, {self.args!r})'


class UnaryOp:
    __slots__ = ('op', 'operand')

    def __init__(self, op, operand):
        self.op = op
        self.operand = operand

    def __repr__(self):
        return f'UnaryOp({self.op!r}, {self.operand!r})'


class BinOp:
    __slots__ = ('op', 'left', 'right')

    def __init__(self, op, left, right):
        self.op = op
        self.left = left
        self.right = right

    def __repr__(self):
        return f'BinOp({self.op!r}, {self.left!r}, {self.right!r})'


class BoolOp:
    """Short-circuiting `and`/`or` over 2+ operands (chained, like Python's
    own AST) -- kept distinct from BinOp because it must not eagerly
    evaluate every operand."""
    __slots__ = ('op', 'values')

    def __init__(self, op, values):
        self.op = op
        self.values = values

    def __repr__(self):
        return f'BoolOp({self.op!r}, {self.values!r})'


class Ternary:
    """Python-style `a if cond else b`."""
    __slots__ = ('body', 'cond', 'orelse')

    def __init__(self, body, cond, orelse):
        self.body = body
        self.cond = cond
        self.orelse = orelse

    def __repr__(self):
        return f'Ternary({self.body!r}, {self.cond!r}, {self.orelse!r})'
