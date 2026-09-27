// api/create-checkout-session.js
//
// Crea una sesión de pago de Stripe (Checkout) para contratar N vehículos
// nuevos en la suscripción de DRIVX. El Dashboard llama a esto cuando el
// MASTER confirma "Aceptar" en el aviso de añadir vehículos, y redirige
// al navegador a la URL que devuelve.
//
// Variables de entorno necesarias en Vercel:
//   STRIPE_SECRET_KEY   = tu clave secreta de Stripe (sk_test_... o sk_live_...)
//   STRIPE_PRICE_ID     = el ID del precio del producto "Vehículo DRIVX" (price_...)
//   APP_URL             = la URL de tu Dashboard, ej. https://drive-x-lilac-seven.vercel.app

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  try {
    const { cantidad, email } = req.body || {};
    const qty = parseInt(cantidad, 10);
    if (!qty || qty < 1) {
      res.status(400).json({ error: 'Cantidad inválida' });
      return;
    }
    if (!process.env.STRIPE_PRICE_ID) {
      res.status(500).json({ error: 'Falta configurar STRIPE_PRICE_ID en Vercel' });
      return;
    }

    const appUrl = process.env.APP_URL || 'https://drive-x-lilac-seven.vercel.app';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: qty }],
      customer_email: email || undefined,
      success_url: appUrl + '/drivx-admin-dashboard.html?susc=ok&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: appUrl + '/drivx-admin-dashboard.html?susc=cancelado',
      metadata: { cantidad: String(qty), origen: 'drivx-suscripcion' },
      subscription_data: {
        metadata: { cantidad: String(qty), origen: 'drivx-suscripcion' },
      },
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
