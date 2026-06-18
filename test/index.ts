import { TextEncoder, TextDecoder } from "util";
import { Macro } from "ava";
import {
  Comment,
  DocumentHandlers,
  Element,
  ElementHandlers,
  HTMLRewriter as RawHTMLRewriter,
  HTMLRewriterOptions as RawHTMLRewriterOptions,
  TextChunk,
} from "..";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * HTMLRewriter 包装类
 *
 * 简化原始 API 的使用：将 Uint8Array 输入/输出转为字符串。
 * 所有处理器在 transform() 调用时一次性注册。
 *
 * 使用示例：
 *   const result = await new HTMLRewriter()
 *     .on("p", { element(el) { el.setInnerContent("new"); } })
 *     .transform("<p>old</p>");
 *   // result === "<p>new</p>"
 */
export class HTMLRewriter {
  private elementHandlers: [selector: string, handlers: ElementHandlers][] = [];
  private documentHandlers: DocumentHandlers[] = [];

  constructor(private readonly options?: RawHTMLRewriterOptions) {}

  /** 注册元素级处理器 */
  on(selector: string, handlers: ElementHandlers): this {
    this.elementHandlers.push([selector, handlers]);
    return this;
  }

  /** 注册文档级处理器 */
  onDocument(handlers: DocumentHandlers): this {
    this.documentHandlers.push(handlers);
    return this;
  }

  /** 执行转换：输入 HTML 字符串，返回转换后的字符串 */
  async transform(input: string): Promise<string> {
    let output = "";
    const rewriter = new RawHTMLRewriter((chunk) => {
      output += decoder.decode(chunk);
    }, this.options);
    for (const [selector, handlers] of this.elementHandlers) {
      rewriter.on(selector, handlers);
    }
    for (const handlers of this.documentHandlers) {
      rewriter.onDocument(handlers);
    }
    try {
      await rewriter.write(encoder.encode(input));
      await rewriter.end();
      return output;
    } finally {
      rewriter.free();
    }
  }
}

/**
 * 便捷函数：一步完成 HTML 转换
 *
 * @param input - 输入 HTML 字符串
 * @param setup - 配置函数，用于注册处理器
 * @returns 转换后的 HTML 字符串
 *
 * 使用示例：
 *   const result = await transformString("<p>hello</p>", (rw) => {
 *     rw.on("p", { element(el) { el.setInnerContent("world"); } });
 *   });
 */
export async function transformString(
  input: string,
  setup: (rewriter: HTMLRewriter) => void
): Promise<string> {
  const rw = new HTMLRewriter();
  setup(rw);
  return rw.transform(input);
}

/** 等待指定毫秒数（用于异步 handler 测试） */
export function wait(t: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, t));
}

/**
 * AVA 测试宏：批量测试 token 的 before/after/replace/remove 操作
 *
 * 用于 element、comment、text_chunk 等类型的变异测试。
 * 验证 HTML/纯文本两种模式下的行为。
 */
export const mutationsMacro: Macro<
  [
    (
      rw: HTMLRewriter,
      handler: (token: Element | TextChunk | Comment) => void
    ) => HTMLRewriter,
    string,
    {
      beforeAfter: string;
      replace: string;
      replaceHtml: string;
      remove: string;
    }
  ]
> = async (t, func, input, expected) => {
  // In all these tests, only process text chunks containing text. All test
  // inputs for text handlers will be single characters, so we'll only process
  // text nodes once.

  // before/after
  let res = await func(new HTMLRewriter(), (token) => {
    if ("text" in token && !token.text) return;
    token.before("<span>before</span>");
    token.before("<span>before html</span>", { html: true });
    token.after("<span>after</span>");
    token.after("<span>after html</span>", { html: true });
  }).transform(input);
  t.is(res, expected.beforeAfter);

  // replace
  res = await func(new HTMLRewriter(), (token) => {
    if ("text" in token && !token.text) return;
    token.replace("<span>replace</span>");
  }).transform(input);
  t.is(res, expected.replace);
  res = await func(new HTMLRewriter(), (token) => {
    if ("text" in token && !token.text) return;
    token.replace("<span>replace</span>", { html: true });
  }).transform(input);
  t.is(res, expected.replaceHtml);

  // remove
  res = await func(new HTMLRewriter(), (token) => {
    if ("text" in token && !token.text) return;
    t.false(token.removed);
    token.remove();
    t.true(token.removed);
  }).transform(input);
  t.is(res, expected.remove);
};
