import { Readable, Writable } from "stream"

export class TestWriteStream extends Writable {
  public readonly isTTY = true
  public readonly columns: number
  public readonly rows: number

  constructor(columns = 80, rows = 24) {
    super()
    this.columns = columns
    this.rows = rows
  }

  override _write(_chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback()
  }

  getColorDepth(): number {
    return 24
  }
}

export type TestStdout = TestWriteStream & NodeJS.WriteStream

export function createTestStdin(): NodeJS.ReadStream {
  return new Readable({ read() {} }) as NodeJS.ReadStream
}

export function createTestStdout(columns = 80, rows = 24): NodeJS.WriteStream {
  return new TestWriteStream(columns, rows) as TestStdout
}
