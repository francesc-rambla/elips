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

"""Evaluator for the calculated-field formula mini-language's AST (see
parser.py for the grammar). The one design idea that drives everything here:
a dotted `Path` node evaluates in one of two modes, decided purely by WHERE
it sits in the expression, never by the function inspecting it:

  * VECTOR mode -- a Path passed directly as an argument to a
    vector-consuming function (OR/AND/SUM/AVERAGE/COUNT/MIN/MAX, and
    SUMIF's two path arguments) yields a plain list of one value per row
    crossed. Those functions are then trivial generic reducers (any/all/
    sum/len/min/max) with no path-awareness of their own.

  * SCALAR mode -- a Path used anywhere else (bare arithmetic, a function
    argument that isn't itself a vector-consuming slot, ...) yields a
    single value: unchanged if the path never crosses a list, or the sum
    of its numeric-coercible per-row values if it does (the same implicit
    "bare field = sum across the table" quirk the old regex engine had,
    kept for backward compatibility with existing formulas).

`ctx` is a `(row, global_data, parent_chain)` triple throughout this module.
`parent_chain` is a tuple of ancestor rows, nearest first (the immediate
containing row of a nested table/group, then ITS containing row, and so on
up to the top-level sheet), empty at the root. `parent` is a reserved leading
Path segment: `parent.camp` resolves `camp` against `parent_chain[0]`,
`parent.parent.camp` against `parent_chain[1]`, etc. -- the recursive
behavior falls out of simply stripping one `parent` segment at a time and
re-indexing into the chain, no separate "grandparent" concept needed."""

from . import ast_nodes as A
from .lexer import tokenize, FormulaSyntaxError
from .parser import Parser
from .primitives import (
    is_cert, is_fals, extract_bool_val, normalize_number, reduce_numeric,
    coerce_num_or_str, criteria_matches, iter_tables, as_number, extract_row_val,
)

_OR_NAMES = ('OR', 'O', 'ANY', 'SOME')
_AND_NAMES = ('AND', 'I', 'EVERY', 'ALL')
_NUMERIC_AGG_NAMES = ('SUM', 'AVERAGE', 'AVG', 'MIN', 'MAX')


# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------

def _walk_path(current, segments, ctx):
    """Walks `segments` (a list of ('attr', name) / ('index', ast_node))
    through `current`. Returns (value, crossed_list):

    - Hitting a list at an 'attr' segment fans out: the rest of the path is
      resolved independently inside every row, producing one entry per row
      (crossed_list becomes True from that point on, and stays True all the
      way back up the call stack).
    - Hitting a list at an 'index' segment instead indexes into it (a single
      element, not a fan-out).
    - Hitting a plain scalar (str/int/float) with segments still left is the
      foreign-key case: the scalar is treated as a related row's key and
      looked up across every table in the data tree (any depth), continuing
      the walk from the matching row.
    """
    if not segments:
        return current, False
    if current is None:
        return None, False
    seg, rest = segments[0], segments[1:]
    global_data = ctx[1]

    if isinstance(current, list):
        if seg[0] == 'index':
            idx = _eval_index(seg[1], ctx)
            if idx is None or idx < 0 or idx >= len(current):
                return None, False
            return _walk_path(current[idx], rest, ctx)
        vector = []
        for item in current:
            sub, _ = _walk_path(item, segments, ctx)
            vector.append(sub)
        return vector, True

    if seg[0] == 'index':
        return None, False
    part = seg[1]

    if isinstance(current, dict):
        nxt = current.get(part)
        if nxt is None:
            return None, False
        return _walk_path(nxt, rest, ctx)

    if isinstance(current, (str, int, float)) and not isinstance(current, bool):
        if global_data:
            # `current` is a scalar that itself came from the row being
            # evaluated (e.g. row['element']), so the row's own table always
            # contains a "match" for it -- itself. Without excluding it, a
            # calculated field whose own column name happens to also exist
            # on the row (e.g. a field literally named `preu`, matching the
            # `preu` column on the FK's target table) would resolve `part`
            # against its OWN already-computed value instead of ever
            # reaching the real target row, converging on a fixed point that
            # never changes (each evaluation "confirms" whatever value was
            # already there, regardless of which row is actually selected).
            origin_row = ctx[0]
            for table in iter_tables(global_data):
                match_row = next((r for r in table if isinstance(r, dict) and r is not origin_row
                                   and any(str(v) == str(current) for v in r.values())), None)
                if match_row is not None and part in match_row:
                    return _walk_path(match_row[part], rest, ctx)
        return None, False

    return None, False


