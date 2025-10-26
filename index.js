import express from "express";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const sessions = new Map();

// Logger
const logger = pino({ level: "info" });

// Função para criar/gerenciar sessão WhatsApp
async function createWhatsAppSession(sessionId) {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(
      `./auth_sessions/${sessionId}`
    );
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: state,
      browser: ["Barbearia System", "Chrome", "1.0.0"],
    });

    let qrCode = null;
    let connectionStatus = "disconnected";
    let phoneNumber = null;

    // QR Code
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          qrCode = await QRCode.toDataURL(qr);
          connectionStatus = "qr_ready";
          logger.info(`[${sessionId}] QR Code gerado`);
        } catch (err) {
          logger.error(`[${sessionId}] Erro ao gerar QR:`, err);
        }
      }

      if (connection === "close") {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !==
          DisconnectReason.loggedOut;
        logger.info(
          `[${sessionId}] Conexão fechada. Reconectar: ${shouldReconnect}`
        );

        if (shouldReconnect) {
          connectionStatus = "connecting";
          setTimeout(() => createWhatsAppSession(sessionId), 3000);
        } else {
          connectionStatus = "disconnected";
          sessions.delete(sessionId);
        }
      } else if (connection === "open") {
        connectionStatus = "connected";
        qrCode = null;
        phoneNumber = sock.user?.id?.split(":")[0] || null;
        logger.info(`[${sessionId}] Conectado: ${phoneNumber}`);
      } else if (connection === "connecting") {
        connectionStatus = "connecting";
      }
    });

    // Salvar credenciais
    sock.ev.on("creds.update", saveCreds);

    sessions.set(sessionId, {
      sock,
      getQR: () => qrCode,
      getStatus: () => connectionStatus,
      getPhone: () => phoneNumber,
    });

    return { success: true };
  } catch (error) {
    logger.error(`[${sessionId}] Erro ao criar sessão:`, error);
    return { success: false, error: error.message };
  }
}

// Endpoints
app.post("/whatsapp/init", async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res
      .status(400)
      .json({ success: false, error: "sessionId obrigatório" });
  }

  logger.info(`[${sessionId}] Iniciando conexão`);

  const result = await createWhatsAppSession(sessionId);

  if (!result.success) {
    return res.status(500).json(result);
  }

  // Aguardar QR code ser gerado
  let attempts = 0;
  const checkQR = setInterval(() => {
    const session = sessions.get(sessionId);
    const qr = session?.getQR();
    const status = session?.getStatus();

    if (qr || attempts > 20) {
      clearInterval(checkQR);
      if (qr) {
        res.json({
          success: true,
          qr,
          status,
          message: "QR Code gerado com sucesso",
        });
      } else {
        res.status(500).json({
          success: false,
          error: "Timeout ao gerar QR Code",
        });
      }
    }
    attempts++;
  }, 500);
});

app.post("/whatsapp/status", (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res
      .status(400)
      .json({ success: false, error: "sessionId obrigatório" });
  }

  const session = sessions.get(sessionId);

  if (!session) {
    return res.json({
      success: true,
      status: "disconnected",
      qr: null,
      phoneNumber: null,
    });
  }

  res.json({
    success: true,
    status: session.getStatus(),
    qr: session.getQR(),
    phoneNumber: session.getPhone(),
  });
});

app.post("/whatsapp/disconnect", (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res
      .status(400)
      .json({ success: false, error: "sessionId obrigatório" });
  }

  const session = sessions.get(sessionId);

  if (session) {
    session.sock.logout();
    sessions.delete(sessionId);
    logger.info(`[${sessionId}] Desconectado`);
  }

  res.json({ success: true, message: "Desconectado com sucesso" });
});

app.post("/whatsapp/send", async (req, res) => {
  const { sessionId, phone, message } = req.body;

  if (!sessionId || !phone || !message) {
    return res.status(400).json({
      success: false,
      error: "sessionId, phone e message são obrigatórios",
    });
  }

  const session = sessions.get(sessionId);

  if (!session || session.getStatus() !== "connected") {
    return res.status(400).json({
      success: false,
      error: "WhatsApp não conectado",
    });
  }

  try {
    const formattedPhone = phone.includes("@s.whatsapp.net")
      ? phone
      : `${phone}@s.whatsapp.net`;
    await session.sock.sendMessage(formattedPhone, { text: message });

    logger.info(`[${sessionId}] Mensagem enviada para ${phone}`);
    res.json({ success: true, message: "Mensagem enviada" });
  } catch (error) {
    logger.error(`[${sessionId}] Erro ao enviar:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "okk", sessions: sessions.size });
});

app.listen(PORT, () => {
  logger.info(`🚀 Servidor rodando na porta ${PORT}`);
});
