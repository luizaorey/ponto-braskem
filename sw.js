/* =====================================================================
   Service Worker — Ponto Braskem
   - Cache-first dos assets (app abre offline)
   - NUNCA cacheia chamadas aos webhooks do n8n
   - Background Sync: esvazia a fila offline (IndexedDB: ponto_db / fila_pontos)
   ===================================================================== */
const CACHE = "ponto-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// Mesma config do index.html — endpoint de registro (nunca cachear).
const WEBHOOK_BASE = "https://giantfalcon-n8n.cloudfy.live/webhook";
const EP_REGISTRAR = WEBHOOK_BASE + "/ponto-registrar";

/* ---------- install / activate ---------- */
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ---------- fetch: cache-first p/ assets, network p/ webhooks ---------- */
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Chamadas aos webhooks do n8n: sempre rede, nunca cache.
  if (url.href.startsWith(WEBHOOK_BASE)) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Só tratamos GET de assets do próprio app.
  if (e.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Cache-first, com atualização em segundo plano; fallback ao index quando offline.
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const rede = fetch(e.request)
        .then((resp) => {
          if (resp && resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => hit || caches.match("./index.html"));
      return hit || rede;
    })
  );
});

/* ---------- Background Sync: esvazia a fila offline ---------- */
self.addEventListener("sync", (e) => {
  if (e.tag === "sync-pontos") {
    e.waitUntil(sincronizarFila());
  }
});

/* IndexedDB (mesmo schema do index.html) */
const DB_NAME = "ponto_db", DB_VER = 1, STORE = "fila_pontos";
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "local_id" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function filaAll() {
  return idb().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const rq = tx.objectStore(STORE).getAll();
    rq.onsuccess = () => res(rq.result || []);
    rq.onerror = () => rej(rq.error);
  }));
}
function filaDel(local_id) {
  return idb().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(local_id);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  }));
}

// FIFO: envia os registros pendentes na ordem em que foram criados.
async function sincronizarFila() {
  const itens = (await filaAll()).sort((a, b) => (a.registrado_em < b.registrado_em ? -1 : 1));
  for (const it of itens) {
    try {
      const r = await fetch(EP_REGISTRAR, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(it),
      });
      if (r.ok) {
        await filaDel(it.local_id);
      } else {
        break; // erro do servidor: tenta na próxima rodada de sync
      }
    } catch (e) {
      break; // sem rede: para e o Sync tenta de novo depois
    }
  }
  // avisa páginas abertas para atualizarem o contador de pendentes
  const clients = await self.clients.matchAll();
  clients.forEach((c) => c.postMessage({ type: "fila-sincronizada" }));
}
