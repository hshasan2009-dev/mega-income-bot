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

// ফায়ারবেস URL (সিকিউরিটির জন্য Environment Variable সহ)
const FIREBASE_DB_URL =
    process.env.FIREBASE_DB_URL || "https://mega-income-bot-9d9fa-default-rtdb.firebaseio.com";

const PORT = process.env.PORT || 3000;

const app = express();

app.use(cors());
app.use(express.json());

/*
====================================================
FIREBASE HELPERS
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
            console.error(`[Firebase] Update failed: ${response.status}`);
        }
    } catch (error) {
        console.error('[Firebase update error]', error.message);
    }
}

async function getFirebaseNode(pathNode) {
    try {
        const response = await fetch(`${FIREBASE_DB_URL}/${pathNode}.json`);
        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        console.error('[Firebase read error]', error.message);
        return null;
    }
}

/*
====================================================
PHONE NUMBER NORMALIZATION
====================================================
ইউজার ১১ ডিজিটের নম্বর দিলে (যেমন: 01337176976)
সেটিকে কান্ট্রি কোডসহ canonical format (8801337176976)-এ রূপান্তর করবে।
*/

function normalizePhone(phone) {
    if (!phone) return '';

    let value = String(phone).replace(/\D/g, '');

    if (value.startsWith('00880')) {
        value = value.substring(2);
    } else if (value.startsWith('8800')) {
        value = '88' + value.substring(3);
    } else if (value.startsWith('0')) {
        value = '880' + value.substring(1);
    } else if (!value.startsWith('880') && value.length === 10) {
        value = '880' + value;
    }

    return value;
}

/*
====================================================
SESSION & MEMORY STORAGE
====================================================
*/

const sessionsRoot = path.join(__dirname, 'sessions');

if (!fs.existsSync(sessionsRoot)) {
    fs.mkdirSync(sessionsRoot, { recursive: true });
}

const sessions = {};
const pairingLocks = {};
const pairingStates = {};

/*
====================================================
HELPERS
====================================================
*/

function getSessionDir(phone) {
    return path.join(sessionsRoot, phone);
}

function removeSessionDir(phone) {
    const sessionDir = getSessionDir(phone);
    if (fs.existsSync(sessionDir)) {
        try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (error) {
            console.error(`[Session remove error] ${phone}:`, error.message);
        }
    }
}

function closeSocket(phone) {
    const sock = sessions[phone];
    if (!sock) return;

    try {
        sock.end();
    } catch (error) {}

    delete sessions[phone];
}

function getDisconnectCode(lastDisconnect) {
    return (
        lastDisconnect &&
        lastDisconnect.error &&
        lastDisconnect.error.output &&
        lastDisconnect.error.output.statusCode
    );
}

function getErrorMessage(error) {
    if (!error) return '';
    return String(error.message || error.data || error).toLowerCase();
}

/*
====================================================
FIREBASE STATUS HELPERS
====================================================
*/

async function markPending(phone) {
    await updateFirebaseNode(`whatsapp_accounts/${phone}`, {
        status: 'pending',
        requestedAt: Date.now()
    });
}

async function markLinked(phone) {
    await updateFirebaseNode(`whatsapp_accounts/${phone}`, {
        status: 'linked',
        linkedAt: Date.now(),
        lastSeenAt: Date.now()
    });
}

async function markLoggedOut(phone, reason) {
    await updateFirebaseNode(`whatsapp_accounts/${phone}`, {
        status: 'logged_out',
        disconnectedAt: Date.now(),
        disconnectReason: reason || 'logged_out'
    });
}

async function markFailed(phone, reason) {
    await updateFirebaseNode(`whatsapp_accounts/${phone}`, {
        status: 'failed',
        failedAt: Date.now(),
        error: reason || 'pairing_failed'
    });
}

/*
====================================================
SOCKET CREATION
====================================================
*/

