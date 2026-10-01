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
// PRIVACIDAD DENTRO DE LA EMPRESA (con sesión):
//   { accion: 'lista', carpeta, empresa? }  carpeta = conductores_registro | usuarios_supervisor | propietarios
//       → devuelve SOLO lo que esa persona puede ver:
//         Dashboard: todo · Propietario: todo de los conductores de SUS vehículos ·
//         Conductor: su ficha + nombre/turno de sus compañeros de vehículo ·
//         Supervisor: nombre/matrícula/turno de los conductores de sus comunidades
//   { accion: 'cierres', cid, empresa? }  → semanas cerradas de un conductor (si puede verlas)
//   { accion: 'sincronizar', empresa? }   → (Dashboard) actualiza qué papel tiene cada persona
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

// ══════════════ PAPELES DE CADA PERSONA (para las reglas de seguridad) ══════════════
// directorio_usuarios/{email} = { empresa, email, roles:{dashboard,supervisor,propietario,driver},
//                                 cid?, pid?, supId? }
// Las reglas de Firebase usan estos datos para decidir qué puede leer cada uno.
function slugMat(m) { return String(m || '').replace(/\s/g, '_'); }
// Formato único (sin espacios, mayúsculas): el que usan las facturas
function claveMat(m) { return String(m || '').replace(/\s/g, '').toUpperCase(); }
async function leerListas(db, empresa) {
  const b = 'empresas/' + empresa + '/';
  const [dash, sup, props, cond, vehs] = await Promise.all(
    ['usuarios_dashboard', 'usuarios_supervisor', 'propietarios', 'conductores_registro', 'vehiculos_extra']
      .map((c) => db.ref(b + c).once('value').then((x) => x.val() || {}))
  );
  return { dash, sup, props, cond, vehs };
}
function papelesDe(L, email) {
  const e = String(email || '').toLowerCase();
  const igual = (v) => v && String(v.email || '').toLowerCase() === e;
  const r = { roles: {}, cid: null, pid: null, supId: null, matriculas: [], ccaa: [] };
  Object.keys(L.dash).forEach((k) => { if (igual(L.dash[k]) && L.dash[k].inviteUsado) r.roles.dashboard = true; });
  Object.keys(L.sup).forEach((k) => { if (igual(L.sup[k]) && L.sup[k].inviteUsado) { r.roles.supervisor = true; r.supId = k; r.ccaa = L.sup[k].ccaa || []; } });
  Object.keys(L.props).forEach((k) => { if (igual(L.props[k]) && L.props[k].inviteUsado) { r.roles.propietario = true; r.pid = k; r.matriculas = L.props[k].matriculas || []; } });
  Object.keys(L.cond).forEach((k) => { if (igual(L.cond[k])) { r.roles.driver = true; r.cid = L.cond[k].cid || k; } });
  return r;
}
async function sincronizarPersona(db, empresa, email, L, extra) {
  const p = papelesDe(L, email);
  if (extra) {
    Object.assign(p.roles, extra.roles || {});
    ['cid', 'pid', 'supId'].forEach((k) => { if (extra[k]) p[k] = extra[k]; });
  }
  const ref = db.ref('directorio_usuarios/' + emailKey(email));
  const d = (await ref.once('value')).val();
  if (d && d.empresa && d.empresa !== empresa) return; // pertenece a otra empresa: no se toca
  await ref.set({
    empresa, email: String(email).toLowerCase(), ts: (d && d.ts) || Date.now(),
    roles: p.roles, cid: p.cid || null, pid: p.pid || null, supId: p.supId || null,
  });
}
// Todas las personas de una empresa + mapa de matrículas de cada propietario
async function sincronizarEmpresa(db, empresa) {
  const L = await leerListas(db, empresa);
  const emails = new Set();
  [L.dash, L.sup, L.props, L.cond].forEach((o) => Object.keys(o).forEach((k) => { if (o[k] && o[k].email) emails.add(String(o[k].email).toLowerCase()); }));
  for (const e of emails) await sincronizarPersona(db, empresa, e, L);
  // matriculasMap: las reglas lo usan para saber de qué vehículos es cada propietario
  const upd = {};
  Object.keys(L.props).forEach((pid) => {
    const m = {};
    (L.props[pid].matriculas || []).forEach((x) => { m[slugMat(x)] = true; m[claveMat(x)] = true; });
    upd['empresas/' + empresa + '/propietarios/' + pid + '/matriculasMap'] = Object.keys(m).length ? m : null;
  });
  if (Object.keys(upd).length) await db.ref().update(upd);
  return emails.size;
}
// Quién llama y a qué empresa pertenece (la cuenta master puede indicar la empresa)
async function quienLlama(db, req, b) {
  const tok = await tokenDe(req);
  if (!tok) { const e = new Error('Sin sesión'); e.status = 401; throw e; }
  let empresa = null;
  if (tok.superadmin === true && /^DRX-[A-Z0-9]{5}$/.test(String(b.empresa || ''))) empresa = b.empresa;
  else {
    const d = (await db.ref('directorio_usuarios/' + emailKey(tok.email)).once('value')).val();
    empresa = d && d.empresa;
  }
  if (!empresa) { const e = new Error('Tu cuenta no pertenece a ninguna empresa'); e.status = 403; throw e; }
  const L = await leerListas(db, empresa);
  const p = papelesDe(L, tok.email);
  if (tok.superadmin === true) p.roles.dashboard = true;
  return { tok, empresa, L, p };
}
function proyeccionConductor(c) {
  return { cid: c.cid, nombre: c.nombre || '', matricula: c.matricula || '', turno: c.turno || '', modelo: c.modelo || '' };
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
      // Papeles de esta persona para las reglas de seguridad
      const extra = { roles: {} };
      if (inv.tipo === 'driver') {
        const cidNuevo = String(b.cid || '');
        if (!/^[A-Za-z0-9_-]{3,60}$/.test(cidNuevo)) { res.status(400).json({ error: 'Falta el identificador del conductor.' }); return; }
        extra.roles.driver = true; extra.cid = cidNuevo;
      }
      if (inv.tipo === 'dashboard') extra.roles.dashboard = true;
      if (inv.tipo === 'supervisor') { extra.roles.supervisor = true; extra.supId = inv.id; }
      if (inv.tipo === 'propietario') {
        extra.roles.propietario = true; extra.pid = inv.id;
        const m = {}; (inv.registro.matriculas || []).forEach((x) => { m[slugMat(x)] = true; m[claveMat(x)] = true; });
        await db.ref(inv.ruta + '/matriculasMap').set(Object.keys(m).length ? m : null);
      }
      await sincronizarPersona(db, inv.empresa, inv.email, await leerListas(db, inv.empresa), extra);
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
      await sincronizarPersona(db, codigo, emailEmpresa, await leerListas(db, codigo), { roles: { dashboard: true } });
      res.status(200).json({ ok: true, empresa: codigo, usuario });
      return;
    }

    // ═══ Privacidad: listas filtradas según quién pregunta ═══
    if (b.accion === 'lista') {
      const { tok, empresa, L, p } = await quienLlama(db, req, b);
      const out = {};
      if (b.carpeta === 'conductores_registro') {
        const misMats = new Set(p.matriculas.map(slugMat));
        const miVeh = p.cid && L.cond[p.cid] ? slugMat(L.cond[p.cid].matricula) : null;
        const ccaaDeMat = {};
        Object.keys(L.vehs).forEach((k) => { const v = L.vehs[k]; if (v && v.matricula) ccaaDeMat[slugMat(v.matricula)] = v.ccaa; });
        Object.keys(L.cond).forEach((k) => {
          const c = L.cond[k]; if (!c) return;
          const mat = slugMat(c.matricula);
          if (p.roles.dashboard || (p.roles.propietario && misMats.has(mat)) || (p.cid && (c.cid || k) === p.cid)) {
            const copia = Object.assign({}, c); delete copia.pass; out[k] = copia;
          } else if ((miVeh && mat === miVeh) || (p.roles.supervisor && (p.ccaa || []).indexOf(ccaaDeMat[mat]) !== -1)) {
            out[k] = proyeccionConductor(c);
          }
        });
      } else if (b.carpeta === 'usuarios_supervisor') {
        Object.keys(L.sup).forEach((k) => { if (p.roles.dashboard || k === p.supId) { const c = Object.assign({}, L.sup[k]); delete c.pass; out[k] = c; } });
      } else if (b.carpeta === 'propietarios') {
        Object.keys(L.props).forEach((k) => { if (p.roles.dashboard || k === p.pid) { const c = Object.assign({}, L.props[k]); delete c.pass; out[k] = c; } });
      } else { res.status(400).json({ error: 'Carpeta no válida' }); return; }
      // De paso, mantenemos al día los papeles de quien pregunta
      if (tok.superadmin !== true) await sincronizarPersona(db, empresa, tok.email, L);
      res.status(200).json({ ok: true, datos: out });
      return;
    }

    if (b.accion === 'cierres') {
      const { empresa, L, p } = await quienLlama(db, req, b);
      const cid = String(b.cid || '');
      if (!cid) { res.status(400).json({ error: 'Falta el conductor' }); return; }
      const misMats = new Set(p.matriculas.map(slugMat));
      const puedeTodo = p.roles.dashboard || cid === p.cid;
      if (!puedeTodo && !p.roles.propietario) { res.status(403).json({ error: 'Sin permiso' }); return; }
      const todos = (await db.ref('empresas/' + empresa + '/facturacion_cierres').once('value')).val() || {};
      const out = {};
      Object.keys(todos).forEach((mat) => {
        if (!puedeTodo && !misMats.has(mat)) return;
        const r = todos[mat] && todos[mat][cid];
        if (r) out[mat] = r;
      });
      res.status(200).json({ ok: true, cierres: out });
      return;
    }

    // ═══ El conductor desbloquea SU vehículo parado (revisión, ITV, taller…) ═══
    // Se hace aquí y no desde la app, para no depender de que las reglas
    // cuadren matrícula, directorio y ficha exactamente: el servidor compara
    // la matrícula sin espacios ni mayúsculas.
    if (b.accion === 'desbloquear_vehiculo') {
      const { tok, empresa, L } = await quienLlama(db, req, b);
      const norm = (m) => String(m || '').replace(/[\s_]/g, '').toUpperCase();
      const pedida = norm(b.matricula);
      if (!pedida) { res.status(400).json({ error: 'Falta la matrícula' }); return; }
      const mail = String(tok.email || '').toLowerCase();
      let quien = null;
      Object.keys(L.cond).forEach((k) => {
        const c = L.cond[k];
        if (c && String(c.email || '').toLowerCase() === mail && norm(c.matricula) === pedida) quien = Object.assign({ cid: c.cid || k }, c);
      });
      if (!quien && tok.superadmin !== true) { res.status(403).json({ error: 'Solo un conductor de este vehículo puede desbloquearlo.' }); return; }
      const base = 'empresas/' + empresa + '/';
      const estados = (await db.ref(base + 'vehiculos_estado').once('value')).val() || {};
      const clave = Object.keys(estados).find((k) => norm(k) === pedida || norm(estados[k] && estados[k].matricula) === pedida);
      if (!clave || !estados[clave] || !estados[clave].parado) { res.status(200).json({ ok: true, yaEstaba: true }); return; }
      const e = estados[clave];
      const ahora = Date.now();
      const nombre = (quien && quien.nombre) || 'Conductor';
      const upd = {};
      upd[base + 'vehiculos_estado/' + clave] = null;
      if (e.paradaId) {
        upd[base + 'vehiculos_paradas/' + clave + '/' + e.paradaId + '/hastaTs'] = ahora;
        upd[base + 'vehiculos_paradas/' + clave + '/' + e.paradaId + '/cerradoPor'] = nombre;
        upd[base + 'vehiculos_paradas/' + clave + '/' + e.paradaId + '/cerradoPorRol'] = 'Conductor';
      }
      const avisoId = db.ref(base + 'avisos_vehiculos').push().key;
      upd[base + 'avisos_vehiculos/' + avisoId] = {
        tipo: 'desbloqueo', matricula: e.matricula || b.matricula, por: nombre, porRol: 'Conductor',
        cid: (quien && quien.cid) || '', ts: ahora, motivoPrevio: String(b.motivoPrevio || '').slice(0, 80),
      };
      await db.ref().update(upd);
      res.status(200).json({ ok: true, matricula: e.matricula || b.matricula });
      return;
    }

    if (b.accion === 'sincronizar') {
      const { empresa, p } = await quienLlama(db, req, b);
      if (!p.roles.dashboard) { res.status(403).json({ error: 'Solo el Dashboard' }); return; }
      const n = await sincronizarEmpresa(db, empresa);
      res.status(200).json({ ok: true, personas: n });
      return;
    }

    res.status(400).json({ error: 'Acción inválida' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};
