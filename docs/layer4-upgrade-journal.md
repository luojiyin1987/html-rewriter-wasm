# 第 4 层改造：Asyncify 异步桥接 — 问题与解决记录

> 日期：2026-06-18
> 目标：理解同步 WASM 如何支持 async JS handler，添加调试和超时检测

---

## 核心原理

### Asyncify 状态机

lol-html 只支持同步回调。当 JS handler 返回 Promise 时，Binaryen Asyncify 通过保存/恢复 WASM 栈实现异步：

```
Rust 解析遇到元素
  → 调用 JS handler
  → handler 返回 Promise
  → Asyncify: unwind WASM 栈到临时存储
  → JS: await Promise
  → Asyncify: rewind WASM 栈，继续解析
```

状态流转：

```
NONE ──unwind──► UNWINDING ──(JS await)──► REWINDING ──stop_rewind──► NONE
  │                    │                        │
  │   asyncify_start_unwind                    │
  │                    │                        │
  │              asyncify_stop_unwind     asyncify_start_rewind
  │                                         │
  └─────────────────────────────────────────┘
```

### 关键代码位置

| 文件 | 行号 | 函数 | 作用 |
|---|---|---|---|
| `src/asyncify.js:66` | `awaitPromise()` | 被 Rust 回调调用，触发 unwind |
| `src/asyncify.js:89` | `wrap()` | 管理 unwind/rewind 循环 |
| `src/handlers.rs:32` | `make_handler!` | Rust 回调中调用 `await_promise` |
| `dist/html_rewriter.js:1182` | `async write()` | 被 patch 为 async，调用 `wrap()` |
| `dist/html_rewriter.js:1156` | `async end()` | 被 patch 为 async，调用 `wrap()` |

---

## 改造 1：状态日志

### 目的

在 `awaitPromise` 和 `wrap` 关键位置打印 state 变化，观察 asyncify 的执行流程。

### 实现

```js
const StateNames = {
  [State.NONE]: "NONE",
  [State.UNWINDING]: "UNWINDING",
  [State.REWINDING]: "REWINDING",
};

let debugMode = false;

function setDebugMode(enabled) {
  debugMode = enabled;
}

function log(message) {
  if (debugMode) {
    console.log(`[asyncify] ${message}`);
  }
}
```

在关键位置添加日志：

```js
// awaitPromise 中
log(`awaitPromise: start_unwind (stackPtr=${stackPtr})`);

// wrap 中
log(`wrap: calling fn (stackPtr=${stackPtr})`);
log(`wrap: awaiting promise (stackPtr=${stackPtr})`);
log(`wrap: start_rewind (stackPtr=${stackPtr})`);
log(`wrap: done (stackPtr=${stackPtr})`);
```

### 使用方式

```js
const { setDebugMode } = require("./asyncify.js");
setDebugMode(true);
// 然后正常执行 rewriter.write() / rewriter.end()
// 控制台会输出：
// [asyncify] wrap: calling fn (stackPtr=123456)
// [asyncify] awaitPromise: start_unwind (stackPtr=123456)
// [asyncify] wrap: awaiting promise (stackPtr=123456)
// [asyncify] wrap: start_rewind (stackPtr=123456)
// [asyncify] wrap: done (stackPtr=123456)
```

### 知识点

- `debugMode` 默认关闭，零运行时开销
- 只在 `debugMode = true` 时输出日志
- 日志包含 `stackPtr` 用于区分不同 rewriter 实例

---

## 改造 2：超时检测

### 目的

如果 promise 超过 5s 未 resolve，打印警告。帮助诊断卡死的异步 handler。

### 实现

```js
let timeoutMs = 0;

function setTimeoutMs(ms) {
  timeoutMs = ms;
}

// 在 awaitPromise 中
let timer = null;
if (timeoutMs > 0) {
  timer = setTimeout(() => {
    console.warn(
      `[asyncify] WARNING: Promise at stackPtr=${stackPtr} has not resolved after ${timeoutMs}ms`
    );
  }, timeoutMs);
}

promises.set(stackPtr, { promise, timer });

// 在 wrap 中 await 之前
if (entry.timer !== null) {
  clearTimeout(entry.timer);
}
```

