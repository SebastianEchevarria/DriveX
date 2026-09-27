// api/create-checkout-session.js
//
// Crea una sesión de pago de Stripe (Checkout). Se usa desde DOS sitios:
//
//  1) WEB (drivx-landing.html) → ALTA de una empresa/particular NUEVO.
//     Recibe: { modo:'alta', tipo, nombre, nif, direccion, cp, ciudad, email, cantidad }
//     Al pagar, el webhook crea la empresa con su CÓDIGO ÚNICO.
//
//  2) DASHBOARD → AMPLIAR vehículos de una empresa que ya existe.
//     Recibe: { cantidad, email, empresaId? }
//
// Variables de entorno necesarias en Vercel:
//   STRIPE_SECRET_KEY, STRIPE_PRICE_ID, APP_URL

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

function limpiar(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 200);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  try {
    const body = req.body || {};
    const qty = parseInt(body.cantidad, 10);
    if (!qty || qty < 1 || qty > 500) {
      res.status(400).json({ error: 'Cantidad de vehículos inválida' });
      return;
    }
    if (!process.env.STRIPE_PRICE_ID) {
      res.status(500).json({ error: 'Falta configurar STRIPE_PRICE_ID en Vercel' });
      return;
    }

    const appUrl = process.env.APP_URL || 'https://drive-x-lilac-seven.vercel.app';

    // ─────────── 1) ALTA NUEVA DESDE LA WEB ───────────
    if (body.modo === 'alta') {
      const tipo      = body.tipo === 'particular' ? 'particular' : 'empresa';
      const nombre    = limpiar(body.nombre, 120);
      const nif       = limpiar(body.nif, 20).toUpperCase().replace(/[\s-]/g, '');
      const direccion = limpiar(body.direccion, 200);
      const cp        = limpiar(body.cp, 10);
      const ciudad    = limpiar(body.ciudad, 80);
      const email     = limpiar(body.email, 120).toLowerCase();

      if (!nombre || !nif || !direccion || !cp || !ciudad || !email) {
        res.status(400).json({ error: 'Faltan datos obligatorios' });
        return;
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        res.status(400).json({ error: 'El email no es válido' });
        return;
      }

      // Cliente de Stripe con sus datos → salen en las facturas de Stripe
      const customer = await stripe.customers.create({
        email: email,
        name: nombre,
        address: { line1: direccion, postal_code: cp, city: ciudad, country: 'ES' },
        metadata: { tipo: tipo, nif: nif },
      });

      const meta = {
        origen: 'drivx-alta',
        cantidad: String(qty),
        tipo: tipo,
        nombre: nombre,
        nif: nif,
        direccion: direccion,
        cp: cp,
        ciudad: ciudad,
        email: email,
      };

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customer.id,
        line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: qty }],
        success_url: appUrl + '/drivx-landing.html?alta=ok&session_id={CHECKOUT_SESSION_ID}',
        cancel_url: appUrl + '/drivx-landing.html?alta=cancelado#precios',
        metadata: meta,
        subscription_data: { metadata: meta },
      });

      res.status(200).json({ url: session.url });
      return;
    }

    // ─────────── 2) AMPLIAR DESDE EL DASHBOARD ───────────
    const email = limpiar(body.email, 120);
    const empresaId = limpiar(body.empresaId, 20);
    const meta = { cantidad: String(qty), origen: 'drivx-suscripcion' };
    if (empresaId) meta.empresaId = empresaId;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: qty }],
      customer_email: email || undefined,
      success_url: appUrl + '/drivx-admin-dashboard.html?susc=ok&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: appUrl + '/drivx-admin-dashboard.html?susc=cancelado',
      metadata: meta,
      subscription_data: { metadata: meta },
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
