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

"""AST-based parser/evaluator for the calculated-field formula mini-language
(SI/ARRODONEIX/OR/AND/SUM/AVERAGE/COUNT/MIN/MAX/SUMIF/...). Replaces the
previous regex-transform-chain-into-restricted-eval() approach: a real
lexer/parser/AST removes a whole class of bugs that came from the old
engine's textual substitution steps interacting with each other (e.g.
OR(a.b.c) breaking whenever a.b.c also happened to be a resolvable field,
or "actiu and (unitats > 0)" getting hijacked by the AND(...) transform)."""

from .evaluator import evaluate_formula, validate_formula_syntax
from .lexer import FormulaSyntaxError
from .parser import parse

__all__ = ['evaluate_formula', 'validate_formula_syntax', 'FormulaSyntaxError', 'parse']