### 使用方式

```js
const { setTimeoutMs } = require("./asyncify.js");
setTimeoutMs(5000); // 5 秒超时
```

### 知识点

- `setTimeout` 返回 timer ID，存入 `promises` Map
- promise resolve 后 `clearTimeout` 取消定时器
- 超时只是警告，不会中断执行
- `timeoutMs = 0` 表示禁用超时检测

---

## 改造 3：patch_glue.py 更新

### 问题

`asyncify.js` 新增了 `setDebugMode` 和 `setTimeoutMs` 导出，但 `patch_glue.py` 的 import 语句没有更新。

### 解决方案

更新 patch 脚本的第 1 项变换：

```python
# 旧
'const { awaitPromise } = require(String.raw`./asyncify.js`);',
'const { awaitPromise, setWasmExports, wrap } = require(String.raw`./asyncify.js`);',

# 新
'const { awaitPromise } = require(String.raw`./asyncify.js`);',
'const { awaitPromise, setWasmExports, wrap, setDebugMode, setTimeoutMs } = require(String.raw`./asyncify.js`);',
```

---

## Asyncify 完整执行流程

以 `async element` handler 为例：

```
1. JS: await rewriter.write(chunk)
   │
2. JS: wasm.htmlrewriter_write(retptr, ptr, len)
   │  └── Rust 开始解析 HTML
   │
3. Rust: 遇到 <p> 元素
   │  └── 调用 make_handler! 生成的闭包
   │
4. Rust: handler.call1(element)
   │  └── 调用 JS async element handler
   │
5. JS: handler 返回 Promise
   │
6. Rust: res.dyn_ref::<JsPromise>() → Some(promise)
   │  └── 调用 await_promise(stackPtr, promise)
   │
7. JS asyncify.js: awaitPromise()
   │  ├── state = NONE → 检查通过
   │  ├── 设置栈指针: memory[stackPtr/4] = [stackPtr+8, stackPtr+1024]
   │  ├── wasm.asyncify_start_unwind(stackPtr)
   │  │   └── WASM 栈保存到临时存储，控制权返回 JS
   │  └── promises.set(stackPtr, { promise, timer })
   │
8. JS: handler 继续执行（可能有 await wait(50)）
   │
9. JS: handler 返回，Promise resolve
   │
10. JS asyncify.js: wrap() 的 while 循环
    │  ├── state = UNWINDING → 进入循环
    │  ├── wasm.asyncify_stop_unwind()
    │  ├── await promise ← 挂起，等待 Promise
    │  │   └── （此时 JS 可以处理其他任务）
    │  ├── promise resolve
    │  ├── wasm.asyncify_start_rewind(stackPtr)
    │  │   └── WASM 栈从临时存储恢复
    │  └── result = fn() ← 重新调用 wasm.htmlrewriter_write
    │
11. Rust: 从上次中断的地方继续解析
    │  └── ... 继续处理后续 HTML ...
    │
12. JS: write() 完成，返回结果
```

---

## 关键文件变更

| 文件 | 变更 |
|---|---|
| `src/asyncify.js` | 加 `setDebugMode()`, `setTimeoutMs()`, 状态日志, 超时检测 |
| `src/patch_glue.py` | 更新 import 语句 |

---

## 关键教训

1. **Asyncify 是 Binaryen 的 pass** — 不是 wasm-bindgen 的功能，是编译时优化
2. **每个 rewriter 只能有一个 pending promise** — promises Map 用 stackPtr 做 key
3. **栈指针必须 4 字节对齐** — `assert.strictEqual(stackPtr % 4, 0)`
4. **unwind/rewind 是对称操作** — start_unwind ↔ stop_unwind, start_rewind ↔ stop_rewind
5. **debug 模式默认关闭** — 避免影响生产环境性能
6. **超时检测只是警告** — 不会中断执行，需要人工介入
