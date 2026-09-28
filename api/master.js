// api/master.js
//
// Funciones del PANEL MASTER (solo para el creador de DRIVX).
//
//   POST /api/master   (cabecera Authorization: Bearer <token de Firebase>)
//   { accion: 'verificar' }                 → confirma que eres MASTER (y te marca como superadmin)
//   { accion: 'listar' }                    → todas las empresas con sus datos y cifras
//   { accion: 'estado', empresa, estado }   → 'activa' | 'suspendida'
//   { accion: 'ajustes', empresa, ajustes } → guarda los ajustes de esa empresa
//        (qué apartados del menú del Dashboard ve). empresa 'ORIGINAL' = flota original.
//   { accion: 'usuarios', empresa }         → todas las personas de la empresa, por app
//
// SEGURIDAD: solo responde si el token es de la cuenta MASTER
// (MASTER_EMAIL, por defecto drivx.apps@gmail.com) Y ese email está
// VERIFICADO (solo quien controla ese buzón puede verificarlo). Así nadie
// puede hacerse pasar por MASTER creando una cuenta con ese email.
//
// Variables de entorno: FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL,
//   STRIPE_SECRET_KEY (para saber si Stripe está en modo prueba o real),
//   (opcional) MASTER_EMAIL

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

const MASTER_EMAIL = String(process.env.MASTER_EMAIL || 'drivx.apps@gmail.com').toLowerCase();
// Apartados del menú del Dashboard que se pueden activar/desactivar por empresa
const SECCIONES_MENU = ['inicio','flota','gastos','citas','propietarios','conductores','facturacion','estadisticas','informes','suscripcion','configuracion'];

async function comprobarMaster(req) {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return { error: 'Sin sesión', status: 401 };
  let dec;
  try { dec = await admin.auth().verifyIdToken(token); }
  catch (e) { return { error: 'Sesión caducada. Vuelve a entrar.', status: 401 }; }
  if (String(dec.email || '').toLowerCase() !== MASTER_EMAIL) return { error: 'Acceso denegado', status: 403 };
  if (!dec.email_verified) return { error: 'Tienes que verificar tu email antes de entrar (revisa tu bandeja de entrada).', status: 403, sinVerificar: true };
  return { uid: dec.uid, email: dec.email, superadmin: dec.superadmin === true };
}

// Lista de códigos de empresa sin descargar todos sus datos (consulta "shallow")
async function codigosEmpresas() {
  const tok = await admin.app().options.credential.getAccessToken();
  const url = String(process.env.FIREBASE_DATABASE_URL).replace(/\/$/, '') + '/empresas.json?shallow=true&access_token=' + encodeURIComponent(tok.access_token);
  const r = await fetch(url);
  const d = await r.json();
  return d && typeof d === 'object' ? Object.keys(d) : [];
}

async function contar(db, ruta) {
  const s = await db.ref(ruta).once('value');
  const v = s.val();
  return v && typeof v === 'object' ? v : {};
}

