const express = require('express');
const cors = require('cors');

const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs');
const path = require('path');

const FIREBASE_DB_URL =
    "https://mega-income-bot-9d9fa-default-rtdb.firebaseio.com";

const PORT = process.env.PORT || 3000;

const app = express();

app.use(cors());
app.use(express.json());

/*
====================================================
FIREBASE
====================================================
*/

async function updateFirebaseNode(pathNode, data) {
    try {
        const response = await fetch(
            `${FIREBASE_DB_URL}/${pathNode}.json`,
            {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            }
        );

        if (!response.ok) {
            console.error(
                `[Firebase] Update failed: ${response.status}`
            );
        }
    } catch (error) {
        console.error(
            '[Firebase update error]',
            error.message
        );
    }
}

async function getFirebaseNode(pathNode) {
    try {
        const response = await fetch(
            `${FIREBASE_DB_URL}/${pathNode}.json`
        );

        if (!response.ok) {
            return null;
        }

        return await response.json();
    } catch (error) {
        console.error(
            '[Firebase read error]',
            error.message
        );

        return null;
    }
}

/*
====================================================
PHONE NUMBER NORMALIZATION
====================================================

Bangladesh examples:

01337176976
8801337176976
+8801337176976
+880 1337176976

সব একই canonical format হবে:

8801337176976
*/

function normalizePhone(phone) {
    if (!phone) {
        return '';
    }

    let value = String(phone).replace(/\D/g, '');

    if (value.startsWith('00880')) {
        value = value.substring(2);
    }

    if (value.startsWith('8800')) {
        value = '88' + value.substring(3);
    }

    if (value.startsWith('0')) {
        value = '880' + value.substring(1);
    }

    if (value.startsWith('880')) {
        return value;
    }

    return value;
}

/*
====================================================
SESSION STORAGE
====================================================
*/

const sessionsRoot = path.join(__dirname, 'sessions');

if (!fs.existsSync(sessionsRoot)) {
    fs.mkdirSync(sessionsRoot, {
        recursive: true
    });
}

/*
====================================================
ACTIVE SOCKETS
====================================================
*/

const sessions = {};

/*
একই নম্বরে একই সময়ে একাধিক
pairing request আটকানোর জন্য।
*/

const pairingLocks = {};

/*
Pairing status memory
*/

const pairingStates = {};

/*
====================================================
HELPERS
====================================================
*/

function getSessionDir(phone) {
    return path.join(
        sessionsRoot,
        phone
    );
}

function removeSessionDir(phone) {
    const sessionDir = getSessionDir(phone);

    if (fs.existsSync(sessionDir)) {
        try {
            fs.rmSync(sessionDir, {
                recursive: true,
                force: true
            });
        } catch (error) {
            console.error(
                `[Session remove error] ${phone}:`,
                error.message
            );
        }
    }
}

function closeSocket(phone) {
    const sock = sessions[phone];

    if (!sock) {
        return;
    }

    try {
        sock.end();
    } catch (error) {}

    delete sessions[phone];
}

/*
====================================================
CONNECTION ERROR CODE
====================================================
*/

function getDisconnectCode(lastDisconnect) {
    return (
        lastDisconnect &&
        lastDisconnect.error &&
        lastDisconnect.error.output &&
        lastDisconnect.error.output.statusCode
    );
}

function getErrorMessage(error) {
    if (!error) {
        return '';
    }

    return String(
        error.message ||
        error.data ||
        error
    ).toLowerCase();
}

/*
====================================================
FIREBASE STATUS HELPERS
====================================================
*/

async function markPending(phone) {
    await updateFirebaseNode(
        `whatsapp_accounts/${phone}`,
        {
            status: 'pending',
            requestedAt: Date.now()
        }
    );
}

async function markLinked(phone) {
    await updateFirebaseNode(
        `whatsapp_accounts/${phone}`,
        {
            status: 'linked',
            linkedAt: Date.now(),
            lastSeenAt: Date.now()
        }
    );
}

