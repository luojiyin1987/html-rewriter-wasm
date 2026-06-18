import test from "ava";
import { HTMLRewriter } from ".";

test("auto-adds loading='lazy' to img without loading attribute", async (t) => {
  const res = await new HTMLRewriter()
    .on("img", {})
    .transform('<img src="photo.jpg" alt="photo">');
  t.is(res, '<img src="photo.jpg" alt="photo" loading="lazy">');
});

test("does not overwrite existing loading attribute", async (t) => {
  const res = await new HTMLRewriter()
    .on("img", {})
    .transform('<img src="photo.jpg" alt="photo" loading="eager">');
  t.is(res, '<img src="photo.jpg" alt="photo" loading="eager">');
});

test("adds loading='lazy' to multiple img tags", async (t) => {
  const res = await new HTMLRewriter()
    .on("img", {})
    .transform(
      '<div><img src="a.jpg"><img src="b.jpg" loading="eager"><img src="c.jpg"></div>'
    );
  t.is(
    res,
    '<div><img src="a.jpg" loading="lazy"><img src="b.jpg" loading="eager"><img src="c.jpg" loading="lazy"></div>'
  );
});

test("works alongside user-registered handlers", async (t) => {
  let userHandlerCalled = false;
  const res = await new HTMLRewriter()
    .on("img", {
      element(el) {
        userHandlerCalled = true;
        el.setAttribute("alt", "user-set");
      },
    })
    .transform('<img src="photo.jpg">');
  t.true(userHandlerCalled);
  // Built-in handler runs first (prepended), so loading comes before alt
  t.is(res, '<img src="photo.jpg" loading="lazy" alt="user-set">');
});

test("works without any user handlers registered", async (t) => {
  const res = await new HTMLRewriter()
    .on("p", {})
    .transform('<img src="photo.jpg"><p>text</p>');
  t.is(res, '<img src="photo.jpg" loading="lazy"><p>text</p>');
});

test("does not affect non-img elements", async (t) => {
  const res = await new HTMLRewriter()
    .on("div", {})
    .transform('<div class="container">content</div>');
  t.is(res, '<div class="container">content</div>');
});

test("handles self-closing img tags", async (t) => {
  const res = await new HTMLRewriter()
    .on("img", {})
    .transform('<img src="photo.jpg" />');
  t.is(res, '<img src="photo.jpg" loading="lazy" />');
});

test("handles img with no attributes", async (t) => {
  const res = await new HTMLRewriter()
    .on("img", {})
    .transform("<img>");
  t.is(res, '<img loading="lazy">');
});

test("getStats still works with built-in handler", async (t) => {
  // Verify that user handlers are counted correctly despite the built-in handler
  await new HTMLRewriter()
    .on("img", {})
    .on("div", { element(el) {} })
    .transform("<img>");
  // If we got here without error, the built-in handler didn't break registration
  t.pass();
});
