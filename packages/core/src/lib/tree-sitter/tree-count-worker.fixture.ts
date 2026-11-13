import { parentPort } from "node:worker_threads"
import { Node, Parser, Tree } from "web-tree-sitter"
import "./parser.worker.js"

// Logs "tree-count <json>" on each performance request: the trees the parser worker parsed and has not deleted, the
// reads from a tree it had deleted (Tree.delete() zeroes the tree's address), the parsers it has not deleted, and the
// parses that reused an old tree.
const live = new Set<Tree>()
const parsers = new Set<Parser>()
let freedReads = 0
let reused = 0
const countFreed = (tree: Tree) => void ((tree as unknown as { 0: number })[0] === 0 && freedReads++)
const { parse, setLanguage, delete: deleteParser } = Parser.prototype
// The worker sets a language on every parser it creates, right after new Parser().
Parser.prototype.setLanguage = function (...args: Parameters<Parser["setLanguage"]>) {
  parsers.add(this)
  return setLanguage.apply(this, args)
}
Parser.prototype.delete = function () {
  parsers.delete(this)
  deleteParser.call(this)
}
const { delete: deleteTree, getChangedRanges } = Tree.prototype
// A cancelled parse returns null; the worker sets no timeout, so the text "null-parse" stands in for one.
Parser.prototype.parse = function (...args: Parameters<Parser["parse"]>) {
  const tree = args[0] === "null-parse" ? null : parse.apply(this, args)
  if (tree) live.add(tree)
  if (args[1]) reused++
  return tree
}
Tree.prototype.delete = function () {
  live.delete(this)
  deleteTree.call(this)
}
Tree.prototype.getChangedRanges = function (other: Tree) {
  countFreed(this)
  return getChangedRanges.call(this, other)
}
for (const key of ["endIndex", "endPosition"]) {
  const get = Object.getOwnPropertyDescriptor(Node.prototype, key)!.get!
  Object.defineProperty(Node.prototype, key, {
    get(this: Node) {
      countFreed(this.tree)
      return get.call(this)
    },
  })
}
parentPort!.on("message", (message: { type?: string }) => {
  if (message.type !== "GET_PERFORMANCE") return
  console.log(`tree-count ${JSON.stringify({ live: live.size, freedReads, parsers: parsers.size, reused })}`)
})