async function markLoggedOut(phone, reason) {
    await updateFirebaseNode(
        `whatsapp_accounts/${phone}`,
        {
            status: 'logged_out',
            disconnectedAt: Date.now(),
            disconnectReason: reason || 'logged_out'
        }
    );
}

async function markFailed(phone, reason) {
    await updateFirebaseNode(
        `whatsapp_accounts/${phone}`,
        {
            status: 'failed',
            failedAt: Date.now(),
            error: reason || 'pairing_failed'
        }
    );
}

/*
====================================================
SOCKET CREATION
====================================================
*/

async function createSocket(
    phone,
    options = {}
) {
    const sessionDir = getSessionDir(phone);

    /*
    নতুন pairing-এর জন্য fresh session দরকার।
    reconnect-এর সময় session মুছবে না।
    */

    if (options.fresh === true) {
        closeSocket(phone);
        removeSessionDir(phone);
    }

    const authState =
        await useMultiFileAuthState(sessionDir);

    const state = authState.state;
    const saveCreds = authState.saveCreds;

    let version;

    try {
        const latest =
            await fetchLatestBaileysVersion();

        version = latest.version;

        console.log(
            `[WhatsApp] ${phone} using WA version: ${version.join('.')}`
        );
    } catch (error) {
        console.error(
            '[WhatsApp] Could not fetch latest version:',
            error.message
        );

        /*
        fallback version
        */
        version = [2, 3000, 1035194821];
    }

    /*
    Pairing-code-এর জন্য official Browser helper।
    */

    const browser =
        Browsers.windows('Chrome');

    const sock = makeWASocket({
        version,

        auth: {
            creds: state.creds,

            keys: makeCacheableSignalKeyStore(
                state.keys,
                pino({
                    level: 'silent'
                })
            )
        },

        logger: pino({
            level: 'silent'
        }),

        browser,

        printQRInTerminal: false,

        connectTimeoutMs: 60000,

        defaultQueryTimeoutMs: 60000,

        retryRequestDelayMs: 250,

        maxMsgRetryCount: 5,

        syncFullHistory: false,

        markOnlineOnConnect: true,

        generateHighQualityLinkPreview: false,

        emitOwnEvents: true
    });

    sessions[phone] = sock;

    /*
    ==================================================
    EVENT PROCESSOR

    creds.update আগে save হবে।
    তারপর connection.update handle হবে।
    ==================================================
    */

    sock.ev.process(
        async (events) => {

            /*
            ------------------------------------------
            CREDENTIALS UPDATE
            ------------------------------------------
            */

            if (events['creds.update']) {
                try {
                    await saveCreds();

                    console.log(
                        `[WhatsApp] Credentials saved: ${phone}`
                    );
                } catch (error) {
                    console.error(
                        `[WhatsApp] Credential save error ${phone}:`,
                        error.message
                    );
                }
            }

            /*
            ------------------------------------------
            CONNECTION UPDATE
            ------------------------------------------
            */

            if (events['connection.update']) {

                const update =
                    events['connection.update'];

                const connection =
                    update.connection;

                const lastDisconnect =
                    update.lastDisconnect;

                const statusCode =
                    getDisconnectCode(
                        lastDisconnect
                    );

                /*
                ======================================
                NEW LOGIN DETECTED
                ======================================
                */

                if (update.isNewLogin) {

                    console.log(
                        `[WhatsApp] NEW LOGIN / PAIR SUCCESS: ${phone}`
                    );

                    if (pairingStates[phone]) {
                        pairingStates[phone].paired =
                            true;
                    }

                    await updateFirebaseNode(
                        `whatsapp_accounts/${phone}`,
                        {
                            status: 'pairing_confirmed',
                            pairingConfirmedAt: Date.now()
                        }
                    );
                }

                /*
                ======================================
                CONNECTING
                ======================================
                */

                if (connection === 'connecting') {

                    console.log(
                        `[WhatsApp] Connecting: ${phone}`
                    );

                    if (pairingStates[phone]) {
                        pairingStates[phone].connecting =
                            true;
                    }
                }

                /*
                ======================================
                OPEN = REAL LINKED
                ======================================
                */

                if (connection === 'open') {

                    console.log(
                        `[WhatsApp] SUCCESSFULLY LINKED: ${phone}`
                    );

                    if (pairingStates[phone]) {
                        pairingStates[phone].linked =
                            true;

                        pairingStates[phone].paired =
                            true;
                    }

                    await markLinked(phone);

                    return;
                }

                /*
                ======================================
                CONNECTION CLOSED
                ======================================
                */

                if (connection === 'close') {

                    const errorMessage =
                        getErrorMessage(
                            lastDisconnect &&
                            lastDisconnect.error
                        );

                    console.log(
                        `[WhatsApp] Connection closed: ${phone} | code=${statusCode} | ${errorMessage}`
                    );

                    /*
                    ----------------------------------
                    515 = RESTART REQUIRED

                    এটি logout নয়।
                    Saved credentials দিয়ে
                    নতুন socket চালু করতে হবে।
                    ----------------------------------
                    */

                    if (
                        statusCode ===
                        DisconnectReason.restartRequired
                    ) {

                        console.log(
                            `[WhatsApp] 515 restart required: ${phone}`
                        );

                        delete sessions[phone];

                        /*
                        কোনো session delete নয়।
                        কোনো Firebase logout নয়।
                        */

                        setTimeout(
                            async () => {

                                try {

                                    const sessionDir =
                                        getSessionDir(phone);

                                    if (
                                        !fs.existsSync(
                                            sessionDir
                                        )
                                    ) {
                                        console.error(
                                            `[WhatsApp] Session missing after 515: ${phone}`
                                        );

                                        await markFailed(
                                            phone,
                                            'session_missing_after_restart'
                                        );

                                        return;
                                    }

                                    console.log(
                                        `[WhatsApp] Reconnecting with saved credentials: ${phone}`
                                    );

                                    await createSocket(
                                        phone,
                                        {
                                            fresh: false
                                        }
                                    );

                                } catch (error) {

                                    console.error(
                                        `[WhatsApp] 515 reconnect error ${phone}:`,
                                        error.message
                                    );

                                    await markFailed(
                                        phone,
                                        error.message
                                    );
                                }

                            },
                            0
                        );

                        return;
                    }

                    /*
                    ----------------------------------
                    LOGGED OUT / DEVICE REMOVED
                    ----------------------------------
                    */

                    const isLoggedOut =
                        statusCode ===
                        DisconnectReason.loggedOut;

                    const isForbidden =
                        statusCode ===
                        DisconnectReason.forbidden;

                    const deviceRemoved =
                        errorMessage.includes(
                            'device_removed'
                        ) ||
                        errorMessage.includes(
                            'logged out'
                        );

                    if (
                        isLoggedOut ||
                        isForbidden ||
                        deviceRemoved
                    ) {

                        console.log(
                            `[WhatsApp] LOGGED OUT / REMOVED: ${phone}`
                        );

                        await markLoggedOut(
                            phone,
                            `disconnect_${statusCode || 'unknown'}`
                        );

                        delete sessions[phone];

                        if (
                            pairingStates[phone]
                        ) {
                            pairingStates[phone].linked =
                                false;
                        }

                        removeSessionDir(
                            phone
                        );

                        return;
                    }

                    /*
                    ----------------------------------
                    OTHER TEMPORARY CONNECTION ERRORS

                    Pairing-এর সময় 400/408 ইত্যাদি
                    হলে pending pairing failed।
                    ----------------------------------
                    */

                    if (
                        pairingStates[phone] &&
                        pairingStates[phone].waitingForPairing
                    ) {

                        /*
                        যদি pairing এখনো complete না হয়ে
                        connection বন্ধ হয়ে যায়, তাহলে
                        pending request failed ধরা হবে।
                        */

                        if (
                            !pairingStates[phone].paired
                        ) {

                            await markFailed(
                                phone,
                                `pairing_connection_closed_${statusCode || 'unknown'}`
                            );

                            pairingStates[phone].failed =
                                true;
                        }
                    }

                    /*
                    ----------------------------------
                    LINKED SESSION-এর temporary
                    disconnect হলে reconnect
                    ----------------------------------
                    */

                    if (
                        pairingStates[phone] &&
                        pairingStates[phone].paired
                    ) {

                        delete sessions[phone];

                        setTimeout(
                            async () => {

                                try {

                                    /*
                                    session এখনো থাকলে
                                    reconnect করবে।
                                    */

                                    if (
                                        fs.existsSync(
                                            getSessionDir(
                                                phone
                                            )
                                        )
                                    ) {

                                        console.log(
                                            `[WhatsApp] Temporary disconnect, reconnecting: ${phone}`
                                        );

                                        await createSocket(
                                            phone,
                                            {
                                                fresh: false
                                            }
                                        );
                                    }

                                } catch (error) {

                                    console.error(
                                        `[WhatsApp] Reconnect error ${phone}:`,
                                        error.message
                                    );
                                }

                            },
                            1000
                        );

                        return;
                    }
                }
            }
        }
    );

    /*
    ==================================================
    LOW LEVEL FAILURE EVENT

    Pairing request server-side reject হলে
    pairing state-কে failed করা হবে।
    ==================================================
    */

    if (
        sock.ws &&
        typeof sock.ws.on === 'function'
    ) {

        sock.ws.on(
            'CB:failure',
            async (json) => {

                console.error(
                    `[WhatsApp] Server failure for ${phone}:`,
                    JSON.stringify(json)
                );

                if (
                    pairingStates[phone] &&
                    pairingStates[phone].waitingForPairing &&
                    !pairingStates[phone].paired
                ) {

                    pairingStates[phone].failed =
                        true;

                    await markFailed(
                        phone,
                        'whatsapp_server_rejected_pairing'
                    );
                }
            }
        );
    }

    return {
        sock,
        state
    };
}

