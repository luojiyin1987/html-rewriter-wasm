# WASM 技术概念讨论记录

> 日期：2026-06-18
> 背景：在完成 html-rewriter-wasm 项目 5 层改造后，对 WASM 技术栈的深入讨论

---

## 一、为什么用 JS + Rust 两门语言？

### 架构图

```
用户 JS 代码
    ↓ 调用
JS Glue 层 (asyncify.js + patch 后的 html_rewriter.js)
    ↓ FFI 调用
WASM (Rust 编译产物)
    ↓ 解析
lol-html (Rust 实现的 HTML 解析器)
```

### 各自职责

| 语言 | 职责 | 为什么选它 |
|---|---|---|
| **Rust** | HTML 解析、标签匹配、内存管理 | 零开销抽象、无 GC、速度接近 C |
| **JavaScript** | 用户 API、异步 handler、WASM 栈管理 | npm 生态、async/await、浏览器/Node 兼容 |

### 如果只用一门语言

**只用 JS：** 解析大型 HTML（几 MB）时 GC 暂停会导致卡顿，速度比 Rust 慢 5-10 倍

**只用 Rust：** 无法直接在浏览器/Node 运行，用户要手动编译 WASM，生态孤立

### WASM 是桥梁

```
Rust 源码 → wasm-pack → .wasm 文件 → 浏览器/Node 直接运行
                                  ↑
                         不需要用户装 Rust
```

Cloudflare 选择这个架构是因为他们的 Workers 边缘计算需要：
- **Rust** 的性能（每秒处理百万请求）
- **JS** 的开发者体验（用户直接 `import` 就能用）

本质上就是"用 Rust 写核心引擎，用 JS 包一层 API"，和游戏引擎（C++ 核心 + Lua/Python 脚本）是同一个思路。

---

## 二、不用 C++ 写插件？

### 传统方式 vs WASM 方式

| | C++ 插件 | Rust → WASM |
|---|---|---|
| 编译目标 | 特定 OS 的 .so/.dll | 通用 .wasm，到处运行 |
| 分发 | 用户要自己编译 | 一个 .wasm 文件，所有平台 |
| 安全性 | 野指针、内存泄漏风险 | Rust 编译期保证内存安全 |
| 构建 | CMake/Make，依赖地狱 | `wasm-pack build`，一条命令 |
| 嵌入 | 需要 FFI/嵌入式解释器 | 浏览器/Node 原生支持 WASM |

### C++ 插件方案被淘汰的原因

1. **分发痛苦** — 你要为 Windows/Linux/macOS 各编译一份，用户还要装对应运行时

2. **内存不安全** — C++ 的 `char*` 指针越界会崩溃，Rust 在编译期就阻止这类问题

3. **没有统一的沙箱** — C++ 插件崩溃会影响宿主进程，WASM 有线性内存隔离

### Rust 取代 C++ 的趋势

```
Chrome:  用 Rust 重写网络栈 (Quiche)
Firefox: 用 Rust 写 CSS 引擎 (Stylo)
Cloudflare: 用 Rust 写边缘计算核心
Discord: 从 Go 迁移到 Rust，延迟降低 10x
```

核心原因：**Rust 有 C++ 的性能，但编译器帮你管内存**。写 HTML 解析器这种高频调用的场景，Rust 比 C++ 更安全，比 JS 更快。

---

## 三、JS 加载 WASM 并使用其 API

### 流程

```
JS: fetch("html_rewriter_bg.wasm")
    ↓
JS: WebAssembly.instantiate(bytes)
    ↓
WASM 导出函数列表：
    ├── htmlrewriter_new()
    ├── htmlrewriter_write()
    ├── htmlrewriter_end()
    ├── element_set_attribute()
    └── ...
    ↓
JS: 调用这些函数
    ↓
WASM: 执行 Rust 代码，返回结果
```

### 具体到本项目

```js
// 用户看到的 API（JS 封装）
const rewriter = new HTMLRewriter(callback);
rewriter.on("img", { element(el) { el.setAttribute("loading", "lazy"); } });
await rewriter.write(chunk);
await rewriter.end();

// 底层实际调用的是 WASM 导出的函数
wasm.htmlrewriter_new(callbackPtr);
wasm.htmlrewriter_on(rewriterPtr, selectorPtr, handlersPtr);
wasm.htmlrewriter_write(rewriterPtr, chunkPtr, chunkLen);
wasm.htmlrewriter_end(rewriterPtr);
```

