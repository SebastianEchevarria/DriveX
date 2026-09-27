// api/stripe-webhook.js
//
// Stripe llama a esta URL cada vez que pasa algo relevante (un pago se
// completa, una renovación anual se cobra, etc.). Es la ÚNICA fuente de
// verdad de "esto ya se ha cobrado de verdad" — el Dashboard nunca
// escribe la suscripción directamente en Firebase, siempre pasa por aquí.
//
// Variables de entorno necesarias en Vercel:
//   STRIPE_SECRET_KEY          = tu clave secreta de Stripe
//   STRIPE_WEBHOOK_SECRET      = el "signing secret" de este webhook (whsec_...),
//                                 lo da Stripe al crear el endpoint (paso final)
//   FIREBASE_SERVICE_ACCOUNT   = el JSON completo de la cuenta de servicio de
//                                 Firebase, pegado como una sola línea (texto)
//   FIREBASE_DATABASE_URL      = la misma URL de tu Realtime Database
//
// IMPORTANTE: esta función necesita leer el cuerpo de la petición "en
// crudo" (sin que Vercel lo convierta a JSON antes) para poder comprobar
// la firma de Stripe — por eso el "config" de abajo desactiva el bodyParser.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

module.exports.config = {
  api: { bodyParser: false },
};

function leerCuerpoCrudo(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Método no permitido');
    return;
  }

  let event;
  try {
    const rawBody = await leerCuerpoCrudo(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    res.status(400).send('Firma inválida: ' + err.message);
    return;
  }

  try {
    const db = admin.database();

    // 1) Se completó el pago de una suscripción nueva → creamos el lote
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.mode === 'subscription') {
        const cantidad = parseInt((session.metadata && session.metadata.cantidad) || '1', 10);
        const hoy = new Date().toISOString().slice(0, 10);
        await db.ref('suscripcion_lotes').push({
          cantidad: cantidad,
          precioUnitario: 299,
          fechaContratacion: hoy,
          stripeSubscriptionId: session.subscription,
          stripeCustomerId: session.customer,
          creadoTs: Date.now(),
        });
      }
    }

    // 2) Una renovación anual se cobró correctamente — no hace falta
    // escribir nada nuevo (el lote ya existe desde que se creó), esto es
    // solo para tener constancia si más adelante quieres mostrar un
    // historial de cobros reales.
    if (event.type === 'invoice.paid') {
      // De momento no hace falta acción — dejado preparado para el futuro.
    }

    // 3) Un cobro falló — aquí se podría avisar al MASTER por email/push
    // más adelante. De momento no hace falta acción.
    if (event.type === 'invoice.payment_failed') {
      // Dejado preparado para el futuro.
    }

    res.status(200).json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
