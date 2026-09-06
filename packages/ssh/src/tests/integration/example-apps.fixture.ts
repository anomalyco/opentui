import ssh2 from "ssh2"

const listen = ssh2.Server.prototype.listen
ssh2.Server.prototype.listen = function (this: ssh2.Server, ...args: Parameters<typeof listen>) {
  this.once("listening", () => {
    const address = this.address()
    if (typeof address === "object" && address) process.send?.({ port: address.port })
  })
  return listen.apply(this, args)
} as typeof listen
