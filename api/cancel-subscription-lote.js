// api/cancel-subscription-lote.js
//
// Cancela (o reduce la cantidad de) un lote de vehículos contratados,
// directamente en Stripe. El Dashboard llama a esto cuando el MASTER
// confirma "Aceptar" al querer BAJAR la cantidad de vehículos. Solo
// cuando Stripe confirma que se ha hecho, se borra/actualiza el lote en
// Firebase — igual que con las altas, nunca se toca Firebase a ciegas.
//
// Variables de entorno necesarias (las mismas que las otras funciones):
//   STRIPE_SECRET_KEY, FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  try {
    const { loteId } = req.body || {};
    const cantidadAQuitar = parseInt((req.body || {}).cantidadAQuitar, 10);
    if (!loteId || !cantidadAQuitar || cantidadAQuitar < 1) {
      res.status(400).json({ error: 'Faltan datos' });
      return;
    }

    // SEGURIDAD: solo un administrador (MASTER) de la empresa, con su
    // sesión DRIVX. La empresa se deduce de su cuenta, no del navegador.
    const h = String(req.headers.authorization || '');
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) { res.status(401).json({ error: 'Sin sesión. Vuelve a entrar.' }); return; }
    let dec;
    try { dec = await admin.auth().verifyIdToken(token); }
    catch (e) { res.status(401).json({ error: 'Sesión caducada. Vuelve a entrar.' }); return; }
    const db = admin.database();
    const key = String(dec.email || '').trim().toLowerCase().replace(/\./g, ',').replace(/[#$\[\]\/]/g, '_');
    const dir = (await db.ref('directorio_usuarios/' + key).once('value')).val();
    const empresa = dir && dir.empresa;
    if (!empresa) { res.status(403).json({ error: 'Tu cuenta no pertenece a ninguna empresa.' }); return; }
    const usuarios = (await db.ref('empresas/' + empresa + '/usuarios_dashboard').once('value')).val() || {};
    const esAdmin = Object.keys(usuarios).some((k) => usuarios[k] && String(usuarios[k].email || '').toLowerCase() === String(dec.email || '').toLowerCase() && usuarios[k].role === 'admin');
    if (!esAdmin) { res.status(403).json({ error: 'Solo el administrador MASTER puede quitar vehículos.' }); return; }
    const base = 'empresas/' + empresa + '/';
    const loteRef = db.ref(base + 'suscripcion_lotes/' + loteId);
    const snap = await loteRef.once('value');
    const lote = snap.val();
    if (!lote) {
      res.status(404).json({ error: 'No se encontró ese lote' });
      return;
    }

    const restante = lote.cantidad - cantidadAQuitar;

    if (restante <= 0) {
      // Se cancela la suscripción entera en Stripe, y se borra el lote
      if (lote.stripeSubscriptionId) {
        await stripe.subscriptions.cancel(lote.stripeSubscriptionId);
      }
      await loteRef.remove();
    } else {
      // Se reduce la cantidad en Stripe (Stripe calcula el prorrateo solo),
      // y se actualiza el lote
      if (lote.stripeSubscriptionId) {
        const sub = await stripe.subscriptions.retrieve(lote.stripeSubscriptionId);
        const itemId = sub.items.data[0].id;
        await stripe.subscriptions.update(lote.stripeSubscriptionId, {
          items: [{ id: itemId, quantity: restante }],
        });
      }
      await loteRef.update({ cantidad: restante });
    }

    res.status(200).json({ ok: true, restante: Math.max(0, restante) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
