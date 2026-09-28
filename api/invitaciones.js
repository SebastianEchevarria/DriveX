// api/invitaciones.js
//
// Gestiona las invitaciones que crea el Dashboard para las apps
// Driver, Supervisor, Propietario (y usuarios del propio Dashboard).
//
//   POST /api/invitaciones   (con cabecera Authorization: Bearer <token de Firebase>)
//   { accion: 'enviar',   code: 'DRVX-XXXX', tipo: 'driver'|'supervisor'|'propietario'|'dashboard' }
//       → envía por email el código y el enlace a la app. Si ese email tenía
//         una cuenta antigua que ya no se usa (miembro borrado, registro a
//         medias…), la libera para que pueda registrarse de nuevo.
//   { accion: 'eliminar', code, tipo }
//       → borra la invitación pendiente y libera el email.
//
// SEGURIDAD: solo puede usarlo un administrador o manager de la MISMA
// empresa a la que pertenece la invitación. El email de destino se lee
// siempre de la base de datos (nunca del navegador), así que no se puede
// usar para enviar correos a quien uno quiera.
//
// Variables de entorno: FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL,
//   SMTP_USER, SMTP_PASS, (opc.) SMTP_HOST, SMTP_PORT, EMAIL_FROM, APP_URL

const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

const ADMINS_FIJOS_FLOTA_ORIGINAL = ['admin@vtcinfinity.com'];
// Cuentas fijas de la flota original: nunca se liberan ni se borran desde aquí
const CUENTAS_PROTEGIDAS = ['admin@vtcinfinity.com', 'manager@vtcinfinity.com', 'ana@drivx.es'];
const ROLES_CON_PERMISO = ['admin', 'ccaa_manager'];

