// Safe arithmetic expression compiler (no eval / Function).
//
//   expr    := term (('+' | '-') term)*
//   term    := unary (('*' | '/') unary)*
//   unary   := ('-' | '+') unary | power
//   power   := primary ('^' unary)?          right-associative, so 2^-1 and 2^3^2 work
//   primary := number | name | name '(' expr (',' expr)* ')' | '(' expr ')'
//
// -x^2 parses as -(x^2). `log` and `ln` are both the natural logarithm.

const FUNCS = {
  sin: [1, Math.sin],
  cos: [1, Math.cos],
  tan: [1, Math.tan],
  exp: [1, Math.exp],
  log: [1, Math.log],
  ln: [1, Math.log],
  log2: [1, Math.log2],
  sqrt: [1, Math.sqrt],
  abs: [1, Math.abs],
  pow: [2, Math.pow],
  min: [-1, Math.min],
  max: [-1, Math.max],
};
const CONSTS = { pi: Math.PI, e: Math.E };

export const RESERVED_NAMES = new Set([...Object.keys(FUNCS), ...Object.keys(CONSTS)]);
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const TOKEN_RE = /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\S))/y;

function tokenize(src) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while (TOKEN_RE.lastIndex < src.length && (m = TOKEN_RE.exec(src))) {
    const pos = m.index + m[0].length - (m[1] ?? m[2] ?? m[3] ?? '').length;
    if (m[1] !== undefined) tokens.push({ kind: 'num', value: Number(m[1]), pos });
    else if (m[2] !== undefined) tokens.push({ kind: 'name', value: m[2], pos });
    else if (m[3] !== undefined) tokens.push({ kind: 'op', value: m[3], pos });
  }
  tokens.push({ kind: 'end', value: '', pos: src.length });
  return tokens;
}

// Compiles `src` into (scope) => number. `names` lists the variables `scope` provides.
export function compile(src, names) {
  const allowed = new Set(names);
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const fail = (msg, tok = peek()) => {
    throw new Error(`Invalid expression "${src}": ${msg} at position ${tok.pos + 1}`);
  };
  const isOp = (value) => peek().kind === 'op' && peek().value === value;
  const expect = (value) => {
    if (!isOp(value)) fail(`expected "${value}"`);
    i++;
  };

  function expr() {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const op = tokens[i++].value;
      const a = left;
      const b = term();
      left = op === '+' ? (s) => a(s) + b(s) : (s) => a(s) - b(s);
    }
    return left;
  }

  function term() {
    let left = unary();
    while (isOp('*') || isOp('/')) {
      const op = tokens[i++].value;
      const a = left;
      const b = unary();
      left = op === '*' ? (s) => a(s) * b(s) : (s) => a(s) / b(s);
    }
    return left;
  }

  function unary() {
    if (isOp('-')) {
      i++;
      const a = unary();
      return (s) => -a(s);
    }
    if (isOp('+')) {
      i++;
      return unary();
    }
    return power();
  }

  function power() {
    const base = primary();
    if (!isOp('^')) return base;
    i++;
    const exponent = unary();
    return (s) => base(s) ** exponent(s);
  }

  function primary() {
    const tok = peek();
    if (tok.kind === 'num') {
      i++;
      return () => tok.value;
    }
    if (isOp('(')) {
      i++;
      const inner = expr();
      expect(')');
      return inner;
    }
    if (tok.kind !== 'name') fail(tok.kind === 'end' ? 'unexpected end' : `unexpected "${tok.value}"`);
    i++;
    const name = tok.value;
    if (Object.hasOwn(FUNCS, name)) return call(name, tok);
    if (Object.hasOwn(CONSTS, name)) {
      const value = CONSTS[name];
      return () => value;
    }
    if (!allowed.has(name)) fail(`unknown name "${name}"`, tok);
    return (s) => s[name];
  }

  function call(name, tok) {
    const [arity, fn] = FUNCS[name];
    expect('(');
    const args = [expr()];
    while (isOp(',')) {
      i++;
      args.push(expr());
    }
    expect(')');
    if (arity > 0 && args.length !== arity) fail(`${name}() takes ${arity} argument${arity > 1 ? 's' : ''}`, tok);
    if (args.length === 1) {
      const [a] = args;
      return (s) => fn(a(s));
    }
    return (s) => fn(...args.map((a) => a(s)));
  }

  const compiled = expr();
  if (peek().kind !== 'end') fail(`unexpected "${peek().value}"`);
  return compiled;
}
