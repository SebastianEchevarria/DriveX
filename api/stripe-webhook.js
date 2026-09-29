// api/stripe-webhook.js
//
// Stripe llama a esta URL cada vez que pasa algo relevante. Es la ÚNICA
// fuente de verdad de "esto ya se ha cobrado de verdad".
//
// ── MULTI-EMPRESA ──
// Cada empresa vive en su propia carpeta de Firebase:
//     empresas/{CODIGO}/empresa_info        → nombre, NIF, dirección, email…
//     empresas/{CODIGO}/suscripcion_lotes   → vehículos contratados
//     empresas/{CODIGO}/...                 → (fase 2) el resto de sus datos
// Y además:
//     altas_por_sesion/{sessionId}          → qué código se creó en cada pago
//                                             (la web lo usa para enseñárselo)
//
// Variables de entorno necesarias en Vercel:
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//   FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL, APP_URL
//   SMTP_USER   = la cuenta de correo desde la que se envía (ej. drivx.app@gmail.com)
//   SMTP_PASS   = la "contraseña de aplicación" de esa cuenta (16 letras)
//   (opcionales) SMTP_HOST (por defecto smtp.gmail.com), SMTP_PORT (465),
//                EMAIL_FROM (por defecto "DRIVX <SMTP_USER>")

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

function leerCuerpoCrudo(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Código tipo DRX-7K3P9 (sin letras que se confundan: sin O, 0, I, 1, L)
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generarCodigo() {
  let c = '';
  for (let i = 0; i < 5; i++) c += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
  return 'DRX-' + c;
}

async function reservarCodigoUnico(db) {
  for (let intento = 0; intento < 20; intento++) {
    const codigo = generarCodigo();
    const r = await db.ref('empresas/' + codigo + '/empresa_info').transaction((actual) => {
      if (actual !== null) return; // ya existe → abortar
      return { reservado: true };
    });
    if (r.committed) return codigo;
  }
  throw new Error('No se pudo generar un código único');
}

// ══════════════ EMAIL DE BIENVENIDA ══════════════
function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function enviarEmailBienvenida({ email, nombre, codigo, cantidad }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('Faltan SMTP_USER / SMTP_PASS en Vercel');
  }
  const appUrl = process.env.APP_URL || 'https://drive-x-lilac-seven.vercel.app';
  const enlace = appUrl + '/drivx-admin-dashboard.html?empresa=' + encodeURIComponent(codigo);
  const port = parseInt(process.env.SMTP_PORT || '465', 10);

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const total = (cantidad * 299).toLocaleString('es-ES') + ' € + IVA';
  const html = `
<div style="background:#070b12;padding:32px 16px;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#0c1420;border:2px solid #00d4ff;border-radius:18px;padding:32px 28px;color:#ffffff">
    <div style="font-size:28px;font-weight:900;letter-spacing:1px;margin-bottom:4px">DRIV<span style="color:#00d4ff">X</span></div>
    <div style="font-size:11px;letter-spacing:3px;color:#9ab0c8;margin-bottom:28px">VTC FLEET</div>

    <h1 style="font-size:22px;margin:0 0 12px">¡Bienvenido a DRIVX, ${esc(nombre)}!</h1>
    <p style="font-size:15px;line-height:1.6;margin:0 0 20px">Tu suscripción se ha activado correctamente: <b>${cantidad} vehículo${cantidad !== 1 ? 's' : ''}</b> · <b>${total} al año</b>.</p>

    <p style="font-size:15px;margin:0 0 8px">Este es el <b>código único</b> de tu empresa:</p>
    <div style="font-family:'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:4px;text-align:center;padding:18px;border:2px solid #00e676;border-radius:14px;background:#0a2a1c;color:#ffffff;margin:0 0 20px">${esc(codigo)}</div>

    <div style="background:#2a2208;border:1.5px solid #ffb300;border-radius:12px;padding:14px 16px;font-size:14px;line-height:1.5;margin:0 0 26px">
      ⚠️ <b>Guarda este email.</b> Necesitarás el código para crear tu cuenta de administrador. Todas tus apps (Driver, Supervisor y Propietario) quedarán vinculadas únicamente a este código. No lo compartas con nadie ajeno a tu empresa.
    </div>

    <p style="font-size:15px;margin:0 0 14px"><b>Primer paso:</b> abre tu Dashboard y crea tu cuenta de administrador.</p>
    <div style="text-align:center;margin:0 0 14px">
      <a href="${enlace}" style="display:inline-block;background:#00d4ff;color:#02131d;text-decoration:none;font-weight:900;font-size:16px;padding:15px 34px;border-radius:12px">Abrir mi Dashboard →</a>
    </div>
    <p style="font-size:12px;color:#9ab0c8;text-align:center;margin:0 0 26px;word-break:break-all">Si el botón no funciona, copia este enlace:<br>${enlace}</p>

    <p style="font-size:14px;line-height:1.6;margin:0 0 6px"><b>¿Cómo instalarlo como app?</b></p>
    <p style="font-size:13.5px;line-height:1.6;color:#dfe8f3;margin:0 0 24px">
      En el ordenador (Chrome): pulsa el icono de instalar que aparece a la derecha de la barra de direcciones.<br>
      En Android (Chrome): menú ⋮ → <i>Añadir a pantalla de inicio</i>.<br>
      En iPhone (Safari): botón Compartir → <i>Añadir a pantalla de inicio</i>.
    </p>

    <p style="font-size:12px;color:#9ab0c8;border-top:1px solid #243347;padding-top:16px;margin:0">Recibes este email porque has contratado DRIVX. Las facturas de cada cobro te llegarán por separado.</p>
  </div>
</div>`;

  const texto =
    `¡Bienvenido a DRIVX, ${nombre}!\n\n` +
    `Tu suscripción está activa: ${cantidad} vehículo(s) · ${total} al año.\n\n` +
    `CÓDIGO ÚNICO DE TU EMPRESA: ${codigo}\n\n` +
    `Guarda este email. Necesitarás el código para crear tu cuenta de administrador.\n\n` +
    `Abre tu Dashboard aquí:\n${enlace}\n`;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || ('DRIVX <' + process.env.SMTP_USER + '>'),
    to: email,
    subject: 'Bienvenido a DRIVX · Tu código de empresa: ' + codigo,
    text: texto,
    html: html,
  });
}

