require('dotenv').config();
const express = require('express');

const app = express();

app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const MP_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN || '';
const BASE_STORAGE = "https://fvdltrqzdosqkebsydqn.supabase.co/storage/v1/object/public/Libros";
const WEBHOOK_PAGO_URL = "https://whatsapp-dev-prod.vercel.app/webhook-pago";

const FETCH_TIMEOUT = 2500;

async function fetchWithTimeout(url, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
        return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ── Health ──
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Webhook verification ──
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

// ── WhatsApp incoming messages ──
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

    const msg = body.entry[0].changes[0].value.messages[0];
    const from = msg.from;
    const phoneId = body.entry[0].changes[0].value.metadata.phone_number_id;

    if (msg.type === 'text' && msg.text && msg.text.body) {
        const text = msg.text.body.trim().toLowerCase();
        if (['catalogo', 'catálogo', 'libro', 'menu', 'menú', 'productos', 'hola', 'inicio'].includes(text)) {
            await enviarCatalogo(from, phoneId);
            return;
        }
    }

    if (msg.type === 'interactive' && msg.interactive) {
        const interactive = msg.interactive;
        if (interactive.type === 'list_reply' && interactive.list_reply) {
            const rowId = interactive.list_reply.id;
            if (rowId.startsWith('prod_')) {
                const prodRowId = rowId.replace('prod_', '');
                await procesarSeleccionProducto(from, phoneId, prodRowId);
            }
        }
    }
}

// ── Catálogo (List Message) ──
async function enviarCatalogo(to, phoneId) {
    const productos = await obtenerProductos();
    const rows = productos.map(p => ({
        id: `prod_${p.row_id}`,
        title: p.title.replace('Materia Programable: ', ''),
        description: `$${p.price_cop.toLocaleString()} COP`
    }));

    await enviarInteractiveWhatsApp(to, phoneId, {
        type: "list",
        header: { type: "text", text: "📚 Catálogo Digital" },
        body: { text: "Selecciona un libro para ver los detalles y pagar:" },
        footer: { text: "ProDig Editorial" },
        action: {
            button: "Ver productos",
            sections: [{ title: "Libros disponibles", rows }]
        }
    });
}

// ── Producto seleccionado → crear pago ──
async function procesarSeleccionProducto(to, phoneId, prodRowId) {
    const prod = await obtenerProductoPorRowId(prodRowId);
    if (!prod) {
        await enviarMensajeWhatsApp(to, phoneId, "Ese producto no está disponible. Escribe *catálogo* para ver las opciones.");
        return;
    }

    const preference = await crearPreferenceMP(prod, to);

    const msg = `📖 *${prod.title}*\n\n${prod.description}\n\n💰 *$${prod.price_cop.toLocaleString()} COP*\n\nToca el botón de abajo para pagar de forma segura con Mercado Pago.`;
    await enviarTextoConBotonWhatsApp(to, phoneId, msg, preference.init_point);
}

// ── Mercado Pago: crear preferencia de pago ──
async function crearPreferenceMP(prod, phone) {
    const externalRef = `${phone}:${prod.row_id}`;
    const body = {
        items: [{
            title: prod.title,
            description: prod.description,
            quantity: 1,
            unit_price: prod.price_cop,
            currency_id: "COP"
        }],
        external_reference: externalRef,
        notification_url: WEBHOOK_PAGO_URL,
        purpose: "wallet_purchase"
    };

    const response = await fetchWithTimeout('https://api.mercadopago.com/checkout/preferences', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`MP preference error ${response.status}: ${err}`);
    }

    return response.json();
}

// ── IPN de Mercado Pago ──
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
            const externalRef = payment.external_reference || '';
            const phoneNameId = process.env.PHONE_NUMBER_ID;

            let customerPhone = '';
            let prodRowId = '';

            if (externalRef.includes(':')) {
                const parts = externalRef.split(':');
                customerPhone = parts[0];
                prodRowId = parts[1];
            }

            if (customerPhone && prodRowId && phoneNameId) {
                const prod = await obtenerProductoPorRowId(prodRowId);
                if (prod) {
                    const pdfUrl = `${BASE_STORAGE}/${prod.pdf_filename}`;
                    await enviarDocumentoWhatsApp(customerPhone, phoneNameId, pdfUrl, prod.pdf_filename);
                }
            }
        }
    }
}

// ── Supabase: productos ──
async function obtenerProductos() {
    const response = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/productos?order=price_cop.asc`, {
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
    });
    return response.json();
}

async function obtenerProductoPorRowId(rowId) {
    const response = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/productos?row_id=eq.${rowId}&limit=1`,
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

// ── Mercado Pago: consultar pago ──
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

// ── WhatsApp: enviar mensajes ──
async function enviarMensajeWhatsApp(to, phoneId, text) {
    const token = process.env.WHATSAPP_ACCESS_TOKEN ? process.env.WHATSAPP_ACCESS_TOKEN.trim() : '';
    const response = await fetchWithTimeout(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
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

async function enviarInteractiveWhatsApp(to, phoneId, interactive) {
    const token = process.env.WHATSAPP_ACCESS_TOKEN ? process.env.WHATSAPP_ACCESS_TOKEN.trim() : '';
    const response = await fetchWithTimeout(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to, type: "interactive",
            interactive
        })
    });
    const data = await response.json();
    if (!response.ok) console.error('Error WhatsApp interactive:', data);
    return data;
}

async function enviarTextoConBotonWhatsApp(to, phoneId, text, url) {
    const token = process.env.WHATSAPP_ACCESS_TOKEN ? process.env.WHATSAPP_ACCESS_TOKEN.trim() : '';
    const response = await fetchWithTimeout(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "interactive",
            interactive: {
                type: "cta_url",
                body: { text },
                action: {
                    name: "cta_url",
                    parameters: {
                        display_text: "💳 Pagar con Mercado Pago",
                        url
                    }
                }
            }
        })
    });
    const data = await response.json();
    if (!response.ok) console.error('Error WhatsApp CTA:', data);
    return data;
}

async function enviarDocumentoWhatsApp(to, phoneId, pdfUrl, filename) {
    const token = process.env.WHATSAPP_ACCESS_TOKEN ? process.env.WHATSAPP_ACCESS_TOKEN.trim() : '';
    const response = await fetchWithTimeout(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to, type: "document",
            document: {
                link: pdfUrl,
                filename: filename || "Libro_ProDig.pdf",
                caption: "¡Aquí tienes tu libro! Gracias por tu compra."
            }
        })
    });
    const data = await response.json();
    if (!response.ok) console.error('Error WhatsApp doc:', data);
    return data;
}

// ── Startup ──
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'vercel') {
    app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
}

module.exports = app;
