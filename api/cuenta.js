// api/cuenta.js
//
// Activaciones de cuenta. Con las reglas de seguridad activadas, alguien
// que aún no pertenece a ninguna empresa no puede leer la base de datos,
// así que las comprobaciones y el "alta" en la empresa las hace el servidor.
//
//   POST /api/cuenta
//   { accion: 'comprobar_invitacion', code, email }       (sin sesión)
//       → ¿existe ese código, sin usar, para ese email?  → { ok, tipo }
//   { accion: 'activar_invitacion', code }                (con sesión: Authorization: Bearer <token>)
//       → vincula el email de la sesión a su empresa y marca la invitación como usada
//         → { ok, empresa, tipo, id, registro }
//   { accion: 'comprobar_alta', codigo, email }           (sin sesión)
//       → para el administrador titular de una empresa recién contratada
//   { accion: 'activar_alta', codigo, nombre }            (con sesión)
//       → crea su usuario administrador y lo vincula a la empresa
//
// Variables de entorno: FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

function emailKey(email) {
  return String(email || '').trim().toLowerCase().replace(/\./g, ',').replace(/[#$\[\]\/]/g, '_');
}
const CARPETA = { dashboard: 'usuarios_dashboard', supervisor: 'usuarios_supervisor', propietario: 'propietarios' };

async function tokenDe(req) {
  const h = String(req.headers.authorization || '');
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) return null;
  try { return await admin.auth().verifyIdToken(t); } catch (e) { return null; }
}

// Busca la invitación a partir de su código (índice → empresa → registro)
async function buscar(db, code) {
  const idx = (await db.ref('indice_invitaciones/' + code).once('value')).val();
  if (!idx || !idx.empresa) return null;
  const base = 'empresas/' + idx.empresa + '/';
  if (idx.app === 'driver') {
    const v = (await db.ref(base + 'invites/' + code).once('value')).val();
    if (!v) return null;
    return { empresa: idx.empresa, tipo: 'driver', id: code, ruta: base + 'invites/' + code, registro: v, email: String(v.email || '').toLowerCase(), usado: !!v.usado };
  }
  const carpeta = CARPETA[idx.app] || 'usuarios_supervisor';
  const todos = (await db.ref(base + carpeta).once('value')).val() || {};
  for (const id of Object.keys(todos)) {
    const v = todos[id];
    if (v && v.inviteCode === code) {
      return { empresa: idx.empresa, tipo: idx.app, id, ruta: base + carpeta + '/' + id, registro: v, email: String(v.email || '').toLowerCase(), usado: !!v.inviteUsado };
    }
  }
  return null;
}

// Un email solo puede pertenecer a una empresa
async function vincular(db, email, empresa) {
  const ref = db.ref('directorio_usuarios/' + emailKey(email));
  const d = (await ref.once('value')).val();
  if (d && d.empresa && d.empresa !== empresa) {
    const e = new Error('Este email ya pertenece a otra empresa DRIVX. Pide que te inviten con otro email.');
    e.status = 409; throw e;
  }
  if (!d) await ref.set({ empresa, email: String(email).toLowerCase(), ts: Date.now() });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }
  try {
    const b = req.body || {};
    const db = admin.database();
    const code = String(b.code || '').trim().toUpperCase();
    const codigo = String(b.codigo || '').trim().toUpperCase();
    const email = String(b.email || '').trim().toLowerCase();

    // ═══ Invitaciones (Driver, Supervisor, Propietario, usuarios del Dashboard) ═══
    if (b.accion === 'comprobar_invitacion') {
      if (!/^[A-Z0-9-]{4,20}$/.test(code)) { res.status(400).json({ error: 'Código no válido.' }); return; }
      const inv = await buscar(db, code);
      if (!inv) { res.status(404).json({ error: 'Código no válido.' }); return; }
      if (inv.usado) { res.status(409).json({ error: 'Este código ya se usó. Inicia sesión con tu email y contraseña.' }); return; }
      if (email && inv.email !== email) { res.status(403).json({ error: 'Código o email incorrectos.' }); return; }
      const info = (await db.ref('empresas/' + inv.empresa + '/empresa_info').once('value')).val() || {};
      if (info.estado === 'suspendida') { res.status(403).json({ error: 'El acceso de esta empresa está suspendido.' }); return; }
      res.status(200).json({ ok: true, tipo: inv.tipo, empresa: inv.empresa, empresaNombre: info.nombre || '' });
      return;
    }

    if (b.accion === 'activar_invitacion') {
      const tok = await tokenDe(req);
      if (!tok) { res.status(401).json({ error: 'Sesión no válida. Vuelve a intentarlo.' }); return; }
      const inv = await buscar(db, code);
      if (!inv) { res.status(404).json({ error: 'Código no válido.' }); return; }
      if (inv.email !== String(tok.email || '').toLowerCase()) { res.status(403).json({ error: 'Este código es para otro email.' }); return; }
      if (inv.usado && inv.tipo !== 'driver') { res.status(409).json({ error: 'Este código ya se usó.' }); return; }
      await vincular(db, inv.email, inv.empresa);
      // Driver: la app termina el registro (datos, documentos) y marca el código como usado.
      if (inv.tipo !== 'driver') {
        await db.ref(inv.ruta).update({ inviteUsado: true, pass: null, activadoTs: Date.now() });
        await db.ref('indice_invitaciones/' + code).remove();
      }
      const reg = Object.assign({}, inv.registro); delete reg.pass;
      res.status(200).json({ ok: true, empresa: inv.empresa, tipo: inv.tipo, id: inv.id, registro: reg });
      return;
    }

    // ═══ Administrador titular de una empresa nueva (viene de la web) ═══
    if (b.accion === 'comprobar_alta' || b.accion === 'activar_alta') {
      if (!/^DRX-[A-Z0-9]{5}$/.test(codigo)) { res.status(400).json({ error: 'El código de empresa debe tener el formato DRX-XXXXX.' }); return; }
      const infoRef = db.ref('empresas/' + codigo + '/empresa_info');
      const info = (await infoRef.once('value')).val();
      if (!info || !info.codigo) { res.status(404).json({ error: 'Ese código de empresa no existe. Revisa el email que te enviamos.' }); return; }
      if (info.estado && info.estado !== 'activa') { res.status(403).json({ error: 'Esta empresa no tiene la suscripción activa.' }); return; }
      if (info.adminCreado) { res.status(409).json({ error: 'Esta empresa ya tiene su administrador. Inicia sesión con tu email y contraseña.' }); return; }
      const emailEmpresa = String(info.email || '').toLowerCase();
      const pista = emailEmpresa.replace(/(.{2}).*(@.*)/, '$1•••$2');

      if (b.accion === 'comprobar_alta') {
        if (email !== emailEmpresa) { res.status(403).json({ error: 'Usa el mismo email con el que contrataste DRIVX (' + pista + ').' }); return; }
        res.status(200).json({ ok: true });
        return;
      }
      const tok = await tokenDe(req);
      if (!tok) { res.status(401).json({ error: 'Sesión no válida. Vuelve a intentarlo.' }); return; }
      if (String(tok.email || '').toLowerCase() !== emailEmpresa) { res.status(403).json({ error: 'Usa el mismo email con el que contrataste DRIVX (' + pista + ').' }); return; }
      await vincular(db, emailEmpresa, codigo);
      const nombre = String(b.nombre || '').trim().slice(0, 80) || 'Administrador';
      const usuario = { nombre, email: emailEmpresa, role: 'admin', inviteUsado: true, esTitular: true, ts: Date.now() };
      await db.ref('empresas/' + codigo + '/usuarios_dashboard/u_titular').set(usuario);
      await infoRef.update({ adminCreado: true, adminEmail: emailEmpresa });
      res.status(200).json({ ok: true, empresa: codigo, usuario });
      return;
    }

    res.status(400).json({ error: 'Acción inválida' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};
