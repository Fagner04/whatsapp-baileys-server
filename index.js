const express = require("express");
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const P = require("pino");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Sessions storage
const sessions = new Map();

// Logger silencioso
const logger = P({ level: "silent" });

// Diretório de autenticação
const AUTH_DIR = path.join(__dirname, "auth_sessions");
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Helper para aguardar QR code com timeout de 60 segundos
async function waitForQR(session, maxWaitMs = 60000) {
  const startTime = Date.now();

  console.log(`⏳ Aguardando QR code por até ${maxWaitMs / 1000}s...`);

  while (Date.now() - startTime < maxWaitMs) {
    const qr = session.getQR();
    const status = session.getStatus();

    // Log a cada 5 segundos
    const elapsed = Date.now() - startTime;
    if (elapsed > 0 && elapsed % 5000 < 300) {
      console.log(
        `⏱️ ${Math.floor(elapsed / 1000)}s - Status: ${status}, QR: ${!!qr}`
      );
    }

    if (qr) {
      console.log(`✅ QR Code gerado após ${elapsed}ms`);
      return { qr, status };
    }

    if (status === "connected") {
      console.log(`✅ Conectado sem QR após ${elapsed}ms`);
      return { qr, status };
    }

    // Verificar a cada 200ms
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.error(
    `❌ Timeout após ${maxWaitMs}ms - Status: ${session.getStatus()}`
  );
  throw new Error(
    "Timeout ao gerar QR Code - WhatsApp demorou mais de 60 segundos. Tente novamente em alguns segundos."
  );
}

// Initialize WhatsApp connection
async function initWhatsApp(sessionId) {
  try {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`[${sessionId}] 🚀 Iniciando sessão WhatsApp...`);
    console.log(`${"=".repeat(60)}\n`);

    const sessionDir = path.join(AUTH_DIR, sessionId);

    // Criar diretório se não existir (NÃO deletar credenciais salvas!)
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
      console.log(`[${sessionId}] 📁 Novo diretório criado: ${sessionDir}`);
    } else {
      console.log(
        `[${sessionId}] 📁 Usando credenciais salvas em: ${sessionDir}`
      );
    }

    // Carregar versão mais recente
    console.log(`[${sessionId}] 📦 Carregando versão do Baileys...`);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(
      `[${sessionId}] 📦 Versão: ${version.join(".")}, Latest: ${isLatest}`
    );

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    console.log(`[${sessionId}] 🔐 Auth state configurado`);

    console.log(`[${sessionId}] 🔌 Criando socket WhatsApp...`);
    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: true,
      browser: ["BarberClick", "Chrome", "1.0.0"],
      connectTimeoutMs: 60000,
      qrTimeout: 60000,
      defaultQueryTimeoutMs: undefined,
      keepAliveIntervalMs: 10000,
    });

    let qrCode = null;
    let connectionStatus = "connecting";
    let phoneNumber = null;

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      console.log(`[${sessionId}] 📡 Connection update:`, {
        connection,
        hasQR: !!qr,
        timestamp: new Date().toISOString(),
      });

      if (qr) {
        try {
          console.log(
            `[${sessionId}] 📱 QR Code recebido! Convertendo para DataURL...`
          );
          qrCode = await QRCode.toDataURL(qr);
          connectionStatus = "qr_ready";
          console.log(
            `[${sessionId}] ✅ QR Code gerado com sucesso! Length: ${qrCode.length}`
          );
        } catch (err) {
          console.error(`[${sessionId}] ❌ Erro ao gerar QR:`, err);
        }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[${sessionId}] ❌ Conexão fechada`);
        console.log(`[${sessionId}] Status Code:`, statusCode);
        console.log(
          `[${sessionId}] DisconnectReason.loggedOut:`,
          DisconnectReason.loggedOut
        );
        console.log(`[${sessionId}] Deve reconectar?:`, shouldReconnect);
        console.log(`[${sessionId}] Erro completo:`, lastDisconnect?.error);

        if (shouldReconnect) {
          connectionStatus = "connecting";
          console.log(`[${sessionId}] 🔄 Reconectando em 3 segundos...`);
          setTimeout(() => {
            console.log(`[${sessionId}] 🔄 Iniciando reconexão...`);
            // Não remover a sessão do Map, apenas reconectar o socket
            initWhatsApp(sessionId).catch((err) => {
              console.error(
                `[${sessionId}] ❌ Erro ao reconectar:`,
                err.message
              );
              connectionStatus = "disconnected";
            });
          }, 3000);
        } else {
          // Só deletar credenciais se o usuário fez logout explícito
          console.log(
            `[${sessionId}] 🗑️ Logout detectado - removendo credenciais`
          );
          connectionStatus = "disconnected";
          sessions.delete(sessionId);
          if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          }
        }
      } else if (connection === "open") {
        connectionStatus = "connected";
        phoneNumber = sock.user?.id?.split(":")[0];
        qrCode = null;
        console.log(`[${sessionId}] ✅ CONECTADO! Número:`, phoneNumber);
      } else if (connection === "connecting") {
        connectionStatus = "connecting";
        console.log(`[${sessionId}] 🔄 Conectando...`);
      }
    });

    sock.ev.on("creds.update", saveCreds);

    // Configurar handler de mensagens para o bot
    setupMessageHandler(sock, sessionId);

    const session = {
      sock,
      getQR: () => qrCode,
      getStatus: () => connectionStatus,
      getPhoneNumber: () => phoneNumber,
      sessionDir: sessionDir,
    };

    sessions.set(sessionId, session);
    console.log(`[${sessionId}] ✅ Sessão criada e armazenada`);

    return session;
  } catch (error) {
    console.error(`[${sessionId}] 💥 ERRO ao inicializar:`, error);
    throw error;
  }
}

// Routes
app.post("/whatsapp/init", async (req, res) => {
  const startTime = Date.now();
  try {
    const sessionId = req.body.sessionId || "default";
    console.log(`\n${"=".repeat(60)}`);
    console.log(`[API /init] 🚀 Nova requisição`);
    console.log(`[API /init] SessionId: ${sessionId}`);
    console.log(`[API /init] Timestamp: ${new Date().toISOString()}`);
    console.log(`${"=".repeat(60)}\n`);

    let session = sessions.get(sessionId);

    if (!session) {
      console.log(`[${sessionId}] Criando nova sessão...`);
      session = await initWhatsApp(sessionId);

      // Verificar se tem credenciais salvas (se conectou automaticamente)
      const status = session.getStatus();
      if (status === "connected") {
        console.log(
          `[${sessionId}] ✅ Reconectado automaticamente com credenciais salvas!`
        );
        return res.json({
          success: true,
          message: "Reconectado automaticamente",
          qr: null,
          status: "connected",
          phoneNumber: session.getPhoneNumber(),
        });
      }

      console.log(`[${sessionId}] Aguardando QR code (timeout: 60s)...`);
      const { qr, status: finalStatus } = await waitForQR(session, 60000);

      const duration = Date.now() - startTime;
      console.log(`\n${"=".repeat(60)}`);
      console.log(`[API /init] ✅ SUCESSO!`);
      console.log(`[API /init] Duração: ${duration}ms`);
      console.log(`[API /init] Status: ${finalStatus}`);
      console.log(`[API /init] QR length: ${qr?.length || 0}`);
      console.log(`${"=".repeat(60)}\n`);

      return res.json({
        success: true,
        message: "QR Code gerado com sucesso",
        qr,
        status: finalStatus,
        duration: `${duration}ms`,
      });
    }

    // Sessão já existe
    const qr = session.getQR();
    const status = session.getStatus();

    console.log(
      `[${sessionId}] Sessão existente - Status: ${status}, QR: ${!!qr}`
    );

    res.json({
      success: true,
      message: qr
        ? "QR Code disponível"
        : status === "connected"
        ? "Já conectado"
        : "Aguardando conexão",
      qr,
      status,
      phoneNumber: session.getPhoneNumber(),
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`\n${"=".repeat(60)}`);
    console.error(`[API /init] 💥 ERRO!`);
    console.error(`[API /init] Duração: ${duration}ms`);
    console.error(`[API /init] Erro:`, error.message);
    console.error(`${"=".repeat(60)}\n`);

    res.status(500).json({
      success: false,
      error: error.message,
      duration: `${duration}ms`,
    });
  }
});

app.post("/whatsapp/status", async (req, res) => {
  try {
    const sessionId = req.body.sessionId || "default";
    const session = sessions.get(sessionId);

    if (!session) {
      return res.json({
        success: true,
        status: "disconnected",
        qr: null,
        phoneNumber: null,
      });
    }

    const status = session.getStatus();
    const qr = session.getQR();
    const phoneNumber = session.getPhoneNumber();

    res.json({
      success: true,
      status,
      qr,
      phoneNumber,
    });
  } catch (error) {
    console.error("Erro em /whatsapp/status:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/whatsapp/disconnect", async (req, res) => {
  try {
    const sessionId = req.body.sessionId || "default";
    const session = sessions.get(sessionId);

    if (!session) {
      return res.json({
        success: true,
        message: "Sessão não encontrada",
      });
    }

    await session.sock.logout();
    sessions.delete(sessionId);

    const sessionDir = path.join(AUTH_DIR, sessionId);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    res.json({
      success: true,
      message: "Desconectado com sucesso",
    });
  } catch (error) {
    console.error("Erro em /whatsapp/disconnect:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Handler de mensagens recebidas - para processar menus do bot
async function setupMessageHandler(sock, sessionId) {
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      // Ignorar mensagens do próprio bot
      if (msg.key.fromMe) continue;

      const messageText =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";
      const remoteJid = msg.key.remoteJid;

      console.log(
        `📨 [BOT] Mensagem recebida de ${remoteJid}: "${messageText}"`
      );

      // Enviar TODAS as mensagens para o bot-handler processar
      // O bot-handler decidirá se deve responder baseado nos trigger_keywords configurados
      if (messageText && messageText.trim()) {
        try {
          // Chamar edge function para buscar menus configurados
          const response = await fetch(
            "https://qeevcauhornyqrfeevwc.supabase.co/functions/v1/bot-handler",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization:
                  "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFlZXZjYXVob3JueXFyZmVldndjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAxNDg3MzAsImV4cCI6MjA3NTcyNDczMH0.UJ9-w6i3lROn8NRgeG6T1KWIR1FyKmjVGh8TEEBvglc",
              },
              body: JSON.stringify({
                sessionId,
                message: messageText,
                from: remoteJid,
              }),
            }
          );

          if (response.ok) {
            const data = await response.json();
            if (data.success && data.reply) {
              await sock.sendMessage(remoteJid, { text: data.reply });
              console.log(`✅ [BOT] Menu enviado para ${remoteJid}`);
            } else {
              console.log(
                `ℹ️ [BOT] Nenhum menu correspondente para: "${messageText}"`
              );
            }
          } else {
            console.error(
              `❌ [BOT] Erro HTTP ${response.status}:`,
              await response.text()
            );
          }
        } catch (error) {
          console.error("❌ [BOT] Erro ao processar mensagem:", error);
        }
      }
    }
  });
}

app.post("/whatsapp/send", async (req, res) => {
  try {
    const { phone, message, sessionId = "default" } = req.body;
    console.log(`📤 [SEND] Tentando enviar mensagem para ${phone}`);

    const session = sessions.get(sessionId);

    if (!session) {
      console.error("❌ [SEND] Sessão não encontrada");
      return res.status(400).json({
        success: false,
        error: "WhatsApp não conectado",
      });
    }

    const currentStatus = session.getStatus();
    console.log(`🔍 [SEND] Status da sessão: ${currentStatus}`);

    if (currentStatus !== "connected") {
      console.error(
        `❌ [SEND] WhatsApp não conectado. Status: ${currentStatus}`
      );
      return res.status(400).json({
        success: false,
        error: `WhatsApp não está conectado. Status atual: ${currentStatus}`,
      });
    }

    // Formatar número corretamente para WhatsApp
    let formattedPhone = phone.replace(/\D/g, "");

    // Verificar se o número existe no WhatsApp antes de enviar
    console.log(`📞 [SEND] Número original: ${phone}`);
    console.log(`📞 [SEND] Número formatado: ${formattedPhone}`);

    // Tentar com o formato padrão primeiro
    let jid = `${formattedPhone}@s.whatsapp.net`;

    try {
      // Verificar se o número existe no WhatsApp
      const [result] = await session.sock.onWhatsApp(formattedPhone);

      if (result && result.exists) {
        jid = result.jid;
        console.log(`✅ [SEND] Número verificado no WhatsApp: ${jid}`);
      } else {
        console.warn(
          `⚠️ [SEND] Número não encontrado no WhatsApp, tentando enviar mesmo assim`
        );
      }
    } catch (verifyError) {
      console.warn(
        `⚠️ [SEND] Erro ao verificar número, continuando com JID padrão:`,
        verifyError.message
      );
    }

    console.log(`📝 [SEND] JID final: ${jid}`);
    console.log(`📝 [SEND] Mensagem (${message.length} caracteres)`);

    // Enviar mensagem e aguardar confirmação
    const sendResult = await session.sock.sendMessage(jid, { text: message });

    console.log(`✅ [SEND] Mensagem enviada com sucesso!`);
    console.log(`📊 [SEND] Detalhes:`, JSON.stringify(sendResult, null, 2));

    res.json({
      success: true,
      message: "Mensagem enviada",
      messageId: sendResult?.key?.id,
      timestamp: sendResult?.messageTimestamp,
      status: sendResult?.status,
    });
  } catch (error) {
    console.error("❌ [SEND] Erro ao enviar mensagem:", error);
    console.error("❌ [SEND] Stack:", error.stack);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.stack,
    });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    activeSessions: sessions.size,
    timestamp: new Date().toISOString(),
  });
});

// Sistema de keep-alive: verifica conexões a cada 15 segundos
setInterval(async () => {
  for (const [sessionId, session] of sessions.entries()) {
    const status = session.getStatus();

    if (session.sock && status === "connected") {
      try {
        // Ping simples para manter conexão ativa
        await session.sock.sendPresenceUpdate("available");
        console.log(
          `[${sessionId}] ✅ Keep-alive OK - Status: ${status}, Phone: ${session.getPhoneNumber()}`
        );
      } catch (error) {
        console.error(`[${sessionId}] ❌ Erro no keep-alive:`, error.message);
        console.log(
          `[${sessionId}] Tentando reconectar após erro de keep-alive...`
        );

        // Se o keep-alive falhar, tentar reconectar
        initWhatsApp(sessionId).catch((err) => {
          console.error(`[${sessionId}] ❌ Falha ao reconectar:`, err.message);
        });
      }
    } else {
      console.log(
        `[${sessionId}] ⚠️ Sessão não conectada - Status: ${status} - Tentando reconectar...`
      );

      // Se não está conectado, tentar reconectar
      if (status === "disconnected") {
        initWhatsApp(sessionId).catch((err) => {
          console.error(`[${sessionId}] ❌ Falha ao reconectar:`, err.message);
        });
      }
    }
  }
}, 15000); // A cada 15 segundos

app.get("/debug", (req, res) => {
  const sessionStates = [];
  sessions.forEach((session, sessionId) => {
    sessionStates.push({
      sessionId,
      status: session.getStatus(),
      hasQR: !!session.getQR(),
      phoneNumber: session.getPhoneNumber(),
    });
  });

  res.json({
    totalSessions: sessions.size,
    sessions: sessionStates,
  });
});

app.listen(PORT, () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🚀 WhatsApp Baileys Server rodando na porta ${PORT}`);
  console.log(`📱 Health: http://localhost:${PORT}/health`);
  console.log(`🐛 Debug: http://localhost:${PORT}/debug`);
  console.log(`${"=".repeat(60)}\n`);
});