### wasm-bindgen 做了什么

它自动生成中间层，帮你处理：

| 手动做 | wasm-bindgen 自动处理 |
|---|---|
| WASM 只接受数字 | JS 对象 ↔ 指针转换 |
| 字符串是 UTF-8 字节 | JS string ↔ WASM ptr+len |
| 函数调用要对齐栈 | 调用约定适配 |
| 对象生命周期 | 内存管理 |

### asyncify.js 做了什么

普通 WASM 是同步的，但 JS handler 可以是 async。asyncify.js 就是那个"挂起/恢复"的翻译层：

```
Rust: 遇到元素 → 调用 JS handler
JS:   handler 返回 Promise
Rust: 暂停！保存整个调用栈到内存
JS:   await promise ...
JS:   promise 完成
Rust: 恢复调用栈，继续执行
```

---

## 补充：Asyncify 是通用技术

### Asyncify 是什么

Binaryen 的 Asyncify 是一个**编译时 pass**，可以将任何同步 WASM 模块转换为支持异步操作的模块。它不是本项目的专属技术，而是 WebAssembly 生态的通用工具。

### 工作原理

```
原始同步 WASM：
  fn process() {
    do_something();
    call_js_handler();  // ← 如果 JS 要 async 怎么办？
    do_more();
  }

Asyncify 转换后：
  fn process() {
    do_something();
    call_js_handler();
    // ← 检查：JS 返回了 Promise？
    // 是 → 保存整个调用栈到线性内存，暂停
    //     JS await 完成后，恢复调用栈，继续执行 do_more()
    // 否 → 直接继续
  }
```

### 谁在用 Asyncify

| 项目 | 用途 |
|---|---|
| **Cloudflare Workers** | 在边缘节点执行 WASM，需要 async I/O |
| **Figma** | 高性能图形编辑器，WASM 处理图形，JS 处理 UI |
| **Emscripten** | 将 C/C++ 代码编译为 WASM，支持 async 文件操作 |
| **Rust wasm-bindgen** | 通过 Asyncify 支持 JS Promise |
| **本项目 (html-rewriter-wasm)** | 让同步的 lol-html 支持 async JS handler |

### Asyncify vs 其他异步方案

| 方案 | 原理 | 优点 | 缺点 |
|---|---|---|---|
| **Asyncify** | 编译时转换，保存/恢复调用栈 | 通用，任何同步代码都能用 | 性能开销（栈保存/恢复） |
| **SharedArrayBuffer** | WASM 和 JS 共享内存，JS 轮询 | 无栈开销 | 需要多线程支持，复杂 |
| **JSPI (JS Promise Integration)** | WASM 原生支持 Promise | 标准化，性能好 | 还在提案阶段，未广泛支持 |
| **手写状态机** | 手动将 async 逻辑拆成状态 | 性能最好 | 只适用于简单场景 |

### 为什么本项目选择 Asyncify

```
lol-html 是同步设计的 Rust 库
  ↓
不想重写为异步（工作量大，破坏 API）
  ↓
用 Asyncify 在编译时自动转换
  ↓
JS 侧可以写 async handler
  ↓
Rust 代码完全不用改
```

### Asyncify 的代价

| 代价 | 说明 |
|---|---|
| 性能 | 每次 async 都要保存/恢复整个调用栈，约 2-3x 开销 |
| 内存 | 需要额外的栈空间存储（本项目 1024 字节） |
| 编译时间 | Binaryen 的 Asyncify pass 增加编译时间 |
| 体积 | WASM 体积增加约 10-20%（本项目 840KB → 优化后差不多） |

### 一句话总结

**Asyncify 是"让同步代码支持 async"的通用编译技术**，本项目只是它的一个应用场景。类似的场景还包括：将 C/C++ 库编译为 WASM 并支持异步 I/O、让游戏引擎在浏览器中支持 async 资源加载等。

---

## 四、WASM 是同步的？JS 为什么用 async？

### WASM 是同步的

WASM 执行模型很简单：**调用 → 执行 → 返回**，没有内置的 await/async 概念。

```rust
// Rust 代码编译成 WASM 后
fn write(chunk: &[u8]) -> Result<()> {
    // 解析 HTML，遇到元素就回调
    // 回调必须同步完成，不能 await
}
```

