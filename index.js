const express = require('express');
const cors = require('cors');
const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const FIREBASE_DB_URL = "https://mega-income-bot-9d9fa-default-rtdb.firebaseio.com";

async function updateFirebaseNode(pathNode, data) {
    try {
        await fetch(`${FIREBASE_DB_URL}/${pathNode}.json`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
    } catch (e) {
        console.error("Firebase update error:", e.message);
    }
}

async function getFirebaseNode(pathNode) {
    try {
        const res = await fetch(`${FIREBASE_DB_URL}/${pathNode}.json`);
        return await res.json();
    } catch (e) {
        console.error("Firebase read error:", e.message);
        return null;
    }
}

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.status(200).send('Mega Income Bot Backend Status: Live & Running!');
});

/*
|--------------------------------------------------------------------------
| WhatsApp Sessions
|--------------------------------------------------------------------------
*/

const sessions = {};
const pairingRequests = {};

/*
|--------------------------------------------------------------------------
| Phone Number Format
|--------------------------------------------------------------------------
*/

function normalizePhone(phone) {
    phone = String(phone || '').replace(/[^0-9]/g, '');

    if (phone.startsWith('0')) {
        phone = '88' + phone;
    }

    return phone;
}

/*
|--------------------------------------------------------------------------
| Get Disconnect Status Code
|--------------------------------------------------------------------------
*/

function getDisconnectStatusCode(lastDisconnect) {
    try {
        return (
            lastDisconnect?.error?.output?.statusCode ||
            lastDisconnect?.error?.statusCode ||
            lastDisconnect?.error?.data?.statusCode ||
            null
        );
    } catch (e) {
        return null;
    }
}

/*
|--------------------------------------------------------------------------
| Remove Session
|--------------------------------------------------------------------------
*/

function removeSessionFromMemory(phone) {
    if (sessions[phone]) {
        try {
            sessions[phone].end();
        } catch (e) {}

        delete sessions[phone];
    }
}

/*
|--------------------------------------------------------------------------
| Create WhatsApp Socket
|--------------------------------------------------------------------------
|
| reset = true
|   নতুন binding শুরু করবে এবং পুরোনো auth/session মুছে দেবে।
|
| reset = false
|   আগের saved WhatsApp session ব্যবহার করবে।
|
|--------------------------------------------------------------------------
*/