def _eval_index(node, ctx):
    val = eval_node(node, ctx)
    if isinstance(val, bool):
        return None
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def _resolve_path(segments, ctx):
    """Resolves `segments` against `row` first, falling back to
    `global_data` (whole tree) and then an `OUT_`-prefixed root sheet name --
    mirroring the old engine's fallback order. A `doc.`/`dades.` leading
    segment is a root alias, stripped before resolution. One or more leading
    `parent` segments instead jump to the corresponding ancestor row in
    `ctx`'s parent_chain and resolve the rest of the path from there (see
    this module's docstring) -- checked first, so `parent` always means
    "go to the ancestor", even on the unlikely chance a row has its own
    `parent` column."""
    row, global_data, parent_chain = ctx
    n_parent = 0
    while n_parent < len(segments) and segments[n_parent][0] == 'attr' and segments[n_parent][1].lower() == 'parent':
        n_parent += 1
    if n_parent > 0:
        if not parent_chain or n_parent > len(parent_chain):
            return None, False
        rest = segments[n_parent:]
        if not rest:
            return None, False
        return _walk_path(parent_chain[n_parent - 1], rest, ctx)

    has_index = any(s[0] == 'index' for s in segments)
    if not has_index:
        raw_path = '.'.join(s[1] for s in segments)
        if isinstance(row, dict) and raw_path in row:
            return row[raw_path], False

    work = list(segments)
    if work and work[0][0] == 'attr' and work[0][1].lower() in ('doc', 'dades'):
        work = work[1:]
    if not work:
        return None, False

    val, crossed = _walk_path(row, work, ctx) if isinstance(row, (dict, list)) else (None, False)
    if val is None and global_data is not None:
        val, crossed = _walk_path(global_data, work, ctx)
        if val is None and work[0][0] == 'attr':
            prefixed = [('attr', 'OUT_' + work[0][1])] + work[1:]
            val, crossed = _walk_path(global_data, prefixed, ctx)
    return val, crossed


def eval_path_scalar(segments, ctx):
    val, crossed = _resolve_path(segments, ctx)
    if not crossed:
        return coerce_num_or_str(val) if val is not None else None
    nums = []
    for v in val:
        try:
            nums.append(float(v))
        except (TypeError, ValueError):
            pass
    return normalize_number(sum(nums)) if nums else 0


def eval_path_vector(segments, ctx):
    val, crossed = _resolve_path(segments, ctx)
    if crossed:
        return val
    if isinstance(val, list):
        return val
    return [] if val is None else [val]


# ---------------------------------------------------------------------------
# Table locator for SUMIF (needs a criteria column and a sum column read off
# the SAME row, which a flattened vector can't give back)
# ---------------------------------------------------------------------------

def _locate_list(current, names):
    if not names:
        return current if isinstance(current, list) else None
    if isinstance(current, list):
        for item in current:
            if isinstance(item, dict):
                found = _locate_list(item, names)
                if found is not None:
                    return found
        return None
    if not isinstance(current, dict):
        return None
    return _locate_list(current.get(names[0]), names[1:])


