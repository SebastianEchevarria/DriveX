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
//   FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

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

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const meta = session.metadata || {};

      if (session.mode === 'subscription') {
        const cantidad = parseInt(meta.cantidad || '1', 10);
        const hoy = new Date().toISOString().slice(0, 10);
        const lote = {
          cantidad: cantidad,
          precioUnitario: 299,
          fechaContratacion: hoy,
          stripeSubscriptionId: session.subscription,
          stripeCustomerId: session.customer,
          creadoTs: Date.now(),
        };

        // ── A) ALTA NUEVA DESDE LA WEB → crear empresa con código único ──
        if (meta.origen === 'drivx-alta') {
          // Si Stripe reenvía el mismo evento, no creamos otra empresa
          const yaHecho = await db.ref('altas_por_sesion/' + session.id).once('value');
          if (yaHecho.exists()) {
            res.status(200).json({ received: true, duplicado: true });
            return;
          }

          const codigo = await reservarCodigoUnico(db);
          await db.ref('empresas/' + codigo + '/empresa_info').set({
            codigo: codigo,
            tipo: meta.tipo || 'empresa',
            nombre: meta.nombre || '',
            nif: meta.nif || '',
            direccion: meta.direccion || '',
            cp: meta.cp || '',
            ciudad: meta.ciudad || '',
            email: meta.email || '',
            stripeCustomerId: session.customer,
            estado: 'activa',
            creadoTs: Date.now(),
          });
          await db.ref('empresas/' + codigo + '/suscripcion_lotes').push(lote);
          await db.ref('altas_por_sesion/' + session.id).set({
            codigo: codigo,
            nombre: meta.nombre || '',
            email: meta.email || '',
            ts: Date.now(),
          });

        // ── B) AMPLIACIÓN DESDE EL DASHBOARD ──
        } else if (meta.empresaId) {
          await db.ref('empresas/' + meta.empresaId + '/suscripcion_lotes').push(lote);
        } else {
          // Compatibilidad: Dashboard antiguo (antes de multi-empresa)
          await db.ref('suscripcion_lotes').push(lote);
        }
      }
    }

    if (event.type === 'invoice.paid') {
      // Renovación anual cobrada — preparado para el futuro.
    }
    if (event.type === 'invoice.payment_failed') {
      // Cobro fallido — preparado para el futuro (avisar al MASTER).
    }

    res.status(200).json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = handler;
// Necesitamos el cuerpo "en crudo" para comprobar la firma de Stripe
module.exports.config = { api: { bodyParser: false } };