### 但 JS handler 可以是 async

```js
rewriter.on("img", {
  async element(el) {    // ← 这个 async 怎么办？
    await fetch("something");
    el.setAttribute("loading", "lazy");
  }
});
```

问题：WASM 正在执行 `write()`，它不知道 JS 在 await 什么。

### Asyncify 的解决方案

```
Rust: write() 执行中
  → 调用 JS handler
  → JS: async element() { await ... }
  → WASM: 好，我先把整个调用栈保存到内存，暂停
  → JS: 你继续 await 吧
  → JS: await 完成
  → WASM: 恢复调用栈，继续执行 write()
```

### 为什么默认同步更好

| | 同步 | 异步 |
|---|---|---|
| 性能 | 最快，无栈开销 | 有 unwind/rewind 开销 |
| 内存 | 无额外消耗 | 每次 async 都要保存整个栈 |
| 复杂度 | 简单直接 | 需要 asyncify 支持 |
| 可用性 | 所有 WASM 运行时都支持 | 需要 Binaryen 编译时优化 |

**结论：JS 侧用 async 是为了用户体验（可以 await），但底层尽量用同步 handler。** 只有真正需要异步操作（网络请求、数据库查询）才用 async element handler。纯内存操作的 handler 应该写同步：

```js
// 好：同步，无 asyncify 开销
on("img", { element(el) { el.setAttribute("loading", "lazy"); } })

// 慢：异步，每次触发都有栈保存/恢复开销
on("img", { async element(el) { await fetch(...); } })
```

---

## 五、多个 Worker 调用 WASM 会资源争夺吗？

### Node.js Worker（多线程）

```
Worker 1: new HTMLRewriter() → 实例 A → WASM 内存 A
Worker 2: new HTMLRewriter() → 实例 B → WASM 内存 B
```

**不会争夺** — 每个 Worker 有独立的 WASM 实例和内存。V8 的 isolates 机制天然隔离。

### 同一 Worker 内多实例

```
Worker 1:
  rewriterA: new HTMLRewriter() → WASM 实例 A
  rewriterB: new HTMLRewriter() → WASM 实例 B
```

**也不会争夺** — 每个 `new HTMLRewriter()` 在 WASM 中分配独立内存，互不干扰。

### 但有共享资源

| 资源 | 是否共享 | 争夺风险 |
|---|---|---|
| WASM 内存 | 每实例独立 | 无 |
| CPU | 所有实例共享 | 有（同步解析会阻塞事件循环） |
| 文件/网络 | 共享 | 有（常规并发问题） |

### 真正的瓶颈是 CPU

```js
// 同一 Worker 内，多个 rewriter 同步执行会阻塞
await rewriterA.write(bigHtml);  // 阻塞
await rewriterB.write(bigHtml);  // 等 rewriterA 完成才执行
```

WASM 是同步执行的，一个 `write()` 调用会独占 CPU 直到完成。要并发处理多个大文件，用 **Worker 而不是多实例**：

```js
// 好：Worker 并行
const worker1 = new Worker("./worker1.js");  // rewriterA
const worker2 = new Worker("./worker2.js");  // rewriterB
// 两个同时跑

// 差：同一 Worker 串行
await rewriterA.write(html1);  // 阻塞
await rewriterB.write(html2);  // 等着
```

### 总结

- **内存隔离**：WASM 实例天然隔离，不会像 C++ 那样共享堆内存
- **CPU 争抢**：同一 Worker 内是串行的，用 Worker 做并发
- **asyncify 的代价**：每次 async handler 都要保存/恢复栈，多实例并发时内存开销翻倍

---

## 六、WASM 的文件读写

WASM 本身**不能直接读写文件**。它运行在沙箱里，只能操作自己的线性内存。

### 文件操作的路径

```
用户 JS 代码
  ↓ fs.readFile("input.html")
JS: 读取文件到 Buffer
  ↓ rewriter.write(buffer)
WASM: 在内存中解析 Buffer（不能读磁盘）
  ↓ outputSink 回调
JS: 收到处理后的字节
  ↓ fs.writeFile("output.html", output)
JS: 写回磁盘
```

### 这个项目的实际流程