/*
====================================================
WAIT FOR SOCKET READY
====================================================
*/

async function waitForSocketReady(
    phone,
    sock,
    timeout = 20000
) {
    return new Promise(
        (resolve, reject) => {

            let finished = false;

            const finish = (
                error
            ) => {

                if (finished) {
                    return;
                }

                finished = true;

                clearTimeout(timer);

                try {
                    sock.ev.off(
                        'connection.update',
                        listener
                    );
                } catch (e) {}

                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };

            const listener =
                (update) => {

                    if (
                        update.connection ===
                        'connecting'
                    ) {

                        finish();
                    }

                    if (
                        update.connection ===
                        'open'
                    ) {

                        finish();
                    }

                    if (
                        update.connection ===
                        'close'
                    ) {

                        const code =
                            getDisconnectCode(
                                update.lastDisconnect
                            );

                        if (
                            code &&
                            code !==
                            DisconnectReason.restartRequired
                        ) {

                            finish(
                                new Error(
                                    `WhatsApp connection closed before pairing: ${code}`
                                )
                            );
                        }
                    }
                };

            const timer =
                setTimeout(
                    () => {

                        finish(
                            new Error(
                                'WhatsApp socket ready হতে সময় বেশি লাগছে।'
                            )
                        );

                    },
                    timeout
                );

            sock.ev.on(
                'connection.update',
                listener
            );
        }
    );
}

