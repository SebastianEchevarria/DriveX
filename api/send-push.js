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
//      (usa también FIREBASE_SERVICE_ACCOUNT y FIREBASE_DATABASE_URL, ya configuradas)
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
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@drivx.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

function emailKey(email) {
  return String(email || '').trim().toLowerCase().replace(/\./g, ',').replace(/[#$\[\]\/]/g, '_');
}

// SEGURIDAD: solo puede enviar avisos alguien con sesión DRIVX, y SOLO a
// los dispositivos de SU empresa (se deduce de su cuenta, no de lo que
// mande el navegador). La base de datos se lee con credenciales de
// servidor, así que funciona con las reglas de seguridad activadas.
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

    const h = String(req.headers.authorization || '');
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) { res.status(401).json({ error: 'Sin sesión' }); return; }
    let dec;
    try { dec = await admin.auth().verifyIdToken(token); }
    catch (e) { res.status(401).json({ error: 'Sesión caducada' }); return; }

    const db = admin.database();
    const dir = (await db.ref('directorio_usuarios/' + emailKey(dec.email)).once('value')).val();
    const empresa = dir && dir.empresa;
    if (!empresa) { res.status(403).json({ error: 'Tu cuenta no pertenece a ninguna empresa' }); return; }
    const base = 'empresas/' + empresa + '/';

    // Todas las suscripciones de ESTA empresa
    const subsData = (await db.ref(base + 'push_subscriptions').once('value')).val() || {};
    const entries = Object.keys(subsData).map((id) => ({ id, ...subsData[id] }));

    // Aviso de un vehículo concreto ({ matricula }): solo a SUS conductores y a SU propietario
    let porVehiculo = null;
    if (target && target.matricula) {
      const slug = (m) => String(m || '').replace(/\s/g, '_');
      const mat = slug(target.matricula);
      const [conds, props] = await Promise.all([
        db.ref(base + 'conductores_registro').once('value').then((x) => x.val() || {}),
        db.ref(base + 'propietarios').once('value').then((x) => x.val() || {}),
      ]);
      const cids = new Set(Object.keys(conds).filter((k) => conds[k] && slug(conds[k].matricula) === mat).map((k) => conds[k].cid || k));
      const pids = new Set(Object.keys(props).filter((k) => props[k] && (props[k].matriculas || []).some((x) => slug(x) === mat)));
      porVehiculo = (e) => (e.role === 'conductor' && (cids.has(e.cid) || slug(e.matricula) === mat)) || (e.role === 'propietario' && pids.has(e.pid));
    }

    // Filtro opcional por destinatario: { role: 'ccaa_manager', ccaa: 'Andalucía' } o { matricula }
    const destinatarios = entries.filter((e) => {
      if (!e || !e.subscription) return false;
      if (porVehiculo) return porVehiculo(e);
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

    let enviados = 0, caducados = 0, errores = 0;
    await Promise.all(
      destinatarios.map(async (d) => {
        try {
          // Cada uno abre SU app al tocar el aviso
          const urlApp = d.role === 'conductor' ? '/drivx-driver-app.html' : d.role === 'propietario' ? '/drivx-propietario-app.html' : d.role === 'supervisor' ? '/drivx-supervisor-app.html' : null;
          const cuerpo = (porVehiculo && urlApp) ? JSON.stringify(Object.assign(JSON.parse(payload), { url: urlApp })) : payload;
          await webpush.sendNotification(d.subscription, cuerpo);
          enviados++;
        } catch (err) {
          // 404/410 = el navegador ya no acepta este dispositivo: lo limpiamos
          if (err.statusCode === 404 || err.statusCode === 410) {
            caducados++;
            await db.ref(base + 'push_subscriptions/' + d.id).remove().catch(() => {});
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