def _resolve_table(segments, ctx, drop_last_as_col=True):
    names = [s[1] for s in segments if s[0] == 'attr']
    row, global_data, parent_chain = ctx
    n_parent = 0
    while n_parent < len(names) and names[n_parent].lower() == 'parent':
        n_parent += 1
    if n_parent > 0:
        if not parent_chain or n_parent > len(parent_chain):
            return None, None
        row = parent_chain[n_parent - 1]
        names = names[n_parent:]
    if names and names[0].lower() in ('doc', 'dades'):
        names = names[1:]
    if drop_last_as_col and len(names) >= 2:
        group, col = names[:-1], names[-1]
    else:
        group, col = names, None
    rows = _locate_list(row, group) if isinstance(row, (dict, list)) else None
    if rows is None and global_data:
        rows = _locate_list(global_data, group)
        if rows is None and group:
            rows = _locate_list(global_data, ['OUT_' + group[0]] + group[1:])
    return rows, col


def _eval_criteria(node, ctx):
    """Quoted = literal; unquoted (a bare Path) = another field's current
    value, falling back to the raw dotted text as a literal if that path
    doesn't resolve to anything (the same tolerant convention as the SUMIF
    calculated-field type)."""
    if isinstance(node, A.Str):
        return coerce_num_or_str(node.value)
    if isinstance(node, A.Path):
        val = eval_path_scalar(node.segments, ctx)
        if val is not None:
            return val
        raw = '.'.join(s[1] for s in node.segments if s[0] == 'attr')
        return coerce_num_or_str(raw)
    return eval_node(node, ctx)


def _fn_sumif(args, ctx):
    if len(args) < 3 or not isinstance(args[0], A.Path) or not isinstance(args[2], A.Path):
        return 0
    rows, sum_col = _resolve_table(args[2].segments, ctx)
    if not rows:
        return 0
    crit_names = [s[1] for s in args[0].segments if s[0] == 'attr']
    crit_col = crit_names[-1] if crit_names else None
    criteria_val = _eval_criteria(args[1], ctx)
    total = sum(
        extract_row_val(r, sum_col) for r in rows
        if isinstance(r, dict) and criteria_matches(r.get(crit_col), criteria_val)
    )
    return normalize_number(total)


# ---------------------------------------------------------------------------
# Generic expression evaluation
# ---------------------------------------------------------------------------

_BINOPS = {
    '+': lambda a, b: a + b, '-': lambda a, b: a - b, '*': lambda a, b: a * b,
    '/': lambda a, b: a / b, '//': lambda a, b: a // b, '%': lambda a, b: a % b,
    '**': lambda a, b: a ** b,
    '==': lambda a, b: a == b, '!=': lambda a, b: a != b,
    '<': lambda a, b: a < b, '<=': lambda a, b: a <= b,
    '>': lambda a, b: a > b, '>=': lambda a, b: a >= b,
}


def _eval_vector_arg(arg_node, ctx):
    if isinstance(arg_node, A.Path):
        return eval_path_vector(arg_node.segments, ctx)
    val = eval_node(arg_node, ctx)
    return [] if val is None else [val]


def _flatten_args(args, ctx):
    out = []
    for a in args:
        out.extend(_eval_vector_arg(a, ctx))
    return out


