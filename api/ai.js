// api/ai.js
//
// Lectura de imágenes con IA (tickets, nóminas, citas…) a través de
// Claude. La clave de la API vive SOLO aquí, en el servidor.
//
// SEGURIDAD: solo responde a personas con sesión DRIVX que pertenezcan a
// una empresa (o a la cuenta master). Así nadie ajeno puede usar tu saldo.
//
// Variables de entorno: ANTHROPIC_API_KEY, FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL

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

const MAX_IMAGEN = 12 * 1024 * 1024; // ~9 MB de imagen en base64
const MAX_PROMPT = 8000;          // con imagen (tickets, nóminas…)
const MAX_PROMPT_TEXTO = 30000;   // solo texto (asistente de ayuda del Dashboard, que incluye la guía)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  // ── ¿Quién llama? ──
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Sin sesión' }); return; }
  let dec;
  try { dec = await admin.auth().verifyIdToken(token); }
  catch (e) { res.status(401).json({ error: 'Sesión caducada' }); return; }
  if (dec.superadmin !== true) {
    const dir = (await admin.database().ref('directorio_usuarios/' + emailKey(dec.email)).once('value')).val();
    if (!dir || !dir.empresa) { res.status(403).json({ error: 'Tu cuenta no pertenece a ninguna empresa' }); return; }
  }

  const { base64, mediaType, prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || prompt.length > (base64 ? MAX_PROMPT : MAX_PROMPT_TEXTO)) { res.status(400).json({ error: 'Petición no válida' }); return; }
  if (base64 && (typeof base64 !== 'string' || base64.length > MAX_IMAGEN)) { res.status(413).json({ error: 'La imagen es demasiado grande' }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: 'API key not configured' }); return; }

  const content = base64
    ? [{ type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } }, { type: 'text', text: prompt }]
    : [{ type: 'text', text: prompt }];

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 800, messages: [{ role: 'user', content }] }),
    });
    const data = await r.json();
    res.json({ text: (data.content && data.content[0] && data.content[0].text) || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
