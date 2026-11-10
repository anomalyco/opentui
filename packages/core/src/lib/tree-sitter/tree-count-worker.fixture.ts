import { parentPort } from "node:worker_threads"
import { Node, Parser, Tree } from "web-tree-sitter"
import "./parser.worker.js"

// Logs "tree-count <json>" on each performance request: the trees the parser worker parsed and has not deleted, and
// the reads from a tree it had deleted (Tree.delete() zeroes the tree's address).
const live = new Set<Tree>()
let freedReads = 0
const countFreed = (tree: Tree) => void ((tree as unknown as { 0: number })[0] === 0 && freedReads++)
const { parse } = Parser.prototype
const { delete: deleteTree, getChangedRanges } = Tree.prototype
Parser.prototype.parse = function (...args: Parameters<Parser["parse"]>) {
  const tree = parse.apply(this, args)
  if (tree) live.add(tree)
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
  if (message.type === "GET_PERFORMANCE") console.log(`tree-count ${JSON.stringify({ live: live.size, freedReads })}`)
})