async function resumenDe(db, base) {
  const [info, lotes, vehExtra, conductores, dash, sup, props, ajustes] = await Promise.all([
    base ? db.ref(base + 'empresa_info').once('value').then((s) => s.val()) : Promise.resolve(null),
    contar(db, base + 'suscripcion_lotes'),
    contar(db, base + 'vehiculos_extra'),
    contar(db, base + 'conductores_registro'),
    contar(db, base + 'usuarios_dashboard'),
    contar(db, base + 'usuarios_supervisor'),
    contar(db, base + 'propietarios'),
    db.ref(base + 'ajustes_empresa').once('value').then((s) => s.val()),
  ]);
  const vehiculosContratados = Object.keys(lotes).reduce((s, k) => s + (Number(lotes[k] && lotes[k].cantidad) || 0), 0);
  const activos = (o) => Object.keys(o).filter((k) => o[k] && o[k].inviteUsado).length;
  let ultimaContratacion = 0;
  Object.keys(lotes).forEach((k) => { ultimaContratacion = Math.max(ultimaContratacion, Number(lotes[k] && lotes[k].creadoTs) || 0); });
  return {
    info: info || {},
    vehiculosContratados,
    vehiculosEnFlota: Object.keys(vehExtra).length,
    conductores: Object.keys(conductores).length,
    usuariosDashboard: activos(dash),
    supervisores: activos(sup),
    propietarios: activos(props),
    ultimaContratacion,
    ajustes: ajustes || {},
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }
  try {
    const m = await comprobarMaster(req);
    if (m.error) { res.status(m.status).json({ error: m.error, sinVerificar: !!m.sinVerificar }); return; }
    const { accion } = req.body || {};
    const db = admin.database();

    if (accion === 'verificar') {
      // Marca permanente de superadministrador en el servidor (la usarán
      // también las reglas de seguridad de Firebase).
      if (!m.superadmin) await admin.auth().setCustomUserClaims(m.uid, { superadmin: true });
      res.status(200).json({ ok: true, email: m.email, recienMarcado: !m.superadmin });
      return;
    }

    if (accion === 'listar') {
      const codigos = await codigosEmpresas();
      const empresas = await Promise.all(codigos.map(async (codigo) => {
        const r = await resumenDe(db, 'empresas/' + codigo + '/');
        return Object.assign({ codigo }, r);
      }));
      // La flota original (datos en la raíz, sin empresa todavía)
      const original = await resumenDe(db, '');
      const modoPrueba = String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test');
      res.status(200).json({ ok: true, empresas, original, modoPrueba, precio: 299 });
      return;
    }

    if (accion === 'estado') {
      const empresa = String((req.body && req.body.empresa) || '');
      const estado = String((req.body && req.body.estado) || '');
      if (!/^DRX-[A-Z0-9]{5}$/.test(empresa)) { res.status(400).json({ error: 'Empresa inválida' }); return; }
      if (!['activa', 'suspendida'].includes(estado)) { res.status(400).json({ error: 'Estado inválido' }); return; }
      const ref = db.ref('empresas/' + empresa + '/empresa_info');
      if (!(await ref.once('value')).exists()) { res.status(404).json({ error: 'No existe esa empresa' }); return; }
      await ref.update({ estado, estadoCambiadoTs: Date.now(), estadoCambiadoPor: 'MASTER' });
      res.status(200).json({ ok: true, empresa, estado });
      return;
    }

    if (accion === 'usuarios') {
      const empresa = String((req.body && req.body.empresa) || '');
      if (empresa !== 'ORIGINAL' && !/^DRX-[A-Z0-9]{5}$/.test(empresa)) { res.status(400).json({ error: 'Empresa inválida' }); return; }
      const base = empresa === 'ORIGINAL' ? '' : 'empresas/' + empresa + '/';
      const [dash, sup, props, cond] = await Promise.all([
        contar(db, base + 'usuarios_dashboard'),
        contar(db, base + 'usuarios_supervisor'),
        contar(db, base + 'propietarios'),
        contar(db, base + 'conductores_registro'),
      ]);
      const lista = (o, fn) => Object.keys(o).filter((k) => o[k]).map((k) => fn(k, o[k]));
      res.status(200).json({
        ok: true,
        dashboard: lista(dash, (k, v) => ({ id: k, nombre: v.nombre || '', email: v.email || '', rol: v.role || '', activo: !!v.inviteUsado })),
        supervisor: lista(sup, (k, v) => ({ id: k, nombre: v.nombre || '', email: v.email || '', detalle: Array.isArray(v.ccaa) ? v.ccaa.join(', ') : '', activo: !!v.inviteUsado })),
        propietario: lista(props, (k, v) => ({ id: k, nombre: v.nombre || '', email: v.email || '', detalle: (v.matriculas || []).join(', '), activo: !!v.inviteUsado })),
        driver: lista(cond, (k, v) => ({ id: k, nombre: v.nombre || '', email: v.email || '', detalle: [v.matricula, v.turno ? 'turno ' + v.turno : ''].filter(Boolean).join(' · '), activo: true })),
      });
      return;
    }

    if (accion === 'ajustes') {
      const empresa = String((req.body && req.body.empresa) || '');
      if (empresa !== 'ORIGINAL' && !/^DRX-[A-Z0-9]{5}$/.test(empresa)) { res.status(400).json({ error: 'Empresa inválida' }); return; }
      const entrada = (req.body && req.body.ajustes) || {};
      const menu = {};
      SECCIONES_MENU.forEach((k) => { menu[k] = !(entrada.menu && entrada.menu[k] === false); });
      if (!SECCIONES_MENU.some((k) => menu[k])) { res.status(400).json({ error: 'Deja al menos un apartado activo.' }); return; }
      const base = empresa === 'ORIGINAL' ? '' : 'empresas/' + empresa + '/';
      if (empresa !== 'ORIGINAL' && !(await db.ref(base + 'empresa_info').once('value')).exists()) { res.status(404).json({ error: 'No existe esa empresa' }); return; }
      const guardar = { menu, actualizadoTs: Date.now() };
      await db.ref(base + 'ajustes_empresa').set(guardar);
      res.status(200).json({ ok: true, empresa, ajustes: guardar });
      return;
    }

    res.status(400).json({ error: 'Acción inválida' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
