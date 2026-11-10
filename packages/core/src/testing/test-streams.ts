import { Readable, Writable, type WritableOptions } from "stream"

export class TestWriteStream extends Writable {
  public readonly isTTY = true
  public readonly columns: number
  public readonly rows: number

  constructor(columns = 80, rows = 24, options?: WritableOptions) {
    super(options)
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

/**
 * Test stdout that copies every write. `hold()` parks the next write's completion until `release()`, which models a
 * slow terminal or socket: the Session keeps the frame pending and later output queued.
 */
export class RecordingWriteStream extends TestWriteStream {
  public readonly writes: Buffer[] = []
  private held = false
  private parked: (() => void) | undefined

  override _write(chunk: Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    // The Session reuses its output storage after acknowledgement.
    this.writes.push(Buffer.from(chunk))
    if (this.held) this.parked = () => callback()
    else callback()
  }

  /** True while a write waits for `release()`. */
  get pendingWrite(): boolean {
    return this.parked !== undefined
  }

  hold(): void {
    this.held = true
  }

  /** Stops holding and completes the parked write, if any. */
  release(): void {
    this.held = false
    const parked = this.parked
    this.parked = undefined
    parked?.()
  }

  bytes(): Buffer {
    return Buffer.concat(this.writes)
  }

  text(): string {
    return this.bytes().toString()
  }

  clear(): void {
    this.writes.length = 0
  }
}

export type TestStdout = TestWriteStream & NodeJS.WriteStream

export function createTestStdin(): NodeJS.ReadStream {
  return new Readable({ read() {} }) as NodeJS.ReadStream
}

export function createTestStdout(columns = 80, rows = 24): NodeJS.WriteStream {
  return new TestWriteStream(columns, rows) as TestStdout
}
