/*
 * Seletor de cidade (botão flutuante). Mostra a cidade detectada do lead;
 * ao clicar, a pessoa digita outra cidade — o servidor busca, registra e
 * o app recarrega em /<slug>. A escolha fica salva no navegador.
 */
(function () {
  var c = window.__CIDADE;
  if (!c) return;

  var style = document.createElement("style");
  style.textContent =
    "#cw-cidade{position:fixed;left:12px;bottom:12px;z-index:9998;display:flex;align-items:center;gap:6px;" +
    "padding:8px 12px;border-radius:999px;background:var(--primary,#000);color:var(--primary-contrast,#fff);" +
    "font:500 13px Rubik,system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25);cursor:pointer;border:0}" +
    "#cw-cidade svg{width:14px;height:14px;fill:currentColor}#cw-cidade[disabled]{opacity:.6}";
  document.head.appendChild(style);

  var btn = document.createElement("button");
  btn.id = "cw-cidade";
  btn.type = "button";
  btn.title = "Trocar cidade";
  btn.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>' +
    "<span>" + c.nome + " - " + c.uf + "</span>" +
    '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>';

  btn.addEventListener("click", async function () {
    var texto = prompt("Qual é a sua cidade? (ex.: Uberlândia - MG)", c.nome + " - " + c.uf);
    if (!texto || !texto.trim()) return;
    btn.disabled = true;
    try {
      var r = await fetch("/api/cidade?busca=" + encodeURIComponent(texto.trim()));
      var d = await r.json();
      if (!r.ok) { alert(d.message || "Cidade não encontrada"); return; }
      try { localStorage.setItem("cidade_escolhida", d.slug); } catch (e) {}
      if (d.slug !== c.slug) location.href = "/" + d.slug;
    } catch (e) {
      alert("Não foi possível buscar a cidade agora.");
    } finally {
      btn.disabled = false;
    }
  });
  document.body.appendChild(btn);
})();
