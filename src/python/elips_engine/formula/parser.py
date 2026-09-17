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

"""Recursive-descent parser for the calculated-field formula mini-language.

Grammar (lowest to highest precedence):

    expr        := ternary
    ternary     := bool_or ( 'if' bool_or 'else' ternary )?
    bool_or     := bool_and ( 'or' bool_and )*
    bool_and    := bool_not ( 'and' bool_not )*
    bool_not    := 'not' bool_not | comparison
    comparison  := additive ( (== | != | < | <= | > | >=) additive )*
    additive    := multiplicative ( (+ | -) multiplicative )*
    multiplicative := unary ( (* | / | // | %) unary )*
    unary       := (+ | -) unary | power
    power       := postfix ( ** unary )?          # right-associative
    postfix     := primary ( '.' IDENT | '[' expr ']' )*
    primary     := NUMBER | STRING | 'True' | 'False' | 'None'
                 | IDENT '(' args ')'              # function call
                 | IDENT                           # start of a dotted path
                 | '(' expr ')'

`and`/`or`/`not`/`if`/`else`/`True`/`False`/`None` are reserved EXACTLY as
spelled (case-sensitive) -- any other casing (AND, Or, TRUE, ...) is an
ordinary identifier, resolved as a function call (if followed by '(') or a
data path. This is a deliberate, disclosed split from the old regex engine,
which hijacked "and("/"or(" at ANY casing -- including inside a perfectly
ordinary boolean expression like `actiu and (unitats > 0)` -- into the
vector-aggregation form, because its matching was purely textual. A real
grammar naturally avoids that clash instead of working around it.
"""

from . import ast_nodes as A
from .lexer import tokenize, FormulaSyntaxError

_KEYWORDS = {'and', 'or', 'not', 'if', 'else', 'True', 'False', 'None'}


class Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.pos = 0

    def _peek(self):
        return self.tokens[self.pos]

    def _advance(self):
        tok = self.tokens[self.pos]
        if tok.type != 'EOF':
            self.pos += 1
        return tok

    def _check_kw(self, word):
        tok = self._peek()
        return tok.type == 'IDENT' and tok.value == word

    def _expect(self, type_, label=None):
        tok = self._peek()
        if tok.type != type_:
            raise FormulaSyntaxError(f"S'esperava {label or type_}, s'ha trobat {tok.value!r}", tok.pos)
        return self._advance()

    def parse(self):
        node = self._ternary()
        self._expect('EOF', 'final de la fórmula')
        return node

    def _ternary(self):
        body = self._bool_or()
        if self._check_kw('if'):
            self._advance()
            cond = self._bool_or()
            if not self._check_kw('else'):
                raise FormulaSyntaxError("S'esperava 'else' a l'expressió condicional", self._peek().pos)
            self._advance()
            orelse = self._ternary()
            return A.Ternary(body, cond, orelse)
        return body

    def _bool_or(self):
        values = [self._bool_and()]
        while self._check_kw('or'):
            self._advance()
            values.append(self._bool_and())
        return values[0] if len(values) == 1 else A.BoolOp('or', values)

    def _bool_and(self):
        values = [self._bool_not()]
        while self._check_kw('and'):
            self._advance()
            values.append(self._bool_not())
        return values[0] if len(values) == 1 else A.BoolOp('and', values)

    def _bool_not(self):
        if self._check_kw('not'):
            self._advance()
            return A.UnaryOp('not', self._bool_not())
        return self._comparison()

    _COMPARISON_OPS = {'EQ': '==', 'NE': '!=', 'LT': '<', 'LE': '<=', 'GT': '>', 'GE': '>='}

    def _comparison(self):
        node = self._additive()
        while self._peek().type in self._COMPARISON_OPS:
            op = self._COMPARISON_OPS[self._advance().type]
            node = A.BinOp(op, node, self._additive())
        return node

    def _additive(self):
        node = self._multiplicative()
        while self._peek().type in ('PLUS', 'MINUS'):
            op = self._advance().value
            node = A.BinOp(op, node, self._multiplicative())
        return node

    def _multiplicative(self):
        node = self._unary()
        while self._peek().type in ('STAR', 'SLASH', 'FLOORDIV', 'PERCENT'):
            op = self._advance().value
            node = A.BinOp(op, node, self._unary())
        return node

    def _unary(self):
        if self._peek().type in ('PLUS', 'MINUS'):
            op = self._advance().value
            return A.UnaryOp(op, self._unary())
        return self._power()

    def _power(self):
        node = self._postfix()
        if self._peek().type == 'POWER':
            self._advance()
            return A.BinOp('**', node, self._unary())
        return node

    def _postfix(self):
        node = self._primary()
        if not isinstance(node, A.Path):
            return node
        segments = list(node.segments)
        while True:
            tok = self._peek()
            if tok.type == 'DOT':
                self._advance()
                name_tok = self._expect('IDENT', 'nom de propietat')
                segments.append(('attr', name_tok.value))
            elif tok.type == 'LBRACKET':
                self._advance()
                idx_expr = self._ternary()
                self._expect('RBRACKET', "']'")
                segments.append(('index', idx_expr))
            else:
                break
        return A.Path(segments)

    def _primary(self):
        tok = self._peek()

        if tok.type == 'NUMBER':
            self._advance()
            return A.Num(tok.value)

        if tok.type == 'STRING':
            self._advance()
            return A.Str(tok.value)

        if tok.type == 'LPAREN':
            self._advance()
            node = self._ternary()
            self._expect('RPAREN', "')'")
            return node

        if tok.type == 'IDENT':
            if tok.value == 'True':
                self._advance()
                return A.Bool(True)
            if tok.value == 'False':
                self._advance()
                return A.Bool(False)
            if tok.value == 'None':
                self._advance()
                return A.Null()
            if tok.value in _KEYWORDS:
                raise FormulaSyntaxError(f"Paraula reservada inesperada {tok.value!r}", tok.pos)

            self._advance()
            if self._peek().type == 'LPAREN':
                self._advance()
                args = self._parse_args()
                self._expect('RPAREN', "')'")
                return A.Call(tok.value, args)
            return A.Path([('attr', tok.value)])

        raise FormulaSyntaxError(f"Token inesperat {tok.value!r}", tok.pos)

    def _parse_args(self):
        args = []
        if self._peek().type == 'RPAREN':
            return args
        args.append(self._ternary())
        while self._peek().type in ('COMMA', 'SEMI'):
            self._advance()
            args.append(self._ternary())
        return args


def parse(formula_str):
    return Parser(tokenize(formula_str)).parse()
