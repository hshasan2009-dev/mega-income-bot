const express = require('express');
const cors = require('cors');

const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs');
const path = require('path');

const FIREBASE_DB_URL =
    'https://mega-income-bot-9d9fa-default-rtdb.firebaseio.com';

const app = express();

app.use(cors());
app.use(express.json());

/*
|--------------------------------------------------------------------------
| Firebase
|--------------------------------------------------------------------------
*/

async function updateFirebaseNode(pathNode, data) {
    try {
        await fetch(
            `${FIREBASE_DB_URL}/${pathNode}.json`,
            {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            }
        );
    } catch (error) {
        console.error(
            '[Firebase Update Error]',
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
            '[Firebase Read Error]',
            error.message
        );

        return null;
    }
}

/*
|--------------------------------------------------------------------------
| Phone Number
|--------------------------------------------------------------------------
*/

function normalizePhone(phone) {
    let value = String(phone || '')
        .replace(/\D/g, '');

    /*
     * Bangladesh:
     * 01337176976
     * becomes
     * 8801337176976
     *
     * Already international:
     * 8801337176976
     * remains unchanged.
     */

    if (value.startsWith('00')) {
        value = value.substring(2);
    }

    if (value.startsWith('0')) {
        value = '88' + value;
    }

    return value;
}

/*
|--------------------------------------------------------------------------
| Sessions
|--------------------------------------------------------------------------
*/

const sessions = Object.create(null);

const pairingState = Object.create(null);

const reconnectTimers = Object.create(null);

/*
|--------------------------------------------------------------------------
| Status Code
|--------------------------------------------------------------------------
*/

function getStatusCode(lastDisconnect) {
    return (
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.statusCode ||
        lastDisconnect?.error?.data?.statusCode ||
        null
    );
}

/*
|--------------------------------------------------------------------------
| Wait
|--------------------------------------------------------------------------
*/

function sleep(ms) {
    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );
}

/*
|--------------------------------------------------------------------------
| Remove socket from memory
|--------------------------------------------------------------------------
*/

function removeSocket(phone, socket) {
    if (
        socket &&
        sessions[phone] === socket
    ) {
        delete sessions[phone];
    }
}

/*
|--------------------------------------------------------------------------
| Create WhatsApp Socket
|--------------------------------------------------------------------------
*/

