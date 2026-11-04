/*
 * 启动守卫（boot guard）。
 *
 * 为什么需要它：main.tsx 里的 ErrorBoundary 只能接住「React 已经起来之后」的
 * 渲染异常。如果故障发生在**模块加载阶段**（资源 404、顶层抛错、语法错误），
 * React 压根没执行，ErrorBoundary 不会触发，用户看到的就是一整片白 —— 且
 * 打包后的 .app 里拿不到 console，等于完全没有线索。
 *
 * 这个脚本在业务 bundle 之前同步执行，把三类启动故障直接画到页面上：
 *   1. 资源加载失败（script / link 的 error 事件，需要捕获阶段）
 *   2. 顶层 JS 异常 / 未处理的 Promise 拒绝
 *   3. 模块跑完后 #root 仍为空（语法错误这类不触发 error 事件，只能靠兜底探测）
 *
 * 只在启动失败时显示，正常路径上零开销、零可见性。确定不需要了可以删掉
 * index.html 里那一行引用。
 */
(function () {
  var shown = false;

  function render(kind, detail) {
    if (shown) return;
    shown = true;
    try {
      var box = document.createElement("pre");
      box.id = "__boot_error__";
      box.style.cssText = [
        "position:fixed",
        "inset:0",
        "z-index:2147483647",
        "margin:0",
        "padding:24px",
        "overflow:auto",
        "background:#fff",
        "color:#c00",
        "font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace",
        "white-space:pre-wrap",
        "word-break:break-all",
      ].join(";");
      box.textContent =
        "启动失败 [" +
        kind +
        "]\n\n" +
        detail +
        "\n\n--- 环境 ---\nUA: " +
        navigator.userAgent +
        "\nURL: " +
        location.href;
      document.body.appendChild(box);
      document.title = "启动失败：" + kind;
    } catch (e) {
      /* 连报错都写不出来就只能认了 */
    }
  }

  window.addEventListener(
    "error",
    function (e) {
      // 资源加载失败走这里：target 是 script/link 元素而不是 window
      var t = e && e.target;
      if (t && t !== window && t.tagName) {
        render("资源加载失败", t.tagName + "\n" + (t.src || t.href || "(无地址)"));
        return;
      }
      render(
        "JS 异常",
        String((e && e.message) || "(无消息)") +
          "\n" +
          ((e && e.error && e.error.stack) || "") +
          "\n@ " +
          String((e && e.filename) || "?") +
          ":" +
          String((e && e.lineno) || "?") +
          ":" +
          String((e && e.colno) || "?")
      );
    },
    true
  );

  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    render("未处理的 Promise 拒绝", (r && (r.stack || r.message)) || String(r));
  });

  window.addEventListener("DOMContentLoaded", function () {
    // 给模块脚本留出执行时间再判空。语法错误不会触发 error 事件，
    // 但一定会表现成「root 里什么都没有」，这是唯一能抓到它的地方。
    setTimeout(function () {
      var root = document.getElementById("root");
      if (!root || root.childElementCount === 0) {
        render(
          "页面空白",
          "#root 在模块脚本执行后仍为空。\n常见原因：资源路径 404、bundle 语法错误、模块顶层抛错（未触发 error 事件）。"
        );
      }
    }, 2500);
  });
})();