async function handler(req, res) {
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

    const hoy = new Date().toISOString().slice(0, 10);

    // ══ Crea la empresa de un alta pagada (tarjeta o transferencia) ══
    // clave = id de la sesión (tarjeta) o de la suscripción (transferencia):
    // si Stripe repite el aviso, no se crea otra empresa.
    async function crearEmpresaDeAlta(clave, meta, customer, subscriptionId) {
      const yaHecho = await db.ref('altas_por_sesion/' + clave).once('value');
      if (yaHecho.exists()) return null;
      const cantidad = parseInt(meta.cantidad || '1', 10);
      const codigo = await reservarCodigoUnico(db);
      await db.ref('empresas/' + codigo + '/empresa_info').set({
        codigo, tipo: meta.tipo || 'empresa', nombre: meta.nombre || '', nif: meta.nif || '',
        direccion: meta.direccion || '', cp: meta.cp || '', ciudad: meta.ciudad || '', email: meta.email || '',
        stripeCustomerId: customer, estado: 'activa', creadoTs: Date.now(),
      });
      await db.ref('empresas/' + codigo + '/suscripcion_lotes').push({
        cantidad, precioUnitario: 299, iva: 21, fechaContratacion: hoy,
        stripeSubscriptionId: subscriptionId, stripeCustomerId: customer, creadoTs: Date.now(),
      });
      await db.ref('suscripciones_stripe/' + subscriptionId).set({ empresa: codigo, origen: 'alta' });
      await db.ref('altas_por_sesion/' + clave).set({ codigo, nombre: meta.nombre || '', email: meta.email || '', ts: Date.now() });
      await db.ref('altas_pendientes/' + subscriptionId).remove();
      // Email de bienvenida (si falla, la empresa ya está creada y queda anotado)
      try {
        await enviarEmailBienvenida({ email: meta.email, nombre: meta.nombre || '', codigo, cantidad });
        await db.ref('altas_por_sesion/' + clave).update({ emailEnviado: true });
      } catch (e) {
        await db.ref('altas_por_sesion/' + clave).update({ emailEnviado: false, emailError: String(e.message || e) });
      }
      return codigo;
    }
    function subDeFactura(inv) {
      return inv.subscription || (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription) || null;
    }

    // ── Pago con tarjeta completado (alta o ampliación) ──
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const meta = session.metadata || {};
      if (session.mode === 'subscription') {
        if (meta.origen === 'drivx-alta') {
          await crearEmpresaDeAlta(session.id, meta, session.customer, session.subscription);
        } else {
          const lote = {
            cantidad: parseInt(meta.cantidad || '1', 10), precioUnitario: 299, iva: 21, fechaContratacion: hoy,
            stripeSubscriptionId: session.subscription, stripeCustomerId: session.customer, creadoTs: Date.now(),
          };
          if (meta.empresaId) {
            await db.ref('empresas/' + meta.empresaId + '/suscripcion_lotes').push(lote);
            await db.ref('suscripciones_stripe/' + session.subscription).set({ empresa: meta.empresaId, origen: 'ampliacion' });
          } else {
            await db.ref('suscripcion_lotes').push(lote); // Dashboard antiguo (antes de multi-empresa)
          }
        }
      }
    }

    // ── Factura pagada: si es el primer pago de un alta POR TRANSFERENCIA, se crea la empresa ──
    if (event.type === 'invoice.paid') {
      const inv = event.data.object;
      const subId = subDeFactura(inv);
      if (subId && inv.billing_reason === 'subscription_create') {
        const sub = await stripe.subscriptions.retrieve(subId);
        const meta = sub.metadata || {};
        if (meta.origen === 'drivx-alta' && sub.collection_method === 'send_invoice') {
          await crearEmpresaDeAlta(subId, meta, sub.customer, subId);
        }
      }
      // Renovación pagada: se quita cualquier aviso de pago pendiente
      if (subId && inv.billing_reason === 'subscription_cycle') {
        const idx = (await db.ref('suscripciones_stripe/' + subId).once('value')).val();
        if (idx && idx.empresa) await db.ref('empresas/' + idx.empresa + '/empresa_info').update({ pagoPendiente: null });
      }
    }

    // ── Cobro fallido: se anota para que lo veas en el panel master ──
    if (event.type === 'invoice.payment_failed') {
      const subId = subDeFactura(event.data.object);
      const idx = subId ? (await db.ref('suscripciones_stripe/' + subId).once('value')).val() : null;
      if (idx && idx.empresa) await db.ref('empresas/' + idx.empresa + '/empresa_info').update({ pagoPendiente: Date.now() });
    }

    // ── Suscripción cancelada (por impago o a petición) ──
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const idx = (await db.ref('suscripciones_stripe/' + sub.id).once('value')).val();
      if (idx && idx.empresa) {
        // Los vehículos de esa suscripción dejan de contar
        const lotes = (await db.ref('empresas/' + idx.empresa + '/suscripcion_lotes').once('value')).val() || {};
        const upd = {};
        Object.keys(lotes).forEach((k) => { if (lotes[k] && lotes[k].stripeSubscriptionId === sub.id) upd['empresas/' + idx.empresa + '/suscripcion_lotes/' + k] = null; });
        // Si era la suscripción del alta, la empresa se suspende (sus datos se conservan)
        if (idx.origen === 'alta') {
          upd['empresas/' + idx.empresa + '/empresa_info/estado'] = 'suspendida';
          upd['empresas/' + idx.empresa + '/empresa_info/motivoSuspension'] = 'Suscripción cancelada en Stripe';
          upd['empresas/' + idx.empresa + '/empresa_info/estadoCambiadoTs'] = Date.now();
        }
        if (Object.keys(upd).length) await db.ref().update(upd);
      }
      // Alta por transferencia que nunca se pagó y Stripe la anuló
      await db.ref('altas_pendientes/' + sub.id).remove();
    }

    res.status(200).json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = handler;
// Necesitamos el cuerpo "en crudo" para comprobar la firma de Stripe
module.exports.config = { api: { bodyParser: false } };
