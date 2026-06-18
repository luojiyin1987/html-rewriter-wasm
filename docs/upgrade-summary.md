# html-rewriter-wasm 升级总结

> 日期：2026-06-18
> 分支：master
> 范围：Layer 1 (JS/TS 表面) + Layer 2 (构建管线) + Layer 3 (wasm-bindgen 绑定)

---

## 一、升级概览

### 目标

从外到内改造项目，每层改造完都能 `npm run build && npm test` 验证。本阶段完成前 3 层。

### 最终状态

```
✅ 第 1 层：JS/TS 表面        — 会用
✅ 第 2 层：构建管线          — 会构建
✅ 第 3 层：wasm-bindgen 绑定 — 会扩展 API
⬜ 第 4 层：Asyncify 异步桥接 — 会改异步逻辑
⬜ 第 5 层：核心 Rust/lol-html — 会改核心逻辑
```

### 测试结果

```
70 tests passed (全部通过)
```

---

## 二、Commit 历史

| Commit | 说明 |
|---|---|
| `e87000c` | chore(deps): upgrade devDependencies and modernize build pipeline |
| `4404875` | docs: add Layer 1 upgrade journal with 9 problems and solutions |
| `f9c624f` | chore(deps): upgrade serde 1.0.228, serde-wasm-bindgen 0.6.5 |
| `5c6ed2f` | ci: modernize CI and enhance build pipeline |
| `f9a98c2` | ci(test): update action ver |
| `96d484e` | docs: add Layer 2 upgrade journal |
| `c4a11cd` | docs: mark Layer 2 as completed in LEARNING.md |
| `534101f` | feat: add debug(), getStats(), attributeCount to wasm-bindgen bindings |

---

## 三、依赖变更汇总

### JS/TS 依赖 (package.json)

| 包 | 旧版本 | 新版本 | 说明 |
|---|---|---|---|
| `ava` | ^3.15.0 | ^6.4.1 | 测试框架，TypeScript 加载方式变更 |
| `typescript` | ^4.3.5 | ^5.0.0 | |
| `@types/node` | ^14.17.5 | ^22.0.0 | |
| `prettier` | ^2.3.2 | ^3.0.0 | |
| `ts-node` | ^10.1.0 | 移除 | 用 tsx 替代 |
| `tsx` | 无 | ^4.0.0 | 新增，轻量 TS 执行器 |

### Rust 依赖 (Cargo.toml)

| 包 | 旧版本 | 新版本 | 说明 |
|---|---|---|---|
| `wasm-bindgen` | 0.2.74 | **=0.2.92** | 锁定，externref+asyncify 不兼容 |
| `js-sys` | 0.3.33 | **=0.3.69** | 锁定，匹配 wasm-bindgen |
| `serde` | 1.0.104 | 1.0.228 | 向后兼容 |
| `serde-wasm-bindgen` | 0.1.3 | 0.6.5 | 核心 API 不变 |
| `thiserror` | 1.0.2 | 1.0.69 | |
| `fnv` | 1.0.7 | 移除 | serde-wasm-bindgen 0.6.5 不再依赖 |

### 工具链

| 工具 | 旧版本 | 新版本 | 说明 |
|---|---|---|---|
| `wasm-pack` | 0.14.0 (mrbbot fork) | 0.15.0 (官方) | 去掉 fork |
| `wasm-opt` | 116 | 120 | Rust nightly 需要 >= 120 |
| Node.js | v24.15.0 | v24.15.0 | 不变 |
| Rust | 1.97.0-nightly | 1.97.0-nightly | 不变 |

---

## 四、遇到的问题与解决方案

### Layer 1：JS/TS 表面 (9 个问题)