async function createSocket(phone, options = {}) {
    const sessionDir = getSessionDir(phone);

    if (options.fresh === true) {
        closeSocket(phone);
        removeSessionDir(phone);
    }

    const authState = await useMultiFileAuthState(sessionDir);
    const state = authState.state;
    const saveCreds = authState.saveCreds;

    let version;
    try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
    } catch (error) {
        version = [2, 3000, 1015901307];
    }

    // নোটিফিকেশন নিশ্চিত করতে macOS Desktop ব্রাউজার ওয়াটসঅ্যাপ গ্রহণ করে
    const browser = Browsers.macOS('Desktop');

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(
                state.keys,
                pino({ level: 'silent' })
            )
        },
        logger: pino({ level: 'silent' }),
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

    sock.ev.process(async (events) => {
        // Credentials update
        if (events['creds.update']) {
            try {
                await saveCreds();
            } catch (error) {
                console.error(`[WhatsApp] Credential save error ${phone}:`, error.message);
            }
        }

        // Connection update
        if (events['connection.update']) {
            const update = events['connection.update'];
            const connection = update.connection;
            const lastDisconnect = update.lastDisconnect;
            const statusCode = getDisconnectCode(lastDisconnect);

            if (update.isNewLogin) {
                console.log(`[WhatsApp] NEW LOGIN SUCCESS: ${phone}`);
                await updateFirebaseNode(`whatsapp_accounts/${phone}`, {
                    status: 'pairing_confirmed',
                    pairingConfirmedAt: Date.now()
                });
            }

            if (connection === 'open') {
                console.log(`[WhatsApp] SUCCESSFULLY LINKED: ${phone}`);
                if (pairingStates[phone]) {
                    pairingStates[phone].linked = true;
                    pairingStates[phone].paired = true;
                }
                await markLinked(phone);
                delete pairingStates[phone];
                return;
            }

            if (connection === 'close') {
                const errorMessage = getErrorMessage(lastDisconnect && lastDisconnect.error);
                console.log(`[WhatsApp] Closed: ${phone} | code=${statusCode} | ${errorMessage}`);

                // 515 = RESTART REQUIRED
                if (statusCode === DisconnectReason.restartRequired) {
                    delete sessions[phone];
                    setTimeout(async () => {
                        try {
                            if (fs.existsSync(getSessionDir(phone))) {
                                await createSocket(phone, { fresh: false });
                            }
                        } catch (error) {
                            console.error(`[WhatsApp] 515 reconnect error ${phone}:`, error.message);
                        }
                    }, 1000);
                    return;
                }

                // Logged out / device removed
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const isForbidden = statusCode === DisconnectReason.forbidden;
                const deviceRemoved = errorMessage.includes('device_removed') || errorMessage.includes('logged out');

                if (isLoggedOut || isForbidden || deviceRemoved) {
                    console.log(`[WhatsApp] LOGGED OUT: ${phone}`);
                    await markLoggedOut(phone, `disconnect_${statusCode || 'unknown'}`);
                    closeSocket(phone);
                    removeSessionDir(phone);
                    delete pairingStates[phone];
                    return;
                }

                // Temporary reconnect
                if (!isLoggedOut && fs.existsSync(getSessionDir(phone))) {
                    delete sessions[phone];
                    setTimeout(async () => {
                        try {
                            if (fs.existsSync(getSessionDir(phone))) {
                                await createSocket(phone, { fresh: false });
                            }
                        } catch (error) {
                            console.error(`[WhatsApp] Reconnect error ${phone}:`, error.message);
                        }
                    }, 2000);
                }
            }
        }
    });

    return { sock, state };
}

/*
====================================================
WAIT FOR SOCKET STABLE
====================================================
*/

async function waitForSocketReady(phone, sock, timeout = 25000) {
    return new Promise((resolve, reject) => {
        let finished = false;

        const timer = setTimeout(() => {
            if (!finished) {
                finished = true;
                cleanup();
                // টাইমআউট হলেও যেন রিকোয়েস্ট পুরোপুরি ব্লক না হয়ে চেষ্টা করতে পারে
                resolve();
            }
        }, timeout);

        const listener = (update) => {
            if (update.connection === 'connecting' || update.connection === 'open') {
                if (!finished) {
                    finished = true;
                    cleanup();
                    resolve();
                }
            } else if (update.connection === 'close') {
                const code = getDisconnectCode(update.lastDisconnect);
                if (code && code !== DisconnectReason.restartRequired) {
                    if (!finished) {
                        finished = true;
                        cleanup();
                        reject(new Error(`কানেকশন সংযোগ বিচ্ছিন্ন হয়েছে (Code: ${code})`));
                    }
                }
            }
        };

        const cleanup = () => {
            clearTimeout(timer);
            try {
                sock.ev.off('connection.update', listener);
            } catch (e) {}
        };

        sock.ev.on('connection.update', listener);
    });
}

/*
====================================================
HOME
====================================================
*/

app.get('/', (req, res) => {
    res.status(200).send('Mega Income Bot Backend Status: Live & Running!');
});

/*
====================================================
GET PAIRING CODE
====================================================
*/

