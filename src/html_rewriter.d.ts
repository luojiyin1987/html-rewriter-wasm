/**
 * html-rewriter-wasm 类型定义
 *
 * 基于 Cloudflare Workers HTMLRewriter API 的 WebAssembly 实现。
 * 核心库是 lol-html（流式 HTML 解析器），通过 wasm-bindgen 暴露给 JS。
 *
 * 使用流程：
 *   1. 创建 HTMLRewriter 实例，传入输出回调
 *   2. 用 on() / onDocument() 注册选择器和处理器
 *   3. 调用 write() 输入 HTML 数据（可多次）
 *   4. 调用 end() 结束解析
 *   5. 调用 free() 释放 WASM 内存
 */

/** 内容类型选项：控制插入内容是 HTML 还是纯文本 */
export interface ContentTypeOptions {
  /** true = 插入原始 HTML；false/undefined = 转义为纯文本 */
  html?: boolean;
}

/**
 * HTML 元素节点
 *
 * 对应 lol-html 的 Element 类型。在 element handler 回调中可用。
 * 注意：handler 返回后 token 失效，访问会抛 TypeError。
 */
export class Element {
  /** 在当前元素之前插入内容 */
  before(content: string, options?: ContentTypeOptions): this;
  /** 在当前元素之后插入内容 */
  after(content: string, options?: ContentTypeOptions): this;
  /** 替换当前元素（包括子元素） */
  replace(content: string, options?: ContentTypeOptions): this;
  /** 删除当前元素 */
  remove(): this;
  /** 获取属性值，不存在返回 null */
  getAttribute(name: string): string | null;
  /** 检查属性是否存在 */
  hasAttribute(name: string): boolean;
  /** 设置属性值 */
  setAttribute(name: string, value: string): this;
  /** 删除属性 */
  removeAttribute(name: string): this;
  /** 在子内容最前面插入 */
  prepend(content: string, options?: ContentTypeOptions): this;
  /** 在子内容最后面插入 */
  append(content: string, options?: ContentTypeOptions): this;
  /** 替换所有子内容 */
  setInnerContent(content: string, options?: ContentTypeOptions): this;
  /** 删除标签但保留子内容 */
  removeAndKeepContent(): this;
  /** 遍历所有属性，返回 [name, value] 迭代器 */
  readonly attributes: IterableIterator<[string, string]>;
  /** 属性数量 */
  readonly attributeCount: number;
  /** 命名空间 URI（如 http://www.w3.org/1999/xhtml） */
  readonly namespaceURI: string;
  /** 是否已被 remove() 删除 */
  readonly removed: boolean;
  /** 标签名（可读写，修改会改变输出标签） */
  tagName: string;
  /** 注册结束标签处理器。handler 中 this 指向当前 Element */
  onEndTag(handler: (this: this, endTag: EndTag) => void | Promise<void>): void;
  /** 返回类型名称（调试用） */
  debug(): string;
}

/**
 * 结束标签（如 </p>）
 *
 * 通过 Element.onEndTag() 获取。只能在 onEndTag 回调内使用。
 */
export class EndTag {
  /** 在结束标签之前插入内容 */
  before(content: string, options?: ContentTypeOptions): this;
  /** 在结束标签之后插入内容 */
  after(content: string, options?: ContentTypeOptions): this;
  /** 删除结束标签 */
  remove(): this;
  /** 标签名（可读写，如将 "p" 改为 "h1"） */
  name: string;
  /** 返回类型名称（调试用） */
  debug(): string;
}

/**
 * HTML 注释节点（<!-- ... -->）
 *
 * 在 comments handler 回调中可用。
 */
export class Comment {
  /** 在注释之前插入内容 */
  before(content: string, options?: ContentTypeOptions): this;
  /** 在注释之后插入内容 */
  after(content: string, options?: ContentTypeOptions): this;
  /** 替换整个注释 */
  replace(content: string, options?: ContentTypeOptions): this;
  /** 删除注释 */
  remove(): this;
  /** 是否已被删除 */
  readonly removed: boolean;
  /** 注释文本内容（不含 <!-- -->） */
  text: string;
  /** 返回类型名称（调试用） */
  debug(): string;
}

/**
 * 文本节点片段
 *
 * 在 text handler 回调中可用。文本可能被拆分成多个片段。
 */
