// api/cloudinary-delete.js
// Endpoint seguro para borrar archivos de Cloudinary desde el Dashboard.
// La API Secret de Cloudinary NUNCA debe estar en el código del navegador —
// por eso este borrado pasa por aquí, en el servidor de Vercel.

const crypto = require('crypto');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // SEGURIDAD: ninguna app lo usa ya (las fotos de los tickets se conservan).
  // Solo la cuenta master puede borrar archivos, para tareas de mantenimiento.
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  let dec = null;
  try { dec = token ? await admin.auth().verifyIdToken(token) : null; } catch (e) { dec = null; }
  if (!dec || dec.superadmin !== true) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }

  const { publicIds } = req.body || {};
  if (!Array.isArray(publicIds) || !publicIds.length) {
    return res.status(400).json({ error: 'Falta publicIds (array)' });
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    return res.status(500).json({
      error: 'Cloudinary no está configurado en el servidor. Añade las variables de entorno CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY y CLOUDINARY_API_SECRET en Vercel.'
    });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const results = [];

  for (const publicId of publicIds) {
    try {
      const paramsToSign = `public_id=${publicId}&timestamp=${timestamp}`;
      const signature = crypto.createHash('sha1').update(paramsToSign + apiSecret).digest('hex');

      const form = new URLSearchParams();
      form.append('public_id', publicId);
      form.append('timestamp', String(timestamp));
      form.append('api_key', apiKey);
      form.append('signature', signature);

      const resp = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      });
      const data = await resp.json();
      results.push({ publicId, result: data.result || data });
    } catch (err) {
      results.push({ publicId, error: err.message });
    }
  }

  res.status(200).json({ results });
};