app.post('/api/get-code', async (req, res) => {
    let rawPhone = req.body && req.body.phone;
    let phone = normalizePhone(rawPhone);

    if (!phone || phone.length < 11) {
        return res.status(400).json({
            success: false,
            error: 'সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন (যেমন: 01337176976)'
        });
    }

    if (pairingLocks[phone]) {
        return res.status(409).json({
            success: false,
            error: 'এই নম্বরের জন্য প্রসেসিং চলছে। অনুগ্রহ করে অপেক্ষা করুন।'
        });
    }

    pairingLocks[phone] = true;

    try {
        const existing = await getFirebaseNode(`whatsapp_accounts/${phone}`);
        if (existing && existing.status === 'linked') {
            return res.json({
                success: false,
                error: 'এই নম্বরটি ইতিমধ্যে যুক্ত করা রয়েছে।'
            });
        }

        closeSocket(phone);

        pairingStates[phone] = {
            waitingForPairing: true,
            requestedAt: Date.now()
        };

        await markPending(phone);

        // সকেট তৈরি
        const result = await createSocket(phone, { fresh: true });
        const sock = result.sock;

        // সকেট কানেকশন সম্পূর্ণ তৈরি হওয়া পর্যন্ত প্রমিজ হোল্ড
        await waitForSocketReady(phone, sock, 25000);

        // সকেট কানেক্টের পর ২ সেকেন্ড ডিলে দেওয়া হচ্ছে যেন WhatsApp সার্ভার রিকোয়েস্ট গ্রহণ করে
        await new Promise(resolve => setTimeout(resolve, 2000));

        if (sock.authState && sock.authState.creds && sock.authState.creds.registered) {
            await markLinked(phone);
            return res.json({
                success: false,
                error: 'এই নম্বরটি ইতিমধ্যে WhatsApp-এ linked আছে।'
            });
        }

        console.log(`[WhatsApp] Requesting pairing code for: ${phone}`);

        // আসল পেয়ারিং কোড চাওয়া
        const code = await sock.requestPairingCode(phone);
        const cleanCode = String(code).replace(/\s+/g, '').toUpperCase();

        console.log(`[WhatsApp] Pairing code generated for ${phone}: ${cleanCode}`);

        return res.json({
            success: true,
            code: cleanCode,
            phone: phone,
            status: 'pending'
        });

    } catch (error) {
        console.error(`[Pairing Error] ${phone}:`, error);
        await markFailed(phone, error.message);
        delete pairingStates[phone];

        return res.status(500).json({
            success: false,
            error: 'কোড পেতে সমস্যা হয়েছে: ' + (error.message || 'Connection Closed')
        });
    } finally {
        delete pairingLocks[phone];
    }
});

/*
====================================================
CHECK WHATSAPP ACCOUNT STATUS
====================================================
*/

app.get('/api/whatsapp-status/:phone', async (req, res) => {
    const phone = normalizePhone(req.params.phone);

    if (!phone) {
        return res.status(400).json({
            success: false,
            error: 'Invalid phone number'
        });
    }

    const firebaseData = await getFirebaseNode(`whatsapp_accounts/${phone}`);
    const sock = sessions[phone];

    let liveStatus = firebaseData && firebaseData.status ? firebaseData.status : 'not_linked';

    if (sock && sock.user) {
        liveStatus = 'linked';
    }

    return res.json({
        success: true,
        phone,
        status: liveStatus,
        connected: !!sock,
        linked: !!(sock && sock.user)
    });
});

/*
====================================================
SEND MESSAGE
====================================================
*/

app.post('/api/send-message', async (req, res) => {
    let senderPhone = normalizePhone(req.body && req.body.senderPhone);
    let targetPhone = normalizePhone(req.body && req.body.targetPhone);
    const message = req.body && req.body.message;

    if (!senderPhone || !targetPhone || !message) {
        return res.status(400).json({
            success: false,
            error: 'সবগুলো তথ্য সঠিকভাবে পূরণ করুন'
        });
    }

    try {
        const accountData = await getFirebaseNode(`whatsapp_accounts/${senderPhone}`);

        if (!accountData || accountData.status !== 'linked') {
            return res.json({
                success: false,
                reward: 0,
                status: 'Unlinked or Logged Out',
                error: 'নম্বরটি যুক্ত করা নেই অথবা লগআউট হয়ে গেছে।'
            });
        }

        const sock = sessions[senderPhone];

        if (!sock) {
            return res.json({
                success: false,
                reward: 0,
                status: 'Failed',
                error: 'WhatsApp সেশন সক্রিয় নেই।'
            });
        }

        const jid = `${targetPhone}@s.whatsapp.net`;
        const sent = await sock.sendMessage(jid, { text: String(message) });

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
        console.error('[Send Message Error]', error.message);
        return res.json({
            success: false,
            reward: 0,
            status: 'Failed',
            error: error.message
        });
    }
});

/*
====================================================
RESTORE EXISTING SESSIONS ON SERVER STARTUP
====================================================
*/

async function restoreSessions() {
    try {
        const files = fs.readdirSync(sessionsRoot);
        for (const file of files) {
            const sessionPath = path.join(sessionsRoot, file);
            if (fs.statSync(sessionPath).isDirectory()) {
                console.log(`[Restore] Reconnecting saved session for: ${file}`);
                await createSocket(file, { fresh: false });
            }
        }
    } catch (error) {
        console.error('[Restore Error]', error.message);
    }
}

/*
====================================================
SERVER INIT
====================================================
*/

app.listen(PORT, () => {
    console.log(`Mega Income Bot Backend running on port ${PORT}`);
    restoreSessions();
});