```js
// JS 负责 I/O
const input = fs.readFileSync("input.html");   // JS 读
const chunks = [];
const rewriter = new HTMLRewriter((chunk) => {
  chunks.push(chunk);                           // JS 接收输出
});
await rewriter.write(input);                    // WASM 处理
await rewriter.end();
fs.writeFileSync("output.html", Buffer.concat(chunks)); // JS 写
```

### 为什么 WASM 不碰文件

| 原因 | 说明 |
|---|---|
| 沙箱安全 | WASM 只能访问自己的内存，不能访问宿主文件系统 |
| 可移植 | 同一份 .wasm 在浏览器/Node/Deno 都能跑，不用关心文件 API 差异 |
| 性能 | 内存操作比文件 I/O 快 1000x，文件操作交给 JS 更合理 |

**总结：JS 是"搬运工"，WASM 是"加工厂"。** 文件读写全在 JS 侧，WASM 只管内存中的字节流。

---

## 七、WASM 是在内存上运行的？以数据处理为主？

对。WASM 的本质是**内存中的虚拟 CPU**。

### WASM 运行模型

```
线性内存（ArrayBuffer）
┌─────────────────────────────┐
│ 0x0000  stack (调用栈)       │
│ 0x1000  heap (动态分配)      │
│ 0x8000  data (常量)          │
│ ...                         │
│ 用户数据 buffer              │
└─────────────────────────────┘
      ↑
  WASM 指针直接读写这块内存
```

它没有文件系统、没有网络、没有 DOM — **只有内存和 CPU 指令**。

### WASM 擅长的场景

| 场景 | 为什么适合 | 例子 |
|---|---|---|
| 数据解析 | 大量字节操作，无 I/O 等待 | HTML 解析（本项目）、JSON、Protocol Buffers |
| 加密/解密 | 纯计算，无系统调用 | SHA256、AES |
| 图像处理 | 像素级操作 | 缩放、滤镜、WebP 编码 |
| 压缩/解压 | 纯算法 | gzip、brotli、zstd |
| 视频编解码 | CPU 密集型 | H.264、AV1 |

### 不适合 WASM 的场景

| 场景 | 为什么不行 |
|---|---|
| 文件读写 | WASM 没有文件系统 API |
| 网络请求 | WASM 没有 socket |
| 操作系统调用 | WASM 是沙箱 |
| UI 渲染 | 浏览器有专门的渲染引擎 |

### 本质类比

```
WASM ≈ 一个没有外设的 CPU
  - 有寄存器（局部变量）
  - 有内存（线性内存）
  - 能做算术/逻辑运算
  - 不能访问硬盘、网卡、显示器

JS ≈ 操作系统
  - 提供所有外设访问
  - 调用 WASM 时，WASM 只处理内存中的数据
  - 处理完了，结果写回内存，JS 取走
```

**WASM 就是一个"内存加工厂"：JS 把原料搬进来，WASM 加工，JS 把成品搬出去。**

---

## 八、WASM 是解决 JS CPU 效率低的问题？

对，这是最核心的原因。

### JS 慢在哪

```js
// JS 引擎执行代码的过程
源码 → 解析 → AST → 字节码 → 解释执行 → JIT 编译 → 优化 → 反优化 → ...
```

| 问题 | 原因 |
|---|---|
| 动态类型 | `x + x` 要判断：是数字相加还是字符串拼接？ |
| JIT 反优化 | 类型变了，之前编译的机器码作废，重新编译 |
| GC 暂停 | 垃圾回收器运行时，所有代码暂停 |
| 单线程 | 一个大任务会阻塞整个事件循环 |

### WASM 为什么快

```
Rust 源码 → 编译期确定类型 → 直接生成机器码 → WASM 字节码 → 接近原生速度执行
```

| 优势 | 说明 |
|---|---|
| 静态类型 | 编译期知道 `x` 是 i32，直接生成整数加法指令 |
| 无 GC | Rust 编译期管理内存，运行时零开销 |
| 无反优化 | 类型不会变，JIT 信心满满 |
| SIMD 支持 | 一条指令处理多个数据 |

### 性能对比

```
HTML 解析（本项目场景）：
  JS (google-html-parser):  ~100ms / 1MB
  Rust lol-html (WASM):     ~15ms / 1MB
  原生 C++:                  ~10ms / 1MB

  WASM 比 JS 快 5-7 倍，接近原生 C++
```

### 但 JS 并不差

