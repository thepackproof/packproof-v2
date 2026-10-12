'use strict';

// PackProof GHSA-vfj7-8cjw-p6xm: bound structural recursion independently of
// the existing character limit. Literal/escaped braces do not consume depth.
const MAX_DEPTH = 128;
const assertDepth = depth => {
  if (depth > MAX_DEPTH) {
    throw new SyntaxError(`Braces nesting depth exceeds the supported maximum (${MAX_DEPTH})`);
  }
};

// Public walkers also accept caller-supplied ASTs. Check without recursion so
// those entry points cannot bypass the parser limit (including nodes cycles).
const assertAstDepth = ast => {
  const stack = [{ node: ast, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    if (node && Array.isArray(node.nodes)) {
      assertDepth(depth);
      for (const child of node.nodes) stack.push({ node: child, depth: depth + 1 });
    }
  }
};

module.exports = { MAX_DEPTH, assertDepth, assertAstDepth };