async function createWhatsAppSocket(phone, reset = false) {
    const sessionDir = path.join(__dirname, 'sessions', phone);

    /*
    |--------------------------------------------------------------------------
    | শুধু নতুন binding-এর সময় পুরোনো session মুছবে
    |--------------------------------------------------------------------------
    */

    if (reset) {
        removeSessionFromMemory(phone);

        if (fs.existsSync(sessionDir)) {
            try {
                fs.rmSync(sessionDir, {
                    recursive: true,
                    force: true
                });
            } catch (e) {
                console.error(
                    `[${phone}] পুরোনো session মুছতে সমস্যা:`,
                    e.message
                );
            }
        }
    } else {
        /*
        |--------------------------------------------------------------------------
        | reconnect করার আগে memory-এর পুরোনো socket সরানো
        |--------------------------------------------------------------------------
        */

        if (sessions[phone]) {
            try {
                sessions[phone].end();
            } catch (e) {}

            delete sessions[phone];
        }
    }

    /*
    |--------------------------------------------------------------------------
    | Auth State
    |--------------------------------------------------------------------------
    */

    const { state, saveCreds } =
        await useMultiFileAuthState(sessionDir);

    const { version } =
        await fetchLatestBaileysVersion();

    /*
    |--------------------------------------------------------------------------
    | Socket
    |--------------------------------------------------------------------------
    */

    const sock = makeWASocket({
        version,

        auth: state,

        logger: pino({
            level: 'silent'
        }),

        printQRInTerminal: false,

        browser: Browsers.ubuntu('Chrome'),

        connectTimeoutMs: 60000,

        defaultQueryTimeoutMs: 60000,

        keepAliveIntervalMs: 25000,

        emitOwnEvents: true,

        markOnlineOnConnect: true,

        syncFullHistory: false
    });

    sessions[phone] = sock;

    /*
    |--------------------------------------------------------------------------
    | Save WhatsApp Credentials
    |--------------------------------------------------------------------------
    */

    sock.ev.on('creds.update', async () => {
        try {
            await saveCreds();
        } catch (e) {
            console.error(
                `[${phone}] Credentials save error:`,
                e.message
            );
        }
    });

    /*
    |--------------------------------------------------------------------------
    | Connection Update
    |--------------------------------------------------------------------------
    */

    sock.ev.on('connection.update', async (update) => {
        const {
            connection,
            lastDisconnect
        } = update;

        /*
        |--------------------------------------------------------------------------
        | WhatsApp Pairing Code
        |--------------------------------------------------------------------------
        |
        | Code শুধু তখনই request হবে যখন socket connecting অবস্থায় যাবে।
        | Fixed 4 second timer ব্যবহার করা হচ্ছে না।
        |
        |--------------------------------------------------------------------------
        */

        if (
            connection === 'connecting' &&
            !sock.authState.creds.registered &&
            !pairingRequests[phone]
        ) {
            pairingRequests[phone] = true;

            try {
                console.log(
                    `[WhatsApp] ${phone} এর জন্য pairing code চাওয়া হচ্ছে...`
                );

                const code =
                    await sock.requestPairingCode(phone);

                console.log(
                    `[WhatsApp] ${phone} Pairing Code: ${code}`
                );

                /*
                |--------------------------------------------------------------------------
                | Code পাওয়া মানেই Linked নয়
                |--------------------------------------------------------------------------
                */

                await updateFirebaseNode(
                    `whatsapp_accounts/${phone}`,
                    {
                        status: 'pending',
                        requestedAt: Date.now(),
                        pairingCode: code
                    }
                );

                /*
                |--------------------------------------------------------------------------
                | API request-এর জন্য code store
                |--------------------------------------------------------------------------
                */

                if (!pairingRequests[phone]) {
                    pairingRequests[phone] = {};
                }

                pairingRequests[phone] = {
                    requested: true,
                    code: code
                };

            } catch (err) {
                console.error(
                    `[WhatsApp Pairing Error] ${phone}:`,
                    err.message
                );

                pairingRequests[phone] = {
                    requested: false,
                    error: err.message
                };

                await updateFirebaseNode(
                    `whatsapp_accounts/${phone}`,
                    {
                        status: 'pairing_failed',
                        error: err.message,
                        failedAt: Date.now()
                    }
                );
            }
        }

        /*
        |--------------------------------------------------------------------------
        | WhatsApp Successfully Linked
        |--------------------------------------------------------------------------
        |
        | এই জায়গাতেই আসল binding হবে।
        | শুধু code generate হলে linked হবে না।
        |
        |--------------------------------------------------------------------------
        */

        if (connection === 'open') {
            console.log(
                `[WhatsApp] ${phone} সফলভাবে লিঙ্ক হয়েছে!`
            );

            await updateFirebaseNode(
                `whatsapp_accounts/${phone}`,
                {
                    status: 'linked',
                    linkedAt: Date.now(),
                    pairingCode: null,
                    error: null
                }
            );

            /*
            |--------------------------------------------------------------------------
            | Pairing request cleanup
            |--------------------------------------------------------------------------
            */

            delete pairingRequests[phone];

            /*
            |--------------------------------------------------------------------------
            | নিশ্চিতভাবে active socket store
            |--------------------------------------------------------------------------
            */

            sessions[phone] = sock;
        }

        /*
        |--------------------------------------------------------------------------
        | Connection Closed
        |--------------------------------------------------------------------------
        */

        if (connection === 'close') {
            const statusCode =
                getDisconnectStatusCode(lastDisconnect);

            console.log(
                `[WhatsApp] ${phone} connection closed. Status: ${statusCode}`
            );

            /*
            |--------------------------------------------------------------------------
            | REAL LOGOUT
            |--------------------------------------------------------------------------
            */

            if (
                statusCode === DisconnectReason.loggedOut
            ) {
                console.log(
                    `[WhatsApp] ${phone} থেকে logout হয়েছে।`
                );

                await updateFirebaseNode(
                    `whatsapp_accounts/${phone}`,
                    {
                        status: 'logged_out',
                        disconnectedAt: Date.now()
                    }
                );

                delete pairingRequests[phone];

                if (sessions[phone] === sock) {
                    delete sessions[phone];
                }

                /*
                |--------------------------------------------------------------------------
                | Logout হলে auth/session মুছে ফেলবে
                |--------------------------------------------------------------------------
                */

                if (fs.existsSync(sessionDir)) {
                    try {
                        fs.rmSync(sessionDir, {
                            recursive: true,
                            force: true
                        });
                    } catch (e) {
                        console.error(
                            `[${phone}] Logout session delete error:`,
                            e.message
                        );
                    }
                }

                return;
            }

            /*
            |--------------------------------------------------------------------------
            | Temporary Disconnect / Restart Required
            |--------------------------------------------------------------------------
            |
            | 515 / restartRequired-কে permanent logout ধরা হবে না।
            | Saved credentials ব্যবহার করে আবার socket চালু হবে।
            |
            |--------------------------------------------------------------------------
            */

            if (
                statusCode === DisconnectReason.restartRequired ||
                statusCode === DisconnectReason.connectionClosed ||
                statusCode === DisconnectReason.connectionLost ||
                statusCode === DisconnectReason.timedOut ||
                statusCode === DisconnectReason.multideviceMismatch
            ) {
                console.log(
                    `[WhatsApp] ${phone} reconnect করা হচ্ছে...`
                );

                if (sessions[phone] === sock) {
                    delete sessions[phone];
                }

                /*
                |--------------------------------------------------------------------------
                | Reconnect-এর আগে Firebase-এ temporary status
                |--------------------------------------------------------------------------
                */

                await updateFirebaseNode(
                    `whatsapp_accounts/${phone}`,
                    {
                        status:
                            sock.authState.creds.registered
                                ? 'reconnecting'
                                : 'pending',
                        reconnectingAt: Date.now()
                    }
                );

                /*
                |--------------------------------------------------------------------------
                | কিছু delay দিয়ে নতুন socket
                |--------------------------------------------------------------------------
                */

                setTimeout(async () => {
                    try {
                        await createWhatsAppSocket(
                            phone,
                            false
                        );
                    } catch (e) {
                        console.error(
                            `[${phone}] Reconnect error:`,
                            e.message
                        );
                    }
                }, 1500);

                return;
            }

            /*
            |--------------------------------------------------------------------------
            | অন্য কোনো unexpected disconnect
            |--------------------------------------------------------------------------
            */

            if (sessions[phone] === sock) {
                delete sessions[phone];
            }

            /*
            |--------------------------------------------------------------------------
            | যদি session registered থাকে, reconnect করার চেষ্টা
            |--------------------------------------------------------------------------
            */

            if (
                sock.authState &&
                sock.authState.creds &&
                sock.authState.creds.registered
            ) {
                console.log(
                    `[WhatsApp] ${phone} unexpected disconnect — reconnecting...`
                );

                await updateFirebaseNode(
                    `whatsapp_accounts/${phone}`,
                    {
                        status: 'reconnecting',
                        reconnectingAt: Date.now()
                    }
                );

                setTimeout(async () => {
                    try {
                        await createWhatsAppSocket(
                            phone,
                            false
                        );
                    } catch (e) {
                        console.error(
                            `[${phone}] Unexpected reconnect error:`,
                            e.message
                        );
                    }
                }, 2000);
            }
        }
    });

    return sock;
}

