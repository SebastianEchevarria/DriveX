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
//   { accion: 'migrar_original', nombre, simular } → convierte la flota original
//        (datos en la raíz) en una empresa más. Con simular:true solo informa.
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

// ══════════════ MIGRACIÓN DE LA FLOTA ORIGINAL A EMPRESA ══════════════
// Copia (no mueve: la raíz queda como copia de seguridad) todos los datos de
// la flota original a empresas/{CODIGO}/, vincula a cada usuario con esa
// empresa, crea su cuenta de acceso segura con la contraseña que ya tenía y
// quita las contraseñas legibles de la copia nueva.
const NODOS_SISTEMA = ['empresas', 'directorio_usuarios', 'indice_invitaciones', 'altas_por_sesion', 'migracion_original'];
const ALFABETO_COD = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function emailKeyM(email) { return String(email || '').trim().toLowerCase().replace(/\./g, ',').replace(/[#$\[\]\/]/g, '_'); }
function passwordParaFirebase(pass) { pass = String(pass || ''); while (pass.length < 6) pass += '·'; return pass; }
async function nodosRaiz() {
  const tok = await admin.app().options.credential.getAccessToken();
  const url = String(process.env.FIREBASE_DATABASE_URL).replace(/\/$/, '') + '/.json?shallow=true&access_token=' + encodeURIComponent(tok.access_token);
  const d = await (await fetch(url)).json();
  return d && typeof d === 'object' ? Object.keys(d).filter((k) => !NODOS_SISTEMA.includes(k)) : [];
}
async function reservarCodigo(db) {
  for (let i = 0; i < 20; i++) {
    let c = 'DRX-'; for (let j = 0; j < 5; j++) c += ALFABETO_COD[Math.floor(Math.random() * ALFABETO_COD.length)];
    const r = await db.ref('empresas/' + c + '/empresa_info').transaction((a) => (a !== null ? undefined : { reservado: true }));
    if (r.committed) return c;
  }
  throw new Error('No se pudo generar un código');
}
async function migrarOriginal(db, nombre, simular, titular) {
  const ADMIN_TITULAR_ORIGINAL = { email: titular.email, nombre: titular.nombre || 'Administrador' };
  const previa = (await db.ref('migracion_original').once('value')).val();
  if (previa && previa.codigo) return { yaMigrada: true, codigo: previa.codigo, nombre: previa.nombre, ts: previa.ts };

  const nodos = await nodosRaiz();
  const datos = {};
  for (const k of nodos) datos[k] = (await db.ref(k).once('value')).val();

  // Personas y sus cuentas
  const personas = []; // { email, pass, app, ruta, activo, inviteCode }
  const add = (app, carpeta, campoActivo) => {
    const o = datos[carpeta] || {};
    Object.keys(o).forEach((id) => {
      const v = o[id]; if (!v || typeof v !== 'object') return;
      personas.push({ app, carpeta, id, email: String(v.email || '').toLowerCase(), pass: v.pass || '', activo: campoActivo ? !!v[campoActivo] : true, inviteCode: v.inviteCode || v.code || '' });
    });
  };
  add('dashboard', 'usuarios_dashboard', 'inviteUsado');
  add('supervisor', 'usuarios_supervisor', 'inviteUsado');
  add('propietario', 'propietarios', 'inviteUsado');
  add('driver', 'conductores_registro', null);
  const invitesDriver = datos.invites || {};

  const resumen = {
    nodos: nodos.map((k) => ({ nodo: k, elementos: datos[k] && typeof datos[k] === 'object' ? Object.keys(datos[k]).length : 1 })),
    usuariosActivos: personas.filter((p) => p.activo && p.email).length,
    invitacionesPendientes: personas.filter((p) => !p.activo && p.inviteCode).length + Object.keys(invitesDriver).filter((c) => invitesDriver[c] && !invitesDriver[c].usado).length,
    conflictos: [], cuentasCreadas: 0, cuentasExistentes: 0, sinContrasena: [],
  };

  // ¿Emails ya vinculados a OTRA empresa?
  const emails = Array.from(new Set(personas.filter((p) => p.activo && p.email).map((p) => p.email).concat([ADMIN_TITULAR_ORIGINAL.email])));
  for (const e of emails) {
    const d = (await db.ref('directorio_usuarios/' + emailKeyM(e)).once('value')).val();
    if (d && d.empresa) resumen.conflictos.push({ email: e, empresa: d.empresa });
  }
  let adminTieneCuenta = false;
  try { await admin.auth().getUserByEmail(ADMIN_TITULAR_ORIGINAL.email); adminTieneCuenta = true; } catch (e) {}
  resumen.adminTitular = ADMIN_TITULAR_ORIGINAL.email;
  resumen.adminTieneCuenta = adminTieneCuenta;
  const titularEnOtra = resumen.conflictos.find((c) => c.email === ADMIN_TITULAR_ORIGINAL.email);
  if (titularEnOtra) throw new Error('El email del administrador titular ya pertenece a otra empresa (' + titularEnOtra.empresa + '). Usa otro.');
  if (!adminTieneCuenta && String(titular.pass || '').length < 6) {
    if (simular) resumen.faltaContrasenaTitular = true;
    else throw new Error('Escribe una contraseña de al menos 6 caracteres para el administrador titular.');
  }

  if (simular) return { simulacion: true, resumen };

  // Cuenta segura del administrador titular (si aún no la tiene)
  if (!adminTieneCuenta) await admin.auth().createUser({ email: ADMIN_TITULAR_ORIGINAL.email, password: String(titular.pass) });

  // ── 1) Código y datos ──
  const codigo = await reservarCodigo(db);
  const base = 'empresas/' + codigo + '/';
  const copia = {};
  nodos.forEach((k) => { if (datos[k] !== null && datos[k] !== undefined) copia[k] = datos[k]; });
  // Sin contraseñas legibles en la copia nueva
  ['usuarios_dashboard', 'usuarios_supervisor', 'propietarios', 'conductores_registro'].forEach((c) => {
    const o = copia[c]; if (!o || typeof o !== 'object') return;
    Object.keys(o).forEach((id) => { if (o[id] && typeof o[id] === 'object') delete o[id].pass; });
  });
  // Administrador titular
  copia.usuarios_dashboard = copia.usuarios_dashboard || {};
  const yaEsta = Object.keys(copia.usuarios_dashboard).some((k) => String((copia.usuarios_dashboard[k] || {}).email || '').toLowerCase() === ADMIN_TITULAR_ORIGINAL.email);
  if (!yaEsta) copia.usuarios_dashboard['u_titular'] = { nombre: ADMIN_TITULAR_ORIGINAL.nombre, email: ADMIN_TITULAR_ORIGINAL.email, role: 'admin', inviteUsado: true, esTitular: true, ts: Date.now() };
  delete copia.empresa_info;
  await db.ref(base.slice(0, -1)).update(copia);
  await db.ref(base + 'empresa_info').set({
    codigo, tipo: 'empresa', nombre, nif: '', direccion: '', cp: '', ciudad: '', email: ADMIN_TITULAR_ORIGINAL.email,
    estado: 'activa', adminCreado: true, adminEmail: ADMIN_TITULAR_ORIGINAL.email, origen: 'migracion_flota_original', creadoTs: Date.now(),
  });

  // ── 2) Cuentas de acceso seguras (misma contraseña que ya usaban) ──
  for (const p of personas) {
    if (!p.activo || !p.email) continue;
    let existe = false;
    try { await admin.auth().getUserByEmail(p.email); existe = true; } catch (e) {}
    if (existe) { resumen.cuentasExistentes++; continue; }
    if (!p.pass) { resumen.sinContrasena.push(p.email); continue; }
    try { await admin.auth().createUser({ email: p.email, password: passwordParaFirebase(p.pass) }); resumen.cuentasCreadas++; }
    catch (e) { resumen.sinContrasena.push(p.email); }
  }

  // ── 3) Directorio (email → empresa) ──
  const conflictivos = new Set(resumen.conflictos.map((c) => c.email));
  for (const e of emails) {
    if (conflictivos.has(e)) continue;
    await db.ref('directorio_usuarios/' + emailKeyM(e)).set({ empresa: codigo, email: e, ts: Date.now(), origen: 'migracion' });
  }

  // ── 4) Invitaciones pendientes → índice ──
  for (const p of personas) {
    if (p.activo || !p.inviteCode) continue;
    await db.ref('indice_invitaciones/' + p.inviteCode).set({ empresa: codigo, app: p.app, ts: Date.now() });
  }
  for (const c of Object.keys(invitesDriver)) {
    if (invitesDriver[c] && !invitesDriver[c].usado) await db.ref('indice_invitaciones/' + c).set({ empresa: codigo, app: 'driver', ts: Date.now() });
  }

  await db.ref('migracion_original').set({ codigo, nombre, ts: Date.now() });
  return { hecho: true, codigo, resumen };
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
      original.migracion = (await db.ref('migracion_original').once('value')).val();
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

    if (accion === 'migrar_original') {
      const nombre = String((req.body && req.body.nombre) || '').trim().slice(0, 120);
      if (!nombre) { res.status(400).json({ error: 'Escribe el nombre de la empresa.' }); return; }
      const tEmail = String((req.body && req.body.titularEmail) || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(tEmail)) { res.status(400).json({ error: 'Escribe un email válido para el administrador titular.' }); return; }
      if (tEmail === MASTER_EMAIL) { res.status(400).json({ error: 'La cuenta master no puede ser administradora de una empresa. Usa otro email.' }); return; }
      const r = await migrarOriginal(db, nombre, !!(req.body && req.body.simular), {
        email: tEmail, pass: String((req.body && req.body.titularPass) || ''), nombre: String((req.body && req.body.titularNombre) || '').trim().slice(0, 80),
      });
      res.status(200).json(Object.assign({ ok: true }, r));
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
