// GENERATED — do not edit.
// Authoritative source: packages/dsh-wsl/lib/protocol.js
// Refresh with: node tools/sync-helper.mjs
/**
 * dsh-wsl wire protocol: shared by the Windows-side connection and the in-distro helper.
 *
 * This module has no dependencies and is imported by both halves, so it must stay
 * plain ESM that Node can run directly from either operating system.
 *
 * Framing
 * -------
 * Every message is `u32be payloadLength || utf8(JSON payload)`. Lengths are byte
 * counts of the UTF-8 encoding, never character counts. A frame larger than
 * {@link MAX_FRAME_BYTES} is rejected on both halves rather than buffered.
 *
 * Why length-prefixed instead of newline-delimited
 * -----------------------------------------------
 * The transport is `wsl.exe` stdio, which crosses the Windows/Linux boundary.
 * A newline-delimited protocol would be corrupted by newline translation and
 * cannot carry arbitrary JSON strings safely without escaping. A byte-count
 * prefix is immune to both and lets a receiver know exactly how much to read.
 *
 * @module @local/dsh-wsl/protocol
 */

/** Protocol revision. Bump on any incompatible change to methods or payload shapes. */
export const PROTOCOL_VERSION = 1

/** Hard ceiling for a single frame's JSON payload, matching the reference SSH helper. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

/** Every frame carries a `type` discriminator. */
export const FrameType = /** @type {const} */ ({
  /** helper -> host: first frame, proves identity and version match. */
  HELLO: 'hello',
  /** host -> helper: ordinary request. */
  REQUEST: 'request',
  /** helper -> host: successful response to a request. */
  RESPONSE: 'response',
  /** helper -> host: failed response to a request. */
  ERROR: 'error',
  /** both -> helper/host: liveness. The helper expires its lease without these. */
  HEARTBEAT: 'heartbeat',
  /** host -> helper: orderly shutdown; the helper tears down managed ranges. */
  SHUTDOWN: 'shutdown',
})

/**
 * Stable error codes the helper can return. Callers branch on these, never on
 * message text, so a reworded message cannot change control flow.
 */
export const HelperErrorCode = /** @type {const} */ ({
  BAD_FRAME: 'BAD_FRAME',
  UNKNOWN_METHOD: 'UNKNOWN_METHOD',
  INVALID_PARAMS: 'INVALID_PARAMS',
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  NOT_FOUND: 'NOT_FOUND',
  IO_ERROR: 'IO_ERROR',
  ABORTED: 'ABORTED',
  INTERNAL: 'INTERNAL',
})

/** An error carrying a stable {@link HelperErrorCode} across the wire. */
export class HelperError extends Error {
  /**
   * @param {string} code one of {@link HelperErrorCode}
   * @param {string} message human-readable detail; never parsed by callers
   * @param {unknown} [details] optional structured context
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'HelperError'
    this.code = code
    this.details = details
  }
}

/**
 * Encode one frame as a length-prefixed buffer.
 *
 * @param {object} message JSON-serializable frame body; must carry `type`
 * @returns {Buffer} the framed bytes, ready to write to the transport
 * @throws {HelperError} when the payload exceeds {@link MAX_FRAME_BYTES}
 */
export function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  if (payload.length > MAX_FRAME_BYTES) {
    throw new HelperError(
      HelperErrorCode.BAD_FRAME,
      `frame payload ${payload.length} exceeds ceiling ${MAX_FRAME_BYTES}`,
    )
  }
  const frame = Buffer.allocUnsafe(4 + payload.length)
  frame.writeUInt32BE(payload.length, 0)
  payload.copy(frame, 4)
  return frame
}

/**
 * Incremental frame decoder for a byte stream.
 *
 * Feed arbitrary chunks in any splitting; the decoder yields whole messages only.
 * On a corrupt length it throws {@link HelperError} and the caller must close the
 * transport: the stream cannot be resynchronized after a bad length.
 */
export class FrameDecoder {
  #buffer = Buffer.alloc(0)

  /**
   * Push one chunk and drain every complete frame it completes.
   *
   * @param {Buffer|Uint8Array} chunk bytes as received
   * @returns {object[]} decoded messages, in arrival order
   * @throws {HelperError} on an oversized or unparsable frame
   */
  push(chunk) {
    this.#buffer =
      this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk])

    const messages = []
    for (;;) {
      if (this.#buffer.length < 4) break
      const length = this.#buffer.readUInt32BE(0)
      if (length > MAX_FRAME_BYTES) {
        throw new HelperError(
          HelperErrorCode.BAD_FRAME,
          `declared frame length ${length} exceeds ceiling ${MAX_FRAME_BYTES}`,
        )
      }
      if (this.#buffer.length < 4 + length) break

      const payload = this.#buffer.subarray(4, 4 + length)
      this.#buffer = this.#buffer.subarray(4 + length)

      let parsed
      try {
        parsed = JSON.parse(payload.toString('utf8'))
      } catch (error) {
        throw new HelperError(HelperErrorCode.BAD_FRAME, `frame is not valid JSON: ${error.message}`)
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new HelperError(HelperErrorCode.BAD_FRAME, 'frame payload must be a JSON object')
      }
      messages.push(parsed)
    }
    return messages
  }

  /** Bytes buffered but not yet forming a complete frame; for diagnostics only. */
  get pendingBytes() {
    return this.#buffer.length
  }
}

/**
 * Build the helper's handshake frame.
 *
 * @param {object} facts verified facts about the running helper
 * @returns {object} the hello message
 */
export function helloMessage(facts) {
  return {
    type: FrameType.HELLO,
    protocolVersion: PROTOCOL_VERSION,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    ...facts,
  }
}

/**
 * Validate a peer's handshake and refuse a mismatch instead of guessing.
 *
 * @param {unknown} message the first frame received
 * @returns {object} the validated hello payload
 * @throws {HelperError} when the frame is not a compatible hello
 */
export function assertHello(message) {
  if (message === null || typeof message !== 'object' || message.type !== FrameType.HELLO) {
    throw new HelperError(HelperErrorCode.PROTOCOL_MISMATCH, 'first frame must be a hello')
  }
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    throw new HelperError(
      HelperErrorCode.PROTOCOL_MISMATCH,
      `helper speaks protocol ${message.protocolVersion}, host requires ${PROTOCOL_VERSION}; redeploy the helper`,
      { helper: message.protocolVersion, host: PROTOCOL_VERSION },
    )
  }
  return message
}
