// DRIVX VTC — Service Worker para notificaciones push
// Se registra desde drivx-admin-dashboard.html. Debe servirse desde la
// raíz del dominio (mismo sitio que los archivos .html) para poder
// controlar toda la app.

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

// Llega un push del servidor → mostramos la notificación
self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    data = { title: 'DRIVX VTC', body: event.data ? event.data.text() : 'Tienes un aviso nuevo' };
  }

  var title = data.title || 'DRIVX VTC';
  var iconFinal = data.icon || '/icon-dashboard-180.png';
  var options = {
    body: data.body || '',
    icon: iconFinal,
    badge: data.badge || iconFinal,   // el mismo icono de la app, no uno fijo
    tag: data.tag || undefined,       // evita duplicar la misma notificación si se repite
    renotify: !!data.tag,
    data: { url: data.url || '/drivx-admin-dashboard.html' },
    vibrate: [120, 60, 120]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// El usuario toca la notificación → abrimos (o traemos al frente) la app
// concreta a la que pertenece ese aviso (Dashboard, Driver, Propietario o
// Supervisor), no siempre el Dashboard.
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || '/drivx-admin-dashboard.html';
  // Nombre del archivo sin la extensión .html, p.ej. "drivx-driver-app"
  var appName = targetUrl.split('/').pop().replace('.html', '');

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.indexOf(appName) !== -1 && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
