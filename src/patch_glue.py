#!/usr/bin/env python3
"""Patch wasm-bindgen glue code for html-rewriter-wasm.

Transformations:
1. Import setWasmExports and wrap from asyncify.js
2. Make mutation methods return this (for chaining)
3. Make write/end async using wrap()
4. Fix attributes getter to return iterator
5. Fix onEndTag to bind this
"""

import re
import sys


def patch(content: str) -> str:
    # 1. Add setWasmExports and wrap to asyncify import
    content = content.replace(
        'const { awaitPromise } = require(String.raw`./asyncify.js`);',
        'const { awaitPromise, setWasmExports, wrap } = require(String.raw`./asyncify.js`);',
    )

    # 2. Make mutation methods return this.
    #    Strategy: find each wasm.METHOD call inside a try block,
    #    then find the closing } of the finally block and the } of the method,
    #    and insert "return this;" between them.
    mutation_methods = [
        "comment_after", "comment_before", "comment_replace", "comment_remove",
        "documentend_append",
        "element_after", "element_before", "element_replace", "element_remove",
        "element_setAttribute", "element_removeAttribute",
        "element_prepend", "element_append",
        "element_setInnerContent", "element_removeAndKeepContent",
        "endtag_after", "endtag_before", "endtag_remove",
        "textchunk_after", "textchunk_before", "textchunk_replace", "textchunk_remove",
        "htmlrewriter_on", "htmlrewriter_onDocument",
    ]

    for method in mutation_methods:
        # Find the wasm.METHOD call line
        call_pattern = rf'            wasm\.{method}\(retptr,'
        call_match = re.search(call_pattern, content)
        if not call_match:
            continue

        # From the call, find the finally { ... } } pattern
        # Look for the finally block after this position
        pos = call_match.start()
        # Find "} finally {" after the call
        finally_pattern = r'        } finally {\n            wasm\.__wbindgen_add_to_stack_pointer\(16\);\n        }\n    }'
        finally_match = re.search(finally_pattern, content[pos:])
        if not finally_match:
            continue

        # The full match ends with "\n    }" which is the method close
        old_end = content[pos + finally_match.start():pos + finally_match.end()]
        if "return this;" in old_end:
            continue

        # Replace the method close with return this + method close
        new_end = old_end[:-4] + "        return this;\n    }"  # Remove last "    }" and replace
        content = content[:pos + finally_match.start()] + new_end + content[pos + finally_match.end():]

    # 3. Make write() async with wrap()
    content = content.replace(
        """    write(chunk) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.htmlrewriter_write(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }""",
        """    async write(chunk) {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        await wrap(this, wasm.htmlrewriter_write, retptr, this.__wbg_ptr, ptr0, len0);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        wasm.__wbindgen_add_to_stack_pointer(16);
        if (r1) {
            throw takeObject(r0);
        }
        return this;
    }""",
    )

    # Make end() async with wrap()
    content = content.replace(
        """    end() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.htmlrewriter_end(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }""",
        """    async end() {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        await wrap(this, wasm.htmlrewriter_end, retptr, this.__wbg_ptr);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        wasm.__wbindgen_add_to_stack_pointer(16);
        if (r1) {
            throw takeObject(r0);
        }
    }""",
    )

    # 4. Fix attributes getter to return iterator
    content = content.replace(
        """            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {Function} handler
    */
    onEndTag""",
        """            return takeObject(r0)[Symbol.iterator]();
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @param {Function} handler
    */
    onEndTag""",
    )

    # 5. Fix onEndTag to bind this
    content = content.replace(
        "wasm.element_onEndTag(retptr, this.__wbg_ptr, addHeapObject(handler));",
        "wasm.element_onEndTag(retptr, this.__wbg_ptr, addHeapObject(handler.bind(this)));",
    )

    # 6. Add setWasmExports(wasm) after wasm is initialized
    content = content.replace(
        "wasm = wasmInstance.exports;\nmodule.exports.__wasm = wasm;",
        "wasm = wasmInstance.exports;\nsetWasmExports(wasm);\nmodule.exports.__wasm = wasm;",
    )

    # 7. Fix Promise detection for cross-realm compatibility
    content = content.replace(
        """        result = getObject(arg0) instanceof Promise;
    } catch (_) {
        result = false;
    }""",
        """        var obj = getObject(arg0);
        result = (obj instanceof Promise) || (Object.prototype.toString.call(obj) === '[object Promise]');
    } catch (_) {
        result = false;
    }""",
    )

    return content


if __name__ == "__main__":
    path = sys.argv[1]
    with open(path, "r") as f:
        content = f.read()
    content = patch(content)
    with open(path, "w") as f:
        f.write(content)
    print(f"Patched {path}")
