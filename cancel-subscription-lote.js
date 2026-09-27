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
    const { loteId, cantidadAQuitar, empresaId } = req.body || {};
    if (!loteId || !cantidadAQuitar) {
      res.status(400).json({ error: 'Faltan datos' });
      return;
    }

    const db = admin.database();
    // Multi-empresa: cada empresa tiene sus lotes en empresas/{CODIGO}/
    const empresa = String(empresaId || '').trim();
    if (empresa && !/^DRX-[A-Z0-9]{5}$/.test(empresa)) {
      res.status(400).json({ error: 'Empresa inválida' });
      return;
    }
    const base = empresa ? ('empresas/' + empresa + '/') : '';
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