| # | 问题 | 原因 | 解决方案 |
|---|---|---|---|
| 1 | ava 6 不识别 `require: ["ts-node/register"]` | ava 6 移除了 require 配置项 | 改用 `nodeArguments: ["--import=tsx"]` |
| 2 | wasm-pack 版本检查失败 | 检查 mrbbot fork 特征 `-asyncify` 后缀 | 去掉版本检查，官方 wasm-pack 0.14+ 已够用 |
| 3 | wasm-opt 116 报 `invalid code after misc prefix: 17` | Rust nightly 生成的 WASM 包含 wasm-opt 116 不认识的指令 | 下载 wasm-opt 120 替换 |
| 4 | ahash 0.7.6 报 `unknown feature stdsimd` | ahash 使用了已移除的 stdsimd feature | `cargo update` 更新到 ahash 0.7.8 |
| 5 | wasm-opt 报 `Asyncify does not support non-number types` | wasm-bindgen >= 0.2.89 默认启用 externref，asyncify 不支持 | 锁定 wasm-bindgen =0.2.92 |
| 6 | diff patch 22 个 hunk 中 21 个失败 | wasm-bindgen 版本变化导致生成代码结构改变 | 用 Python 脚本 `patch_glue.py` 替代 diff patch |
| 7 | `setWasmExports(wasm)` 缺失 | wasm-bindgen 0.2.92 不再自动调用 | 在 patch 脚本中加 `setWasmExports(wasm)` |
| 8 | `return this` 插入到方法外部 | 正则匹配不够精确 | 改用更精确的 finally 块匹配策略 |
| 9 | 跨 realm Promise 检测失败 | `promise instanceof Promise` 在不同 realm 失败 | 加 `Object.prototype.toString.call()` 后备检测 |

### Layer 2：构建管线 (4 个问题)

| # | 问题 | 原因 | 解决方案 |
|---|---|---|---|
| 1 | CI 用废弃 actions + mrbbot fork | 6 个月未更新 | 重写：checkout@v4, rust-cache@v2, setup-node@v4, 官方 wasm-pack |
| 2 | build.sh 无错误处理 | 只有 `set -e` | 改用 `set -euo pipefail`，加步骤编号和构建摘要 |
| 3 | package.json 指向原作者仓库 | fork 后未更新 | 改为 luojiyin1987/html-rewriter-wasm |
| 4 | wasm-pack 版本记录过时 | 安装后未更新文档 | LEARNING.md 更新为 0.15.0 |

### Layer 3：wasm-bindgen 绑定 (4 个探索点)

| # | 探索点 | 发现 |
|---|---|---|
| 1 | 宏展开机制 | `stringify!($Ty)` 编译期将标识符转为字符串，零运行时开销 |
| 2 | 跨 FFI 返回对象 | 需要 `js_sys::Object` + `Reflect::set`，不能直接返回 Rust 结构体 |
| 3 | 命名映射 | `getter=attributeCount` 将 Rust snake_case 映射为 JS camelCase |
| 4 | TypeScript 类型同步 | wasm-pack 不自动更新 `.d.ts`，需要手动维护 |

---

## 五、构建管线完整流程

```
Rust 源码 (src/*.rs)
  │
  ▼ wasm-pack build --target nodejs
  │  ├── cargo build --release --target wasm32-unknown-unknown
  │  ├── wasm-bindgen → pkg/html_rewriter.js + .wasm
  │  └── wasm-opt -Os --asyncify → 优化后的 .wasm
  │
  ▼ python3 src/patch_glue.py
  │  ├── 加 setWasmExports, wrap 导入
  │  ├── mutation 方法加 return this
  │  ├── write/end 改为 async
  │  ├── attributes 返回迭代器
  │  ├── onEndTag 绑定 this
  │  └── Promise 跨 realm 检测
  │
  ▼ cp 到 dist/
  │  ├── html_rewriter.js (52KB)
  │  ├── html_rewriter_bg.wasm (840KB)
  │  ├── asyncify.js (2.5KB)
  │  └── html_rewriter.d.ts (2.7KB)
  │
  ▼ npm test
     └── 70 tests passed
```

---

## 六、关键约束

### wasm-bindgen 锁定 =0.2.92

**原因链：**
1. wasm-bindgen >= 0.2.89 默认启用 externref（WebAssembly 引用类型）
2. Binaryen 的 asyncify pass 不支持引用类型（binaryen#3739）
3. 即使用 `-C target-feature=-reference-types` 编译 Rust，wasm-bindgen 仍在 glue code 中生成 externref
4. 0.2.92 是最后一个不默认启用 externref 的版本

