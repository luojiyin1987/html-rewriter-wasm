const assert = require("assert");

/**
 * @typedef {object} WasmExports
 * @property {WebAssembly.Memory} memory
 * @property {function} asyncify_get_state
 * @property {function} asyncify_start_unwind
 * @property {function} asyncify_stop_unwind
 * @property {function} asyncify_start_rewind
 * @property {function} asyncify_stop_rewind
 */

/**
 * @type {WasmExports}
 */
let wasm;

/**
 * @param {WasmExports} wasmExports
 */
function setWasmExports(wasmExports) {
  wasm = wasmExports;
}

/**
 * @type {Int32Array}
 */
let cachedInt32Memory = null;

/**
 * @returns {Int32Array}
 */
function getInt32Memory() {
  if (
    cachedInt32Memory === null ||
    cachedInt32Memory.buffer !== wasm.memory.buffer
  ) {
    cachedInt32Memory = new Int32Array(wasm.memory.buffer);
  }
  return cachedInt32Memory;
}

// https://github.com/WebAssembly/binaryen/blob/fb9de9d391a7272548dcc41cd8229076189d7398/src/passes/Asyncify.cpp#L99
const State = {
  NONE: 0,
  UNWINDING: 1,
  REWINDING: 2,
};

const StateNames = {
  [State.NONE]: "NONE",
  [State.UNWINDING]: "UNWINDING",
  [State.REWINDING]: "REWINDING",
};

/** @type {boolean} */
let debugMode = false;

/** @type {number} */
let timeoutMs = 0;

/**
 * @param {boolean} enabled
 */
function setDebugMode(enabled) {
  debugMode = enabled;
}

/**
 * @param {number} ms - timeout in milliseconds, 0 = disabled
 */
function setTimeoutMs(ms) {
  timeoutMs = ms;
}

/**
 * @param {string} message
 */
function log(message) {
  if (debugMode) {
    console.log(`[asyncify] ${message}`);
  }
}

function assertNoneState() {
  assert.strictEqual(wasm.asyncify_get_state(), State.NONE);
}

/**
 * Maps `HTMLRewriter`s (their `asyncifyStackPtr`s) to `Promise`s.
 * `asyncifyStackPtr` acts as unique reference to `HTMLRewriter`.
 * Each rewriter MUST have AT MOST ONE pending promise at any time.
 * @type {Map<number, {promise: Promise, timer: ReturnType<typeof setTimeout> | null}>}
 */
const promises = new Map();

/**
 * @param {number} stackPtr
 * @param {Promise} promise
 */
function awaitPromise(stackPtr, promise) {
  if (wasm.asyncify_get_state() === State.REWINDING) {
    log(`awaitPromise: stop_rewind (stackPtr=${stackPtr})`);
    wasm.asyncify_stop_rewind();
    return;
  }

  assertNoneState();

  // https://github.com/WebAssembly/binaryen/blob/fb9de9d391a7272548dcc41cd8229076189d7398/src/passes/Asyncify.cpp#L106
  assert.strictEqual(stackPtr % 4, 0);
  getInt32Memory().set([stackPtr + 8, stackPtr + 1024], stackPtr / 4);

  wasm.asyncify_start_unwind(stackPtr);

  log(`awaitPromise: start_unwind (stackPtr=${stackPtr})`);

  assert(!promises.has(stackPtr));

  let timer = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      console.warn(
        `[asyncify] WARNING: Promise at stackPtr=${stackPtr} has not resolved after ${timeoutMs}ms`
      );
    }, timeoutMs);
  }

  promises.set(stackPtr, { promise, timer });
}

/**
 * @param {HTMLRewriter} rewriter
 * @param {Function} fn
 * @param args
 */
async function wrap(rewriter, fn, ...args) {
  const stackPtr = rewriter.asyncifyStackPtr;

  assertNoneState();
  log(`wrap: calling fn (stackPtr=${stackPtr})`);
  let result = fn(...args);

  while (wasm.asyncify_get_state() === State.UNWINDING) {
    wasm.asyncify_stop_unwind();

    assertNoneState();
    assert(promises.has(stackPtr));
    const entry = promises.get(stackPtr);

    if (entry.timer !== null) {
      clearTimeout(entry.timer);
    }

    log(`wrap: awaiting promise (stackPtr=${stackPtr})`);
    await entry.promise;
    promises.delete(stackPtr);

    assertNoneState();
    wasm.asyncify_start_rewind(stackPtr);
    log(`wrap: start_rewind (stackPtr=${stackPtr})`);
    result = fn();
  }

  assertNoneState();
  log(`wrap: done (stackPtr=${stackPtr})`);
  return result;
}

module.exports = {
  awaitPromise,
  setWasmExports,
  wrap,
  setDebugMode,
  setTimeoutMs,
};
