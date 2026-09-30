// api/create-checkout-session.js
//
// Crea una sesión de pago de Stripe (Checkout). Se usa desde DOS sitios:
//
//  1) WEB (drivx-landing.html) → ALTA de una empresa/particular NUEVO.
//     Recibe: { modo:'alta', tipo, nombre, nif, direccion, cp, ciudad, email, cantidad }
//     Al pagar, el webhook crea la empresa con su CÓDIGO ÚNICO.
//
//     Con metodo:'transferencia' → en lugar de pagar con tarjeta se crea la
//     suscripción con FACTURA a pagar por TRANSFERENCIA (Stripe da a cada cliente
//     un IBAN propio y detecta solo cuándo llega el dinero; entonces el webhook
//     crea la empresa y le envía su código).
//
//  2) DASHBOARD → AMPLIAR vehículos de una empresa que ya existe.
//     Recibe: { cantidad, email, empresaId? }
//
// PRECIO: 299 € + IVA (21 %) por vehículo y año. El IVA se añade en cada cobro.
//
// Variables de entorno necesarias en Vercel:
//   STRIPE_SECRET_KEY, STRIPE_PRICE_ID, APP_URL
//   (opcional) STRIPE_TAX_RATE_ID = tasa de IVA ya creada en Stripe; si no, se crea sola
//   Para la transferencia: FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL, SMTP_USER, SMTP_PASS

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

const PRECIO_BASE = 299;
// País del IBAN para las transferencias. Stripe da IBAN de: DE, FR, IE o NL (todavía
// no de España). Es una transferencia SEPA normal: al cliente le cuesta lo mismo que
// una nacional. Se puede cambiar con la variable STRIPE_TRANSFER_COUNTRY.
// País del IBAN que Stripe da a cada cliente para transferir. Stripe solo los
// emite de DE, FR, IE o NL (no de España); para el cliente es igual: una
// transferencia SEPA desde España cuesta y tarda lo mismo. Por defecto, IE.
const PAIS_IBAN = ['DE', 'FR', 'IE', 'NL'].includes(String(process.env.STRIPE_TRANSFER_COUNTRY || '').toUpperCase())
  ? String(process.env.STRIPE_TRANSFER_COUNTRY).toUpperCase() : 'IE';
const IVA_PCT = 21;

// Tasa de IVA 21 % (sin incluir en el precio): se busca en Stripe y, si no existe, se crea
let _tasaIva = null;
async function tasaIva() {
  if (process.env.STRIPE_TAX_RATE_ID) return process.env.STRIPE_TAX_RATE_ID;
  if (_tasaIva) return _tasaIva;
  const lista = await stripe.taxRates.list({ active: true, limit: 100 });
  const t = lista.data.find((x) => x.percentage === IVA_PCT && x.inclusive === false && /iva/i.test(x.display_name || ''));
  if (t) { _tasaIva = t.id; return t.id; }
  const nueva = await stripe.taxRates.create({ display_name: 'IVA', percentage: IVA_PCT, inclusive: false, country: 'ES', jurisdiction: 'ES', description: 'IVA 21 % España' });
  _tasaIva = nueva.id;
  return nueva.id;
}
function euros(n) { return (Math.round(n * 100) / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }

function limpiar(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 200);
}