**影响：** 所有 js-sys 版本也必须锁定（=0.3.69），因为 js-sys 版本必须匹配 wasm-bindgen。

### lol_html 保持 0.3.0 (git rev)

**原因：** 升级到 3.0.0 需要：
- 重写 Settings 构建代码（struct literal → builder pattern）
- Rust edition 从 2018 升到 2024
- Rust 最低版本 1.85
- 大量 API 变更

**计划：** 放在 Layer 4-5 处理。

---

## 七、新增 API

### Element

```typescript
class Element {
  readonly attributeCount: number;  // 属性数量
  debug(): string;                  // 返回 "Element"
}
```

### Comment / TextChunk / EndTag

```typescript
class Comment  { debug(): string; }  // 返回 "Comment"
class TextChunk { debug(): string; }  // 返回 "TextChunk"
class EndTag   { debug(): string; }  // 返回 "EndTag"
```

### HTMLRewriter

```typescript
interface HTMLRewriterStats {
  handlersRegistered: number;  // 已注册的 handler 数量
  ended: boolean;              // 是否已调用 end()
}

class HTMLRewriter {
  getStats(): HTMLRewriterStats;
}
```

---

## 八、文件变更清单

### 新增文件

| 文件 | 说明 |
|---|---|
| `src/patch_glue.py` | Python 胶水代码补丁脚本（替代 diff patch） |
| `docs/layer1-upgrade-journal.md` | Layer 1 问题记录 |
| `docs/layer2-upgrade-journal.md` | Layer 2 问题记录 |
| `docs/layer3-upgrade-journal.md` | Layer 3 问题记录 |
| `docs/upgrade-summary.md` | 本文档 |

### 修改文件

| 文件 | 变更 |
|---|---|
| `package.json` | devDependencies 升级，repository URL 修复 |
| `Cargo.toml` | serde/serde-wasm-bindgen 版本更新 |
| `Cargo.lock` | 依赖锁定更新 |
| `build.sh` | set -euo pipefail, 步骤编号, 构建摘要 |
| `.github/workflows/test.yml` | 重写：现代化 actions + 官方 wasm-pack |
| `src/lib.rs` | impl_mutations! 宏加 debug() 方法 |
| `src/html_rewriter.rs` | 加 getStats(), handlers_registered, ended |
| `src/element.rs` | 加 attributeCount getter |
| `src/html_rewriter.d.ts` | 同步更新所有新 API 类型定义 |
| `ava.config.js` | require → nodeArguments: ["--import=tsx"] |
| `LEARNING.md` | 标记 Layer 1-3 完成，更新环境信息 |

### 删除文件

| 文件 | 说明 |
|---|---|
| `html_rewriter.js.patch` | 旧的 diff patch（用 patch_glue.py 替代） |

---

## 九、关键教训

1. **Rust + WASM 工具链版本耦合紧密** — Rust 版本、wasm-bindgen、wasm-opt、binaryen 四者必须兼容
2. **Cargo.lock 不更新 = 潜在炸弹** — 锁定 4 年的依赖在新编译器上直接报错
3. **diff patch 维护成本高** — 任何上游变化都会导致 patch 失败，确定性脚本更可靠
4. **externref + asyncify 是已知的不兼容组合** — WebAssembly 生态的待解决问题
5. **CI 配置会腐烂** — 6 个月不更新就会用上废弃的 action
6. **构建脚本需要可见性** — 没有构建摘要，出问题时无法快速定位
7. **宏是 Rust 的元编程工具** — `impl_mutations!` 一次定义多处展开
8. **跨 FFI 返回对象需要 js_sys** — 不能直接返回 Rust 结构体
9. **TypeScript 类型需要手动同步** — wasm-pack 不会自动更新 `.d.ts`

---

## 十、下一步

- **Layer 4**：Asyncify 异步桥接 — 在 asyncify.js 加状态日志和超时检测
- **Layer 5**：核心 Rust / lol-html — 读 lol-html 源码，考虑升级到 3.0.0
