# 第 3 层改造：wasm-bindgen 绑定 — 问题与解决记录

> 日期：2026-06-18
> 目标：理解 Rust 结构体如何暴露为 JS 类，学习 wasm-bindgen 的核心机制

---

## 核心概念：wasm-bindgen 如何工作

### Rust → JS 映射规则

| Rust 标注 | JS 侧等价 |
|---|---|
| `#[wasm_bindgen] pub struct Foo` | `class Foo` |
| `#[wasm_bindgen] impl Foo { pub fn bar() }` | `Foo.prototype.bar = function() {}` |
| `#[wasm_bindgen(constructor)]` | `new Foo()` |
| `#[wasm_bindgen(method, getter)]` | `Object.defineProperty(Foo.prototype, 'bar', {get})` |
| `#[wasm_bindgen(method, setter=name)]` | `Object.defineProperty(Foo.prototype, 'name', {set})` |
| `#[wasm_bindgen(method, js_name=getAttribute)]` | `Foo.prototype.getAttribute = function()` |
| `extern "C" { pub type Foo }` | JS 侧类型引用 |

### 本项目的结构体 → JS 类映射

```
Rust 源码                          JS 类
─────────────────────────────────────────────────
src/lib.rs                        (宏定义)
  impl_mutations!(Element)        → Element 的 before/after/replace/remove
  impl_mutations!(Comment)        → Comment 的 before/after/replace/remove
  impl_mutations!(TextChunk)      → TextChunk 的 before/after/replace/remove
  impl_from_native!(...)          → from_native() 工厂方法

src/element.rs                    Element 类
  tag_name()                      → element.tagName (getter)
  set_tag_name()                  → element.tagName = "h1" (setter)
  attributes()                    → element.attributes (getter, 迭代器)
  attribute_count()               → element.attributeCount (getter) [新增]
  get_attribute()                 → element.getAttribute("class")
  has_attribute()                 → element.hasAttribute("class")
  set_attribute()                 → element.setAttribute("id", "header")
  remove_attribute()              → element.removeAttribute("class")
  prepend/append/etc.             → element.prepend("html")
  on_end_tag()                    → element.onEndTag(handler)
  debug()                         → element.debug() [新增]

src/comment.rs                    Comment 类
  text()                          → comment.text (getter/setter)
  debug()                         → comment.debug() [新增]

src/text_chunk.rs                 TextChunk 类
  text()                          → textChunk.text (getter)
  last_in_text_node()             → textChunk.lastInTextNode (getter)
  debug()                         → textChunk.debug() [新增]

src/doctype.rs                    Doctype 类 (只读)
  name(), public_id(), system_id()

src/end_tag.rs                    EndTag 类
  name()                          → endTag.name (getter/setter)
  before/after/remove             → 链式调用
  debug()                         → endTag.debug() [新增]

src/document_end.rs               DocumentEnd 类
  append()                        → documentEnd.append("html")

src/html_rewriter.rs              HTMLRewriter 类
  constructor(outputSink, options) → new HTMLRewriter(callback, options)
  on(selector, handlers)          → rewriter.on("p", {...})
  on_document(handlers)           → rewriter.onDocument({...})
  write(chunk)                    → await rewriter.write(uint8array) [async via patch]
  end()                           → await rewriter.end() [async via patch]
  asyncify_stack_ptr()            → rewriter.asyncifyStackPtr (getter, 内部)
  get_stats()                     → rewriter.getStats() [新增]
```

---

## 改造 1：impl_mutations! 宏加 debug() 方法

### 目的

理解宏如何批量为多个类型生成相同方法。

### 实现

```rust
macro_rules! impl_mutations {
    ($Ty:ident) => {
        #[wasm_bindgen]
        impl $Ty {
            // ... 现有方法 ...

            #[wasm_bindgen(js_name = debug)]
            pub fn debug(&self) -> JsResult<String> {
                self.0.get().map(|_| stringify!($Ty).to_string())
            }
        }
    };
}
```

### 知识点

- `stringify!($Ty)` 是 Rust 的编译期宏，将标识符转为字符串字面量
- `impl_mutations!(Element)` 展开后，`debug()` 返回 `"Element"`
- `impl_mutations!(Comment)` 展开后，`debug()` 返回 `"Comment"`
- `#[wasm_bindgen(js_name = debug)]` 确保 JS 侧方法名是 `debug` 而非 Rust 的 `debug`（虽然名字一样，但 js_name 显式声明更清晰）

### 宏展开示例

```rust
// 输入
impl_mutations!(Element);

// 展开为（简化）
#[wasm_bindgen]
impl Element {
    pub fn before(...) -> Result<(), JsValue> { ... }
    pub fn after(...) -> Result<(), JsValue> { ... }
    pub fn replace(...) -> Result<(), JsValue> { ... }
    pub fn remove() -> Result<(), JsValue> { ... }
    pub fn removed() -> JsResult<bool> { ... }
    pub fn debug() -> JsResult<String> { self.0.get().map(|_| "Element".to_string()) }
}
```

