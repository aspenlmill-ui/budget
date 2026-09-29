self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { notification: { title: "Family Budget", body: event.data && event.data.text() } }; }
  const n = d.notification || d;
  event.waitUntil(self.registration.showNotification(n.title || "Family Budget", {
    body: n.body || "", tag: n.tag, icon: "icon-192.png", badge: "icon-192.png", data: { url: n.navigate || "./" }
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.registration.scope)) return c.focus();
    return self.clients.openWindow(url);
  }));
});