JS 引擎（V8）已经很聪明了，**常规 Web 应用 JS 完全够用**：

```
JS 够用：           WASM 必要：
├─ API 调用         ├─ 视频编解码
├─ DOM 操作         ├─ 3D 游戏渲染
├─ 业务逻辑         ├─ 图像处理
├─ 表单验证         ├─ 加密算法
└─ 简单计算         ├─ 大文件解析（本项目）
                    ├─ CAD/编辑器
                    └─ 音频处理
```

### 一句话总结

**JS 的瓶颈不是"慢"，而是"不确定"** — 类型不确定、GC 时间不确定、JIT 优化不确定。WASM 的优势是**确定性**：编译期确定一切，运行时直接执行，没有意外。

---

## 九、WASM 的技术局限性和安全风险

### 技术局限性

| 局限 | 说明 |
|---|---|
| **无 DOM 访问** | 不能直接操作页面，必须通过 JS 回调 |
| **无系统调用** | 没有文件/网络/进程，全靠宿主环境提供 |
| **单线程** | 原生 WASM 没有多线程（需要 SharedArrayBuffer + Web Workers） |
| **无 GC** | 不适合需要频繁分配/释放大量对象的语言（如 Java、Go 编译到 WASM 会很大） |
| **启动开销** | WASM 需要编译/实例化，冷启动比 JS 慢（V8 可缓存缓解） |
| **调试困难** | 堆栈信息有限，错误信息不友好，源码映射不完善 |
| **二进制体积** | 简单功能 WASM 可能比 JS 大（HTML 解析器 848KB vs JS 52KB） |
| **无法热更新** | JS 改了立即生效，WASM 改了要重新编译分发 |

### 安全风险

| 风险 | 级别 | 说明 |
|---|---|---|
| **线性内存越界** | 低 | WASM 有边界检查，越界会 trap 而不是访问其他内存 |
| **堆栈溢出** | 低 | WASM 有栈上限，超了会 trap |
| **整数溢出** | 中 | WASM 不检查整数溢出（和 C 一样），需要 Rust/Solidity 自己处理 |
| **侧信道攻击** | 高 | Spectre/Meltdown 仍然有效，WASM 可以测量缓存命中率推测内存内容 |
| **恶意 WASM** | 中 | 恶意模块可以耗尽 CPU/内存，需要沙箱限制资源 |
| **供应链攻击** | 高 | npm 包里藏恶意 .wasm，用户不知道执行了什么 |
| **反编译** | 低 | WASM 字节码比 JS 更难逆向，但不是不可能 |

### WASM vs 原生代码的安全对比

```
原生 C++ 代码：
  void* ptr = malloc(100);
  ptr[200] = 'x';  // ← 越界写入，可能覆盖其他进程内存

WASM：
  let memory = new WebAssembly.Memory({initial: 1});
  // 内存是 ArrayBuffer，有固定大小
  // 越界访问会抛出 WebAssembly.RuntimeError
  // 无法访问宿主进程的其他内存
```

### 真正的安全顾虑

```
不是 WASM 本身的问题，而是：
├─ 你信任这个 WASM 模块吗？（来源）
├─ 它有没有恶意代码？（审计困难）
├─ 它能逃逸沙箱吗？（理论上不能）
└─ 它能利用 CPU 漏洞吗？（Spectre 类攻击）
```

### 一句话总结

**WASM 的安全模型比原生代码好**（有沙箱、有内存隔离、有边界检查），但**不是绝对安全** — 侧信道攻击和供应链攻击是真实威胁。对于本项目（Cloudflare 维护的开源库），这些风险可以接受。

---

## 十、总结：WASM 的定位

```
┌─────────────────────────────────────────────┐
│                用户 JS 代码                   │
├─────────────────────────────────────────────┤
│           JS Glue (asyncify.js)              │
│        桥接：JS 对象 ↔ WASM 指针              │
├─────────────────────────────────────────────┤
│              WASM (Rust 编译)                │
│        执行：内存中的 CPU 指令                 │
│        优势：类型安全、无 GC、确定性           │
├─────────────────────────────────────────────┤
│           宿主环境 (Node/浏览器)              │
│        提供：文件、网络、DOM 等外设访问         │
└─────────────────────────────────────────────┘

WASM = 用 C++ 的性能，用 Rust 的安全，用 JS 的分发
```
