# 第 2 层改造：构建管线 — 问题与解决记录

> 日期：2026-06-18
> 目标：理解从 Rust 源码到可用 JS 包的完整流程，现代化 CI 和构建脚本

---

## 1. CI 仍用已废弃的 Actions 和 mrbbot fork

### 问题

`.github/workflows/test.yml` 多处过时：

```yaml
# 旧 CI
- uses: actions/checkout@v2          # 过时，当前 v4
- uses: actions-rs/toolchain@v1      # 已废弃，不再维护
- uses: Swatinem/rust-cache@v1       # 过时，当前 v2
- uses: actions/setup-node@v2        # 过时，当前 v4
- run: cargo install --git https://github.com/mrbbot/wasm-pack  # mrbbot fork
```

### 探索过程

1. 检查 `.github/workflows/test.yml` → 发现 5 处过时引用
2. `actions-rs/toolchain@v1` → 该 action 已 archived，社区推荐直接用 `rustup`
3. mrbbot fork → Layer 1 已证明官方 wasm-pack 0.14+ 自带 wasm-opt >= 92，无需 fork
4. Rust toolchain → 项目需要 nightly（`Cargo.toml` 无 `rust-version` 字段，但用了 nightly 特性）

### 解决方案

```yaml
# 新 CI
- uses: actions/checkout@v4
- name: Install Rust nightly
  run: |
    rustup toolchain install nightly
    rustup default nightly
- uses: Swatinem/rust-cache@v2
- uses: actions/setup-node@v4
- name: Install wasm-pack
  run: cargo install wasm-pack
- name: Install wasm-opt
  run: |
    curl -sL "https://github.com/WebAssembly/binaryen/releases/download/version_120/binaryen-version_120-x86_64-linux.tar.gz" | tar xz
    cp binaryen-version_120/bin/wasm-opt ~/.cargo/bin/wasm-opt
```

### 知识点

- `actions-rs/toolchain` 已废弃，直接用 `rustup` 更可靠
- wasm-opt 版本要求：Rust nightly 生成的 WASM 需要 >= 120
- 官方 wasm-pack 0.14+ 不再需要 mrbbot fork

---

## 2. build.sh 缺少错误处理和构建信息

### 问题

旧 `build.sh` 只有 `set -e`，构建失败时输出不明确，无法知道构建产物大小和耗时。

### 探索过程

1. 手动执行 `build.sh` 的每一步，观察输出
2. `wasm-pack build --target nodejs` → `pkg/` 目录包含：
   - `html_rewriter.js` (49KB) — wasm-bindgen 生成的 glue code
   - `html_rewriter_bg.wasm` (836KB) — 优化后的 WASM 二进制
   - `html_rewriter.d.ts` (9KB) — TypeScript 类型定义
   - `package.json` — npm 包配置
3. `python3 src/patch_glue.py pkg/html_rewriter.js` → 对 glue code 做 8 项语义变换
4. `cp` 到 `dist/` → 最终发布内容

### 解决方案

```bash
#!/usr/bin/env bash
set -euo pipefail          # 严格模式

STEP=0
step() { STEP=$((STEP+1)); echo "---> [$STEP] $1"; }

START=$(date +%s)

step "Checking wasm-pack version..."
step "Building WebAssembly with wasm-pack..."
step "Patching JavaScript glue code..."
step "Copying required files to dist..."
step "Build summary"
    WASM: 836K | JS: 48K | Time: 10s
```

### 知识点

- `set -euo pipefail` 比 `set -e` 更严格：`-u` 检查未定义变量，`-o pipefail` 捕获管道错误
- 构建产物：WASM 836KB + JS 49KB = 约 885KB 总大小
- `wasm-opt -Os --asyncify` 优化后 WASM 从 ~1.2MB 降到 836KB

---

## 3. package.json 指向错误的仓库

### 项目

```json
"repository": {
  "url": "git+https://github.com/mrbbot/html-rewriter-wasm.git"  // 指向原作者
},
"bugs": {
  "url": "https://github.com/mrbbot/html-rewriter-wasm/issues"
},
"homepage": "https://github.com/mrbbot/html-rewriter-wasm#readme"
```

### 解决方案

改为指向 fork：

```json
"repository": {
  "url": "git+https://github.com/luojiyin1987/html-rewriter-wasm.git"
},
"bugs": {
  "url": "https://github.com/luojiyin1987/html-rewriter-wasm/issues"
},
"homepage": "https://github.com/luojiyin1987/html-rewriter-wasm#readme"
```

---

## 4. wasm-pack 版本漂移

### 问题

`LEARNING.md` 记录 wasm-pack 0.14.0，但实际安装的是 0.15.0（Layer 1 中 `cargo install wasm-pack` 安装了最新版）。

### 解决方案

更新 `LEARNING.md` 环境信息：

```
- wasm-pack: 0.15.0
- wasm-opt: version 120
```

---

## 构建管线完整流程

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
  │  ├── html_rewriter.js (48KB) — 补丁后的 glue code
  │  ├── html_rewriter_bg.wasm (836KB) — 优化后的 WASM
  │  ├── asyncify.js (2.5KB) — 手写的异步桥接
  │  └── html_rewriter.d.ts (2.7KB) — TypeScript 类型
  │
  ▼ npm test
     └── 70 tests passed
```

---

## 最终工具链版本

| 工具 | 版本 | 用途 |
|---|---|---|
| Node.js | v24.15.0 | JS 运行时 |
| Rust | 1.97.0-nightly | 编译器 |
| wasm-pack | 0.15.0 | WASM 构建工具 |
| wasm-opt | 120 | WASM 优化器 |
| wasm-bindgen | 0.2.92 | Rust↔JS 绑定（锁定） |
| Python | 3.x | 胶水代码补丁 |

---

## 关键教训

1. **CI 配置会腐烂** — 6 个月不更新就会用上废弃的 action
2. **构建脚本需要可见性** — 没有构建摘要，出问题时无法快速定位
3. **仓库 URL 是容易忽略的细节** — fork 后记得更新 package.json
4. **版本记录要与实际同步** — 安装工具后立即更新文档
