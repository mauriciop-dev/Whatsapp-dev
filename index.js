require('dotenv').config();
const express = require('express');
const https = require('https');
const app = express();

app.use(express.json());

// 1. ENDPOINT DE VERIFICACIÓN (Para que Meta valide tu servidor)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // Pon el mismo token que inventes aquí en el dashboard de Meta
    const MY_VERIFY_TOKEN = process.env.VERIFY_TOKEN || "prodig_secret_token";

    if (mode && token) {
        if (mode === 'subscribe' && token === MY_VERIFY_TOKEN) {
            console.log('¡Webhook verificado con éxito!');
            return res.status(200).send(challenge);
        } else {
            return res.sendStatus(403);
        }
    }
});

// 2. ENDPOINT DE RECEPCIÓN (Aquí llegan los mensajes del usuario)
app.post('/webhook', async (req, res) => {
    const body = req.body;

    // 1. Responder de inmediato a Meta para cumplir el acuerdo de < 3 segundos
    res.status(200).send('EVENT_RECEIVED');

    try {
        // 2. Validar de forma segura que sea un evento de mensaje de WhatsApp que CONTENGA mensajes
        if (body.object &&
            body.entry &&
            body.entry[0].changes &&
            body.entry[0].changes[0].value &&
            body.entry[0].changes[0].value.messages &&
            body.entry[0].changes[0].value.messages[0]) {

            const messageData = body.entry[0].changes[0].value.messages[0];
            const from = messageData.from;
            const phoneId = body.entry[0].changes[0].value.metadata.phone_number_id;

            // Validar que el mensaje recibido sea estrictamente de tipo texto
            if (messageData.type === 'text' && messageData.text && messageData.text.body) {
                const text = messageData.text.body.trim().toLowerCase();
                console.log(`Mensaje de texto procesado de ${from}: "${text}"`);

                if (text === 'libro') {
                    const respuesta = `¡Hola! Gracias por tu interés en el libro "Materia Programable y la Próxima Revolución Digital" de ProDig.\n\nEl costo es de $10.000 COP. Puedes realizar el pago de manera 100% segura aquí: https://mpago.li/2upFTB5\n\nTan pronto se confirme el débito, recibirás el libro en formato PDF directamente por este chat.`;

                    await enviarMensajeWhatsApp(from, phoneId, respuesta);
                }
            } else {
                console.log(`Se recibió un evento de WhatsApp pero no era un texto (Tipo: ${messageData.type})`);
            }
        } else if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.statuses) {
            console.log("Notificación de estado recibida (entregado/leído). No requiere respuesta.");
        }
    } catch (error) {
        console.error('Error crítico procesando el webhook de WhatsApp:', error);
    }
});

// 3. ENDPOINT DE IPN (Mercado Pago notifica aquí cuando hay un pago)
app.post('/webhook-pago', async (req, res) => {
    res.status(200).send('OK');

    try {
        const notification = req.body;
        console.log('IPN recibido:', JSON.stringify(notification, null, 2));

        if (notification.type === 'payment') {
            const paymentId = notification.data.id;
            const payment = await obtenerPagoMercadoPago(paymentId);

            if (payment.status === 'approved') {
                const customerPhone = payment.payer?.phone?.number || payment.external_reference;
                const phoneNameId = process.env.PHONE_NUMBER_ID;

                if (customerPhone && phoneNameId) {
                    const textoRespuesta = `¡Gracias por tu compra! Aquí tienes tu libro "Materia Programable y la Próxima Revolución Digital" en formato PDF:\n\nhttps://fvdltrqzdosqkebsydqn.supabase.co/storage/v1/object/public/Libros/materia_programable_prodig.pdf\n\n¡Disfruta la lectura!`;

                    await enviarMensajeWhatsApp(customerPhone, phoneNameId, textoRespuesta);
                }
            }
        }
    } catch (error) {
        console.error('Error procesando IPN de Mercado Pago:', error);
    }
});

function obtenerPagoMercadoPago(paymentId) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.mercadopago.com',
            path: `/v1/payments/${paymentId}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(data));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

async function enviarMensajeWhatsApp(to, phoneId, text) {
    const token = process.env.WHATSAPP_ACCESS_TOKEN ? process.env.WHATSAPP_ACCESS_TOKEN.trim() : '';

    const url = `https://graph.facebook.com/v25.0/${phoneId}/messages`;

    const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "text",
        text: {
            preview_url: false,
            body: text
        }
    };

    console.log(`Iniciando petición HTTPS segura a Meta para el número: ${to}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log("Respuesta cruda de Meta:", JSON.stringify(data));
    return data;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));
