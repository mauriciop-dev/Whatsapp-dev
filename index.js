require('dotenv').config();
const express = require('express');

const app = express();

app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const MP_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN || '';
const PDF_URL = "https://fvdltrqzdosqkebsydqn.supabase.co/storage/v1/object/public/Libros/materia_programable_prodig.pdf";

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const MY_VERIFY_TOKEN = process.env.VERIFY_TOKEN || "prodig_secret_token";

    if (mode && token) {
        if (mode === 'subscribe' && token === MY_VERIFY_TOKEN) {
            return res.status(200).send(challenge);
        }
        return res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    await Promise.race([
        procesarMensaje(req.body),
        new Promise(r => setTimeout(r, 2500))
    ]);
    res.status(200).send('EVENT_RECEIVED');
});

async function procesarMensaje(body) {
    if (!body.object || !body.entry || !body.entry[0].changes ||
        !body.entry[0].changes[0].value || !body.entry[0].changes[0].value.messages ||
        !body.entry[0].changes[0].value.messages[0]) return;

    const messageData = body.entry[0].changes[0].value.messages[0];
    const from = messageData.from;
    const phoneId = body.entry[0].changes[0].value.metadata.phone_number_id;

    if (messageData.type === 'text' && messageData.text && messageData.text.body) {
        const text = messageData.text.body.trim().toLowerCase();
        if (text === 'libro') {
            await registrarComprador(from, phoneId);
            const respuesta = `¡Hola! Gracias por tu interés en el libro "Materia Programable y la Próxima Revolución Digital" de ProDig.\n\nEl costo es de $2.000 COP. Puedes realizar el pago de manera 100% segura aquí: https://mpago.li/2joCuAn\n\nTan pronto se confirme el débito, recibirás el libro en formato PDF directamente por este chat.`;
            await enviarMensajeWhatsApp(from, phoneId, respuesta);
        }
    }
}

app.post('/webhook-pago', async (req, res) => {
    await Promise.race([
        procesarPago(req.body),
        new Promise(r => setTimeout(r, 2500))
    ]);
    res.status(200).send('OK');
});

async function procesarPago(notification) {
    if (notification.type === 'payment') {
        const paymentId = notification.data.id;
        const payment = await obtenerPagoMercadoPago(paymentId);

        if (payment && payment.status === 'approved') {
            let customerPhone = payment.payer?.phone?.number;
            let phoneNameId = process.env.PHONE_NUMBER_ID;

            if (!customerPhone) {
                const comprador = await obtenerCompradorPendiente();
                if (comprador) {
                    customerPhone = comprador.phone;
                    await marcarCompradorEnviado(comprador.id, paymentId);
                }
            }

            if (customerPhone && phoneNameId) {
                await enviarDocumentoWhatsApp(customerPhone, phoneNameId, PDF_URL);
            }
        }
    }
}

const FETCH_TIMEOUT = 2500;

async function fetchWithTimeout(url, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
        const response = await fetch(url, { ...opts, signal: controller.signal });
        return response;
    } finally {
        clearTimeout(timer);
    }
}

async function obtenerPagoMercadoPago(paymentId) {
    const response = await fetchWithTimeout(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MP error ${response.status}: ${errorText}`);
    }
    return response.json();
}

async function registrarComprador(phone, phoneId) {
    await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/compradores`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({ phone, phone_id: phoneId, status: 'pending' })
    });
}

async function obtenerCompradorPendiente() {
    const response = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/compradores?status=eq.pending&order=created_at.asc&limit=1`,
        {
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            }
        }
    );
    const data = await response.json();
    return data && data.length > 0 ? data[0] : null;
}

async function marcarCompradorEnviado(id, paymentId) {
    await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/compradores?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({ status: 'completed', payment_id: String(paymentId) })
    });
}

async function enviarMensajeWhatsApp(to, phoneId, text) {
    const token = process.env.WHATSAPP_ACCESS_TOKEN ? process.env.WHATSAPP_ACCESS_TOKEN.trim() : '';
    const response = await fetchWithTimeout(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to, type: "text",
            text: { preview_url: false, body: text }
        })
    });
    const data = await response.json();
    if (!response.ok) console.error('Error WhatsApp:', data);
    return data;
}

async function enviarDocumentoWhatsApp(to, phoneId, pdfUrl) {
    const token = process.env.WHATSAPP_ACCESS_TOKEN ? process.env.WHATSAPP_ACCESS_TOKEN.trim() : '';
    const response = await fetchWithTimeout(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to, type: "document",
            document: {
                link: pdfUrl,
                filename: "Materia_Programable_ProDig.pdf",
                caption: "¡Aquí tienes tu libro! Gracias por tu compra."
            }
        })
    });
    const data = await response.json();
    if (!response.ok) console.error('Error WhatsApp doc:', data);
    return data;
}

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'vercel') {
    app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
}

module.exports = app;