async function createWhatsAppSocket(
    phone,
    fresh = false
) {
    const sessionDir = path.join(
        __dirname,
        'sessions',
        phone
    );

    /*
     * Fresh pairing:
     * পুরোনো session সম্পূর্ণ মুছে নতুন pairing শুরু হবে।
     */

    if (fresh) {
        if (sessions[phone]) {
            try {
                sessions[phone].end();
            } catch (e) {}

            delete sessions[phone];
        }

        if (fs.existsSync(sessionDir)) {
            try {
                fs.rmSync(
                    sessionDir,
                    {
                        recursive: true,
                        force: true
                    }
                );
            } catch (error) {
                console.error(
                    `[${phone}] Session delete error:`,
                    error.message
                );
            }
        }
    }

    /*
     * Existing socket থাকলে reconnect-এর জন্য
     * শুধু memory থেকে remove করা হবে।
     */

    if (!fresh && sessions[phone]) {
        try {
            sessions[phone].end();
        } catch (e) {}

        delete sessions[phone];
    }

    /*
     |--------------------------------------------------------------------------
     | Auth
     |--------------------------------------------------------------------------
     */

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(
        sessionDir
    );

    /*
     |--------------------------------------------------------------------------
     | WhatsApp version
     |--------------------------------------------------------------------------
     */

    const {
        version
    } = await fetchLatestBaileysVersion();

    /*
     |--------------------------------------------------------------------------
     | Socket
     |--------------------------------------------------------------------------
     |
     | IMPORTANT:
     | এখানে browser option intentionally নেই।
     |
     | Pairing-code notification-এর জন্য
     | markOnlineOnConnect false রাখা হয়েছে।
     |
     |--------------------------------------------------------------------------
     */

    const socket = makeWASocket({
        version,

        logger: pino({
            level: 'silent'
        }),

        auth: {
            creds: state.creds,

            keys: makeCacheableSignalKeyStore(
                state.keys,
                pino({
                    level: 'silent'
                })
            )
        },

        printQRInTerminal: false,

        connectTimeoutMs: 60000,

        defaultQueryTimeoutMs: 60000,

        keepAliveIntervalMs: 25000,

        markOnlineOnConnect: false,

        emitOwnEvents: true,

        syncFullHistory: false
    });

    sessions[phone] = socket;

    /*
     |--------------------------------------------------------------------------
     | Save credentials
     |--------------------------------------------------------------------------
     */

    socket.ev.on(
        'creds.update',
        async () => {
            try {
                await saveCreds();
            } catch (error) {
                console.error(
                    `[${phone}] Credential save error:`,
                    error.message
                );
            }
        }
    );

    /*
     |--------------------------------------------------------------------------
     | Connection Update
     |--------------------------------------------------------------------------
     */

    socket.ev.on(
        'connection.update',
        async update => {
            const {
                connection,
                lastDisconnect
            } = update;

            /*
             |--------------------------------------------------------------------------
             | CONNECTING
             |--------------------------------------------------------------------------
             |
             | এখানেই pairing code request করা হবে।
             |
             | Fixed 4 seconds ব্যবহার করা হচ্ছে না।
             |
             |--------------------------------------------------------------------------
             */

            if (
                connection === 'connecting' &&
                !state.creds.registered &&
                !pairingState[phone]?.codeRequested
            ) {
                if (!pairingState[phone]) {
                    pairingState[phone] = {};
                }

                pairingState[
                    phone
                ].codeRequested = true;

                try {
                    /*
                     * WhatsApp pairing code
                     */

                    const code =
                        await socket.requestPairingCode(
                            phone
                        );

                    if (!code) {
                        throw new Error(
                            'WhatsApp pairing code পাওয়া যায়নি।'
                        );
                    }

                    pairingState[
                        phone
                    ].code = code;

                    console.log(
                        `[WhatsApp] ${phone} pairing code: ${code}`
                    );

                    /*
                     * Code তৈরি হয়েছে মাত্র।
                     *
                     * এখনো linked নয়।
                     */

                    await updateFirebaseNode(
                        `whatsapp_accounts/${phone}`,
                        {
                            status: 'pending',
                            requestedAt:
                                Date.now(),
                            pairingCode: code,
                            linkedAt: null,
                            error: null
                        }
                    );

                } catch (error) {
                    console.error(
                        `[${phone}] Pairing code error:`,
                        error.message
                    );

                    pairingState[
                        phone
                    ].codeRequested = false;

                    pairingState[
                        phone
                    ].error = error.message;

                    await updateFirebaseNode(
                        `whatsapp_accounts/${phone}`,
                        {
                            status:
                                'pairing_failed',
                            error:
                                error.message,
                            failedAt:
                                Date.now()
                        }
                    );
                }
            }

            /*
             |--------------------------------------------------------------------------
             | OPEN
             |--------------------------------------------------------------------------
             |
             | এই মুহূর্তের আগে কখনো account-কে linked
             | করা হবে না।
             |
             |--------------------------------------------------------------------------
             */

            if (connection === 'open') {
                console.log(
                    `[WhatsApp] ${phone} successfully linked.`
                );

                sessions[phone] = socket;

                /*
                 * Pairing সফল।
                 */

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
                 * Pairing state cleanup
                 */

                delete pairingState[phone];
            }

            /*
             |--------------------------------------------------------------------------
             | CLOSE
             |--------------------------------------------------------------------------
             */

            if (connection === 'close') {
                const statusCode =
                    getStatusCode(
                        lastDisconnect
                    );

                console.log(
                    `[WhatsApp] ${phone} connection closed: ${statusCode}`
                );

                removeSocket(
                    phone,
                    socket
                );

                /*
                 |--------------------------------------------------------------------------
                 | REAL LOGOUT
                 |--------------------------------------------------------------------------
                 */

                if (
                    statusCode ===
                    DisconnectReason.loggedOut
                ) {
                    console.log(
                        `[WhatsApp] ${phone} logged out.`
                    );

                    delete pairingState[
                        phone
                    ];

                    await updateFirebaseNode(
                        `whatsapp_accounts/${phone}`,
                        {
                            status:
                                'logged_out',
                            disconnectedAt:
                                Date.now(),
                            pairingCode:
                                null
                        }
                    );

                    /*
                     * Auth files remove
                     */

                    if (
                        fs.existsSync(
                            sessionDir
                        )
                    ) {
                        try {
                            fs.rmSync(
                                sessionDir,
                                {
                                    recursive: true,
                                    force: true
                                }
                            );
                        } catch (error) {
                            console.error(
                                `[${phone}] Logout cleanup error:`,
                                error.message
                            );
                        }
                    }

                    return;
                }

                /*
                 |--------------------------------------------------------------------------
                 | Restart Required / Temporary Disconnect
                 |--------------------------------------------------------------------------
                 */

                const shouldReconnect =
                    statusCode ===
                        DisconnectReason
                            .restartRequired ||
                    statusCode ===
                        DisconnectReason
                            .connectionClosed ||
                    statusCode ===
                        DisconnectReason
                            .connectionLost ||
                    statusCode ===
                        DisconnectReason
                            .timedOut;

                if (shouldReconnect) {
                    /*
                     * Pairing-এর সময় 515 বা temporary close
                     * হলে session মুছবে না।
                     */

                    const registered =
                        state.creds.registered;

                    await updateFirebaseNode(
                        `whatsapp_accounts/${phone}`,
                        {
                            status:
                                registered
                                    ? 'reconnecting'
                                    : 'pending',
                            reconnectingAt:
                                Date.now()
                        }
                    );

                    /*
                     * Existing reconnect timer থাকলে
                     * duplicate reconnect করবে না।
                     */

                    if (
                        !reconnectTimers[
                            phone
                        ]
                    ) {
                        reconnectTimers[
                            phone
                        ] = setTimeout(
                            async () => {
                                delete reconnectTimers[
                                    phone
                                ];

                                try {
                                    await createWhatsAppSocket(
                                        phone,
                                        false
                                    );
                                } catch (error) {
                                    console.error(
                                        `[${phone}] Reconnect error:`,
                                        error.message
                                    );
                                }
                            },
                            1500
                        );
                    }

                    return;
                }

                /*
                 |--------------------------------------------------------------------------
                 | Unknown disconnect
                 |--------------------------------------------------------------------------
                 */

                console.error(
                    `[WhatsApp] ${phone} unexpected disconnect.`,
                    statusCode
                );

                if (
                    state.creds.registered
                ) {
                    await updateFirebaseNode(
                        `whatsapp_accounts/${phone}`,
                        {
                            status:
                                'reconnecting',
                            reconnectingAt:
                                Date.now()
                        }
                    );

                    if (
                        !reconnectTimers[
                            phone
                        ]
                    ) {
                        reconnectTimers[
                            phone
                        ] = setTimeout(
                            async () => {
                                delete reconnectTimers[
                                    phone
                                ];

                                try {
                                    await createWhatsAppSocket(
                                        phone,
                                        false
                                    );
                                } catch (error) {
                                    console.error(
                                        `[${phone}] Reconnect error:`,
                                        error.message
                                    );
                                }
                            },
                            2000
                        );
                    }
                }
            }
        }
    );

    return socket;
}

