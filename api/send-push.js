// api/send-push.js
//
// Función serverless de Vercel que envía notificaciones push de verdad
// (Web Push estándar, con claves VAPID — no necesita Firebase Cloud
// Messaging). La llama el propio Dashboard cuando detecta un aviso nuevo
// mientras alguien lo tiene abierto.
//
// PASOS PARA PONERLO EN MARCHA (esto lo tienes que hacer tú, en tu
// proyecto de Vercel — yo no tengo acceso a ese repositorio):
//
// 1) En tu proyecto (donde ya está /api/ai.js), instala la librería:
//      npm install web-push
//
// 2) Sube este archivo tal cual a api/send-push.js
//
// 3) En Vercel → tu proyecto → Settings → Environment Variables, añade:
//      VAPID_PUBLIC_KEY  = BG_O2jr22zuUniJQMKqnj5rD3-dni53kh5OQaEpeeJ0v2DQtgElHACwV_oaNWAVOMrO-d8loghqX3A0rLDUjH2c
//      VAPID_PRIVATE_KEY = fs8oJ08MhBJDZDXUDJIlFBUWJ8sqfNRWZT5HgHJ2b-8
//      VAPID_SUBJECT     = mailto:tu-email@ejemplo.com   (un contacto de tu empresa)
//      FIREBASE_URL      = (la misma URL de tu Realtime Database que ya usan las apps)
//
//    ¡IMPORTANTE! La clave privada (VAPID_PRIVATE_KEY) es secreta — solo
//    debe vivir aquí, en el servidor. Nunca la pongas en los archivos
//    .html ni la subas a un repositorio público.
//
// 4) Vuelve a desplegar el proyecto para que Vercel recoja las nuevas
//    variables de entorno.
//
// A partir de ahí, el Dashboard ya sabe llamar a este endpoint solo.

const webpush = require('web-push');

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@drivx.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  try {
    const { title, body, url, tag, target } = req.body || {};
    if (!title || !body) {
      res.status(400).json({ error: 'Falta title o body' });
      return;
    }

    const FIREBASE_URL = process.env.FIREBASE_URL;
    if (!FIREBASE_URL) {
      res.status(500).json({ error: 'Falta la variable de entorno FIREBASE_URL' });
      return;
    }

    // Leemos todas las suscripciones guardadas por el Dashboard
    const subsResp = await fetch(FIREBASE_URL + '/push_subscriptions.json');
    const subsData = (await subsResp.json()) || {};

    const entries = Object.keys(subsData).map((id) => ({ id, ...subsData[id] }));

    // Filtro opcional por destinatario: { role: 'ccaa_manager', ccaa: 'Andalucía' }
    // Si no se manda target, se avisa a todos los suscritos.
    const destinatarios = entries.filter((e) => {
      if (!target) return true;
      if (target.role && e.role !== target.role && e.role !== 'admin') return false;
      if (target.ccaa && e.ccaaAsignada && e.ccaaAsignada !== target.ccaa) return false;
      return true;
    });

    const payload = JSON.stringify({
      title,
      body,
      url: url || '/drivx-admin-dashboard.html',
      tag: tag || undefined,
    });

    let enviados = 0;
    let caducados = 0;
    let errores = 0;

    await Promise.all(
      destinatarios.map(async (d) => {
        try {
          await webpush.sendNotification(d.subscription, payload);
          enviados++;
        } catch (err) {
          // 404/410 = el navegador ya no acepta este dispositivo (se
          // desinstaló, se revocó el permiso, etc.) — lo limpiamos.
          if (err.statusCode === 404 || err.statusCode === 410) {
            caducados++;
            await fetch(FIREBASE_URL + '/push_subscriptions/' + d.id + '.json', { method: 'DELETE' }).catch(() => {});
          } else {
            errores++;
          }
        }
      })
    );

    res.status(200).json({ ok: true, enviados, caducados, errores, totalDestinatarios: destinatarios.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