export class TextChunk {
  /** 在当前文本片段之前插入 */
  before(content: string, options?: ContentTypeOptions): this;
  /** 在当前文本片段之后插入 */
  after(content: string, options?: ContentTypeOptions): this;
  /** 替换当前文本片段 */
  replace(content: string, options?: ContentTypeOptions): this;
  /** 删除当前文本片段 */
  remove(): this;
  /** 是否是该文本节点的最后一个片段 */
  readonly lastInTextNode: boolean;
  /** 是否已被删除 */
  readonly removed: boolean;
  /** 文本内容 */
  readonly text: string;
  /** 返回类型名称（调试用） */
  debug(): string;
}

/**
 * DOCTYPE 声明（<!DOCTYPE html>）
 *
 * 在 doctype handler 回调中可用。只读。
 */
export class Doctype {
  /** DOCTYPE 名称（如 "html"），可能为 null */
  readonly name: string | null;
  /** PUBLIC 标识符，可能为 null */
  readonly publicId: string | null;
  /** SYSTEM 标识符，可能为 null */
  readonly systemId: string | null;
}

/**
 * 文档结束标记
 *
 * 在 document end handler 回调中可用。只能追加内容到文档末尾。
 */
export class DocumentEnd {
  /** 在文档末尾追加内容 */
  append(content: string, options?: ContentTypeOptions): this;
}

/**
 * 元素级处理器集合
 *
 * 通过 HTMLRewriter.on() 注册。所有处理器都是可选的，支持同步和异步。
 * 异步 handler 会触发 WASM Asyncify 栈展开/恢复。
 */
export interface ElementHandlers {
  /** 匹配到元素时调用（如 <p>、<div class="foo">） */
  element?(element: Element): void | Promise<void>;
  /** 匹配元素内的注释时调用 */
  comments?(comment: Comment): void | Promise<void>;
  /** 匹配元素内的文本时调用（文本可能分多次回调） */
  text?(text: TextChunk): void | Promise<void>;
}

/**
 * 文档级处理器集合
 *
 * 通过 HTMLRewriter.onDocument() 注册。处理整个文档级别的内容。
 */
export interface DocumentHandlers {
  /** 遇到 DOCTYPE 声明时调用 */
  doctype?(doctype: Doctype): void | Promise<void>;
  /** 遇到文档级注释时调用 */
  comments?(comment: Comment): void | Promise<void>;
  /** 遇到文档级文本时调用 */
  text?(text: TextChunk): void | Promise<void>;
  /** 文档解析结束时调用，可在此追加内容到末尾 */
  end?(end: DocumentEnd): void | Promise<void>;
}

/** HTMLRewriter 构造选项 */
export interface HTMLRewriterOptions {
  /** 启用 ESI Include 作为自空标签处理（兼容性标志） */
  enableEsiTags?: boolean;
}

/**
 * HTMLRewriter 统计信息
 */
export interface HTMLRewriterStats {
  /** 已注册的处理器数量 */
  handlersRegistered: number;
  /** 是否已调用 end() */
  ended: boolean;
}

/**
 * HTML 重写器主类
 *
 * 流式处理 HTML 输入，通过注册的选择器处理器进行转换。
 * 底层使用 lol-html 解析器 + Binaryen Asyncify 实现异步 handler。
 *
 * 注意事项：
 *   - 必须在第一次 write() 之前注册所有处理器
 *   - 每个实例只能调用一次 end()
 *   - 异步 handler 时，write/end 必须顺序 await，不支持并发
 *   - 使用完毕后调用 free() 释放 WASM 内存
 */
export class HTMLRewriter {
  /**
   * @param outputSink - 输出回调，接收处理后的 Uint8Array 数据块
   * @param options - 可选配置
   */
  constructor(
    outputSink: (chunk: Uint8Array) => void,
    options?: HTMLRewriterOptions
  );
  /** 注册元素级处理器。selector 是 CSS 选择器 */
  on(selector: string, handlers: ElementHandlers): this;
  /** 注册文档级处理器 */
  onDocument(handlers: DocumentHandlers): this;
  /** 写入 HTML 数据块。异步 handler 时必须 await */
  write(chunk: Uint8Array): Promise<void>;
  /** 结束输入，刷新剩余内容。必须在所有 write() 之后调用 */
  end(): Promise<void>;
  /** 释放 WASM 内存。必须在使用完毕后调用 */
  free(): void;
  /** 获取重写器统计信息 */
  getStats(): HTMLRewriterStats;
}
