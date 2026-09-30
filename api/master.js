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
//   { accion: 'crear_gratuita', tipo, nombre, nif?, email, ciudad?, vehiculos, venceTs?, notas?, menu? }
//        → crea una empresa SIN suscripción (cuenta de cortesía) y envía su código por email
//   { accion: 'editar_gratuita', empresa, vehiculos, venceTs, notas }
//   { accion: 'crear_descuento', tipo:'precio'|'porcentaje', valor, nota? } → código de un solo uso, 24 h
//   { accion: 'borrar_descuento', codigo }
//   { accion: 'ocultar', empresa, ocultar:true|false } → ocultar/mostrar en el listado master
//   { accion: 'eliminar_empresa', empresa, confirmacion:<CÓDIGO> } → borra TODO de una empresa
//        suspendida: sus datos, las cuentas de sus usuarios, sus invitaciones y sus
//        suscripciones de Stripe (se cancelan para que no se le cobre más)
//   { accion: 'borrar_copia_original', confirmacion:'BORRAR' } → borra la copia de
//        seguridad de la flota original (solo si ya se migró a empresa)
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
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

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
  const vehiculosGratis = Object.keys(lotes).reduce((s, k) => s + ((lotes[k] && lotes[k].gratuito) ? (Number(lotes[k].cantidad) || 0) : 0), 0);
  // Lo que paga al año (sin IVA), con el precio de cada lote (normal o pactado)
  const importeAnual = Object.keys(lotes).reduce((s, k) => {
    const l = lotes[k]; if (!l || l.gratuito) return s;
    const pu = l.precioUnitario != null ? Number(l.precioUnitario) : 299;
    return s + (Number(l.cantidad) || 0) * pu;
  }, 0);
  const precioPactado = Object.keys(lotes).some((k) => lotes[k] && !lotes[k].gratuito && lotes[k].precioUnitario != null && Number(lotes[k].precioUnitario) !== 299);
  const activos = (o) => Object.keys(o).filter((k) => o[k] && o[k].inviteUsado).length;
  let ultimaContratacion = 0;
  Object.keys(lotes).forEach((k) => { ultimaContratacion = Math.max(ultimaContratacion, Number(lotes[k] && lotes[k].creadoTs) || 0); });
  return {
    info: info || {},
    vehiculosContratados,
    vehiculosGratis,
    vehiculosPago: vehiculosContratados - vehiculosGratis,
    importeAnual: Math.round(importeAnual * 100) / 100,
    precioPactado,
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
const NODOS_SISTEMA = ['empresas', 'directorio_usuarios', 'indice_invitaciones', 'altas_por_sesion', 'migracion_original', 'empresas_eliminadas', 'altas_pendientes', 'suscripciones_stripe', 'codigos_descuento'];
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

// Email de bienvenida para cuentas gratuitas (de cortesía)
async function emailCortesia({ email, nombre, codigo, vehiculos, venceTs }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) throw new Error('Faltan SMTP_USER / SMTP_PASS');
  const appUrl = process.env.APP_URL || 'https://drive-x-lilac-seven.vercel.app';
  const enlace = appUrl + '/drivx-admin-dashboard.html?empresa=' + encodeURIComponent(codigo);
  const hasta = venceTs ? new Date(venceTs).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  await t.sendMail({
    from: process.env.EMAIL_FROM || ('DRIVX <' + process.env.SMTP_USER + '>'), to: email,
    subject: 'Bienvenido a DRIVX · Tu código de empresa: ' + codigo,
    text: `¡Bienvenido a DRIVX, ${nombre}!\n\nTe hemos activado una cuenta de cortesía con ${vehiculos} vehículo(s)${hasta ? ' hasta el ' + hasta : ''}.\n\nCÓDIGO DE TU EMPRESA: ${codigo}\n\nCrea tu cuenta de administrador aquí:\n${enlace}\n`,
    html: `<div style="background:#070b12;padding:32px 16px;font-family:Arial,sans-serif"><div style="max-width:560px;margin:0 auto;background:#0c1420;border:2px solid #00d4ff;border-radius:18px;padding:30px 26px;color:#fff">
      <div style="font-size:28px;font-weight:900;margin-bottom:22px">DRIV<span style="color:#00d4ff">X</span></div>
      <h1 style="font-size:21px;margin:0 0 12px">¡Bienvenido a DRIVX, ${esc(nombre)}!</h1>
      <p style="font-size:15px;line-height:1.6;margin:0 0 18px">Te hemos activado una <b>cuenta de cortesía</b> con <b>${vehiculos} vehículo${vehiculos !== 1 ? 's' : ''}</b>${hasta ? ' hasta el <b>' + hasta + '</b>' : ''}. No tienes que pagar nada.</p>
      <p style="font-size:15px;margin:0 0 8px">El <b>código único</b> de tu empresa:</p>
      <div style="font-family:'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:4px;text-align:center;padding:18px;border:2px solid #00e676;border-radius:14px;background:#0a2a1c;margin:0 0 20px">${esc(codigo)}</div>
      <p style="font-size:15px;margin:0 0 14px"><b>Primer paso:</b> abre tu Dashboard y crea tu cuenta de administrador con este mismo email.</p>
      <div style="text-align:center;margin:0 0 14px"><a href="${enlace}" style="display:inline-block;background:#00d4ff;color:#02131d;text-decoration:none;font-weight:900;font-size:16px;padding:15px 34px;border-radius:12px">Abrir mi Dashboard →</a></div>
      <p style="font-size:12px;color:#9ab0c8;text-align:center;margin:0;word-break:break-all">${enlace}</p>
    </div></div>`,
  });
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
        // Cuenta gratuita cuyo periodo ya terminó → se suspende (sus datos se conservan)
        if (r.info && r.info.gratuita && r.info.venceTs && Date.now() > r.info.venceTs && (r.info.estado || 'activa') === 'activa') {
          const cambios = { estado: 'suspendida', motivoSuspension: 'Periodo gratuito terminado', estadoCambiadoTs: Date.now() };
          await db.ref('empresas/' + codigo + '/empresa_info').update(cambios);
          Object.assign(r.info, cambios);
        }
        return Object.assign({ codigo }, r);
      }));
      // La flota original (datos en la raíz, sin empresa todavía)
      const original = await resumenDe(db, '');
      original.migracion = (await db.ref('migracion_original').once('value')).val();
      // Altas por transferencia esperando el pago
      const pend = (await db.ref('altas_pendientes').once('value')).val() || {};
      const pendientes = Object.keys(pend).map((k) => Object.assign({ suscripcion: k }, pend[k])).sort((a, b) => (b.ts || 0) - (a.ts || 0));
      // Índice suscripción → empresa (para cancelaciones e impagos), por si falta en empresas antiguas
      const idx = (await db.ref('suscripciones_stripe').once('value')).val() || {};
      const upIdx = {};
      for (const codigo of codigos) {
        const lotes = (await db.ref('empresas/' + codigo + '/suscripcion_lotes').once('value')).val() || {};
        const orden = Object.keys(lotes).map((k) => lotes[k]).filter((l) => l && l.stripeSubscriptionId).sort((a, b) => (a.creadoTs || 0) - (b.creadoTs || 0));
        orden.forEach((l, i) => { if (!idx[l.stripeSubscriptionId]) upIdx['suscripciones_stripe/' + l.stripeSubscriptionId] = { empresa: codigo, origen: i === 0 ? 'alta' : 'ampliacion' }; });
      }
      if (Object.keys(upIdx).length) await db.ref().update(upIdx);
      const modoPrueba = String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test');
      const descRaw = (await db.ref('codigos_descuento').once('value')).val() || {};
      const descuentos = Object.keys(descRaw).map((k) => Object.assign({ codigo: k }, descRaw[k]))
        .filter((d) => Date.now() - (d.creadoTs || 0) < 30 * 86400000)   // últimos 30 días
        .sort((a, b) => (b.creadoTs || 0) - (a.creadoTs || 0));
      res.status(200).json({ ok: true, empresas, original, pendientes, descuentos, modoPrueba, precio: 299, iva: 21 });
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

    if (accion === 'crear_gratuita' || accion === 'editar_gratuita') {
      const b = req.body || {};
      const vehiculos = parseInt(b.vehiculos, 10);
      if (!vehiculos || vehiculos < 1 || vehiculos > 500) { res.status(400).json({ error: 'Indica cuántos vehículos incluye (1 a 500).' }); return; }
      const venceTs = b.venceTs ? Number(b.venceTs) : null;
      if (venceTs !== null && (!venceTs || venceTs < Date.now() - 86400000)) { res.status(400).json({ error: 'La fecha de fin no es válida.' }); return; }
      const notas = String(b.notas || '').trim().slice(0, 500);

      if (accion === 'editar_gratuita') {
        const empresa = String(b.empresa || '');
        if (!/^DRX-[A-Z0-9]{5}$/.test(empresa)) { res.status(400).json({ error: 'Empresa inválida' }); return; }
        const infoRef = db.ref('empresas/' + empresa + '/empresa_info');
        const info = (await infoRef.once('value')).val();
        if (!info) { res.status(404).json({ error: 'No existe esa empresa' }); return; }
        const lotes = (await db.ref('empresas/' + empresa + '/suscripcion_lotes').once('value')).val() || {};
        const idGratis = Object.keys(lotes).find((k) => lotes[k] && lotes[k].gratuito);
        const lote = { cantidad: vehiculos, precioUnitario: 0, gratuito: true, fechaContratacion: (idGratis && lotes[idGratis].fechaContratacion) || new Date().toISOString().slice(0, 10), creadoTs: (idGratis && lotes[idGratis].creadoTs) || Date.now() };
        if (idGratis) await db.ref('empresas/' + empresa + '/suscripcion_lotes/' + idGratis).set(lote);
        else await db.ref('empresas/' + empresa + '/suscripcion_lotes').push(lote);
        const cambios = { gratuita: true, venceTs: venceTs, notasMaster: notas || null };
        // Si estaba suspendida por fin del periodo gratuito y se amplía la fecha, se reactiva
        if (info.estado === 'suspendida' && info.motivoSuspension === 'Periodo gratuito terminado' && (!venceTs || venceTs > Date.now())) {
          cambios.estado = 'activa'; cambios.motivoSuspension = null; cambios.estadoCambiadoTs = Date.now();
        }
        await infoRef.update(cambios);
        res.status(200).json({ ok: true, empresa });
        return;
      }

      // ── Crear ──
      const tipo = b.tipo === 'particular' ? 'particular' : 'empresa';
      const nombre = String(b.nombre || '').trim().slice(0, 120);
      const email = String(b.email || '').trim().toLowerCase();
      if (!nombre) { res.status(400).json({ error: 'Escribe el nombre.' }); return; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { res.status(400).json({ error: 'El email del administrador no es válido.' }); return; }
      if (email === MASTER_EMAIL) { res.status(400).json({ error: 'La cuenta master no puede ser administradora de una empresa.' }); return; }
      const dir = (await db.ref('directorio_usuarios/' + emailKeyM(email)).once('value')).val();
      if (dir && dir.empresa) { res.status(409).json({ error: 'Ese email ya pertenece a otra empresa DRIVX (' + dir.empresa + '). Usa otro.' }); return; }

      const codigo = await reservarCodigo(db);
      const base = 'empresas/' + codigo + '/';
      await db.ref(base + 'empresa_info').set({
        codigo, tipo, nombre, nif: String(b.nif || '').trim().toUpperCase().slice(0, 20), direccion: '', cp: '',
        ciudad: String(b.ciudad || '').trim().slice(0, 80), email, estado: 'activa', creadoTs: Date.now(),
        gratuita: true, venceTs: venceTs, notasMaster: notas || null, creadoPor: 'MASTER',
      });
      await db.ref(base + 'suscripcion_lotes').push({ cantidad: vehiculos, precioUnitario: 0, gratuito: true, fechaContratacion: new Date().toISOString().slice(0, 10), creadoTs: Date.now() });
      // Personalización: apartados del menú
      if (b.menu && typeof b.menu === 'object') {
        const menu = {};
        SECCIONES_MENU.forEach((k) => { menu[k] = !(b.menu[k] === false); });
        await db.ref(base + 'ajustes_empresa').set({ menu, actualizadoTs: Date.now() });
      }
      // Email con el código de acceso
      let emailEnviado = false;
      try { await emailCortesia({ email, nombre, codigo, vehiculos, venceTs }); emailEnviado = true; } catch (e) { /* se puede reenviar a mano */ }
      res.status(200).json({ ok: true, codigo, emailEnviado });
      return;
    }

    if (accion === 'crear_descuento') {
      const tipo = (req.body && req.body.tipo) === 'porcentaje' ? 'porcentaje' : 'precio';
      const valor = Math.round(Number(req.body && req.body.valor) * 100) / 100;
      let precioUnitario;
      if (tipo === 'porcentaje') {
        if (!(valor > 0 && valor < 100)) { res.status(400).json({ error: 'El porcentaje tiene que estar entre 1 y 99.' }); return; }
        precioUnitario = Math.round(299 * (100 - valor)) / 100;
      } else {
        if (!(valor > 0 && valor < 299)) { res.status(400).json({ error: 'El precio especial tiene que ser mayor que 0 y menor que 299 €.' }); return; }
        precioUnitario = valor;
      }
      const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let codigo = '';
      for (let intento = 0; intento < 10; intento++) {
        let c = 'DESC-';
        for (let i = 0; i < 6; i++) c += letras[Math.floor(Math.random() * letras.length)];
        if (!(await db.ref('codigos_descuento/' + c).once('value')).exists()) { codigo = c; break; }
      }
      if (!codigo) { res.status(500).json({ error: 'No se pudo generar el código. Inténtalo otra vez.' }); return; }
      const ahora = Date.now();
      const d = { tipo, valor, precioUnitario, nota: String((req.body && req.body.nota) || '').trim().slice(0, 120) || null,
        creadoTs: ahora, venceTs: ahora + 24 * 3600000, usado: false };
      await db.ref('codigos_descuento/' + codigo).set(d);
      res.status(200).json(Object.assign({ ok: true, codigo }, d));
      return;
    }

    if (accion === 'borrar_descuento') {
      const codigo = String((req.body && req.body.codigo) || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
      if (!codigo) { res.status(400).json({ error: 'Falta el código' }); return; }
      await db.ref('codigos_descuento/' + codigo).remove();
      res.status(200).json({ ok: true });
      return;
    }

    if (accion === 'ocultar') {
      const empresa = String((req.body && req.body.empresa) || '');
      if (!/^DRX-[A-Z0-9]{5}$/.test(empresa)) { res.status(400).json({ error: 'Empresa inválida' }); return; }
      const ref = db.ref('empresas/' + empresa + '/empresa_info');
      if (!(await ref.once('value')).exists()) { res.status(404).json({ error: 'No existe esa empresa' }); return; }
      await ref.update({ ocultaEnMaster: !!(req.body && req.body.ocultar) });
      res.status(200).json({ ok: true });
      return;
    }

    if (accion === 'eliminar_empresa') {
      const empresa = String((req.body && req.body.empresa) || '');
      if (!/^DRX-[A-Z0-9]{5}$/.test(empresa)) { res.status(400).json({ error: 'Empresa inválida' }); return; }
      if ((req.body && req.body.confirmacion) !== empresa) { res.status(400).json({ error: 'Para confirmar, escribe el código de la empresa.' }); return; }
      const info = (await db.ref('empresas/' + empresa + '/empresa_info').once('value')).val();
      if (!info) { res.status(404).json({ error: 'No existe esa empresa' }); return; }
      if (info.estado !== 'suspendida') { res.status(409).json({ error: 'Solo se pueden eliminar empresas suspendidas. Suspéndela primero.' }); return; }
      const resumen = { cuentas: 0, suscripcionesCanceladas: 0, invitaciones: 0, errores: [] };

      // 1) Cancelar sus suscripciones de Stripe (que no se le vuelva a cobrar)
      if (process.env.STRIPE_SECRET_KEY) {
        const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
        const lotes = (await db.ref('empresas/' + empresa + '/suscripcion_lotes').once('value')).val() || {};
        const subs = new Set(Object.keys(lotes).map((k) => lotes[k] && lotes[k].stripeSubscriptionId).filter(Boolean));
        for (const id of subs) {
          try {
            const sub = await stripe.subscriptions.retrieve(id);
            if (sub && sub.status !== 'canceled') { await stripe.subscriptions.cancel(id); resumen.suscripcionesCanceladas++; }
          } catch (e) { resumen.errores.push('Stripe ' + id + ': ' + e.message); }
        }
      }
      // 2) Cuentas de acceso y directorio de sus usuarios (solo los de esta empresa)
      const dir = (await db.ref('directorio_usuarios').once('value')).val() || {};
      for (const k of Object.keys(dir)) {
        const d = dir[k];
        if (!d || d.empresa !== empresa) continue;
        try { const u = await admin.auth().getUserByEmail(d.email); await admin.auth().deleteUser(u.uid); resumen.cuentas++; } catch (e) { /* no tenía cuenta */ }
        await db.ref('directorio_usuarios/' + k).remove();
      }
      // 3) Invitaciones pendientes y registros de alta que apuntan a ella
      const idx = (await db.ref('indice_invitaciones').once('value')).val() || {};
      const borrar = {};
      Object.keys(idx).forEach((c) => { if (idx[c] && idx[c].empresa === empresa) { borrar['indice_invitaciones/' + c] = null; resumen.invitaciones++; } });
      const altas = (await db.ref('altas_por_sesion').once('value')).val() || {};
      Object.keys(altas).forEach((sid) => { if (altas[sid] && altas[sid].codigo === empresa) borrar['altas_por_sesion/' + sid] = null; });
      // 4) Todos sus datos
      borrar['empresas/' + empresa] = null;
      // Constancia mínima de que existió (sin datos personales de sus usuarios)
      borrar['empresas_eliminadas/' + empresa] = { nombre: info.nombre || '', nif: info.nif || '', email: info.email || '', altaTs: info.creadoTs || null, eliminadaTs: Date.now() };
      await db.ref().update(borrar);
      res.status(200).json(Object.assign({ ok: true, empresa }, resumen));
      return;
    }

    if (accion === 'borrar_copia_original') {
      if ((req.body && req.body.confirmacion) !== 'BORRAR') { res.status(400).json({ error: 'Falta la confirmación.' }); return; }
      const mig = (await db.ref('migracion_original').once('value')).val();
      if (!mig || !mig.codigo) { res.status(409).json({ error: 'La flota original todavía no se ha migrado a una empresa. No se borra nada.' }); return; }
      if (!(await db.ref('empresas/' + mig.codigo + '/empresa_info').once('value')).exists()) {
        res.status(409).json({ error: 'No se encuentra la empresa ' + mig.codigo + '. Por seguridad no se borra la copia.' }); return;
      }
      const nodos = await nodosRaiz(); // todo lo de la raíz menos los nodos del sistema
      const borrar = {};
      nodos.forEach((k) => { borrar[k] = null; });
      if (nodos.length) await db.ref().update(borrar);
      await db.ref('migracion_original').update({ copiaBorradaTs: Date.now(), nodosBorrados: nodos.length });
      res.status(200).json({ ok: true, nodosBorrados: nodos.length, empresa: mig.codigo });
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
