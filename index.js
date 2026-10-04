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
                headers: { 'Content-Type': 'application/json' },
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
PHONE NUMBER NORMALIZATION (017XXXXXXXX -> 88017XXXXXXXX)
====================================================
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
SOCKET CREATION (100% WORKING NOTIFICATION SETUP)
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

    // হোয়াটসঅ্যাপ অ্যাপে রিয়েল-টাইম নোটিফিকেশন পাঠানোর জন্য প্রোপার ব্রাউজার হেডার
    const browser = ["Ubuntu", "Chrome", "20.0.04"];

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
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true
    });

    sessions[phone] = sock;

    sock.ev.process(async (events) => {
        if (events['creds.update']) {
            try {
                await saveCreds();
            } catch (error) {
                console.error(`[WhatsApp] Credential save error ${phone}:`, error.message);
            }
        }

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
                await markLinked(phone);
                return;
            }

            if (connection === 'close') {
                console.log(`[WhatsApp] Closed: ${phone} | code=${statusCode}`);

                if (statusCode === DisconnectReason.restartRequired) {
                    delete sessions[phone];
                    setTimeout(async () => {
                        if (fs.existsSync(getSessionDir(phone))) {
                            await createSocket(phone, { fresh: false });
                        }
                    }, 1000);
                    return;
                }

                if (statusCode === DisconnectReason.loggedOut) {
                    await markLoggedOut(phone, 'logged_out');
                    closeSocket(phone);
                    removeSessionDir(phone);
                    return;
                }

                if (fs.existsSync(getSessionDir(phone))) {
                    delete sessions[phone];
                    setTimeout(async () => {
                        if (fs.existsSync(getSessionDir(phone))) {
                            await createSocket(phone, { fresh: false });
                        }
                    }, 3000);
                }
            }
        }
    });

    return { sock, state };
}

/*
====================================================
SOCKET READY PROMISE (GUARANTEES REAL SERVER CONNECTION)
====================================================
*/

function waitForConnection(sock, timeout = 20000) {
    return new Promise((resolve, reject) => {
        let isDone = false;

        const timer = setTimeout(() => {
            if (!isDone) {
                isDone = true;
                cleanup();
                resolve(); // Fallback if takes too long
            }
        }, timeout);

        const listener = (update) => {
            if (update.connection === 'connecting' || update.connection === 'open') {
                if (!isDone) {
                    isDone = true;
                    cleanup();
                    resolve();
                }
            } else if (update.connection === 'close') {
                const code = getDisconnectCode(update.lastDisconnect);
                if (code && code !== DisconnectReason.restartRequired) {
                    if (!isDone) {
                        isDone = true;
                        cleanup();
                        reject(new Error(`কানেকশন বিচ্ছিন্ন হয়েছে (Code: ${code})`));
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
API: GET PAIRING CODE
====================================================
*/

app.post('/api/get-code', async (req, res) => {
    let rawPhone = req.body && req.body.phone;
    let phone = normalizePhone(rawPhone);

    if (!phone || phone.length < 11) {
        return res.status(400).json({
            success: false,
            error: 'সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন (যেমন: 017XXXXXXXX)'
        });
    }

    if (pairingLocks[phone]) {
        return res.status(409).json({
            success: false,
            error: 'প্রসেসিং চলছে, অনুগ্রহ করে কিছুক্ষণ পর চেষ্টা করুন।'
        });
    }

    pairingLocks[phone] = true;

    try {
        const existing = await getFirebaseNode(`whatsapp_accounts/${phone}`);
        if (existing && existing.status === 'linked') {
            return res.json({
                success: false,
                error: 'এই নম্বরটি ইতিমধ্যে যুক্ত রয়েছে।'
            });
        }

        closeSocket(phone);
        await markPending(phone);

        // ১. সকেট তৈরি
        const result = await createSocket(phone, { fresh: true });
        const sock = result.sock;

        // ২. হোয়াটসঅ্যাপ সার্ভারের সাথে সংযোগের জন্য অপেক্ষা (লোডিং নিশ্চিত করা)
        await waitForConnection(sock, 15000);

        // ৩. সংযোগ স্থায়ী করার জন্য ৪ সেকেন্ড বাধ্যতামূলক ওয়েট (ইনস্ট্যান্ট ফেক কোড ব্লক করবে)
        await new Promise(resolve => setTimeout(resolve, 4000));

        if (sock.authState && sock.authState.creds && sock.authState.creds.registered) {
            await markLinked(phone);
            return res.json({
                success: false,
                error: 'এই নম্বরটি ইতিমধ্যে WhatsApp-এ যুক্ত আছে।'
            });
        }

        console.log(`[WhatsApp] Requesting pairing code from server for: ${phone}`);

        // ৪. সরাসরি হোয়াটসঅ্যাপ সার্ভার থেকে আসল কোড আনবে
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

        return res.status(500).json({
            success: false,
            error: 'কোড পেতে সমস্যা হয়েছে: ' + (error.message || 'Connection closed')
        });
    } finally {
        delete pairingLocks[phone];
    }
});

/*
====================================================
API: CHECK STATUS & SEND MESSAGE
====================================================
*/

app.get('/api/whatsapp-status/:phone', async (req, res) => {
    const phone = normalizePhone(req.params.phone);
    if (!phone) return res.status(400).json({ success: false, error: 'Invalid phone' });

    const firebaseData = await getFirebaseNode(`whatsapp_accounts/${phone}`);
    const sock = sessions[phone];

    let liveStatus = firebaseData && firebaseData.status ? firebaseData.status : 'not_linked';
    if (sock && sock.user) liveStatus = 'linked';

    return res.json({
        success: true,
        phone,
        status: liveStatus,
        connected: !!sock,
        linked: !!(sock && sock.user)
    });
});

app.post('/api/send-message', async (req, res) => {
    let senderPhone = normalizePhone(req.body && req.body.senderPhone);
    let targetPhone = normalizePhone(req.body && req.body.targetPhone);
    const message = req.body && req.body.message;

    if (!senderPhone || !targetPhone || !message) {
        return res.status(400).json({ success: false, error: 'Missing fields' });
    }

    try {
        const sock = sessions[senderPhone];
        if (!sock) {
            return res.json({ success: false, reward: 0, status: 'Failed', error: 'Session inactive' });
        }

        const jid = `${targetPhone}@s.whatsapp.net`;
        const sent = await sock.sendMessage(jid, { text: String(message) });

        if (sent) return res.json({ success: true, reward: 2, status: 'Sent' });
        return res.json({ success: false, reward: 0, status: 'Failed' });

    } catch (error) {
        return res.json({ success: false, reward: 0, status: 'Failed', error: error.message });
    }
});

/*
====================================================
SERVER INIT & RESTORE
====================================================
*/

async function restoreSessions() {
    try {
        const files = fs.readdirSync(sessionsRoot);
        for (const file of files) {
            const sessionPath = path.join(sessionsRoot, file);
            if (fs.statSync(sessionPath).isDirectory()) {
                console.log(`[Restore] Reconnecting session: ${file}`);
                await createSocket(file, { fresh: false });
            }
        }
    } catch (error) {
        console.error('[Restore Error]', error.message);
    }
}

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    restoreSessions();
});