function emailKey(email) {
  return String(email || '').trim().toLowerCase().replace(/\./g, ',').replace(/[#$\[\]\/]/g, '_');
}
function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function base(empresa) { return empresa ? ('empresas/' + empresa + '/') : ''; }

// ── Busca la invitación por su código ──
async function buscarInvitacion(db, empresa, tipo, code) {
  const b = base(empresa);
  if (tipo === 'driver') {
    const s = await db.ref(b + 'invites/' + code).once('value');
    const v = s.val();
    if (!v) return null;
    return { ruta: b + 'invites/' + code, email: v.email, usado: !!v.usado, ts: v.creadoTs || 0, nombre: v.email, extra: v };
  }
  const carpeta = tipo === 'propietario' ? 'propietarios' : tipo === 'dashboard' ? 'usuarios_dashboard' : 'usuarios_supervisor';
  const s = await db.ref(b + carpeta).once('value');
  const todos = s.val() || {};
  for (const id of Object.keys(todos)) {
    const v = todos[id];
    if (v && v.inviteCode === code) {
      return { ruta: b + carpeta + '/' + id, email: v.email, usado: !!v.inviteUsado, ts: v.ts || 0, nombre: v.nombre || v.email, extra: v };
    }
  }
  return null;
}

// ── ¿Este email es ya un miembro ACTIVO de esta empresa/flota? ──
async function esMiembroActivo(db, empresa, email, rutaExcluir) {
  const b = base(empresa);
  const e = String(email || '').toLowerCase();
  const [dash, sup, props, cond] = await Promise.all([
    db.ref(b + 'usuarios_dashboard').once('value'),
    db.ref(b + 'usuarios_supervisor').once('value'),
    db.ref(b + 'propietarios').once('value'),
    db.ref(b + 'conductores_registro').once('value'),
  ]);
  const listas = [
    [b + 'usuarios_dashboard/', dash.val() || {}, 'inviteUsado'],
    [b + 'usuarios_supervisor/', sup.val() || {}, 'inviteUsado'],
    [b + 'propietarios/', props.val() || {}, 'inviteUsado'],
    [b + 'conductores_registro/', cond.val() || {}, null],
  ];
  for (const [pref, datos, campoActivo] of listas) {
    for (const id of Object.keys(datos)) {
      const v = datos[id];
      if (!v || String(v.email || '').toLowerCase() !== e) continue;
      if (pref + id === rutaExcluir) continue;
      if (campoActivo && !v[campoActivo]) continue; // invitación sin aceptar: no es miembro activo
      return true;
    }
  }
  return false;
}

// ── Libera un email con cuenta antigua que ya no se usa ──
// Devuelve 'libre' | 'liberado' | 'activo' | 'otra_empresa'
async function liberarEmailSiProcede(db, empresa, email, rutaExcluir) {
  if (!email) return 'libre';
  if (CUENTAS_PROTEGIDAS.includes(String(email).toLowerCase())) return 'otra_empresa';
  let user = null;
  try { user = await admin.auth().getUserByEmail(email); } catch (e) { user = null; }
  const dirRef = db.ref('directorio_usuarios/' + emailKey(email));
  const dir = (await dirRef.once('value')).val();

  if (dir && dir.empresa && dir.empresa !== empresa) return 'otra_empresa';
  if (!dir && empresa && user) {
    // Cuenta sin empresa: puede ser de la flota original. Si está activa allí, no se toca.
    if (await esMiembroActivo(db, null, email, null)) return 'otra_empresa';
  }
  if (await esMiembroActivo(db, empresa, email, rutaExcluir)) return 'activo';

  let liberado = false;
  if (user) { await admin.auth().deleteUser(user.uid); liberado = true; }
  if (dir) { await dirRef.remove(); liberado = true; }
  return liberado ? 'liberado' : 'libre';
}

// ── Email ──
async function enviarEmail({ to, subject, html, text }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) throw new Error('Faltan SMTP_USER / SMTP_PASS en Vercel');
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await t.sendMail({ from: process.env.EMAIL_FROM || ('DRIVX <' + process.env.SMTP_USER + '>'), to, subject, html, text });
}

const APPS = {
  driver:      { nombre: 'DRIVX Driver',      archivo: 'drivx-driver-app.html',      color: '#00e676', rol: 'conductor' },
  supervisor:  { nombre: 'DRIVX Supervisor',  archivo: 'drivx-supervisor-app.html',  color: '#ffb300', rol: 'supervisor' },
  propietario: { nombre: 'DRIVX Propietario', archivo: 'drivx-propietario-app.html', color: '#8b6bff', rol: 'propietario' },
  dashboard:   { nombre: 'DRIVX Dashboard',   archivo: 'drivx-admin-dashboard.html', color: '#00d4ff', rol: 'miembro del equipo de administración' },
};

function construirEmail({ tipo, code, email, empresaNombre, inv }) {
  const app = APPS[tipo];
  const appUrl = process.env.APP_URL || 'https://drive-x-lilac-seven.vercel.app';
  const enlace = appUrl + '/' + app.archivo + '?invite=' + encodeURIComponent(code) + '&email=' + encodeURIComponent(email);
  const extraDriver = (tipo === 'driver' && inv.extra && inv.extra.matricula)
    ? `<p style="font-size:14px;margin:0 0 18px">Vehículo asignado: <b>${esc(inv.extra.matricula)}</b>${inv.extra.modelo ? ' · ' + esc(inv.extra.modelo) : ''}${inv.extra.turno ? ' · Turno ' + esc(inv.extra.turno) : ''}</p>`
    : '';
  const html = `
<div style="background:#070b12;padding:32px 16px;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#0c1420;border:2px solid ${app.color};border-radius:18px;padding:32px 28px;color:#ffffff">
    <div style="font-size:28px;font-weight:900;letter-spacing:1px;margin-bottom:4px">DRIV<span style="color:#00d4ff">X</span></div>
    <div style="font-size:11px;letter-spacing:3px;color:#9ab0c8;margin-bottom:28px">${esc(app.nombre.toUpperCase())}</div>

    <h1 style="font-size:21px;margin:0 0 12px">Te han invitado a ${esc(app.nombre)}</h1>
    <p style="font-size:15px;line-height:1.6;margin:0 0 18px"><b>${esc(empresaNombre)}</b> te ha dado acceso como <b>${esc(app.rol)}</b>.</p>
    ${extraDriver}

    <p style="font-size:15px;margin:0 0 8px">Tu <b>código de invitación</b>:</p>
    <div style="font-family:'Courier New',monospace;font-size:30px;font-weight:700;letter-spacing:4px;text-align:center;padding:18px;border:2px solid ${app.color};border-radius:14px;background:#0a1a24;color:#ffffff;margin:0 0 12px">${esc(code)}</div>
    <p style="font-size:12.5px;color:#ffb300;text-align:center;margin:0 0 24px">⚠️ Es de un solo uso: solo sirve para activar tu cuenta una vez. No lo compartas.</p>

    <div style="text-align:center;margin:0 0 14px">
      <a href="${enlace}" style="display:inline-block;background:${app.color};color:#02131d;text-decoration:none;font-weight:900;font-size:16px;padding:15px 34px;border-radius:12px">Abrir la app y activar mi cuenta →</a>
    </div>
    <p style="font-size:12px;color:#9ab0c8;text-align:center;margin:0 0 26px;word-break:break-all">Si el botón no funciona, copia este enlace:<br>${enlace}</p>

    <p style="font-size:14px;line-height:1.6;margin:0 0 6px"><b>Instálala como app en tu móvil:</b></p>
    <p style="font-size:13.5px;line-height:1.6;color:#dfe8f3;margin:0 0 24px">
      Android (Chrome): menú ⋮ → <i>Añadir a pantalla de inicio</i>.<br>
      iPhone (Safari): botón Compartir → <i>Añadir a pantalla de inicio</i>.<br>
      Ordenador (Chrome): icono de instalar a la derecha de la barra de direcciones.
    </p>
    <p style="font-size:12px;color:#9ab0c8;border-top:1px solid #243347;padding-top:16px;margin:0">Si no esperabas esta invitación, puedes ignorar este email.</p>
  </div>
</div>`;
  const text =
    `Te han invitado a ${app.nombre}\n\n${empresaNombre} te ha dado acceso como ${app.rol}.\n\n` +
    `Código de invitación (un solo uso): ${code}\n\nAbre la app y activa tu cuenta aquí:\n${enlace}\n`;
  return { subject: `${empresaNombre} te invita a ${app.nombre} · Código ${code}`, html, text };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  try {
    const { accion, tipo } = req.body || {};
    const code = String((req.body && req.body.code) || '').trim().toUpperCase();
    if (!['enviar', 'eliminar'].includes(accion)) { res.status(400).json({ error: 'Acción inválida' }); return; }
    if (!APPS[tipo]) { res.status(400).json({ error: 'Tipo inválido' }); return; }
    if (!/^[A-Z0-9-]{4,20}$/.test(code)) { res.status(400).json({ error: 'Código inválido' }); return; }

    // ── ¿Quién llama? ──
    const authHeader = String(req.headers.authorization || '');
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) { res.status(401).json({ error: 'Sesión no válida. Cierra sesión y vuelve a entrar.' }); return; }
    let caller;
    try { caller = await admin.auth().verifyIdToken(idToken); }
    catch (e) { res.status(401).json({ error: 'Sesión caducada. Cierra sesión y vuelve a entrar.' }); return; }
    const callerEmail = String(caller.email || '').toLowerCase();

    const db = admin.database();

    // ── ¿De qué empresa es la invitación? ──
    const idx = (await db.ref('indice_invitaciones/' + code).once('value')).val();
    const empresa = (idx && idx.empresa) || null;

    // ── ¿El que llama es admin/manager de ESA empresa? ──
    const dirCaller = (await db.ref('directorio_usuarios/' + emailKey(callerEmail)).once('value')).val();
    const empresaCaller = (dirCaller && dirCaller.empresa) || null;
    if (empresaCaller !== empresa) { res.status(403).json({ error: 'No tienes permiso sobre esta invitación.' }); return; }
    let autorizado = false;
    if (!empresa && ADMINS_FIJOS_FLOTA_ORIGINAL.includes(callerEmail)) autorizado = true;
    if (!autorizado) {
      const usuarios = (await db.ref(base(empresa) + 'usuarios_dashboard').once('value')).val() || {};
      autorizado = Object.keys(usuarios).some((k) => {
        const u = usuarios[k];
        return u && String(u.email || '').toLowerCase() === callerEmail && ROLES_CON_PERMISO.includes(u.role);
      });
    }
    if (!autorizado) { res.status(403).json({ error: 'Solo un administrador o manager puede hacer esto.' }); return; }

    const inv = await buscarInvitacion(db, empresa, tipo, code);

    // ═══════ ELIMINAR ═══════
    if (accion === 'eliminar') {
      let estadoEmail = 'libre';
      if (inv) {
        if (inv.usado) { res.status(409).json({ error: 'Esta invitación ya se aceptó; no es una invitación pendiente.' }); return; }
        await db.ref(inv.ruta).remove();
        estadoEmail = await liberarEmailSiProcede(db, empresa, inv.email, inv.ruta);
      }
      await db.ref('indice_invitaciones/' + code).remove();
      res.status(200).json({ ok: true, email: inv ? inv.email : null, estadoEmail });
      return;
    }

    // ═══════ ENVIAR ═══════
    if (!inv) { res.status(404).json({ error: 'No se encontró la invitación.' }); return; }
    if (inv.usado) { res.status(409).json({ error: 'Este código ya se usó (es de un solo uso).' }); return; }
    if (!inv.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inv.email)) { res.status(400).json({ error: 'La invitación no tiene un email válido.' }); return; }

    const estadoEmail = await liberarEmailSiProcede(db, empresa, inv.email, inv.ruta);
    if (estadoEmail === 'otra_empresa') {
      res.status(409).json({ error: 'Ese email ya está en uso en otra cuenta DRIVX. Usa otro email para esta persona.', estadoEmail });
      return;
    }
    if (estadoEmail === 'activo') {
      res.status(409).json({ error: 'Esa persona ya tiene una cuenta activa en tu empresa con este email.', estadoEmail });
      return;
    }

    let empresaNombre = 'DRIVX';
    if (empresa) {
      const info = (await db.ref('empresas/' + empresa + '/empresa_info').once('value')).val();
      if (info && info.nombre) empresaNombre = info.nombre;
    }
    const correo = construirEmail({ tipo, code, email: inv.email, empresaNombre, inv });
    await enviarEmail({ to: inv.email, subject: correo.subject, html: correo.html, text: correo.text });
    await db.ref(inv.ruta).update({ emailEnviadoTs: Date.now() });

    res.status(200).json({ ok: true, email: inv.email, estadoEmail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
