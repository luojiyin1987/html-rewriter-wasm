# html-rewriter-wasm 学习路径

从外到内改造项目，每层改造完都能 `npm run build && npm test` 验证。

## 项目架构概览

```
┌─────────────────────────────────────────────────┐
│  用户 JS 代码                                    │
│  import { HTMLRewriter } from "html-rewriter-wasm" │
├─────────────────────────────────────────────────┤
│  TS 类型定义层  src/html_rewriter.d.ts           │
├─────────────────────────────────────────────────┤
│  JS Glue 层  pkg/html_rewriter.js (patched)      │
│  + src/asyncify.js (Asyncify 状态机)             │
├─────────────────────────────────────────────────┤
│  wasm-bindgen 绑定层  src/*.rs                   │
│  Rust 结构体 → JS 类的映射                        │
├─────────────────────────────────────────────────┤
│  Rust 核心层  src/lib.rs, html_rewriter.rs, ...  │
│  对 lol-html 的封装                              │
├─────────────────────────────────────────────────┤
│  lol-html 解析器  (外部 git 依赖)                │
│  Cloudflare 的流式 HTML 解析库                   │
└─────────────────────────────────────────────────┘
```

## 依赖角色说明

| 依赖 | 角色 |
|---|---|
| `lol_html` | Rust HTML 解析器，Cloudflare 维护 |
| `wasm-bindgen` | Rust↔JS 绑定生成器 |
| `wasm-pack` | 构建工具：Rust → WASM + JS glue |
| `js-sys` | Rust 中调用 JS 内置对象（Promise, TypeError 等） |
| `serde-wasm-bindgen` | Rust 结构体 ↔ JS 对象序列化 |
| `thiserror` | Rust 错误处理宏 |
| `asyncify.js` | 手写 JS，管理 WASM 栈的 unwind/rewind |
| `ava` | 测试框架 |
| `typescript` | 类型检查 |

---

## 第 1 层：JS/TS 表面（无需 Rust） ✅ 已完成

**目标**：理解公共 API 和测试结构

### 已完成的改造

1. 升级 devDependencies
   - `ava` 3→6.4.1，`typescript` 4→5，`@types/node` 14→22，`prettier` 2→3
   - 移除 `ts-node`，改用 `tsx` 作为 loader
   - 修复 `ava.config.js`：`require` → `nodeArguments: ["--import=tsx"]`

2. 给 `html_rewriter.d.ts` 加中文注释
   - 每个类的用途、每个方法的参数和返回值
   - 添加文件级文档说明使用流程

3. 在 `test/index.ts` 中加 `transformString` 便捷函数
   - 一步完成 HTML 转换的封装

4. 构建管线现代化
   - `build.sh`：去掉 mrbbot wasm-pack fork 检查
   - `Cargo.toml`：锁定 `wasm-bindgen = "=0.2.92"`（最后一个不启用 externref 的版本）
   - `src/patch_glue.py`：替换旧的 diff patch，用 Python 脚本做更可靠的 glue code 变换
   - 安装 wasm-opt 120 替代系统自带的 116

### 学到的要点

- ava 6 不再支持 `require: ["ts-node/register"]`，改用 `nodeArguments: ["--import=tsx"]`
- wasm-bindgen >= 0.2.89 默认启用 externref，但 asyncify 不支持它
- wasm-opt 116 无法解析 Rust nightly 生成的 WASM，需要 >= 120
- 旧的 diff patch 方式太脆弱，改为 Python 脚本做确定性替换

---

## 第 2 层：构建管线

**目标**：理解从 Rust 源码到可用 JS 包的完整流程

### 改造内容

1. 改 `build.sh` 去掉 mrbbot fork 检查
   - 你的 wasm-opt 116 远超所需的 version_92

2. 手动走构建流程，观察每一步产物
   - `wasm-pack build --target nodejs` → 看 `pkg/` 目录
   - `patch` → 对比 glue code 变化
   - 复制到 `dist/` → 理解发布内容