def _eval_call(node, ctx):
    name = node.name.upper()
    args = node.args

    if name in ('SI', 'IF'):
        if len(args) < 3:
            raise FormulaSyntaxError(f'{node.name} necessita 3 arguments (condició; veritat; fals)')
        cond = eval_node(args[0], ctx)
        return eval_node(args[1], ctx) if cond else eval_node(args[2], ctx)

    if name in ('ARRODONEIX', 'ROUND'):
        val = eval_node(args[0], ctx) if args else 0
        prec = eval_node(args[1], ctx) if len(args) > 1 else 0
        if val is None or str(val).strip() == '':
            return 0
        return round(float(val), int(prec))

    if name == 'ABS':
        return abs(eval_node(args[0], ctx)) if args else 0

    if name == 'CERT':
        return is_cert(eval_node(args[0], ctx)) if args else False

    if name == 'FALS':
        return is_fals(eval_node(args[0], ctx)) if args else True

    if name in _OR_NAMES:
        return any(extract_bool_val(v) for v in _flatten_args(args, ctx))

    if name in _AND_NAMES:
        flat = _flatten_args(args, ctx)
        return len(flat) > 0 and all(extract_bool_val(v) for v in flat)

    if name in _NUMERIC_AGG_NAMES:
        nums = [as_number(v) for v in _flatten_args(args, ctx)]
        return reduce_numeric(name, nums)

    if name == 'COUNT':
        return sum(len(_eval_vector_arg(a, ctx)) for a in args)

    if name == 'SUMIF':
        return _fn_sumif(args, ctx)

    raise FormulaSyntaxError(f'Funció desconeguda: {node.name}')


def eval_node(node, ctx):
    t = type(node)
    if t is A.Num:
        return node.value
    if t is A.Str:
        return node.value
    if t is A.Bool:
        return node.value
    if t is A.Null:
        return None
    if t is A.Path:
        return eval_path_scalar(node.segments, ctx)
    if t is A.UnaryOp:
        if node.op == 'not':
            return not bool(eval_node(node.operand, ctx))
        val = eval_node(node.operand, ctx)
        return -val if node.op == '-' else +val
    if t is A.BinOp:
        return _BINOPS[node.op](eval_node(node.left, ctx), eval_node(node.right, ctx))
    if t is A.BoolOp:
        result = node.op != 'and'
        for v in node.values:
            result = eval_node(v, ctx)
            if node.op == 'and' and not result:
                return result
            if node.op == 'or' and result:
                return result
        return result
    if t is A.Ternary:
        return eval_node(node.body, ctx) if eval_node(node.cond, ctx) else eval_node(node.orelse, ctx)
    if t is A.Call:
        return _eval_call(node, ctx)
    raise FormulaSyntaxError(f'Node AST desconegut: {node!r}')


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------

def evaluate_formula(formula_str, row, global_data=None, parent_chain=None):
    """Evaluates one CUSTOM-formula string against `row` (the record being
    computed) and `global_data` (the whole data tree, for cross-group
    lookups). `parent_chain` is a tuple of ancestor rows, nearest first (see
    this module's docstring), letting the formula use `parent`/`parent.parent`
    to reach up the nested-table structure. Returns a number, bool or string,
    or `row.get(formula_str, 0)` as a last-resort fallback on any error -- a
    broken formula shouldn't crash the form, just leave the field showing
    something recognizable."""
    if not formula_str or not isinstance(formula_str, str):
        return 0
    try:
        node = Parser(tokenize(formula_str.strip())).parse()
        result = eval_node(node, (row, global_data, parent_chain or ()))
        if isinstance(result, bool):
            return result
        if isinstance(result, (int, float)):
            return normalize_number(result)
        if result is not None:
            return str(result)
        return 0
    except Exception:
        return row.get(formula_str, 0) if isinstance(row, dict) else 0


def validate_formula_syntax(formula_str):
    """Parses `formula_str` without evaluating it, to catch a malformed
    formula immediately (mirrors validate_template_syntax's shape for the
    Jinja2 template language). Never raises: any problem comes back as
    {'valid': False, 'error': {...}}."""
    import json
    if not formula_str or not isinstance(formula_str, str):
        return json.dumps({'valid': True, 'error': None})
    try:
        Parser(tokenize(formula_str.strip())).parse()
        return json.dumps({'valid': True, 'error': None})
    except FormulaSyntaxError as e:
        return json.dumps({'valid': False, 'error': {'message': str(e), 'pos': e.pos}})
    except Exception as e:
        return json.dumps({'valid': False, 'error': {'message': str(e), 'pos': None}})