/*
====================================================
HOME
====================================================
*/

app.get(
    '/',
    (req, res) => {

        res.status(200).send(
            'Mega Income Bot Backend Status: Live & Running!'
        );
    }
);

/*
====================================================
GET PAIRING CODE
====================================================
*/

app.post(
    '/api/get-code',
    async (req, res) => {

        let phone =
            normalizePhone(
                req.body &&
                req.body.phone
            );

        if (!phone) {

            return res.status(400).json({
                success: false,
                error: 'Phone number required'
            });
        }

        /*
        একই নম্বরে দ্বিতীয় request আটকানো।
        */

        if (pairingLocks[phone]) {

            return res.status(409).json({
                success: false,
                error:
                    'এই নম্বরের জন্য ইতিমধ্যে একটি লিংকিং প্রক্রিয়া চলছে।'
            });
        }

        pairingLocks[phone] = true;

        try {

            /*
            ------------------------------------------
            Firebase-এ আগেই linked থাকলে নতুন code নয়।
            ------------------------------------------
            */

            const existing =
                await getFirebaseNode(
                    `whatsapp_accounts/${phone}`
                );

            if (
                existing &&
                existing.status === 'linked'
            ) {

                return res.json({
                    success: false,
                    error:
                        'এই নম্বরটি ইতিমধ্যে বাঁধা আছে।'
                });
            }

            /*
            ------------------------------------------
            পুরোনো socket বন্ধ
            ------------------------------------------
            */

            closeSocket(phone);

            /*
            ------------------------------------------
            Fresh pairing state
            ------------------------------------------
            */

            pairingStates[phone] = {
                waitingForPairing: true,
                connecting: false,
                paired: false,
                linked: false,
                failed: false,
                requestedAt: Date.now()
            };

            /*
            ------------------------------------------
            Firebase pending
            ------------------------------------------
            */

            await markPending(phone);

            /*
            ------------------------------------------
            Fresh socket
            ------------------------------------------
            */

            const result =
                await createSocket(
                    phone,
                    {
                        fresh: true
                    }
                );

            const sock =
                result.sock;

            /*
            ------------------------------------------
            Socket ready হওয়া পর্যন্ত অপেক্ষা
            ------------------------------------------
            */

            await waitForSocketReady(
                phone,
                sock,
                20000
            );

            /*
            ------------------------------------------
            Already registered?
            ------------------------------------------
            */

            if (
                sock.authState &&
                sock.authState.creds &&
                sock.authState.creds.registered
            ) {

                await markLinked(phone);

                return res.json({
                    success: false,
                    error:
                        'এই নম্বরটি ইতিমধ্যে WhatsApp-এ linked আছে।'
                });
            }

            /*
            ------------------------------------------
            একটি মাত্র pairing request
            ------------------------------------------
            */

            if (
                pairingStates[phone].codeRequested
            ) {

                return res.status(409).json({
                    success: false,
                    error:
                        'Pairing code ইতিমধ্যে তৈরি হয়েছে।'
                });
            }

            pairingStates[phone].codeRequested =
                true;

            console.log(
                `[WhatsApp] Requesting pairing code: ${phone}`
            );

            let code;

            try {

                code =
                    await sock.requestPairingCode(
                        phone
                    );

            } catch (error) {

                console.error(
                    `[WhatsApp] Pairing code request failed ${phone}:`,
                    error.message
                );

                await markFailed(
                    phone,
                    error.message
                );

                delete pairingStates[phone];

                return res.status(500).json({
                    success: false,
                    error:
                        'WhatsApp pairing code তৈরি করতে পারেনি। আবার চেষ্টা করুন।'
                });
            }

            /*
            ------------------------------------------
            IMPORTANT:

            Baileys-এর requestPairingCode বর্তমানে
            server rejection-এর আগেই code return
            করতে পারে।

            তাই অতি অল্প সময় server failure
            detect করার সুযোগ দেওয়া হচ্ছে।

            1.5 sec-এর মধ্যে server failure হলে
            code দেখানো হবে না।
            ------------------------------------------
            */

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        1500
                    )
            );

            if (
                pairingStates[phone] &&
                pairingStates[phone].failed
            ) {

                delete pairingStates[phone];

                return res.status(400).json({
                    success: false,
                    error:
                        'WhatsApp server এই pairing request গ্রহণ করেনি। আবার কোড নিন।'
                });
            }

            /*
            ------------------------------------------
            Code format
            ------------------------------------------
            */

            const cleanCode =
                String(code)
                    .replace(/\s+/g, '')
                    .toUpperCase();

            console.log(
                `[WhatsApp] Pairing code generated for ${phone}: ${cleanCode}`
            );

            return res.json({
                success: true,
                code: cleanCode,
                phone: phone,
                status: 'pending'
            });

        } catch (error) {

            console.error(
                `[Pairing Error] ${phone}:`,
                error
            );

            await markFailed(
                phone,
                error.message
            );

            return res.status(500).json({
                success: false,
                error:
                    'কোড পেতে সমস্যা হয়েছে: ' +
                    error.message
            });

        } finally {

            delete pairingLocks[phone];
        }
    }
);

