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

// 2. ENDPOINT DE RECEPCIÓN (Aquí llegarán los clics y mensajes de WhatsApp)
app.post('/webhook', (req, res) => {
    const body = req.body;

    // Le respondemos a Meta de inmediato (LINEAMIENTO CRÍTICO: < 3 segundos)
    res.status(200).send('EVENT_RECEIVED');

    // Procesamos el mensaje en segundo plano
    if (body.object === 'page' || body.object === 'whatsapp_business_account') {
        console.log('Mensaje recibido de WhatsApp:', JSON.stringify(body, null, 2));
        // Aquí programaremos la lógica del pago y envío del PDF en el siguiente paso
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));
