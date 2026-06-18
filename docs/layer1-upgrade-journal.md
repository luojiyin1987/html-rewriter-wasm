# 第 1 层改造：问题与解决记录

> 日期：2026-06-18
> 目标：升级 devDependencies、现代化构建管线

---

## 1. ava 3 → 6：TypeScript 加载方式变更

### 问题

ava 6 移除了 `require` 配置项，旧的 `require: ["ts-node/register"]` 不再工作。

### 原始配置

```js
// ava.config.js (ava 3)
export default {
  files: ["test/**/*.spec.ts"],
  extensions: ["ts"],
  require: ["ts-node/register"],
};
```

### 解决方案

改用 Node.js 的 `--import` loader 机制，用 `tsx` 替代 `ts-node`：

```js
// ava.config.js (ava 6)
export default {
  files: ["test/**/*.spec.ts"],
  extensions: ["ts"],
  nodeArguments: ["--import=tsx"],
};
```

同时从 `devDependencies` 中移除 `ts-node`，新增 `tsx`。

### 知识点

- ava 6 要求 Node.js >= 18.18
- `--import` 是 Node.js 的 ES module loader 注入方式，比旧的 `--require` 更现代
- `tsx` 是一个轻量的 TypeScript 执行器，不需要 `tsconfig.json` 配置

---

## 2. wasm-pack 版本检查：mrbbot fork 已不需要

### 问题

`build.sh` 检查 wasm-pack 版本是否以 `-asyncify` 结尾（mrbbot fork 的特征），官方 wasm-pack 不匹配。

```bash
if [[ ! $WASM_PACK_VERSION =~ -asyncify$ ]]; then
  echo "please install mrbbot's fork"
  exit 1
fi
```

### 分析

- mrbbot fork 的目的是让 wasm-opt 使用 Binaryen version_92+（导出 `asyncify_get_state`）
- 官方 wasm-pack 0.14.0 自带 wasm-opt 116，已远超 version_92
- 但 wasm-opt 116 又有其他问题（见下一节）

### 解决方案

去掉版本检查，直接使用官方 wasm-pack：

```bash
WASM_PACK_VERSION=$(wasm-pack --version)
echo "Found: $WASM_PACK_VERSION"
```

---

## 3. wasm-opt 116 无法解析 Rust nightly 生成的 WASM

### 问题

```
[parse exception: invalid code after misc prefix: 17 (at 0:483941)]
```

wasm-opt 116 无法解析 Rust 1.97 nightly 编译出的 WASM 二进制。

### 原因

Rust nightly 使用了更新的 LLVM 后端，生成的 WASM 包含 wasm-opt 116 不认识的指令。

### 解决方案

从 Binaryen GitHub releases 下载 wasm-opt 120 替换：

```bash
curl -sL "https://github.com/WebAssembly/binaryen/releases/download/version_120/binaryen-version_120-x86_64-linux.tar.gz" | tar xz
cp binaryen-version_120/bin/wasm-opt ~/.cargo/bin/wasm-opt
```

---

## 4. ahash 0.7.6 与 Rust nightly 不兼容

### 项目

```
error[E0635]: unknown feature `stdsimd`
#![cfg_attr(feature = "stdsimd", feature(stdsimd))]
```

### 原因

`Cargo.lock` 锁定了 `ahash 0.7.6`，它使用了 `stdsimd` feature，该 feature 在新版 Rust 中已被移除。

### 解决方案

运行 `cargo update` 更新所有 Rust 依赖：

```bash
cargo update
```

`ahash` 从 0.7.6 更新到 0.7.8，问题解决。

---

## 5. wasm-bindgen >= 0.2.89 启用 externref，asyncify 不兼容

### 项目

```
Fatal: Asyncify does not yet support non-number types, like references
(see https://github.com/WebAssembly/binaryen/issues/3739)
```

### 原因链

1. `cargo update` 将 `wasm-bindgen` 更新到 0.2.125
2. wasm-bindgen >= 0.2.89 默认在 WASM 中使用 externref（引用类型）
3. Binaryen 的 asyncify pass 不支持引用类型
4. 即使用 `-C target-feature=-reference-types` 编译 Rust，wasm-bindgen 仍会在 glue code 中生成 externref

### 探索过程

| 尝试 | 结果 |
|---|---|
| `RUSTFLAGS="-C target-feature=-reference-types"` | 编译通过，但 wasm-bindgen glue 仍引入 externref |
| wasm-bindgen 0.2.100 + 禁用 reference types | `__wbindgen_externref_table_dealloc` 找不到 |
| wasm-bindgen 0.2.87 | 太旧，与 Rust 1.97 不兼容 |
| wasm-bindgen 0.2.88 | 已被 yanked |
| wasm-bindgen 0.2.89~0.2.92 | **0.2.92 成功** |

### 解决方案

锁定 `wasm-bindgen = "=0.2.92"`（最后一个不默认启用 externref 的版本）：

```toml
# Cargo.toml
[dependencies]
wasm-bindgen = "=0.2.92"
js-sys = "=0.3.69"
```

### 知识点

