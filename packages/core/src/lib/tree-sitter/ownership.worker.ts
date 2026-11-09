import { parentPort } from "node:worker_threads"
import { Parser, Tree } from "web-tree-sitter"

let created = 0
let deleted = 0
const observed = new WeakSet<Tree>()
const parse = Parser.prototype.parse
const deleteTree = Tree.prototype.delete
Parser.prototype.parse = function (...args: Parameters<typeof parse>) {
  const tree = parse.apply(this, args)
  if (tree) {
    observed.add(tree)
    created++
  }
  return tree
}
Tree.prototype.delete = function () {
  deleteTree.call(this)
  if (observed.delete(this)) deleted++
}
parentPort!.on("message", (message) => {
  if (message.type === "GET_PERFORMANCE") {
    parentPort!.postMessage({
      type: "WORKER_LOG",
      logType: "log",
      data: [`ownership ${JSON.stringify([created, deleted])}`],
    })
  }
})
await import("./parser.worker.js")
parentPort!.postMessage({ type: "WORKER_LOG", logType: "log", data: ["ownership-ready"] })