3. 读懂 `html_rewriter.js.patch`
   - 所有 mutation 方法加 `return this` → 链式调用
   - `write`/`end` 改成 `async` → 支持 asyncify
   - `onEndTag` 的 `.bind(this)` → 保持 this 上下文
   - `attributes` 改成 `[Symbol.iterator]()` → 返回迭代器

### 关键文件

- `build.sh` — 构建脚本
- `html_rewriter.js.patch` — 对 wasm-pack 输出的补丁
- `Cargo.toml` — Rust 依赖 + wasm-opt 配置

### 验证

```bash
npm run build && npm test
```

---

## 第 3 层：wasm-bindgen 绑定

**目标**：理解 Rust 结构体如何暴露为 JS 类

### 核心概念

- `#[wasm_bindgen]` 标注的 struct → JS class
- `#[wasm_bindgen]` 标注的 impl → JS 方法
- `#[wasm_bindgen(constructor)]` → JS constructor
- `#[wasm_bindgen(method, getter)]` → JS getter
- `extern "C" { ... }` → 引用 JS 侧的类型

### 改造内容

1. 在 `element.rs` 加新方法
   - 观察 `#[wasm_bindgen]` 如何生成 JS glue code

2. 在 `lib.rs` 的 `impl_mutations!` 宏里加 `debug()` 方法
   - 理解宏如何批量为多个类型生成相同方法

3. 在 `html_rewriter.rs` 加 `getStats()` getter
   - 在 Rust 端维护计数器，通过 `#[wasm_bindgen(getter)]` 暴露

### 验证

```bash
npm run build
node -e "const {HTMLRewriter} = require('./dist/html_rewriter.js'); ..."
```

---

## 第 4 层：Asyncify 异步桥接

**目标**：理解同步 WASM 如何支持 async JS handler

### 核心原理

lol-html 只支持同步回调。当 JS handler 返回 Promise 时：

```
Rust 解析遇到元素
  → 调用 JS handler
  → handler 返回 Promise
  → Asyncify: unwind WASM 栈到临时存储
  → JS: await Promise
  → Asyncify: rewind WASM 栈，继续解析
```

状态流转：`NONE → UNWINDING → (JS await) → REWINDING → NONE`

### 关键代码

- `src/asyncify.js:66` — `awaitPromise()`：触发 unwind
- `src/asyncify.js:89` — `wrap()`：管理 unwind/rewind 循环
- `src/handlers.rs:32` — `make_handler!`：Rust 回调中调用 `await_promise`
- `html_rewriter.js.patch` — `write`/`end` 改为 async 并调用 `wrap()`

### 改造内容

1. 在 `asyncify.js` 加状态日志
   - 在 `awaitPromise` 和 `wrap` 关键位置打印 state 变化

2. 给 `wrap()` 加超时检测
   - 如果 promise 超过 5s 未 resolve，打印警告

3. 在 `handlers.rs` 的 `make_handler!` 宏里加日志
   - 观察 handler 调用链

### 验证

写一个带 `async element` handler 的测试，观察日志输出。

---

## 第 5 层：核心 Rust / lol-html

**目标**：理解 HTML 解析器本身

### 改造内容

1. 读 lol-html 源码
   - Cargo.toml 锁定的 commit: `f32bd14`
   - 理解 `HtmlRewriter`、`Settings`、`OutputSink` trait

2. 更新 lol-html 到最新版
   - 改 `Cargo.toml` 中的 `rev`
   - 观察编译错误，理解 API 演变

3. 在 Rust 端加内置 handler
   - 不通过 JS，直接在 Rust 里处理（如自动给 `<img>` 加 `loading="lazy"`）

### 验证

```bash
npm run build && npm test
```

---

## 执行顺序

```
第1层 (1-2h) → 第2层 (2-3h) → 第3层 (3-4h) → 第4层 (4-6h) → 第5层 (∞)
  ↓                ↓                ↓                ↓
会用             会构建           会扩展API        会改核心逻辑
```

建议从第 1+2 层开始，完全不需要 Rust 知识。

## 当前环境

- Node.js: v24.15.0
- Rust: 1.97.0-nightly
- wasm-pack: 0.15.0
- wasm-opt: version 120