/*
|--------------------------------------------------------------------------
| GET PAIRING CODE
|--------------------------------------------------------------------------
*/

app.post('/api/get-code', async (req, res) => {
    let { phone } = req.body;

    if (!phone) {
        return res.status(400).json({
            success: false,
            error: 'Phone number required'
        });
    }

    phone = normalizePhone(phone);

    /*
    |--------------------------------------------------------------------------
    | Number already linked?
    |--------------------------------------------------------------------------
    */

    const existingAccount =
        await getFirebaseNode(
            `whatsapp_accounts/${phone}`
        );

    if (
        existingAccount &&
        existingAccount.status === 'linked'
    ) {
        return res.json({
            success: false,
            error: 'এই নম্বরটি ইতিমধ্যে লিঙ্কড আছে।'
        });
    }

    /*
    |--------------------------------------------------------------------------
    | পুরোনো pending pairing থাকলে নতুন socket বানানো
    |--------------------------------------------------------------------------
    */

    try {
        delete pairingRequests[phone];

        /*
        |--------------------------------------------------------------------------
        | নতুন binding-এর জন্য নতুন socket
        |--------------------------------------------------------------------------
        */

        await createWhatsAppSocket(
            phone,
            true
        );

        /*
        |--------------------------------------------------------------------------
        | Pairing code event থেকে আসা পর্যন্ত অপেক্ষা
        |--------------------------------------------------------------------------
        |
        | Fixed 4 second নয়।
        | সর্বোচ্চ 30 second অপেক্ষা করবে।
        |
        |--------------------------------------------------------------------------
        */

        const maxWait = 30000;
        const started = Date.now();

        while (Date.now() - started < maxWait) {
            const request =
                pairingRequests[phone];

            if (
                request &&
                request.requested &&
                request.code
            ) {
                return res.json({
                    success: true,
                    code: request.code,
                    status: 'pending'
                });
            }

            if (
                request &&
                request.error
            ) {
                return res.status(500).json({
                    success: false,
                    error:
                        'WhatsApp pairing code তৈরি করা যায়নি: ' +
                        request.error
                });
            }

            await new Promise(resolve =>
                setTimeout(resolve, 300)
            );
        }

        return res.status(504).json({
            success: false,
            error:
                'WhatsApp pairing code তৈরি হতে সময় লাগছে। কিছুক্ষণ পর আবার চেষ্টা করুন।'
        });

    } catch (err) {
        console.error(
            '[Pairing Error]:',
            err.message
        );

        return res.status(500).json({
            success: false,
            error:
                'কোড পেতে সমস্যা হয়েছে: ' +
                err.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| CHECK WHATSAPP ACCOUNT STATUS
|--------------------------------------------------------------------------
|
| Frontend চাইলে এই endpoint ব্যবহার করে status জানতে পারবে।
|
|--------------------------------------------------------------------------
*/

app.get('/api/whatsapp-status/:phone', async (req, res) => {
    let phone = normalizePhone(
        req.params.phone
    );

    const account =
        await getFirebaseNode(
            `whatsapp_accounts/${phone}`
        );

    if (!account) {
        return res.json({
            success: true,
            status: 'not_found'
        });
    }

    return res.json({
        success: true,
        status: account.status || 'unknown',
        linkedAt: account.linkedAt || null,
        disconnectedAt:
            account.disconnectedAt || null
    });
});

/*
|--------------------------------------------------------------------------
| SEND WHATSAPP MESSAGE
|--------------------------------------------------------------------------
*/

app.post('/api/send-message', async (req, res) => {
    let {
        senderPhone,
        targetPhone,
        message
    } = req.body;

    if (
        !senderPhone ||
        !targetPhone ||
        !message
    ) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters'
        });
    }

    senderPhone =
        normalizePhone(senderPhone);

    targetPhone =
        normalizePhone(targetPhone);

    try {
        /*
        |--------------------------------------------------------------------------
        | Firebase থেকে account status যাচাই
        |--------------------------------------------------------------------------
        */

        const accountData =
            await getFirebaseNode(
                `whatsapp_accounts/${senderPhone}`
            );

        if (
            !accountData ||
            accountData.status !== 'linked'
        ) {
            return res.json({
                success: false,
                reward: 0,
                status: 'Unlinked or Logged Out',
                error:
                    'নম্বরটি যুক্ত করা নেই অথবা লগআউট হয়ে গেছে।'
            });
        }

        /*
        |--------------------------------------------------------------------------
        | Active socket
        |--------------------------------------------------------------------------
        */

        const sock =
            sessions[senderPhone];

        if (!sock) {
            return res.json({
                success: false,
                reward: 0,
                status: 'Failed',
                error:
                    'WhatsApp session সক্রিয় নেই।'
            });
        }

        /*
        |--------------------------------------------------------------------------
        | Target JID
        |--------------------------------------------------------------------------
        */

        const jid =
            `${targetPhone}@s.whatsapp.net`;

        /*
        |--------------------------------------------------------------------------
        | Message Send
        |--------------------------------------------------------------------------
        */

        const sent =
            await sock.sendMessage(
                jid,
                {
                    text: message
                }
            );

        /*
        |--------------------------------------------------------------------------
        | Message object পাওয়া গেলে send request সফল
        |--------------------------------------------------------------------------
        */

        if (sent && sent.key) {
            return res.json({
                success: true,
                reward: 2,
                status: 'Sent',
                messageId:
                    sent.key.id || null
            });
        }

        return res.json({
            success: false,
            reward: 0,
            status: 'Failed',
            error:
                'WhatsApp message send করা যায়নি।'
        });

    } catch (err) {
        console.error(
            '[Send Message Error]:',
            err.message
        );

        return res.json({
            success: false,
            reward: 0,
            status: 'Failed',
            error: err.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| SERVER
|--------------------------------------------------------------------------
*/

const PORT =
    process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(
        `Server running on port ${PORT}`
    );
});