// ══ CÓDIGOS DE DESCUENTO (los crea la cuenta master) ══
// codigos_descuento/{CÓDIGO} = { tipo:'precio'|'porcentaje', valor, precioUnitario, nota,
//   creadoTs, venceTs (24 h), usado, usadoPor, usadoTs, reservadoHasta }
// Un solo uso: se marca como usado cuando se completa el pago (webhook). Mientras
// alguien está pagando, queda reservado 1 hora para que no se use dos veces a la vez.
function normCodigoDescuento(c) { return String(c || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20); }
async function comprobarDescuento(codigoCrudo) {
  const codigo = normCodigoDescuento(codigoCrudo);
  if (!codigo) return { ok: false, error: 'Escribe el código.' };
  const d = (await admin.database().ref('codigos_descuento/' + codigo).once('value')).val();
  if (!d) return { ok: false, error: 'Ese código no existe.' };
  if (d.usado) return { ok: false, error: 'Ese código ya se ha utilizado.' };
  if (Date.now() > (d.venceTs || 0)) return { ok: false, error: 'Ese código ha caducado.' };
  if (d.reservadoHasta && Date.now() < d.reservadoHasta) return { ok: false, error: 'Ese código se está usando en otro pago ahora mismo. Inténtalo en unos minutos.' };
  const precio = Math.round(Number(d.precioUnitario) * 100) / 100;
  if (!(precio > 0) || precio > PRECIO_BASE) return { ok: false, error: 'Ese código no es válido.' };
  return { ok: true, codigo, precioUnitario: precio, tipo: d.tipo, valor: d.valor };
}
// Precio anual por vehículo distinto del normal (mismo producto de Stripe)
let _productoStripe = null;
async function precioEspecial(importe) {
  if (!_productoStripe) {
    const p = await stripe.prices.retrieve(process.env.STRIPE_PRICE_ID);
    _productoStripe = typeof p.product === 'string' ? p.product : p.product.id;
  }
  return { currency: 'eur', product: _productoStripe, unit_amount: Math.round(importe * 100), recurring: { interval: 'year' } };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  try {
    const body = req.body || {};
    if (body.accion === 'validar_descuento') {
      const r = await comprobarDescuento(body.codigo);
      res.status(200).json(r.ok ? { ok: true, codigo: r.codigo, precioUnitario: r.precioUnitario, tipo: r.tipo, valor: r.valor } : { ok: false, error: r.error });
      return;
    }
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

      // Código de descuento (opcional)
      let desc = null;
      if (body.descuento) {
        desc = await comprobarDescuento(body.descuento);
        if (!desc.ok) { res.status(400).json({ error: desc.error }); return; }
        await admin.database().ref('codigos_descuento/' + desc.codigo).update({ reservadoHasta: Date.now() + 3600000 });
      }
      const lineaPrecio = desc ? { price_data: await precioEspecial(desc.precioUnitario) } : { price: process.env.STRIPE_PRICE_ID };

      const meta = {
        origen: 'drivx-alta',
        descuento: desc ? desc.codigo : '',
        precioUnitario: String(desc ? desc.precioUnitario : PRECIO_BASE),
        cantidad: String(qty),
        tipo: tipo,
        nombre: nombre,
        nif: nif,
        direccion: direccion,
        cp: cp,
        ciudad: ciudad,
        email: email,
      };

      const iva = await tasaIva();

      // ── Pago por TRANSFERENCIA BANCARIA ──
      if (body.metodo === 'transferencia') {
        const sub = await stripe.subscriptions.create({
          customer: customer.id,
          items: [Object.assign({}, lineaPrecio, { quantity: qty, tax_rates: [iva] })],
          collection_method: 'send_invoice',
          days_until_due: 10,
          payment_settings: {
            payment_method_types: ['customer_balance'],
            payment_method_options: { customer_balance: { funding_type: 'bank_transfer', bank_transfer: { type: 'eu_bank_transfer', eu_bank_transfer: { country: PAIS_IBAN } } } },
          },
          metadata: meta,
        });
        const invId = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : (sub.latest_invoice && sub.latest_invoice.id);
        let factura = await stripe.invoices.retrieve(invId);
        if (factura.status === 'draft') factura = await stripe.invoices.finalizeInvoice(invId);
        try { await stripe.invoices.sendInvoice(invId); } catch (e) { /* en modo prueba Stripe no envía emails */ }
        // IBAN propio de este cliente (cualquier transferencia a él se asigna sola)
        const fi = await stripe.customers.createFundingInstructions(customer.id, {
          currency: 'eur', funding_type: 'bank_transfer',
          bank_transfer: { type: 'eu_bank_transfer', eu_bank_transfer: { country: PAIS_IBAN } },
        });
        const addr = ((fi.bank_transfer || {}).financial_addresses || []).find((a) => a.iban) || {};
        const ib = addr.iban || {};
        const datos = {
          iban: ib.iban || '', bic: ib.bic || '', titular: ib.account_holder_name || '',
          importe: factura.amount_due / 100, concepto: factura.number || '', factura: factura.hosted_invoice_url || '',
          base: qty * (desc ? desc.precioUnitario : PRECIO_BASE), cantidad: qty,
        };
        await admin.database().ref('altas_pendientes/' + sub.id).set({
          nombre, email, nif, tipo, cantidad: qty, importe: datos.importe, concepto: datos.concepto,
          factura: datos.factura, iban: datos.iban, customer: customer.id, ts: Date.now(),
        });
        // Email con los datos de la transferencia
        try {
          if (process.env.SMTP_USER && process.env.SMTP_PASS) {
            const port = parseInt(process.env.SMTP_PORT || '465', 10);
            const t = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
            const fila = (a, b) => `<tr><td style="padding:8px 0;color:#9ab0c8;font-size:13px">${a}</td><td style="padding:8px 0;font-weight:700;font-family:'Courier New',monospace;font-size:15px;text-align:right">${b}</td></tr>`;
            await t.sendMail({
              from: process.env.EMAIL_FROM || ('DRIVX <' + process.env.SMTP_USER + '>'), to: email,
              subject: 'DRIVX · Datos para tu transferencia (' + euros(datos.importe) + ')',
              text: `Hola ${nombre},\n\nPara activar DRIVX haz una transferencia con estos datos:\nIBAN: ${datos.iban}\nBIC: ${datos.bic}\nTitular: ${datos.titular}\nImporte: ${euros(datos.importe)}\nConcepto: ${datos.concepto}\n\nEn cuanto recibamos el pago te enviaremos tu código de acceso.\nFactura: ${datos.factura}\n`,
              html: `<div style="background:#070b12;padding:32px 16px;font-family:Arial,sans-serif"><div style="max-width:560px;margin:0 auto;background:#0c1420;border:2px solid #00d4ff;border-radius:18px;padding:30px 26px;color:#fff">
                <div style="font-size:28px;font-weight:900;margin-bottom:22px">DRIV<span style="color:#00d4ff">X</span></div>
                <h1 style="font-size:20px;margin:0 0 12px">Datos para tu transferencia</h1>
                <p style="font-size:15px;line-height:1.6;margin:0 0 18px">Hola ${nombre}, para activar DRIVX (${qty} vehículo${qty !== 1 ? 's' : ''}) haz una transferencia con estos datos:</p>
                <table style="width:100%;border-collapse:collapse;margin-bottom:18px">${fila('IBAN', datos.iban)}${fila('BIC', datos.bic)}${fila('Titular', datos.titular)}${fila('Importe', euros(datos.importe))}${fila('Concepto', datos.concepto)}</table>
                <p style="font-size:13px;color:#9ab0c8;margin:0 0 18px">${qty} × ${desc ? desc.precioUnitario : PRECIO_BASE} € + IVA (${IVA_PCT} %). Este IBAN es exclusivo para ti: cualquier transferencia a él se asigna automáticamente a tu cuenta. Es una transferencia SEPA normal: se hace desde cualquier banco español y cuesta lo mismo que una nacional.</p>
                <div style="background:#0a2a1c;border:1.5px solid #00e676;border-radius:12px;padding:12px 14px;font-size:14px;line-height:1.5;margin:0 0 20px">✅ En cuanto recibamos el pago (normalmente 1–2 días hábiles) te enviaremos por email tu <b>código de acceso</b> y el enlace a tu Dashboard.</div>
                ${datos.factura ? `<div style="text-align:center"><a href="${datos.factura}" style="display:inline-block;background:#00d4ff;color:#02131d;text-decoration:none;font-weight:900;padding:13px 28px;border-radius:12px">Ver factura</a></div>` : ''}
              </div></div>`,
            });
          }
        } catch (e) { /* si falla el email, los datos se ven igualmente en pantalla */ }
        res.status(200).json({ transferencia: true, datos });
        return;
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customer.id,
        line_items: [Object.assign({}, lineaPrecio, { quantity: qty, tax_rates: [iva] })],
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

    const iva = await tasaIva();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: qty, tax_rates: [iva] }],
      customer_email: email || undefined,
      success_url: appUrl + '/drivx-admin-dashboard.html?susc=ok&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: appUrl + '/drivx-admin-dashboard.html?susc=cancelado',
      metadata: meta,
      subscription_data: { metadata: meta },
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    // El detalle técnico queda en los registros de Vercel; al cliente, un mensaje claro
    console.error('create-checkout-session:', err && err.message);
    res.status(500).json({ error: 'No se pudo preparar el pago. Inténtalo de nuevo en unos minutos o escríbenos a drivx.apps@gmail.com.' });
  }
};
