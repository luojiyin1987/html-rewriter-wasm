# Layer 5 — Core Rust / lol-html Built-in Handler

## 目标

在 Rust 层直接注入一个原生 handler，自动为所有 `<img>` 标签添加 `loading="lazy"` 属性。
这展示了 WASM 边界两侧的能力：JS 注册动态 handler，Rust 提供固定的、高性能的"内置"变换。

## 改动概要

### 1. `src/html_rewriter.rs` — 注入原生 handler

在 `inner_mut()` 方法中，构建 `Settings` 时，在用户注册的 handler **之前**插入一个 Rust 原生 handler：

```rust
// Built-in Rust handler: auto-add loading="lazy" to <img> tags
let lazy_load_handler = lol_html::element!("img", |el| {
    if !el.has_attribute("loading") {
        el.set_attribute("loading", "lazy").unwrap();
    }
    Ok(())
});

let mut element_handlers = /* ... user handlers ... */;
element_handlers.insert(0, lazy_load_handler); // prepend
```

关键点：
- 使用 lol-html 的 `element!` 宏创建 selector-based handler
- `insert(0, ...)` 保证内置 handler 先于用户 handler 执行
- 只在 `<img>` 没有 `loading` 属性时才添加（尊重显式设置）

### 2. `test/lazy-load.spec.ts` — 9 个测试用例

| 测试 | 验证点 |
|------|--------|
| auto-adds loading='lazy' | 基本功能 |
| does not overwrite existing | 尊重 `loading="eager"` |
| adds to multiple img tags | 批量处理 |
| works alongside user handlers | 内置 + 用户 handler 共存 |
| works without user handlers | 纯内置 handler 场景 |
| does not affect non-img | 选择器隔离 |
| handles self-closing img | `<img />` 语法 |
| handles img with no attributes | `<img>` 无属性 |
| getStats still works | 内置 handler 不影响统计 |

## 学到的教训

### 1. lol-html `element!` 宏可以直接在 Settings 中使用

```rust
use lol_html::html_content::ContentType;

let handler = lol_html::element!("img", |el| {
    el.set_attribute("loading", "lazy").unwrap();
    Ok(())
);
```

`element!` 宏返回 `(Cow<'static, Selector>, ElementContentHandlers<'static>)` 元组，
正好是 `Settings.element_content_handlers` 的元素类型。

### 2. Handler 执行顺序 = 注册顺序

`insert(0, ...)` 把内置 handler 放在最前面，它先执行。
执行顺序影响属性的最终顺序：内置 handler 设置的 `loading` 出现在用户 handler 设置的 `alt` 之前。

### 3. WASM 体积影响

注入一个 Rust handler 增加了 ~8KB WASM 体积（840K → 848K）。
这是因为 `element!` 宏引入了 CSS 选择器解析器和匹配逻辑。

### 4. 选择器解析发生在 Rust 构建阶段

`lol_html::element!("img", ...)` 在 `inner_mut()` 调用时解析选择器，
而非在 JS 调用 `.on("img", ...)` 时。内置 handler 的选择器解析是一次性的。

### 5. `has_attribute` 检查避免覆盖

```rust
if !el.has_attribute("loading") {
    el.set_attribute("loading", "lazy").unwrap();
}
```

这是防御性编程：尊重用户显式设置的 `loading="eager"` 或其他值。

## 文件变更

```
src/html_rewriter.rs         +12 行 (内置 handler 注入)
test/lazy-load.spec.ts       +79 行 (9 个测试)
docs/layer5-upgrade-journal.md  本文件
```

## 测试结果

```
79 tests passed (70 original + 9 new)
```

## 后续可探索

- 添加更多内置 handler（如 `<iframe loading="lazy">`、`<video preload="none">`）
- 将内置 handler 做成可配置的 feature flag
- 研究 lol-html 3.0.0 的 builder pattern API 如何简化 Settings 构建
