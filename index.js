require('dotenv').config();
const express = require('express');
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
        // 2. Validar que sea un evento de mensaje de WhatsApp válido
        if (body.object &&
            body.entry &&
            body.entry[0].changes &&
            body.entry[0].changes[0].value.messages) {

            const messageData = body.entry[0].changes[0].value.messages[0];
            const customerPhone = messageData.from; // El número de celular del cliente
            const phoneNameId = body.entry[0].changes[0].value.metadata.phone_number_id;

            // Evitar procesar nuestros propios mensajes enviados
            if (messageData.type === 'text') {
                const userMessage = messageData.text.body.trim().toLowerCase();
                console.log(`Mensaje de ${customerPhone}: ${userMessage}`);

                // 3. Flujo del MVP: Si el usuario escribe algo relacionado con el libro
                if (userMessage.includes('libro') || userMessage.includes('comprar') || userMessage.includes('materia')) {

                    // Aquí llamaremos a la pasarela para generar el link real de 10,000 COP
                    const linkDePagoReal = "https://mpago.li/2upFTB5";

                    const textoRespuesta = `¡Hola! Gracias por tu interés en el libro "Materia Programable y la Próxima Revolución Digital" de ProDig. \n\nEl costo es de $10.000 COP. Puedes realizar el pago de manera 100% segura aquí: ${linkDePagoReal}\n\nTan pronto se confirme el débito, recibirás el libro en formato PDF directamente por este chat.`;

                    // Enviar el mensaje de respuesta mediante la API de Meta
                    await enviarMensajeWhatsApp(customerPhone, phoneNameId, textoRespuesta);
                }
            }
        }
    } catch (error) {
        console.error('Error procesando el webhook de Meta:', error);
    }
});

// Función auxiliar para enviar mensajes de texto usando axios o fetch nativo
async function enviarMensajeWhatsApp(to, phoneId, text) {
    const url = `https://graph.facebook.com/v25.0/${phoneId}/messages`;

    const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "text",
        text: { preview_url: true, body: text }
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Meta API Error: ${errText}`);
    }
    console.log(`Mensaje enviado con éxito a ${to}`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));
