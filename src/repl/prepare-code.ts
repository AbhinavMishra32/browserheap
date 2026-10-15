/**
 * Turns one REPL call's code into a script QuickJS can run with top-level
 * `await`, keeping what it declares for the next call.
 *
 *   const s1 = await snapshot(page)          var s1; (async () => { s1 = await snapshot(page)
 *   console.log(s1.tree)                      console.log(s1.tree)
 *                                             })()
 *
 *   const { a, b } = x      →  (({ a, b } = x));
 *   let n                   →  n = undefined;
 *   function f() {}         →  stays (hoisted inside), and `f = f` at the start makes it global
 *   class C {}              →  C = class C {};
 *
 * Only declarations at the top level change; anything inside a block or a
 * function is left alone. Everything stays on its own line, so errors point
 * at the agent's own line numbers.
 *
 * Uses:    acorn
 * Used by: repl.ts
 * Built:   in O first (5.6), copied into agent-tabs
 */
import { type Node, parse } from "acorn"

/** import / require: there are no modules in the REPL. */
const MODULE_ACCESS = /\b(?:require|import)\s*\(|^\s*import\s/m

export class CodeError extends Error {}

interface Edit {
  start: number
  end: number
  text: string
}

interface Declarator {
  id: Node & { type: string; name?: string }
  init: Node | null
}

interface Statement extends Node {
  kind?: string
  declarations?: Declarator[]
  id?: (Node & { name: string }) | null
}

export function prepareCode(code: string): string {
  if (MODULE_ACCESS.test(code)) {
    throw new CodeError(
      "There are no modules here: no import or require. Everything you can use is already a global.",
    )
  }

  let program: Node & { body: Statement[] }
  try {
    program = parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    }) as Node & { body: Statement[] }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CodeError(`SyntaxError: ${message}`)
  }

  const names = new Set<string>()
  const functionNames: string[] = []
  const edits: Edit[] = []

  for (const statement of program.body) {
    if (statement.type === "VariableDeclaration" && statement.declarations !== undefined) {
      const parts: string[] = []
      for (const declarator of statement.declarations) {
        collectNames(declarator.id, names)
        const target = code.slice(declarator.id.start, declarator.id.end)
        const value =
          declarator.init === null ? "undefined" : code.slice(declarator.init.start, declarator.init.end)
        // A destructuring assignment needs parentheses to not read as a block.
        if (declarator.id.type === "ObjectPattern") {
          parts.push(`(${target} = ${value})`)
        } else {
          parts.push(`${target} = ${value}`)
        }
      }
      edits.push({
        start: statement.start,
        end: statement.end,
        text: `${keepLines(code, statement, parts.join(", "))};`,
      })
    } else if (statement.type === "FunctionDeclaration" && statement.id) {
      names.add(statement.id.name)
      functionNames.push(statement.id.name)
    } else if (statement.type === "ClassDeclaration" && statement.id) {
      names.add(statement.id.name)
      const source = code.slice(statement.start, statement.end)
      edits.push({ start: statement.start, end: statement.end, text: `${statement.id.name} = ${source};` })
    }
  }

  let body = code
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    body = body.slice(0, edit.start) + edit.text + body.slice(edit.end)
  }

  const declared = names.size > 0 ? `var ${[...names].join(", ")}; ` : ""
  // Function declarations are hoisted inside the wrapper; this makes them global too.
  const hoisted = functionNames.map((name) => `globalThis.${name} = ${name}; `).join("")
  return `${declared}(async () => { ${hoisted}${body}\n})()`
}

/** The names a declaration binds: `a`, or every name in `{ a, b: [c] }`. */
function collectNames(pattern: Node & { type: string; name?: string }, names: Set<string>): void {
  const node = pattern as Node & {
    type: string
    name?: string
    properties?: Array<{ type: string; value?: Node; argument?: Node }>
    elements?: Array<Node | null>
    left?: Node
    argument?: Node
  }
  if (node.type === "Identifier" && node.name !== undefined) {
    names.add(node.name)
  } else if (node.type === "ObjectPattern") {
    for (const property of node.properties ?? []) {
      const inner = property.type === "RestElement" ? property.argument : property.value
      if (inner !== undefined) collectNames(inner as Node & { type: string }, names)
    }
  } else if (node.type === "ArrayPattern") {
    for (const element of node.elements ?? []) {
      if (element !== null) collectNames(element as Node & { type: string }, names)
    }
  } else if (node.type === "AssignmentPattern" && node.left !== undefined) {
    collectNames(node.left as Node & { type: string }, names)
  } else if (node.type === "RestElement" && node.argument !== undefined) {
    collectNames(node.argument as Node & { type: string }, names)
  }
}

/** The replacement, padded with the line breaks the original had, so later lines keep their numbers. */
function keepLines(code: string, statement: Node, replacement: string): string {
  const original = code.slice(statement.start, statement.end)
  const breaks = (original.match(/\n/g) ?? []).length - (replacement.match(/\n/g) ?? []).length
  return breaks > 0 ? replacement + "\n".repeat(breaks) : replacement
}