/*
====================================================
CHECK WHATSAPP ACCOUNT STATUS
====================================================
*/

app.get(
    '/api/whatsapp-status/:phone',
    async (req, res) => {

        const phone =
            normalizePhone(
                req.params.phone
            );

        if (!phone) {

            return res.status(400).json({
                success: false,
                error:
                    'Invalid phone number'
            });
        }

        const firebaseData =
            await getFirebaseNode(
                `whatsapp_accounts/${phone}`
            );

        const sock =
            sessions[phone];

        let liveStatus =
            firebaseData &&
            firebaseData.status
                ? firebaseData.status
                : 'not_linked';

        if (
            sock &&
            sock.user
        ) {
            liveStatus = 'linked';
        }

        return res.json({
            success: true,
            phone,
            status: liveStatus,
            connected: !!sock,
            linked: !!(
                sock &&
                sock.user
            )
        });
    }
);

/*
====================================================
SEND MESSAGE
====================================================
*/

app.post(
    '/api/send-message',
    async (req, res) => {

        let senderPhone =
            normalizePhone(
                req.body &&
                req.body.senderPhone
            );

        let targetPhone =
            normalizePhone(
                req.body &&
                req.body.targetPhone
            );

        const message =
            req.body &&
            req.body.message;

        if (
            !senderPhone ||
            !targetPhone ||
            !message
        ) {

            return res.status(400).json({
                success: false,
                error:
                    'Missing required parameters'
            });
        }

        try {

            /*
            ------------------------------------------
            Firebase status check
            ------------------------------------------
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
                    status:
                        'Unlinked or Logged Out',
                    error:
                        'নম্বরটি যুক্ত করা নেই অথবা লগআউট হয়ে গেছে।'
                });
            }

            /*
            ------------------------------------------
            Live socket
            ------------------------------------------
            */

            const sock =
                sessions[senderPhone];

            if (!sock) {

                return res.json({
                    success: false,
                    reward: 0,
                    status: 'Failed',
                    error:
                        'WhatsApp সেশন সক্রিয় নেই।'
                });
            }

            /*
            ------------------------------------------
            WhatsApp JID
            ------------------------------------------
            */

            const jid =
                `${targetPhone}@s.whatsapp.net`;

            /*
            ------------------------------------------
            Send
            ------------------------------------------
            */

            const sent =
                await sock.sendMessage(
                    jid,
                    {
                        text: String(message)
                    }
                );

            if (sent) {

                return res.json({
                    success: true,
                    reward: 2,
                    status: 'Sent'
                });
            }

            return res.json({
                success: false,
                reward: 0,
                status: 'Failed'
            });

        } catch (error) {

            console.error(
                '[Send Message Error]',
                error.message
            );

            return res.json({
                success: false,
                reward: 0,
                status: 'Failed',
                error:
                    error.message
            });
        }
    }
);

/*
====================================================
SERVER
====================================================
*/

app.listen(
    PORT,
    () => {

        console.log(
            `Mega Income Bot Backend running on port ${PORT}`
        );

        console.log(
            'WhatsApp pairing backend initialized.'
        );
    }
);
