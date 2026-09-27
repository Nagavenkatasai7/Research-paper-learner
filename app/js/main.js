/* Paper Quest — boot and routing. */
"use strict";
(function (PQ) {
  const { el, esc, svc, store, pip } = PQ;
  const app = document.getElementById("app");
  let view;
  let route = { name: "library" };
  let rendering = Promise.resolve();

  PQ.go = function go(next) {
    route = next || { name: "library" };
    PQ.leaveStage();
    rendering = rendering.catch(() => {}).then(render);
    try {
      window.scrollTo({ top: 0 });
    } catch (e) {
      /* ignore */
    }
    return rendering;
  };

  async function render() {
    try {
      if (route.name === "paper") await PQ.quest.open(view, route.id, route.stage);
      else await PQ.library.render(view);
    } catch (err) {
      console.error(err);
      PQ.clear(view).appendChild(el(`<div class="wrap" style="padding-block:40px"></div>`)).appendChild(PQ.errorBox(err, () => PQ.go(route)));
    }
  }

  function banner() {
    let text = "";
    if (!svc.inViewer && svc.provider) text = `Pip is thinking with ${svc.provider.model} (free, via OpenRouter). Your library is saved in this browser only.`;
    else if (!svc.inViewer) text = "Pip's brain is offline here. Connect a free OpenRouter model under “Pip's brain” below, or open Paper Quest from claude.ai.";
    else if (!svc.sample) text = "This page can't reach Claude right now, so Pip can't think. Reload the page, and choose Allow if Claude asks.";
    else if (!store.synced) text = "Your library is saved in this browser only, so it won't follow you to another device.";
    if (!text) return null;
    return el(`<div class="banner" role="note"><div class="wrap"><span>${esc(text)}</span></div></div>`);
  }

  /** Redraw the top banner (the brain can be connected or disconnected at runtime). */
  PQ.refreshBanner = function refreshBanner() {
    const old = app.querySelector(".banner");
    const b = banner();
    if (old) old.remove();
    if (b) app.insertBefore(b, app.firstChild);
  };

  async function boot() {
    pip.mountDock();
    await PQ.connect();
    store.choose();
    PQ.clear(app);
    view = el(`<div id="view" style="flex:1;display:flex;flex-direction:column"></div>`);
    app.appendChild(view);
    PQ.refreshBanner();
    await PQ.go({ name: "library" });
  }

  boot().catch((err) => {
    console.error(err);
    PQ.clear(app).appendChild(PQ.errorBox(err, () => location.reload()));
  });
})(window.PQ);