- externref（WebAssembly 引用类型）允许 WASM 直接引用 JS 对象
- asyncify 通过保存/恢复 WASM 栈实现异步，但它假设栈上只有数值类型
- binaryen#3739 是已知的未解决问题

---

## 6. 旧 diff patch 太脆弱

### 问题

`html_rewriter.js.patch` 是针对 wasm-bindgen 0.2.74 生成的 glue code 的 diff。升级到 0.2.92 后，22 个 hunk 中 21 个失败。

```
patching file pkg/html_rewriter.js
Hunk #1 FAILED at 1.
Hunk #2 FAILED at 233.
...
21 out of 22 hunks FAILED
```

### 原因

wasm-bindgen 版本变化导致生成的 JS 代码结构改变（行号、变量名、代码组织），diff patch 无法匹配。

### 解决方案

用 Python 脚本 `src/patch_glue.py` 替代 diff patch。脚本基于**语义匹配**而非行号：

```python
# 旧方式：diff patch（脆弱）
patch -uN pkg/html_rewriter.js < html_rewriter.js.patch

# 新方式：Python 脚本（可靠）
python3 src/patch_glue.py pkg/html_rewriter.js
```

脚本做的 7 项变换：

| # | 变换 | 目的 |
|---|---|---|
| 1 | 导入 `setWasmExports`, `wrap` | asyncify 需要 |
| 2 | mutation 方法加 `return this` | 链式调用 |
| 3 | `write()` 改为 async + `wrap()` | 异步 handler 支持 |
| 4 | `end()` 改为 async + `wrap()` | 异步 handler 支持 |
| 5 | `attributes` 返回 `[Symbol.iterator]()` | 迭代器协议 |
| 6 | `onEndTag` 的 handler 做 `.bind(this)` | 保持 this 上下文 |
| 7 | 加 `setWasmExports(wasm)` 调用 | 初始化 asyncify |
| 8 | Promise 检测加 `toString.call` 兼容 | 跨 realm 支持 |

---

## 7. `setWasmExports(wasm)` 缺失

### 问题

```
TypeError: Cannot read properties of undefined (reading 'asyncify_get_state')
```

### 原因

wasm-bindgen 0.2.92 生成的 glue code 不再自动调用 `setWasmExports(wasm)`。asyncify.js 需要这个调用来获取 WASM 导出函数的引用。

### 解决方案

在 `patch_glue.py` 中添加第 6 项变换，在 `wasm = wasmInstance.exports;` 之后插入 `setWasmExports(wasm);`。

---

## 8. `return this` 插入位置错误

### 问题

```
SyntaxError: Unexpected token 'this'
```

`return this;` 被插入到了方法外部（方法的 `}` 之后），导致语法错误。

### 原因

第一版 patch 脚本的正则表达式匹配了 finally 块的 `}` 和方法的 `}`，但替换时把 `return this;` 放在了方法外面。

### 解决方案

改用更精确的匹配策略：找到 `} finally { ... }` 后，匹配紧随其后的 `\n    }`（方法结束），将其替换为 `\n        return this;\n    }`。

---

## 9. Promise 跨 realm 检测失败

### 问题

```
/misc › handles async handler in different realm
  actual: '<p>old</p>'
  expected: '<p>new</p>'
```

### 原因

测试用 `vm.createContext()` 创建了一个新的 JS realm。在新 realm 中，`promise instanceof Promise` 会失败，因为 `Promise` 来自不同的 realm。

### 解决方案

在 patch 脚本中添加第 8 项变换，使用 `Object.prototype.toString.call(obj) === '[object Promise]'` 作为后备检测：

```js
// 旧：只用 instanceof
result = getObject(arg0) instanceof Promise;

// 新：instanceof + toString 双重检测
var obj = getObject(arg0);
result = (obj instanceof Promise) || (Object.prototype.toString.call(obj) === '[object Promise]');
```

---

## 最终依赖版本

| 依赖 | 旧版本 | 新版本 | 备注 |
|---|---|---|---|
| `@types/node` | ^14.17.5 | ^22.0.0 | |
| `ava` | ^3.15.0 | ^6.4.1 | |
| `prettier` | ^2.3.2 | ^3.0.0 | |
| `typescript` | ^4.3.5 | ^5.0.0 | |
| `ts-node` | ^10.1.0 | 移除 | 用 tsx 替代 |
| `tsx` | 无 | ^4.0.0 | 新增 |
| `wasm-bindgen` | 0.2.74 | =0.2.92 | 锁定，不能用更新版本 |
| `js-sys` | 0.3.33 | =0.3.69 | 锁定，匹配 wasm-bindgen |
| `wasm-opt` | 116 | 120 | 手动替换 |

---

## 关键教训

1. **Rust + WASM 工具链的版本耦合很紧密** — Rust 版本、wasm-bindgen、wasm-opt、binaryen 四者必须兼容
2. **Cargo.lock 不更新 = 潜在炸弹** — 锁定 4 年的依赖在新编译器上直接报错
3. **diff patch 维护成本高** — 任何上游变化都会导致 patch 失败，确定性脚本更可靠
4. **externref + asyncify 是已知的不兼容组合** — 这是 WebAssembly 生态的待解决问题