---

## 改造 2：HTMLRewriter 加 getStats() getter

### 目的

理解 `#[wasm_bindgen]` 如何在 Rust 端维护状态并通过 getter 暴露给 JS。

### 挑战

统计信息需要跨 FFI 边界传递。wasm-bindgen 支持返回 JS 对象，但需要使用 `js_sys::Object` 和 `js_sys::Reflect`。

### 实现

```rust
#[wasm_bindgen]
pub struct HTMLRewriter {
    // ... 现有字段 ...
    handlers_registered: u32,  // 新增：统计注册的 handler 数量
    ended: bool,               // 新增：是否已调用 end()
}

#[wasm_bindgen]
impl HTMLRewriter {
    #[wasm_bindgen(js_name = getStats)]
    pub fn get_stats(&self) -> JsResult<Object> {
        let obj = Object::new();
        js_sys::Reflect::set(&obj, &"handlersRegistered".into(), &JsValue::from(self.handlers_registered))?;
        js_sys::Reflect::set(&obj, &"ended".into(), &JsValue::from(self.ended))?;
        Ok(obj)
    }
}
```

### 知识点

- `js_sys::Object::new()` 创建一个空的 JS 对象 `{}`
- `js_sys::Reflect::set(obj, key, value)` 对应 JS 的 `obj[key] = value`
- 返回类型 `JsResult<Object>` 在 JS 侧表现为普通对象（或抛出异常）
- 计数在 `on()` 和 `on_document()` 中递增，在 `end()` 中设置 `ended = true`

### JS 侧使用

```js
const rewriter = new HTMLRewriter(callback);
rewriter.on("p", { element(el) {} });
rewriter.on("div", { element(el) {} });
console.log(rewriter.getStats());
// { handlersRegistered: 2, ended: false }
await rewriter.end();
console.log(rewriter.getStats());
// { handlersRegistered: 2, ended: true }
```

---

## 改造 3：Element 加 attributeCount getter

### 目的

理解 `#[wasm_bindgen(method, getter=name)]` 的命名映射。

### 实现

```rust
#[wasm_bindgen(method, getter=attributeCount)]
pub fn attribute_count(&self) -> JsResult<usize> {
    self.0.get().map(|e| e.attributes().len())
}
```

### 知识点

- Rust 方法名 `attribute_count`（snake_case）
- JS getter 名 `attributeCount`（camelCase）
- `getter=attributeCount` 告诉 wasm-bindgen 在 JS 侧生成 `get attributeCount()` 
- 返回 `usize` → JS 侧自动转为 `number`

---

## 改造 4：TypeScript 类型定义同步更新

### 问题

Rust 侧加了新方法，但 `html_rewriter.d.ts` 没有同步更新，TypeScript 用户看不到新 API。

### 解决方案

手动更新 `.d.ts` 文件，添加：
- `Element.attributeCount: number`
- `Element.debug(): string`
- `Comment.debug(): string`
- `TextChunk.debug(): string`
- `EndTag.debug(): string`
- `HTMLRewriterStats` 接口
- `HTMLRewriter.getStats(): HTMLRewriterStats`

### 知识点

- wasm-pack 不会自动生成 `.d.ts` 的更新（它只生成 JS glue code）
- TypeScript 类型定义需要手动维护
- 也可以考虑用 `wasm-bindgen` 的 `--typescript` 标志自动生成，但需要额外配置

---

## 关键文件变更

| 文件 | 变更 |
|---|---|
| `src/lib.rs` | `impl_mutations!` 宏加 `debug()` 方法 |
| `src/html_rewriter.rs` | 加 `handlers_registered`, `ended` 字段，加 `get_stats()` 方法 |
| `src/element.rs` | 加 `attribute_count()` getter |
| `src/html_rewriter.d.ts` | 同步更新所有新 API 的类型定义 |

---

## 关键教训

1. **宏是 Rust 的元编程工具** — `impl_mutations!` 一次定义，多处展开，避免重复代码
2. **wasm-bindgen 的 `js_name` 用于命名映射** — Rust snake_case → JS camelCase
3. **跨 FFI 返回对象需要 `js_sys::Object`** — 不能直接返回 Rust 结构体
4. **TypeScript 类型需要手动同步** — wasm-pack 不会自动更新 `.d.ts`
5. **`stringify!` 是编译期宏** — 将标识符转为字符串，零运行时开销
6. **`#[wasm_bindgen(method, getter=name)]`** — Rust 的 `fn name()` 变成 JS 的 `get name()`
