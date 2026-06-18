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

## 第 2 层：构建管线 ✅ 已完成

**目标**：理解从 Rust 源码到可用 JS 包的完整流程

### 已完成的改造

1. 现代化 CI
   - `.github/workflows/test.yml`：actions/checkout@v4, rust-cache@v2, setup-node@v4
   - 去掉 mrbbot wasm-pack fork，改用官方 wasm-pack
   - 加入 wasm-opt 120 安装步骤

2. 增强 build.sh
   - `set -euo pipefail` 替代 `set -e`
   - 步骤编号和耗时统计
   - 构建完成后输出 WASM/JS 大小

3. 修复 package.json
   - repository/bugs/homepage 改为指向 fork

### 学到的要点

- `actions-rs/toolchain` 已废弃，直接用 `rustup` 更可靠
- `set -euo pipefail` 比 `set -e` 更严格（-u 检查未定义变量，-o pipefail 捕获管道错误）
- 构建产物：WASM 836KB + JS 48KB ≈ 885KB 总大小
- `wasm-opt -Os --asyncify` 优化后 WASM 从 ~1.2MB 降到 836KB
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

## 第 3 层：wasm-bindgen 绑定 ✅ 已完成

**目标**：理解 Rust 结构体如何暴露为 JS 类

### 核心概念

- `#[wasm_bindgen]` 标注的 struct → JS class
- `#[wasm_bindgen]` 标注的 impl → JS 方法
- `#[wasm_bindgen(constructor)]` → JS constructor
- `#[wasm_bindgen(method, getter)]` → JS getter
- `extern "C" { ... }` → 引用 JS 侧的类型

### 已完成的改造

1. 在 `lib.rs` 的 `impl_mutations!` 宏里加 `debug()` 方法
   - `stringify!($Ty)` 编译期将标识符转为字符串
   - Element → "Element", Comment → "Comment", TextChunk → "TextChunk"

2. 在 `html_rewriter.rs` 加 `getStats()` getter
   - `handlers_registered: u32` 统计注册的 handler 数量
   - `ended: bool` 是否已调用 end()
   - 使用 `js_sys::Object` + `Reflect::set` 返回 JS 对象

3. 在 `element.rs` 加 `attributeCount` getter
   - `#[wasm_bindgen(method, getter=attributeCount)]` 做命名映射

4. 同步更新 `html_rewriter.d.ts` 类型定义

### 学到的要点

- 宏是 Rust 的元编程工具，`impl_mutations!` 一次定义多处展开
- `#[wasm_bindgen(js_name = ...)]` 做 Rust snake_case → JS camelCase 映射
- 跨 FFI 返回对象需要 `js_sys::Object`，不能直接返回 Rust 结构体
- TypeScript 类型定义需要手动同步更新

### 验证

```bash
npm run build
node -e "const {HTMLRewriter} = require('./dist/html_rewriter.js'); ..."
```

---

## 第 4 层：Asyncify 异步桥接 ✅ 已完成

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

### 已完成的改造

1. 在 `asyncify.js` 加状态日志
   - `setDebugMode(true)` 开启调试模式
   - 在 `awaitPromise` 和 `wrap` 关键位置打印 state 变化

2. 给 `wrap()` 加超时检测
   - `setTimeoutMs(5000)` 设置 5s 超时
   - promise 超时未 resolve 时打印警告
   - 超时只是警告，不会中断执行

### 学到的要点

- Asyncify 是 Binaryen 的 pass，不是 wasm-bindgen 的功能
- 每个 rewriter 只能有一个 pending promise
- 栈指针必须 4 字节对齐
- unwind/rewind 是对称操作
- debug 模式默认关闭，零运行时开销
   
---

## 第 5 层：核心 Rust / lol-html ✅ 已完成

**目标**：理解 HTML 解析器本身

### 核心概念

lol-html 通过 `Settings` 接收 `(Selector, ElementContentHandlers)` 元组列表。
选择器匹配后触发对应的 Rust 回调。内置 handler 可以和 JS handler 共存。

### 已完成的改造

1. 在 `html_rewriter.rs` 注入原生 Rust handler
   - 使用 `lol_html::element!("img", ...)` 宏创建选择器 handler
   - `element_handlers.insert(0, ...)` 保证先于用户 handler 执行
   - `has_attribute("loading")` 检查避免覆盖用户显式设置

2. 9 个测试覆盖所有边界情况
   - 基本功能、不覆盖已有属性、批量处理、与用户 handler 共存
   - 无用户 handler、不影响非 img 元素、自闭合标签、无属性标签

### 学到的要点

- lol-html 的 `element!` 宏返回 `(Cow<Selector>, ElementContentHandlers)` 元组
- Handler 执行顺序 = 注册顺序（`insert(0, ...)` = 最先执行）
- 注入一个 Rust handler 增加 ~8KB WASM 体积
- 选择器解析发生在 `inner_mut()` 首次调用时
- 内置 handler 对 JS 侧完全透明，无需修改 `.d.ts` 类型定义

### 验证

```bash
npm run build && npm test
# 79 tests passed (70 original + 9 new)
```

---

## 执行顺序

```
第1层 (1-2h) ✅ → 第2层 (2-3h) ✅ → 第3层 (3-4h) ✅ → 第4层 (4-6h) ✅ → 第5层 (已完成) ✅
  ↓                ↓                ↓                ↓                ↓
 会用             会构建           会扩展API        会改核心逻辑      会加内置handler
```

建议从第 1+2 层开始，完全不需要 Rust 知识。

## 当前环境

- Node.js: v24.15.0
- Rust: 1.97.0-nightly
- wasm-pack: 0.15.0
- wasm-opt: version 120