/*
|--------------------------------------------------------------------------
| GET PAIRING CODE
|--------------------------------------------------------------------------
*/

app.post(
    '/api/get-code',
    async (req, res) => {
        let {
            phone
        } = req.body;

        if (!phone) {
            return res.status(400).json({
                success: false,
                error:
                    'Phone number required'
            });
        }

        phone =
            normalizePhone(phone);

        if (!phone) {
            return res.status(400).json({
                success: false,
                error:
                    'সঠিক WhatsApp নম্বর দিন।'
            });
        }

        /*
         * Existing linked account check
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
                    'এই নম্বরটি ইতিমধ্যে লিঙ্কড আছে।'
            });
        }

        try {
            /*
             * Previous pairing state clear
             */

            delete pairingState[phone];

            /*
             * New socket
             */

            await createWhatsAppSocket(
                phone,
                true
            );

            /*
             * Pairing code connection.update থেকে
             * আসবে।
             *
             * সর্বোচ্চ 30 seconds অপেক্ষা।
             */

            const start =
                Date.now();

            while (
                Date.now() - start <
                30000
            ) {
                const state =
                    pairingState[phone];

                /*
                 * Code পাওয়া গেছে
                 */

                if (
                    state &&
                    state.code
                ) {
                    return res.json({
                        success: true,
                        code:
                            state.code,
                        status:
                            'pending'
                    });
                }

                /*
                 * Error
                 */

                if (
                    state &&
                    state.error
                ) {
                    return res.status(
                        500
                    ).json({
                        success:
                            false,
                        error:
                            'WhatsApp pairing code তৈরি করা যায়নি: ' +
                            state.error
                    });
                }

                await sleep(250);
            }

            return res.status(504).json({
                success: false,
                error:
                    'WhatsApp pairing code তৈরি হতে সময় লাগছে। আবার চেষ্টা করুন।'
            });

        } catch (error) {
            console.error(
                '[Get Code Error]',
                error.message
            );

            return res.status(500).json({
                success: false,
                error:
                    'কোড পেতে সমস্যা হয়েছে: ' +
                    error.message
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| WHATSAPP STATUS
|--------------------------------------------------------------------------
*/

app.get(
    '/api/whatsapp-status/:phone',
    async (req, res) => {
        const phone =
            normalizePhone(
                req.params.phone
            );

        const data =
            await getFirebaseNode(
                `whatsapp_accounts/${phone}`
            );

        if (!data) {
            return res.json({
                success: true,
                status:
                    'not_found'
            });
        }

        return res.json({
            success: true,
            status:
                data.status ||
                'unknown',
            linkedAt:
                data.linkedAt ||
                null,
            disconnectedAt:
                data.disconnectedAt ||
                null
        });
    }
);

/*
|--------------------------------------------------------------------------
| SEND MESSAGE
|--------------------------------------------------------------------------
*/

app.post(
    '/api/send-message',
    async (req, res) => {
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
                reward: 0,
                status:
                    'Failed',
                error:
                    'Missing required parameters'
            });
        }

        senderPhone =
            normalizePhone(
                senderPhone
            );

        targetPhone =
            normalizePhone(
                targetPhone
            );

        try {
            /*
             * Firebase status
             */

            const account =
                await getFirebaseNode(
                    `whatsapp_accounts/${senderPhone}`
                );

            if (
                !account ||
                account.status !==
                    'linked'
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
             * Active socket
             */

            const socket =
                sessions[
                    senderPhone
                ];

            if (!socket) {
                return res.json({
                    success: false,
                    reward: 0,
                    status:
                        'Failed',
                    error:
                        'WhatsApp session সক্রিয় নেই।'
                });
            }

            /*
             * Send
             */

            const jid =
                `${targetPhone}@s.whatsapp.net`;

            const result =
                await socket.sendMessage(
                    jid,
                    {
                        text: message
                    }
                );

            if (
                result &&
                result.key &&
                result.key.id
            ) {
                return res.json({
                    success: true,
                    reward: 2,
                    status:
                        'Sent',
                    messageId:
                        result.key.id
                });
            }

            return res.json({
                success: false,
                reward: 0,
                status:
                    'Failed',
                error:
                    'WhatsApp message send হয়নি।'
            });

        } catch (error) {
            console.error(
                '[Send Message Error]',
                error.message
            );

            return res.json({
                success: false,
                reward: 0,
                status:
                    'Failed',
                error:
                    error.message
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get(
    '/',
    (req, res) => {
        res.status(200).send(
            'Mega Income Bot Backend: Live & Running!'
        );
    }
);

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

const PORT =
    process.env.PORT || 3000;

app.listen(
    PORT,
    () => {
        console.log(
            `Mega Income Bot Backend running on port ${PORT}`
        );
    }
);
