// api/alta-estado.js
//
// La web llama a esto después de que el cliente pague, para saber qué
// CÓDIGO DE EMPRESA se le ha asignado y enseñárselo en pantalla.
//   GET /api/alta-estado?session_id=cs_...
// Respuestas:
//   { estado:'listo', codigo:'DRX-7K3P9', nombre:'...', email:'...' }
//   { estado:'pendiente' }   → el webhook aún no ha terminado, reintentar
//   { estado:'no_pagado' }   → el pago no se completó

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
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sessionId = String((req.query && req.query.session_id) || '');
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
      res.status(400).json({ error: 'session_id inválido' });
      return;
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || session.payment_status !== 'paid') {
      res.status(200).json({ estado: 'no_pagado' });
      return;
    }

    const snap = await admin.database().ref('altas_por_sesion/' + sessionId).once('value');
    const d = snap.val();
    if (!d) {
      res.status(200).json({ estado: 'pendiente' });
      return;
    }
    res.status(200).json({ estado: 'listo', codigo: d.codigo, nombre: d.nombre, email: d.email, emailEnviado: d.emailEnviado === true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
